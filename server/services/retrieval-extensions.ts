import { QueryCache } from './query-cache.js';
const rerankCache = new QueryCache<any>();
import { terms } from './memory-retrieval.js';
import { createHash } from 'node:crypto';
import {
  retrievalTarget,
  type RetrievalConnection,
  type RetrievalSettings,
} from '../../shared/retrieval.js';
import { assert } from '../core/errors.js';

export async function retrievalPost(
  kind: 'vectors' | 'rerank' | 'lightRag',
  c: RetrievalConnection,
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<any> {
  assert(
    c.enabled && c.authorizedTarget === retrievalTarget(kind, c),
    'RETRIEVAL_CONSENT',
    'Enable this retrieval connection and authorize its exact target in Settings.',
  );
  const url = new URL(c.baseUrl);
  assert(
    !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))),
    'RETRIEVAL_ENDPOINT',
    'Use HTTPS or a loopback HTTP endpoint without URL credentials.',
  );
  const perform = async (signal?: AbortSignal) => {
    const response = await fetch(c.baseUrl.replace(/\/$/, '') + path, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        ...(c.apiKey
          ? kind === 'lightRag'
            ? { 'X-API-Key': c.apiKey }
            : { Authorization: 'Bearer ' + c.apiKey }
          : {}),
      },
      body: JSON.stringify(body),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
        : AbortSignal.timeout(60000),
    });
    assert(response.ok, 'RETRIEVAL_SERVICE', 'Retrieval service returned HTTP ' + response.status);
    // Bound response memory and avoid returning remote exception bodies or credentials.
    const reader = response.body?.getReader();
    assert(reader, 'RETRIEVAL_RESPONSE', 'Missing retrieval response.');
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        size += r.value.length;
        assert(size <= 8 * 1024 * 1024, 'RETRIEVAL_RESPONSE', 'Retrieval response exceeds 8 MiB.');
        parts.push(r.value);
      }
    } finally {
      void reader.cancel().catch(() => {});
    }
    const result = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (kind === 'rerank') {
      assert(
        Array.isArray(result) &&
          result.length <= 60 &&
          result.length === (body as any)?.texts?.length &&
          new Set(result.map((r) => r.index)).size === result.length &&
          result.every(
            (r) =>
              Number.isInteger(r.index) &&
              r.index >= 0 &&
              r.index < result.length &&
              Number.isFinite(r.score),
          ),
        'RERANK_RESPONSE',
        'Invalid reranker scores.',
      );
      return result.map((r) => ({ index: r.index, score: r.score }));
    }
    return result;
  };
  if (kind === 'rerank' && path === '/rerank') {
    const key = createHash('sha256')
      .update(JSON.stringify([c, body]))
      .digest('hex');
    return rerankCache.get(key, perform, signal);
  }
  return perform(signal);
}

// Bound each wire payload; total corpus size is not a request-size limit.
export async function externalVectorSearch(
  c: NonNullable<RetrievalSettings['vectors']>,
  rows: { id: string; values: number[] }[],
  query: number[],
  signal?: AbortSignal,
) {
  assert(
    query.length > 0 && query.length <= 16384,
    'VECTOR_DIMENSIONS',
    'Invalid query dimensions.',
  );
  const size = Math.min(200000, Math.floor((16 * 1024 * 1024) / (query.length * 4)));
  const hits: { id: string; score: number }[] = [];
  const snapshots: { generation: string; ids: string[] }[] = [];
  const indexes = new Set<string>(),
    reasons = new Set<string>();
  for (let offset = 0; offset < rows.length; offset += size) {
    signal?.throwIfAborted();
    const part = await vectorShardSearch(c, rows.slice(offset, offset + size), query, signal);
    if (part.snapshotCached)
      snapshots.push({
        generation: part.generation,
        ids: rows.slice(offset, offset + size).map((r) => r.id),
      });
    hits.push(...part.result);
    indexes.add(part.effectiveIndex);
    if (part.fallbackReason) reasons.add(part.fallbackReason);
    hits.sort((a, b) => b.score - a.score);
    hits.splice(60);
  }
  return {
    result: hits,
    backend: c.backend,
    effectiveIndex: [...indexes].join(','),
    fallbackReason: [...reasons].join('; ') || null,
    snapshots,
    shards: Math.ceil(rows.length / size),
  };
}
const uploadedShards = new Set<string>();
async function vectorShardSearch(
  c: NonNullable<RetrievalSettings['vectors']>,
  rows: { id: string; values: number[] }[],
  query: number[],
  signal?: AbortSignal,
) {
  const supported = c.backend === 'qdrant' ? ['hnsw'] : ['flat', 'hnsw', 'ivf-flat', 'ivf-pq'];
  assert(
    supported.includes(c.index),
    'VECTOR_INDEX',
    'Selected backend does not support this index.',
  );
  const dimensions = query.length;
  assert(
    dimensions > 0 && dimensions <= 16384 && rows.length > 0 && rows.length <= 200000,
    'VECTOR_SIZE',
    'Invalid vector dimensions or row count.',
  );
  assert(
    rows.length * dimensions * 4 <= 80 * 1024 * 1024,
    'VECTOR_SIZE',
    'Vector snapshot exceeds 80 MiB float32 payload; use a smaller eligible scope.',
  );
  const packed = Buffer.alloc(rows.length * dimensions * 4);
  rows.forEach((r, i) => {
    assert(
      r.values.length === dimensions && r.values.every(Number.isFinite),
      'VECTOR_DIMENSIONS',
      'Incompatible vectors.',
    );
    r.values.forEach((v, j) => packed.writeFloatLE(v, (i * dimensions + j) * 4));
  });
  assert(query.every(Number.isFinite), 'VECTOR_DIMENSIONS', 'Invalid query vector.');
  const vectorIds = rows.map((r) => r.id);
  const generation = createHash('sha256')
    .update(packed)
    .update(JSON.stringify(vectorIds))
    .digest('hex');
  const key = retrievalTarget('vectors', c) + '|' + generation;
  let result: any;
  if (uploadedShards.has(key)) {
    try {
      result = await retrievalPost(
        'vectors',
        c,
        '/vectors/search',
        {
          backend: c.backend,
          index: c.index,
          generation,
          query,
          limit: 60,
          cachedOnly: true,
        },
        signal,
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      // Older sidecars may not support cache probes; the bounded legacy request still works.
    }
  }
  if (!result || result.cacheMiss) {
    result = await retrievalPost(
      'vectors',
      c,
      '/vectors/search',
      {
        backend: c.backend,
        index: c.index,
        generation,
        ids: vectorIds,
        dimensions,
        vectorsBase64: packed.toString('base64'),
        query,
        limit: 60,
      },
      signal,
    );
  }
  const ids = new Set(rows.map((r) => r.id)),
    seen = new Set<string>();
  assert(
    Array.isArray(result.result) && result.result.length <= 60,
    'VECTOR_RESPONSE',
    'Invalid vector response.',
  );
  for (const r of result.result) {
    assert(
      ids.has(r.id) && !seen.has(r.id) && Number.isFinite(r.score),
      'VECTOR_RESPONSE',
      'Foreign, repeated or invalid vector hit.',
    );
    seen.add(r.id);
  }
  if (result.snapshotCached) {
    uploadedShards.add(key);
    if (uploadedShards.size > 256) uploadedShards.delete(uploadedShards.values().next().value!);
  }
  return {
    generation,
    snapshotCached: !!result.snapshotCached,
    result: result.result as { id: string; score: number }[],
    backend: c.backend,
    effectiveIndex: String(result.effectiveIndex || c.index).slice(0, 80),
    fallbackReason: result.fallbackReason ? String(result.fallbackReason).slice(0, 160) : null,
  };
}

export async function rerankCandidates(
  c: NonNullable<RetrievalSettings['rerank']>,
  query: string,
  rows: any[],
  signal?: AbortSignal,
) {
  const pool = rows.slice(0, c.candidates ?? 40);
  if (!pool.length) return [];
  const passages = pool.flatMap((row, index) =>
    candidatePassages(row.text, query).map((p) => ({ ...p, index })),
  );
  const best = new Map<number, { index: number; score: number; passage: any }>();
  for (let offset = 0; offset < passages.length; offset += 30) {
    const batch = passages.slice(offset, offset + 30);
    const scored = await retrievalPost(
      'rerank',
      c,
      '/rerank',
      { query, texts: batch.map((p) => p.text), raw_scores: false, return_text: false },
      signal,
    );
    assert(
      Array.isArray(scored) && scored.length === batch.length,
      'RERANK_RESPONSE',
      'Reranker must score every candidate.',
    );
    const seen = new Set<number>();
    for (const row of scored) {
      assert(
        Number.isInteger(row.index) &&
          row.index >= 0 &&
          row.index < batch.length &&
          !seen.has(row.index) &&
          Number.isFinite(row.score),
        'RERANK_RESPONSE',
        'Invalid or duplicate reranker result.',
      );
      seen.add(row.index);
      const p = batch[row.index],
        old = best.get(p.index);
      if (!old || row.score > old.score)
        best.set(p.index, { index: p.index, score: row.score, passage: p });
    }
  }
  const result = [...best.values()];
  const eligible = result
    .sort((a, b) => b.score - a.score)
    .filter((r) => c.minScore == null || r.score >= c.minScore);
  const selection = adaptiveCutoff(eligible);
  return selection.kept.map((r) => ({
    ...pool[r.index],
    rerankScore: r.score,
    relevantPassage: {
      text: r.passage.text,
      start: r.passage.start,
      end: r.passage.end,
      partial: r.passage.partial,
    },
    ranking: {
      ...pool[r.index].ranking,
      semanticReranker: c.model,
      rerankCandidates: pool.length,
      threshold: c.minScore ?? null,
      relevanceCalibrated: false,
      cutoff: {
        method: selection.method,
        before: eligible.length,
        after: selection.kept.length,
        deferred: selection.deferred.map((x) => ({ chunkId: pool[x.index].id, score: x.score })),
        notice:
          'Relative separation is not proof of relevance. Deferred evidence remains searchable.',
      },
    },
  }));
}

// Conservative score-gap heuristic for sigmoid scores, not probability calibration.
// Flat/short lists keep their evidence; always retain at least two complementary passages.
export function adaptiveCutoff<T extends { score: number }>(rows: T[]) {
  if (rows.length < 4 || rows.some((r) => r.score < 0 || r.score > 1))
    return { kept: rows, deferred: [] as T[], method: 'retain-uncertain' };
  const gaps = rows.slice(0, -1).map((r, i) => r.score - rows[i + 1].score);
  const baseline = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
  const boundary = gaps.findIndex(
    (gap, i) => i >= 1 && gap >= 0.15 && gap > 4 * Math.max(baseline, 0.01),
  );
  if (boundary < 0) return { kept: rows, deferred: [] as T[], method: 'retain-uncertain' };
  return {
    kept: rows.slice(0, boundary + 1),
    deferred: rows.slice(boundary + 1),
    method: 'relative-gap',
  };
}

// Query-local windows for legacy large chunks; original citations and text stay intact.
export function candidatePassages(text: string, query: string) {
  if (text.length <= 600) return [{ text, start: 0, end: text.length, partial: false }];
  const q = terms(query),
    windows = [];
  for (let start = 0; start < text.length; start += 480) {
    const value = text.slice(start, start + 600),
      tokens = terms(value);
    windows.push({
      text: value,
      start,
      end: start + value.length,
      partial: true,
      score: [...q].filter((t) => tokens.has(t)).length,
    });
  }
  return windows.sort((a, b) => b.score - a.score || a.start - b.start).slice(0, 3);
}
