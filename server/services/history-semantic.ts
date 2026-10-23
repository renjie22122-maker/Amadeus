import { boundedReview } from './review-policy.js';
import { createHash } from 'node:crypto';
import type { Store } from '../storage/store.js';
import { Embeddings, cosine } from './embedding.js';
import { validVector } from './vector-record.js';
import { historyConversations, historySource, searchHistory } from './conversation-history.js';
import { conversationMemoryScope } from '../../shared/memory-scope.js';

type Vector = {
  id: string;
  conversationId: string;
  scope: string;
  eventId: number;
  offset: number;
  revision: string;
  model: string;
  vector: number[];
  passageKey: string;
  layout: string;
};
const layout = 'utf8-400-80-v1';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const revision = (s: { text: string; speaker: string }) =>
  hash(JSON.stringify([s.text, s.speaker]));
/** Conservative byte windows avoid silently truncating dense multilingual text in small encoders. */
export function historyPassages(text: string) {
  const parts: { offset: number; text: string }[] = [];
  let offset = 0;
  while (offset < text.length) {
    let end = offset,
      bytes = 0;
    const positions: { offset: number; bytes: number }[] = [];
    for (const char of text.slice(offset)) {
      const size = Buffer.byteLength(char, 'utf8');
      if (bytes + size > 400) break;
      positions.push({ offset: end, bytes: size });
      bytes += size;
      end += char.length;
    }
    parts.push({ offset, text: text.slice(offset, end) });
    if (end === text.length) break;
    let overlap = 0,
      next = end;
    for (const p of positions.reverse()) {
      if (overlap + p.bytes > 80) break;
      overlap += p.bytes;
      next = p.offset;
    }
    offset = Math.max(offset + 1, next);
  }
  return parts;
}
// One passage batch at a time per store; concurrent conversations cannot duplicate indexing.
const busy = new WeakSet<Store>();
export class HistorySemantic {
  constructor(
    private store: Store,
    private embedding: Pick<Embeddings, 'enabled' | 'fingerprint' | 'encode'>,
  ) {}
  async search(
    callerId: string,
    query: string,
    signal: AbortSignal,
    before = Number.MAX_SAFE_INTEGER,
    limit = 8,
  ) {
    signal.throwIfAborted();
    const lexical = () => searchHistory(this.store, callerId, query, before, limit);
    if (!this.embedding.enabled())
      return { ...lexical(), method: 'lexical', semantic: { status: 'disabled', indexed: 0 } };
    const model = this.embedding.fingerprint();
    const allowed = () => new Map(historyConversations(this.store, callerId).map((c) => [c.id, c]));
    let authorized = allowed();
    const current = (v: Vector) => {
      const c = authorized.get(v.conversationId);
      if (
        !c ||
        conversationMemoryScope(c) !== v.scope ||
        this.embedding.fingerprint() !== model ||
        !this.embedding.enabled()
      )
        return;
      const s = historySource(this.store, c, v.eventId);
      return s && revision(s) === v.revision ? s : undefined;
    };
    let indexed = 0,
      reused = 0,
      pending = 0,
      status = 'ready';
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(12000)]);
    try {
      if (!busy.has(this.store)) {
        busy.add(this.store);
        let work: Promise<number[][]> | undefined;
        try {
          const candidates = [...allowed().values()]
            .flatMap((c) =>
              (
                this.store.db
                  .prepare(
                    "SELECT id FROM events WHERE conversation_id=? AND id<? AND type IN ('user.message','assistant.message','chat.memory-source') ORDER BY id DESC LIMIT 201",
                  )
                  .all(c.id, before) as { id: number }[]
              ).map((r) => ({ c, eventId: r.id })),
            )
            .sort((a, b) => b.eventId - a.eventId)
            .slice(0, 200);
          const batch: { record: Vector; text: string }[] = [];
          for (const { c, eventId } of candidates) {
            const s = historySource(this.store, c, eventId);
            if (!s) continue;
            const rev = revision(s),
              scope = conversationMemoryScope(c);
            for (const { offset, text } of historyPassages(s.text)) {
              const id = hash(JSON.stringify([layout, model, scope, c.id, eventId, offset, rev]));
              const old = this.store.maybe<Vector>('history-vector', id);
              if (old && validVector(old.vector)) continue;
              const passageKey = hash(JSON.stringify([model, scope, c.id, text]));
              const record = {
                id,
                conversationId: c.id,
                scope,
                eventId,
                offset,
                revision: rev,
                model,
                passageKey,
                layout,
                vector: [] as number[],
              };
              const cached = this.store.maybe<{ id: string; vector: number[] }>(
                'history-passage-vector',
                passageKey,
              );
              if (cached && validVector(cached.vector) && current(record)) {
                this.store.put('history-vector', { ...record, vector: cached.vector });
                reused++;
                continue;
              }
              pending++;
              if (batch.length < 8)
                batch.push({
                  text,
                  record,
                });
            }
          }
          if (batch.length) {
            const unique = [...new Map(batch.map((b) => [b.record.passageKey, b])).values()];
            work = this.embedding.encode(
              unique.map((b) => b.text),
              deadline,
              'passage',
            );
            const vectors = await boundedReview(work, deadline);
            deadline.throwIfAborted();
            if (
              vectors.length !== unique.length ||
              !vectors.every((v) => validVector(v) && v.length === vectors[0].length)
            )
              throw Error('invalid_vectors');
            authorized = allowed();
            this.store.transaction(() => {
              for (let i = 0; i < batch.length; i++)
                if (current(batch[i].record)) {
                  const vector =
                    vectors[
                      unique.findIndex((b) => b.record.passageKey === batch[i].record.passageKey)
                    ];
                  this.store.put('history-passage-vector', {
                    id: batch[i].record.passageKey,
                    vector,
                  });
                  this.store.put('history-vector', { ...batch[i].record, vector });
                  indexed++;
                }
            });
          }
        } finally {
          if (work)
            void work.then(
              () => busy.delete(this.store),
              () => busy.delete(this.store),
            );
          else busy.delete(this.store);
        }
      } else status = 'index_busy';
      const scope = allowed();
      if (!scope.size)
        return {
          ...lexical(),
          method: 'lexical',
          semantic: { status: 'scope_unavailable', indexed },
        };
      // Scope-filter in storage before loading vectors. Old model spaces never mix.
      const vectors = this.store.db
        .prepare(
          `SELECT data FROM records WHERE kind='history-vector' AND json_extract(data,'$.model')=? AND json_extract(data,'$.layout')=? AND json_extract(data,'$.conversationId') IN (${[...scope].map(() => '?').join(',')})`,
        )
        .all(model, layout, ...scope.keys())
        .map((r) => JSON.parse(String(r.data)) as Vector);
      if (!vectors.length)
        return {
          ...lexical(),
          method: 'lexical',
          semantic: { status, indexed, pending: Math.max(0, pending - indexed) },
        };
      if (this.embedding.fingerprint() !== model || !this.embedding.enabled())
        throw Error('embedding_changed');
      const [q] = await boundedReview(this.embedding.encode([query], deadline, 'query'), deadline);
      deadline.throwIfAborted();
      if (!validVector(q)) throw Error('invalid_query_vector');
      const mismatched = vectors.filter((v) => v.vector?.length !== q.length);
      if (mismatched.length) {
        this.store.transaction(() => {
          for (const v of mismatched) {
            this.store.remove('history-vector', v.id);
            if (v.passageKey) this.store.remove('history-passage-vector', v.passageKey);
          }
        });
        status = 'dimension_changed';
        pending += mismatched.length;
      }
      authorized = allowed();
      const compatible = vectors.filter(
        (v) => validVector(v.vector) && v.vector.length === q.length && current(v),
      );
      const semantic = compatible
        .map((v) => ({ v, similarity: cosine(q, v.vector) }))
        .filter((x) => x.similarity >= 0.35)
        .sort((a, b) => b.similarity - a.similarity);
      authorized = allowed();
      const base = lexical();
      const merged = new Map(
        base.results.map((r, i) => [
          r.citation,
          { ...r, score: 1 / (60 + i + 1), channels: ['lexical'] },
        ]),
      );
      let rank = 0;
      for (const { v } of semantic) {
        const s = current(v);
        if (!s) continue;
        const citation = `chat:${v.conversationId}#event:${v.eventId}`;
        // Overlapping chunks of one message count as one vote, never many corroborating sources.
        if (merged.get(citation)?.channels.includes('semantic')) continue;
        const existing = merged.get(citation),
          score = 1 / (60 + ++rank);
        merged.set(
          citation,
          existing
            ? {
                ...existing,
                score: existing.score + score,
                channels: [...existing.channels, 'semantic'],
              }
            : {
                conversationId: v.conversationId,
                eventId: v.eventId,
                speaker: s.speaker,
                at: s.at,
                excerpt:
                  historyPassages(s.text).find((p) => p.offset === v.offset)?.text ||
                  s.text.slice(v.offset, v.offset + 400),
                score,
                channels: ['semantic'],
                citation,
              },
        );
      }
      return {
        ...base,
        results: [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit),
        method: 'hybrid',
        semantic: {
          status,
          indexed,
          reused,
          pending: Math.max(0, pending - indexed),
          compatibleVectors: compatible.length,
        },
        coverage:
          base.coverage +
          ' Semantic retrieval covers only already-indexed eligible passages. Each call indexes at most eight missing passages on this page; continue indexing this page when pending > 0, or use nextBefore for older history. Similarity is not proof of truth.',
      };
    } catch (error) {
      if (signal.aborted) throw error;
      return {
        ...lexical(),
        method: 'lexical',
        semantic: {
          status: deadline.aborted ? 'deadline' : 'unavailable',
          indexed,
          reused,
          pending: Math.max(0, pending - indexed),
        },
        fallback:
          'Semantic indexing/search unavailable; current scoped lexical results remain usable. No automatic retry.',
      };
    }
  }
}
