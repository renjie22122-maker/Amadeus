import { createHash } from 'node:crypto';
import { retrievalTarget } from '../../shared/retrieval.js';
import { Store } from '../storage/store.js';
import { vectorRecord } from './vector-record.js';
import { cosine } from './embedding.js';
import { externalVectorSearch, retrievalPost } from './retrieval-extensions.js';
import { documentEligibilitySQL } from './knowledge-versions.js';
import type { RetrievalSettings } from '../../shared/retrieval.js';

/** Keyset paging bounds host memory; only top candidates retain original text. */
export async function streamedVectors(
  store: Store,
  scopes: string[],
  documentIds: string[],
  asOf: number,
  fingerprint: string,
  query: number[],
  external: RetrievalSettings['vectors'],
  signal?: AbortSignal,
) {
  const revision = () =>
    (store.db.prepare('SELECT version FROM vector_revision WHERE id=1').get() as any).version;
  const before = revision();
  const docs = () =>
    JSON.stringify(
      store.db.prepare("SELECT id,data FROM records WHERE kind='document' ORDER BY id").all(),
    );
  const beforeDocs = docs();
  const eligible = store.db
    .prepare(documentEligibilitySQL)
    .all(asOf, asOf)
    .map((r: any) => r.id)
    .sort();
  const identity = createHash('sha256')
    .update(
      JSON.stringify([
        before,
        beforeDocs,
        eligible,
        [...scopes].sort(),
        [...documentIds].sort(),
        fingerprint,
        query.length,
        external?.enabled ? retrievalTarget('vectors', external) : null,
      ]),
    )
    .digest('hex');
  const manifest = external?.enabled
    ? store.maybe<any>('vector-query-manifest', identity)
    : undefined;
  if (manifest) {
    try {
      let hits: { id: string; score: number }[] = [];
      // Optional batched cache protocol: one isolated worker can serve many shards.
      // Older/external backends retain the existing per-shard path.
      let batched: Map<string, any> | undefined;
      try {
        const results: any[] = [];
        for (let offset = 0; offset < manifest.shards.length; offset += 64) {
          const shards = manifest.shards.slice(offset, offset + 64);
          const response = await retrievalPost(
            'vectors',
            external!,
            '/vectors/search-batch',
            {
              backend: external!.backend,
              index: external!.index,
              generations: shards.map((x: any) => x.generation),
              query,
              limit: 60,
            },
            signal,
          );
          if (
            !Array.isArray(response.results) ||
            response.results.length !== shards.length ||
            response.results.some((r: any, i: number) => r.generation !== shards[i].generation)
          )
            throw Error('Invalid batched vector response');
          results.push(...response.results);
        }
        batched = new Map(results.map((r) => [r.generation, r]));
      } catch (error) {
        if (signal?.aborted) throw error;
      }
      for (const shard of manifest.shards) {
        signal?.throwIfAborted();
        const result =
          batched?.get(shard.generation) ??
          (await retrievalPost(
            'vectors',
            external!,
            '/vectors/search',
            {
              backend: external!.backend,
              index: external!.index,
              generation: shard.generation,
              query,
              limit: 60,
              cachedOnly: true,
            },
            signal,
          ));
        if (result.cacheMiss) throw Error('Snapshot evicted');
        const ids = new Set(shard.ids),
          seen = new Set<string>();
        if (!Array.isArray(result.result) || result.result.length > 60)
          throw Error('Invalid cached response');
        for (const hit of result.result) {
          if (!ids.has(hit.id) || seen.has(hit.id) || !Number.isFinite(hit.score))
            throw Error('Invalid cached hit');
          seen.add(hit.id);
          hits.push(hit);
        }
        hits.sort((a, b) => b.score - a.score);
        hits = hits.slice(0, 60);
      }
      if (revision() !== before || docs() !== beforeDocs)
        throw Object.assign(Error('Index changed'), { code: 'INDEX_CHANGED' });
      const read = store.db.prepare(
        'SELECT id,scope,document_id,name,ordinal,text FROM chunks WHERE id=?',
      );
      const rows: any[] = hits.map((hit) => ({ ...read.get(hit.id), score: hit.score }));
      if (
        rows.some(
          (r) => !r.id || !scopes.includes(r.scope as string) || !eligible.includes(r.document_id),
        )
      )
        throw Error('Cached scope changed');
      return {
        rows,
        diagnostics: {
          backend: 'persistent-external',
          vectorHealthBasis: 'cached_manifest_coverage',
          vectorInputMode: 'cached_index_query',
          cacheHit: true,
          batchedCacheSearch: !!batched,
          batches: manifest.shards.length,
          batchSize: 0,
          fallbackBatches: 0,
          degraded: false,
          vectorHealth: manifest.vectorHealth,
        },
      };
    } catch (error: any) {
      if (signal?.aborted || error.code === 'INDEX_CHANGED') throw error;
      // Eviction/restart is not data loss: rebuild through bounded pages below.
    }
  }
  const snapshots: any[] = [];
  const sql =
    'SELECT c.* FROM chunks c WHERE c.vector IS NOT NULL AND c.scope IN (' +
    scopes.map(() => '?').join(',') +
    ') AND c.document_id IN (' +
    documentEligibilitySQL +
    ')' +
    (documentIds.length
      ? ' AND c.document_id IN (' + documentIds.map(() => '?').join(',') + ')'
      : '') +
    ' AND c.id>? ORDER BY c.id LIMIT ?';
  const batchSize = Math.max(
    1,
    Math.min(4096, Math.floor((16 * 1024 * 1024) / (query.length * 4))),
  );
  let after = '',
    scanned = 0,
    invalid = 0,
    incompatible = 0,
    batches = 0,
    fallback = 0;
  let best: any[] = [];
  for (;;) {
    signal?.throwIfAborted();
    const rows = store.db
      .prepare(sql)
      .all(...scopes, asOf, asOf, ...documentIds, after, batchSize) as any[];
    if (!rows.length) break;
    after = rows.at(-1).id;
    scanned += rows.length;
    batches++;
    const usable = rows.flatMap((r) => {
      const v = vectorRecord(r.vector);
      if (!v) {
        invalid++;
        return [];
      }
      if (v.model !== fingerprint || v.values.length !== query.length) {
        incompatible++;
        return [];
      }
      return [{ ...r, v }];
    });
    let hits: { id: string; score: number }[];
    if (external?.enabled && usable.length) {
      try {
        const found = await externalVectorSearch(
          external,
          usable.map((r) => ({ id: r.id, values: r.v.values })),
          query,
          signal,
        );
        hits = found.result;
        snapshots.push(...found.snapshots);
      } catch (e) {
        if (signal?.aborted) throw e;
        fallback++;
        hits = usable.map((r) => ({ id: r.id, score: cosine(query, r.v.values) }));
      }
    } else hits = usable.map((r) => ({ id: r.id, score: cosine(query, r.v.values) }));
    const byId = new Map(usable.map((r) => [r.id, r]));
    best.push(
      ...hits.map((hit) => {
        const row = byId.get(hit.id)!;
        const { vector, v, ...rest } = row;
        return { ...rest, score: hit.score };
      }),
    );
    best.sort((a, b) => b.score - a.score);
    best = best.slice(0, 60);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (revision() !== before || docs() !== beforeDocs)
    throw Object.assign(new Error('Knowledge changed during streaming; query again.'), {
      code: 'INDEX_CHANGED',
    });
  if (
    external?.enabled &&
    fallback === 0 &&
    invalid === 0 &&
    incompatible === 0 &&
    snapshots.length === batches
  ) {
    store.put('vector-query-manifest', {
      id: identity,
      shards: snapshots,
      vectorHealth: { scanned, usable: scanned, invalid, incompatible },
      createdAt: Date.now(),
    });
    for (const old of store
      .list<any>('vector-query-manifest')
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(8))
      store.remove('vector-query-manifest', old.id);
  }
  return {
    rows: best,
    diagnostics: {
      backend: external?.enabled ? 'streamed-external' : 'streamed-exact',
      vectorHealthBasis: 'rows_read_this_request',
      vectorInputMode: external?.enabled ? 'bounded_snapshot_upload' : 'exact_scan',
      batches,
      batchSize,
      fallbackBatches: fallback,
      degraded: fallback > 0 || invalid > 0 || incompatible > 0,
      vectorHealth: { scanned, usable: scanned - invalid - incompatible, invalid, incompatible },
    },
  };
}
