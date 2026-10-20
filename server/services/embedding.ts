import { QueryCache } from './query-cache.js';
import { createHash } from 'node:crypto';
import { localEncode } from './local-embedding.js';
import type { Settings } from '../../shared/types.js';
import { assert } from '../core/errors.js';
export class Embeddings {
  private queryCache = new QueryCache<number[][]>();
  constructor(private settings: () => Settings['embedding']) {}
  enabled() {
    const s = this.settings();
    return s.backend === 'local' || !!(s.baseUrl && s.model);
  }
  fingerprint() {
    const s = this.settings();
    return s.backend === 'local'
      ? 'local#Xenova/multilingual-e5-small@0b7ea4d6ad2e9d527e013a65b805a4b4df72f648:q8:mean'
      : s.baseUrl.replace(/\/$/, '') + '#' + s.model;
  }
  recoveryRevision() {
    const s = this.settings();
    // Persist only a digest; credentials are never returned in diagnostics.
    return createHash('sha256')
      .update(JSON.stringify([this.fingerprint(), s.apiKey]))
      .digest('hex');
  }
  async encode(
    texts: string[],
    signal?: AbortSignal,
    purpose: 'query' | 'passage' = 'passage',
  ): Promise<number[][]> {
    if (purpose === 'query' && texts.length === 1 && texts[0].length <= 16000) {
      const settings = this.settings();
      const revision = JSON.stringify(settings);
      const key = createHash('sha256')
        .update(JSON.stringify([settings, texts, purpose]))
        .digest('hex');
      return this.queryCache.get(
        key,
        async (shared) => {
          const result = await this.encodeUncached(texts, shared, purpose);
          assert(
            JSON.stringify(this.settings()) === revision,
            'EMBEDDING_CHANGED',
            'Embedding settings changed during query.',
          );
          return result;
        },
        signal,
      );
    }
    return this.encodeUncached(texts, signal, purpose);
  }
  private async encodeUncached(
    texts: string[],
    signal?: AbortSignal,
    purpose: 'query' | 'passage' = 'passage',
  ): Promise<number[][]> {
    signal?.throwIfAborted();
    const s = this.settings();
    if (s.backend === 'local') return localEncode(texts, purpose, signal);
    assert(this.enabled(), 'EMBEDDING_DISABLED', 'Configure an embedding connection first.');
    const u = new URL(s.baseUrl);
    assert(
      u.protocol === 'https:' ||
        (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)),
      'EMBEDDING_ENDPOINT',
      'Use HTTPS or a local embedding endpoint.',
    );
    assert(
      !u.username && !u.password && !u.search && !u.hash,
      'EMBEDDING_ENDPOINT',
      'Embedding URL cannot contain embedded credentials.',
    );
    const base = s.baseUrl.replace(/\/$/, '');
    const response = await fetch(base.endsWith('/embeddings') ? base : base + '/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(s.apiKey ? { Authorization: 'Bearer ' + s.apiKey } : {}),
      },
      body: JSON.stringify({
        model: s.model,
        input: /^intfloat\/multilingual-e5-(small|base|large)$/.test(s.model)
          ? texts.map((text) => (purpose === 'query' ? 'query: ' : 'passage: ') + text)
          : texts,
      }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
        : AbortSignal.timeout(60000),
    });
    assert(response.ok, 'EMBEDDING_FAILED', 'Embedding endpoint returned HTTP ' + response.status);
    const data = (await response.json()) as any;
    assert(
      Array.isArray(data.data) && data.data.length === texts.length,
      'EMBEDDING_SHAPE',
      'Invalid embedding result count.',
    );
    const vectors = data.data
      .sort((a: any, b: any) => a.index - b.index)
      .map((x: any) => x.embedding);
    const dimension = vectors[0]?.length;
    assert(
      dimension > 0 &&
        dimension <= 16384 &&
        vectors.every(
          (v: any) =>
            Array.isArray(v) &&
            v.length === dimension &&
            v.every((n: any) => typeof n === 'number' && Number.isFinite(n)),
        ),
      'EMBEDDING_SHAPE',
      'Invalid embedding vectors.',
    );
    return vectors;
  }
}
export function cosine(a: number[], b: number[]) {
  if (a.length !== b.length) return 0;
  let dot = 0,
    aa = 0,
    bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}
