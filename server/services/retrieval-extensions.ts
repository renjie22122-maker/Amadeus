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
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}

export async function externalVectorSearch(
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
  const result = await retrievalPost(
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
      limit: 30,
    },
    signal,
  );
  const ids = new Set(rows.map((r) => r.id)),
    seen = new Set<string>();
  assert(
    Array.isArray(result.result) && result.result.length <= 30,
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
  return {
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
  const pool = rows.slice(0, c.candidates ?? 20);
  if (!pool.length) return [];
  // TEI serves a configured cross-encoder; model is a declared configuration identity, not a request-time selector.
  const result = await retrievalPost(
    'rerank',
    c,
    '/rerank',
    { query, texts: pool.map((r) => r.text), raw_scores: false, return_text: false },
    signal,
  );
  assert(
    Array.isArray(result) && result.length === pool.length,
    'RERANK_RESPONSE',
    'Reranker must score every candidate.',
  );
  const seen = new Set<number>();
  for (const r of result) {
    assert(
      Number.isInteger(r.index) &&
        r.index >= 0 &&
        r.index < pool.length &&
        !seen.has(r.index) &&
        Number.isFinite(r.score),
      'RERANK_RESPONSE',
      'Invalid or duplicate reranker result.',
    );
    seen.add(r.index);
  }
  return result
    .sort((a, b) => b.score - a.score)
    .filter((r) => c.minScore == null || r.score >= c.minScore)
    .map((r) => ({
      ...pool[r.index],
      rerankScore: r.score,
      ranking: {
        ...pool[r.index].ranking,
        semanticReranker: c.model,
        rerankCandidates: pool.length,
        threshold: c.minScore ?? null,
        relevanceCalibrated: false,
      },
    }));
}
