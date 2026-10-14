import { vectorRecord, validVector } from './vector-record.js';
import { retrievalTarget } from '../../shared/retrieval.js';
import { knowledgeStatus } from './retrieval-status.js';
import type { RetrievalSettings } from '../../shared/retrieval.js';
import { externalVectorSearch, rerankCandidates, retrievalPost } from './retrieval-extensions.js';
import { KnowledgeGraph } from './knowledge-graph.js';
import { dirname, join } from 'node:path';
import { structuredChunks, documentAt, documentEligibilitySQL } from './knowledge-versions.js';
import { AnnIndex } from './ann.js';
import { createHash } from 'node:crypto';
import { assert } from '../core/errors.js';
import { Store, id } from '../storage/store.js';
import { Embeddings, cosine } from './embedding.js';
export const terms = (text: string) => {
  const lower = text.toLowerCase();
  return [...lower.matchAll(/[a-z0-9_]{2,}/g)]
    .map((x) => x[0])
    .concat([...lower.matchAll(/[\u3400-\u9fff]/g)].map((x) => x[0]));
};
export class Knowledge {
  private ann: AnnIndex;
  lastRetrieval: Record<string, unknown> = {};
  close() {
    this.ann.close();
  }
  constructor(
    private store: Store,
    private embeddings?: Embeddings,
    private retrieval: () => RetrievalSettings = () => ({}),
  ) {
    this.ann = new AnnIndex(
      store.path === ':memory:' ? undefined : join(dirname(store.path), 'ann-cache'),
    );
    store.db
      .exec(`CREATE TABLE IF NOT EXISTS vector_revision(id INTEGER PRIMARY KEY,version INTEGER NOT NULL);
    INSERT OR IGNORE INTO vector_revision VALUES(1,0);
    CREATE TRIGGER IF NOT EXISTS vectors_insert AFTER INSERT ON chunks BEGIN UPDATE vector_revision SET version=version+1 WHERE id=1; END;
    CREATE TRIGGER IF NOT EXISTS vectors_update AFTER UPDATE OF vector ON chunks BEGIN UPDATE vector_revision SET version=version+1 WHERE id=1; END;
    CREATE TRIGGER IF NOT EXISTS vectors_delete AFTER DELETE ON chunks BEGIN UPDATE vector_revision SET version=version+1 WHERE id=1; END;`);
  }
  private vectorStatuses(rows: Iterable<any>) {
    const statuses: Record<
      string,
      { completed: number; total: number; invalid: number; status: string }
    > = {};
    for (const row of rows) {
      const item = (statuses[row.document_id] ||= {
        completed: 0,
        total: 0,
        invalid: 0,
        status: 'pending',
      });
      item.total++;
      const vector = vectorRecord(row.vector);
      if (row.vector != null && !vector) item.invalid++;
      if (vector?.model === this.embeddings?.fingerprint()) item.completed++;
      item.status =
        item.completed === item.total ? 'indexed' : item.completed ? 'partial' : 'pending';
    }
    return statuses;
  }
  indexStatuses(scope: string) {
    return this.vectorStatuses(
      this.store.db.prepare('SELECT document_id,vector FROM chunks WHERE scope=?').iterate(scope),
    );
  }
  indexStatus(key: string) {
    return (
      this.vectorStatuses(
        this.store.db
          .prepare('SELECT document_id,vector FROM chunks WHERE document_id=?')
          .iterate(key),
      )[key] || { completed: 0, total: 0, invalid: 0, status: 'pending' }
    );
  }
  statistics(scopes: string[], asOf = Date.now(), memoryBudgetMiB?: number) {
    return knowledgeStatus(
      this.store,
      scopes,
      this.embeddings?.fingerprint() || '',
      !!this.embeddings?.enabled(),
      asOf,
      memoryBudgetMiB,
    );
  }
  diagnostics(scopes: string[], asOf = Date.now()) {
    const statistics = this.statistics(scopes, asOf);
    return {
      status: statistics.state === 'ready' ? 'no_match' : statistics.state,
      queryOutcome: 'no_match',
      documents: statistics.documents.current,
      sources: statistics.sources,
      statistics,
      note: 'Chat history is not automatically imported. Index completeness and query relevance are separate.',
    };
  }

  import(
    scope: string,
    name: string,
    text: string,
    metadata: {
      revisionOf?: string;
      source?: string;
      validFrom?: number;
      publishedAt?: number;
    } = {},
  ) {
    assert(
      text.trim(),
      'EMPTY_DOCUMENT',
      'No readable text was extracted. Scanned images require OCR first.',
    );
    assert(
      text.length <= 5000000,
      'DOCUMENT_TOO_LARGE',
      'Extracted document exceeds 5 million characters.',
    );
    const previous = metadata.revisionOf
      ? this.store.get<any>('document', metadata.revisionOf)
      : null;
    assert(
      !previous || previous.scope === scope,
      'DOCUMENT_SCOPE',
      'Cannot replace a document in another scope.',
    );
    const validFrom = metadata.validFrom ?? Date.now();
    assert(
      !previous ||
        (previous.validUntil == null && validFrom > (previous.validFrom ?? previous.createdAt)),
      'DOCUMENT_TIME',
      'Replace only the latest version at a later effective time.',
    );
    const key = id(),
      hash = createHash('sha256').update(text).digest('hex');
    this.store.transaction(() => {
      if (previous) this.store.put('document', { ...previous, validUntil: validFrom });
      this.store.put('document', {
        id: key,
        scope,
        name,
        characters: text.length,
        createdAt: Date.now(),
        hash,
        source: metadata.source || previous?.source || name,
        familyId: previous?.familyId || previous?.id || key,
        version: (previous?.version || 0) + 1,
        revisionOf: previous?.id,
        validFrom,
        validUntil: null,
        publishedAt: metadata.publishedAt,
      });
      for (const [ordinal, section] of structuredChunks(text).entries()) {
        const chunk = id(),
          body = section.text;
        this.store.put('chunk-metadata', {
          id: chunk,
          documentId: key,
          heading: section.heading,
          start: section.start,
          end: section.end,
        });
        this.store.db
          .prepare(
            'INSERT INTO chunks(id,scope,document_id,name,ordinal,text,source_hash) VALUES(?,?,?,?,?,?,?)',
          )
          .run(chunk, scope, key, name, ordinal, body, hash);
        this.store.db
          .prepare('INSERT INTO chunk_fts(id,terms) VALUES(?,?)')
          .run(chunk, terms(body).join(' '));
      }
    });
    return this.store.get('document', key);
  }
  search(
    scopes: string[],
    query: string,
    limit = 6,
    asOf = Date.now(),
    documentIds: string[] = [],
  ) {
    if (!scopes.length) return [];
    const tokens = [...new Set(terms(query))].slice(0, 40);
    if (!tokens.length) return [];
    const expression = tokens.map((t) => '"' + t.replaceAll('"', '""') + '"').join(' OR ');
    const rows = this.store.db
      .prepare(
        'SELECT c.*,bm25(chunk_fts) AS rank FROM chunk_fts JOIN chunks c ON c.id=chunk_fts.id WHERE chunk_fts MATCH ? AND c.scope IN (' +
          scopes.map(() => '?').join(',') +
          ') AND c.document_id IN (' +
          documentEligibilitySQL +
          ')' +
          (documentIds.length
            ? ' AND c.document_id IN (' + documentIds.map(() => '?').join(',') + ')'
            : '') +
          ' ORDER BY rank LIMIT 500',
      )
      .all(expression, ...scopes, asOf, asOf, ...documentIds) as any[];
    const q = [...new Set(terms(query))],
      N = rows.length;
    const docs = rows.map((r) => ({ ...r, t: terms(r.text) }));
    const df = new Map(q.map((t) => [t, docs.filter((d) => d.t.includes(t)).length]));
    return docs
      .map((d) => {
        let score = 0;
        for (const t of q) {
          const n = d.t.filter((x: string) => x === t).length;
          score +=
            (Math.log(1 + (N - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5)) * n * 2.2) /
            (n + 1.2 * (0.25 + (0.75 * d.t.length) / 300));
        }
        return {
          id: d.id,
          documentId: d.document_id,
          name: d.name,
          ordinal: d.ordinal,
          scope: d.scope,
          text: d.text,
          score,
          scoreKind: 'lexical',
          ...this.citation(d.document_id, d.id),
        };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
  async index(
    key: string,
    allowed: () => boolean = () => true,
    onProgress?: (value: { completed: number; total: number }) => void,
  ) {
    assert(this.embeddings?.enabled(), 'EMBEDDING_DISABLED', 'Configure embeddings first.');
    const fingerprint = this.embeddings!.fingerprint();
    const rows = this.store.db
      .prepare('SELECT id,text,vector FROM chunks WHERE document_id=? ORDER BY ordinal')
      .all(key) as any[];
    assert(rows.length, 'NOT_FOUND', 'Document not found');
    onProgress?.({ completed: 0, total: rows.length });
    for (let i = 0; i < rows.length; i += 16) {
      const batch = rows.slice(i, i + 16).filter((r) => {
        try {
          return !vectorRecord(r.vector, fingerprint);
        } catch {
          return true;
        }
      });
      if (!batch.length) {
        onProgress?.({ completed: Math.min(i + 16, rows.length), total: rows.length });
        continue;
      }
      const vectors: number[][] = [];
      for (const row of batch) {
        assert(
          allowed() && this.embeddings!.fingerprint() === fingerprint,
          'INDEX_CANCELLED',
          'Index configuration changed.',
        );
        const reuse = this.store.db
          .prepare(
            'SELECT vector FROM chunks WHERE text=? AND scope=(SELECT scope FROM chunks WHERE id=?) AND vector IS NOT NULL LIMIT 100',
          )
          .all(row.text, row.id) as any[];
        const cached = reuse
          .map((r) => {
            try {
              return vectorRecord(r.vector, fingerprint);
            } catch {
              return null;
            }
          })
          .find((v) => v?.model === fingerprint);
        vectors.push(cached?.values || (await this.embeddings!.encode([row.text]))[0]);
      }
      assert(
        allowed() && this.embeddings!.fingerprint() === fingerprint,
        'EMBEDDING_CHANGED',
        'Embedding configuration changed during indexing.',
      );
      this.store.transaction(() => {
        for (let n = 0; n < batch.length; n++)
          this.store.db
            .prepare('UPDATE chunks SET vector=? WHERE id=?')
            .run(
              JSON.stringify({ model: this.embeddings!.fingerprint(), values: vectors[n] }),
              batch[n].id,
            );
      });
      onProgress?.({ completed: Math.min(i + 16, rows.length), total: rows.length });
    }
    onProgress?.({ completed: rows.length, total: rows.length });
    return { chunks: rows.length, model: this.embeddings!.fingerprint() };
  }
  async hybrid(
    scopes: string[],
    query: string,
    limit = 6,
    signal?: AbortSignal,
    asOf = Date.now(),
    bypassPolicy = false,
    documentIds: string[] = [],
    mode: 'hybrid' | 'lexical' = 'hybrid',
  ) {
    const traceId = id(),
      startedAt = Date.now();
    const diagnostics: Record<string, unknown> = {};
    const record = (extra: any) => {
      this.store.put('retrieval-trace', {
        id: traceId,
        scopes: [...scopes],
        query,
        asOf,
        documentIds: [...documentIds],
        embedding: this.embeddings?.fingerprint() || null,
        reranker: this.retrieval().rerank?.model || null,
        candidateBudget: this.retrieval().rerank?.candidates || 40,
        requested: limit,
        startedAt,
        durationMs: Date.now() - startedAt,
        diagnostics,
        ...extra,
      });
      const old = this.store.list<any>('retrieval-trace').sort((a, b) => b.startedAt - a.startedAt);
      for (const row of old.slice(500)) this.store.remove('retrieval-trace', row.id);
    };
    try {
      const results = await this.retrieve(
        scopes,
        query,
        limit,
        signal,
        asOf,
        bypassPolicy,
        documentIds,
        diagnostics,
        mode,
      );
      record({
        status: results.length ? 'candidates' : 'no-candidates',
        hits: results.map((r) => ({
          chunkId: r.id,
          documentId: r.documentId,
          version: r.version,
          contentHash: createHash('sha256').update(r.text).digest('hex'),
          ranking: r.ranking,
          rerankScore: r.rerankScore,
          score: r.score,
        })),
        conclusion: 'unassessed',
      });
      return results.map((r) => ({
        ...r,
        retrievalTraceId: traceId,
        retrievalDiagnostics: diagnostics,
        relevanceStatus: 'unassessed',
      }));
    } catch (error) {
      record({ status: signal?.aborted ? 'cancelled' : 'failed' });
      throw error;
    }
  }
  async retrieve(
    scopes: string[],
    query: string,
    limit = 6,
    signal?: AbortSignal,
    asOf = Date.now(),
    bypassPolicy = false,
    documentIds: string[] = [],
    diagnostics: Record<string, unknown> = {},
    mode: 'hybrid' | 'lexical' = 'hybrid',
  ) {
    this.lastRetrieval = diagnostics;
    signal?.throwIfAborted();
    if (!query.trim() || !scopes.length) return [];
    if (mode === 'lexical') {
      Object.assign(diagnostics, { backend: 'lexical', requestedMode: mode });
      // Explicit lexical mode has no embedding, graph, sidecar or reranker dependency.
      return this.search(scopes, query, limit, asOf, documentIds).map((hit) => ({
        ...hit,
        retrievalDiagnostics: diagnostics,
      }));
    }
    if (
      !bypassPolicy &&
      scopes.length === 1 &&
      this.store.maybe<any>('retrieval-policy', scopes[0])?.mode === 'lexical'
    )
      return this.finish(
        this.search(scopes, query, 60, asOf, documentIds),
        scopes,
        query,
        limit,
        asOf,
        signal,
        documentIds,
      );
    const lexical = this.search(scopes, query, 60, asOf, documentIds);
    if (!this.embeddings?.enabled() || !scopes.length)
      return this.finish(lexical, scopes, query, limit, asOf, signal, documentIds);
    let q: number[];
    try {
      [q] = await this.embeddings.encode([query], signal, 'query');
      assert(validVector(q), 'INVALID_QUERY_VECTOR', 'Invalid query embedding.');
    } catch (error) {
      if (signal?.aborted) throw error;
      Object.assign(diagnostics, {
        backend: 'lexical',
        degraded: true,
        reason: 'query_embedding_unavailable',
      });
      return this.finish(lexical, scopes, query, limit, asOf, signal, documentIds);
    }
    const rows = this.store.db
      .prepare(
        'SELECT * FROM chunks WHERE vector IS NOT NULL AND scope IN (' +
          scopes.map(() => '?').join(',') +
          ')' +
          (documentIds.length
            ? ' AND document_id IN (' + documentIds.map(() => '?').join(',') + ')'
            : '') +
          ' ORDER BY id',
      )
      .all(...scopes, ...documentIds) as any[];
    const eligible = rows.filter(
      (r) =>
        (documentIds.length === 0 || documentIds.includes(r.document_id)) &&
        documentAt(this.store.maybe('document', r.document_id), asOf),
    );
    let invalid = 0,
      incompatible = 0;
    const vectors = eligible.flatMap((r) => {
      const v = vectorRecord(r.vector);
      if (!v) {
        invalid++;
        return [];
      }
      if (v.model !== this.embeddings!.fingerprint() || v.values.length !== q.length) {
        incompatible++;
        return [];
      }
      return [{ ...r, v }];
    });
    const vectorHealth = {
      scanned: eligible.length,
      usable: vectors.length,
      invalid,
      incompatible,
    };
    Object.assign(diagnostics, {
      vectorHealth,
      degraded: invalid > 0 || incompatible > 0,
      backend: 'lexical',
    });
    if (!vectors.length)
      return this.finish(lexical, scopes, query, limit, asOf, signal, documentIds);
    let ranked: { id: string; score: number }[];
    const external = this.retrieval().vectors;
    if (external?.enabled) {
      const revision = (
        this.store.db.prepare('SELECT version FROM vector_revision WHERE id=1').get() as any
      ).version;
      let result;
      try {
        result = await externalVectorSearch(
          external,
          vectors.map((r) => ({ id: r.id, values: r.v.values })),
          q,
          signal,
        );
      } catch (error: any) {
        if (signal?.aborted) throw error;
        Object.assign(diagnostics, {
          backend: 'lexical',
          degraded: true,
          reason: 'vector_backend_unavailable',
          errorCode: String(error.code || 'RETRIEVAL_SERVICE'),
        });
        return lexical
          .slice(0, limit)
          .map((hit) => ({ ...hit, retrievalDiagnostics: diagnostics }));
      }
      assert(
        (this.store.db.prepare('SELECT version FROM vector_revision WHERE id=1').get() as any)
          .version === revision,
        'INDEX_CHANGED',
        'Knowledge changed during external retrieval; search again.',
      );
      ranked = result.result;
      Object.assign(diagnostics, {
        ...diagnostics,
        ...result,
        result: undefined,
        chunks: vectors.length,
      });
    } else if (vectors.length < 2000) {
      ranked = vectors
        .map((r) => ({ id: r.id, score: cosine(q, r.v.values) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 60);
      Object.assign(diagnostics, { ...diagnostics, backend: 'exact', chunks: vectors.length });
    } else {
      const revision = (
        this.store.db.prepare('SELECT version FROM vector_revision WHERE id=1').get() as any
      ).version;
      const generation = JSON.stringify([
        revision,
        [...scopes].sort(),
        this.embeddings.fingerprint(),
        q.length,
      ]);
      const result = await this.ann.search(
        generation,
        vectors.map((r) => ({ id: r.id, values: r.v.values })),
        q,
        60,
        signal,
      );
      assert(
        (this.store.db.prepare('SELECT version FROM vector_revision WHERE id=1').get() as any)
          .version === revision,
        'INDEX_CHANGED',
        'Knowledge changed during retrieval; search again.',
      );
      ranked = result.result;
      Object.assign(diagnostics, {
        ...diagnostics,
        backend: result.backend,
        cacheSource: result.cacheSource,
        calibration: result.calibration,
        chunks: vectors.length,
        buildMs: result.buildMs,
        searchMs: result.searchMs,
      });
    }
    const byId = new Map(vectors.map((r) => [r.id, r]));
    const semantic = ranked
      .filter(
        (r) =>
          byId.has(r.id) &&
          Number.isFinite(r.score) &&
          this.store.db.prepare('SELECT id FROM chunks WHERE id=?').get(r.id),
      )
      .map((hit) => {
        const r = byId.get(hit.id)!;
        return {
          id: r.id,
          documentId: r.document_id,
          name: r.name,
          ordinal: r.ordinal,
          scope: r.scope,
          text: r.text,
          score: hit.score,
          embeddingDimension: q.length,
          ...this.citation(r.document_id, r.id),
        };
      });
    const merged = new Map<string, any>();
    for (const [channel, list] of [
      ['lexical', lexical],
      ['semantic', semantic],
    ] as const)
      list.forEach((r, i) => {
        const old = merged.get(r.id);
        const fusionScore = (old?.fusionScore || 0) + 1 / (60 + i + 1);
        merged.set(r.id, {
          ...old,
          ...r,
          score: fusionScore,
          fusionScore,
          scoreKind: 'rrf',
          retrievalChannels: {
            ...old?.retrievalChannels,
            [channel]: { rank: i + 1, rawScore: r.score },
          },
        });
      });
    return this.finish(
      [...merged.values()].sort((a, b) => b.score - a.score),
      scopes,
      query,
      limit,
      asOf,
      signal,
      documentIds,
    );
  }
  private lightSyncBusy = false;
  async syncLightRag() {
    const c = this.retrieval().lightRag;
    if (!c?.enabled || c.authorizedTarget !== retrievalTarget('lightRag', c))
      return { status: 'disabled' };
    if (this.lightSyncBusy) return { status: 'processing' };
    this.lightSyncBusy = true;
    try {
      const target = retrievalTarget('lightRag', c);
      const id = createHash('sha256').update(target).digest('hex');
      const previous = this.store.maybe<any>('lightrag-sync', id);
      const rows = this.store.db
        .prepare(
          'SELECT id,document_id,text FROM chunks WHERE scope=? ORDER BY document_id,ordinal',
        )
        .all(c.scope)
        .filter((r: any) =>
          documentAt(this.store.maybe('document', r.document_id), Date.now()),
        ) as any[];
      const completed = new Set<string>(previous?.completed || []);
      if (previous?.jobId) {
        const job = await retrievalPost('lightRag', c, '/documents/status', {
          jobId: previous.jobId,
        });
        if (job.status !== 'completed')
          return { status: job.status, completed: completed.size, total: rows.length };
        for (const key of previous.batch) completed.add(key);
        this.store.put('lightrag-sync', { id, completed: [...completed] });
      } else if (previous?.status === 'unknown') {
        return {
          status: 'unknown',
          completed: completed.size,
          total: rows.length,
          notice:
            'Submission result unknown; inspect local LightRAG before resetting synchronization.',
        };
      }
      const latest = this.retrieval().lightRag;
      if (
        !latest?.enabled ||
        latest.authorizedTarget !== target ||
        retrievalTarget('lightRag', latest) !== target
      )
        return { status: 'disabled' };
      const batch = rows
        .filter(
          (r) =>
            !completed.has(r.id) &&
            documentAt(this.store.maybe('document', r.document_id), Date.now()),
        )
        .slice(0, 16);
      if (!batch.length) return { status: 'synced', completed: completed.size, total: rows.length };
      // Save intent before sending; an unknown submission is never blindly replayed.
      this.store.put('lightrag-sync', { id, completed: [...completed], status: 'unknown' });
      const result = await retrievalPost('lightRag', c, '/documents/texts', {
        scope: c.scope,
        texts: batch.map((r) => r.text),
        file_sources: batch.map((r) => 'amadeus-' + r.document_id + '-' + r.id),
      });
      assert(
        typeof result.jobId === 'string',
        'LIGHTRAG_JOB',
        'Expected a local LightRAG ingestion job.',
      );
      this.store.put('lightrag-sync', {
        id,
        completed: [...completed],
        jobId: result.jobId,
        batch: batch.map((r) => r.id),
      });
      return { status: result.status, completed: completed.size, total: rows.length };
    } finally {
      this.lightSyncBusy = false;
    }
  }
  private async finish(
    rows: any[],
    scopes: string[],
    query: string,
    limit: number,
    asOf: number,
    signal?: AbortSignal,
    documentIds: string[] = [],
  ) {
    const options = this.retrieval(),
      pool = new Map(rows.map((r) => [r.id, r]));
    const addEvidence = (documentId: string, quote: string, origin: string, edgeId?: string) => {
      const doc = this.store.maybe<any>('document', documentId);
      if (
        !doc ||
        (documentIds.length > 0 && !documentIds.includes(documentId)) ||
        !scopes.includes(doc.scope) ||
        !documentAt(doc, asOf) ||
        !quote.trim()
      )
        return;
      const chunk = this.store.db
        .prepare(
          'SELECT * FROM chunks WHERE document_id=? AND instr(text,?)>0 ORDER BY ordinal LIMIT 1',
        )
        .get(documentId, quote) as any;
      if (!chunk) return;
      const old = pool.get(chunk.id);
      pool.set(chunk.id, {
        ...(old || {
          id: chunk.id,
          documentId,
          scope: doc.scope,
          name: doc.name,
          ordinal: chunk.ordinal,
          text: chunk.text,
          score: 1 / 61,
          scoreKind: origin,
          ...this.citation(documentId, chunk.id),
        }),
        supplementalEvidence: [
          ...(old?.supplementalEvidence || []).filter(
            (e: any) => e.edgeId !== edgeId || e.origin !== origin,
          ),
          { origin, edgeId, quote },
        ].slice(0, 8),
      });
    };
    if (options.graph !== false) {
      const graph = new KnowledgeGraph(this.store).search(scopes, query, asOf, 2);
      for (const path of graph.paths)
        for (const edge of path.edges)
          for (const evidence of edge.evidence)
            if (evidence.type === 'document')
              addEvidence(evidence.id, evidence.quote, 'document-graph', edge.id);
    }
    const light = options.lightRag;
    if (light?.enabled && scopes.includes(light.scope)) {
      const response = await retrievalPost(
        'lightRag',
        light,
        '/query/data',
        { scope: light.scope, query, mode: light.mode, top_k: 20, chunk_top_k: 20 },
        signal,
      );
      assert(
        Array.isArray(response?.data?.chunks),
        'LIGHTRAG_RESPONSE',
        'Expected LightRAG data.chunks.',
      );
      const docs = this.store
        .list<any>('document')
        .filter((d) => d.scope === light.scope && documentAt(d, asOf));
      for (const r of response.data.chunks.slice(0, 30)) {
        if (
          typeof r.content !== 'string' ||
          r.content.length > 20000 ||
          typeof r.file_path !== 'string'
        )
          continue;
        // Never trust external answers or names alone. Import with this stable source ID.
        const doc = docs.find((d) => r.file_path.startsWith('amadeus-' + d.id + '-'));
        if (doc) {
          const chunkId = r.file_path.slice(('amadeus-' + doc.id + '-').length);
          const chunk = this.store.db
            .prepare('SELECT text FROM chunks WHERE id=? AND document_id=?')
            .get(chunkId, doc.id) as any;
          if (chunk?.text.includes(r.content)) addEvidence(doc.id, r.content, 'lightrag');
        }
      }
    }
    let result = this.enrich(
      [...pool.values()].sort((a, b) => b.score - a.score),
      query,
      60,
      asOf,
    );
    if (options.rerank?.enabled)
      result = await rerankCandidates(options.rerank, query, result, signal);
    return result
      .filter(
        (r) =>
          scopes.includes(r.scope) && documentAt(this.store.maybe('document', r.documentId), asOf),
      )
      .slice(0, limit);
  }
  async investigate(
    scopes: string[],
    queries: string[],
    limit = 6,
    signal?: AbortSignal,
    asOf = Date.now(),
  ) {
    assert(
      queries.length > 0 && queries.length <= 4,
      'RESEARCH_BUDGET',
      'Use one to four focused queries.',
    );
    const results = new Map<string, any>(),
      rounds: any[] = [];
    const startedAt = Date.now();
    let stopReason = 'query-budget-exhausted',
      duplicateRounds = 0;
    for (const query of [...new Set(queries.map((q) => q.trim()).filter(Boolean))]) {
      if (signal?.aborted) throw new Error('Retrieval cancelled');
      if (Date.now() - startedAt >= 60000) {
        stopReason = 'time-budget';
        break;
      }
      let hits: any[];
      try {
        hits = await this.hybrid(
          scopes,
          query,
          limit,
          AbortSignal.any([
            ...(signal ? [signal] : []),
            AbortSignal.timeout(Math.max(1, 60000 - (Date.now() - startedAt))),
          ]),
          asOf,
        );
      } catch (error) {
        if (signal?.aborted) throw error;
        stopReason = Date.now() - startedAt >= 60000 ? 'time-budget' : 'retrieval-failed';
        rounds.push({ query, status: stopReason, hits: 0, newChunks: 0 });
        break;
      }
      let added = 0;
      for (const hit of hits) {
        if (!results.has(hit.id)) added++;
        results.set(hit.id, hit);
      }
      rounds.push({
        query,
        hits: hits.length,
        newChunks: added,
        traceId: hits[0]?.retrievalTraceId ?? null,
        assessment: 'unassessed',
        missingEvidence: hits.length ? null : 'No candidates; corpus absence is not proven.',
      });
      duplicateRounds = added === 0 ? duplicateRounds + 1 : 0;
      if (duplicateRounds >= 2) {
        stopReason = 'no-new-evidence';
        break;
      }
    }
    return {
      results: [...results.values()].slice(0, 24),
      rounds,
      budget: { maxQueries: 4, maxDurationMs: 60000, stopReason, hostPlanningModelCalls: 0 },
      next: results.size
        ? 'Compare cited evidence; unresolved conflicts may require a focused follow-up.'
        : 'No grounded results; refine query or inspect ingestion and scope.',
      notice:
        'Agent-directed query variants; host does not infer correctness or launch an unlimited reasoning loop.',
    };
  }
  private citation(documentId: string, chunkId: string) {
    const d = this.store.maybe<any>('document', documentId);
    return {
      version: d?.version || 1,
      source: d?.source || d?.name,
      validFrom: d?.validFrom ?? d?.createdAt,
      validUntil: d?.validUntil,
      publishedAt: d?.publishedAt,
      citation: { documentId, chunkId, version: d?.version || 1 },
      heading: this.store.maybe<any>('chunk-metadata', chunkId)?.heading || '',
    };
  }
  private enrich(rows: any[], query: string, limit: number, asOf: number) {
    const queryTerms = new Set(terms(query));
    const ranked = rows
      .filter((r) => documentAt(this.store.maybe('document', r.documentId), asOf))
      .map((r) => {
        const headingBoost =
          [...new Set(terms(r.heading || ''))].filter((t) => queryTerms.has(t)).length * 0.002;
        return {
          ...r,
          baseScore: r.score,
          headingBoost,
          score: r.score + headingBoost,
          ranking: {
            method: r.scoreKind === 'rrf' ? 'rrf-plus-heading' : 'lexical-plus-heading',
            rrfK: r.scoreKind === 'rrf' ? 60 : null,
            semanticReranker: 'none',
            relevanceCalibrated: false,
            embeddingModel: r.retrievalChannels?.semantic ? this.embeddings?.fingerprint() : null,
            embeddingDimension: r.embeddingDimension ?? null,
          },
        };
      });
    const seen = new Set<string>();
    return ranked
      .sort((a, b) => b.score - a.score)
      .filter((r) => {
        const key = r.documentId + ':' + r.ordinal;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, limit)
      .map((r) => ({
        ...r,
        asOf,
        alternativeSources: ranked
          .filter(
            (x) =>
              x.documentId !== r.documentId &&
              x.text.replace(/\s+/g, ' ').trim() === r.text.replace(/\s+/g, ' ').trim(),
          )
          .slice(0, 4)
          .map((x) => ({
            documentId: x.documentId,
            match: 'whitespace-normalized-exact',
            version: x.version,
            source: x.source,
            quote: x.text.slice(0, 500),
          })),
        neighbors: this.store.db
          .prepare(
            'SELECT id,ordinal,text FROM chunks WHERE document_id=? AND ordinal BETWEEN ? AND ? AND id<>? ORDER BY ordinal',
          )
          .all(r.documentId, Math.max(0, r.ordinal - 1), r.ordinal + 1, r.id),
        evidenceNotice:
          'Ranking is not calibrated relevance or a verification verdict; weak or unrelated candidates may be returned. Compare source versions and quotes. Alternative sources match normalized chunk text; other corroboration is not implied.',
      }));
  }
  remove(key: string) {
    this.store.transaction(() => {
      this.store.db
        .prepare('DELETE FROM chunk_fts WHERE id IN (SELECT id FROM chunks WHERE document_id=?)')
        .run(key);
      this.store.db.prepare('DELETE FROM chunks WHERE document_id=?').run(key);
      for (const m of this.store.list<any>('chunk-metadata'))
        if (m.documentId === key) this.store.remove('chunk-metadata', m.id);
      this.store.remove('document', key);
    });
  }
}
