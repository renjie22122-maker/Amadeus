import { validVector } from './vector-record.js';
import { AppError } from '../core/errors.js';
import { memoryActivity } from './memory-activity.js';
import {
  conversationMemoryScope,
  memoryAccessible,
  memoryConversation,
} from '../../shared/memory-scope.js';
import { memoryValid, MemoryLifecycle } from './memory-lifecycle.js';
import { createHash } from 'node:crypto';
import type { Conversation, Memory } from '../../shared/types.js';
import { Store } from '../storage/store.js';
import { Embeddings, cosine } from './embedding.js';
import { recallMemories } from './memory-retrieval.js';
const hash = (m: Memory) =>
  createHash('sha256')
    .update(JSON.stringify([m.content, m.revision, m.scope]))
    .digest('hex');
export class MemoryIndex {
  constructor(
    private store: Store,
    private embeddings: Embeddings,
  ) {}
  private storedVector(key: string) {
    try {
      return this.store.maybe<any>('memory-vector', key);
    } catch (error) {
      if (error instanceof AppError && error.code === 'RECORD_CORRUPT') return { values: null };
      throw error;
    }
  }
  // Explicit user action only: inactive candidates never leave the machine for embedding.
  async index(scope?: string, allowed: () => boolean = () => true) {
    const fingerprint = this.embeddings.fingerprint();
    let indexed = 0;
    for (const m of this.store
      .list<Memory>('memory')
      .filter(
        (m) =>
          (!scope || m.scope === scope) &&
          memoryValid(m) &&
          new MemoryLifecycle(this.store).evidenceValid(m),
      )) {
      const existing = this.storedVector(m.id);
      if (
        existing?.hash === hash(m) &&
        existing?.model === fingerprint &&
        validVector(existing.values)
      )
        continue;
      if (!allowed() || this.embeddings.fingerprint() !== fingerprint) break;
      const [values] = await this.embeddings.encode([m.content]);
      const current = this.store.maybe<Memory>('memory', m.id);
      if (
        allowed() &&
        current &&
        memoryValid(current) &&
        new MemoryLifecycle(this.store).evidenceValid(current) &&
        hash(current) === hash(m) &&
        this.embeddings.fingerprint() === fingerprint
      ) {
        this.store.put('memory-vector', { id: m.id, hash: hash(m), model: fingerprint, values });
        indexed++;
      }
    }
    return { indexed, model: fingerprint };
  }
  async recall(
    query: string,
    projectId: string | null,
    signal: AbortSignal,
    includeUserMemory = true,
    asOf = Date.now(),
    conversationId?: string,
  ) {
    const conversation = conversationId
      ? this.store.maybe<Conversation>('conversation', conversationId)
      : undefined;
    const isolatedScope =
      conversation && (conversation.remoteChatOnly || conversation.remoteMemoryOnly)
        ? conversationMemoryScope(conversation)
        : undefined;
    const domainAllowed = (m: Memory) => {
      if (isolatedScope) return m.scope === isolatedScope;
      const origin = memoryConversation(m);
      const source = origin ? this.store.maybe<Conversation>('conversation', origin) : undefined;
      return !m.scope.startsWith('chat:') && !source?.remoteChatOnly && !source?.remoteMemoryOnly;
    };
    const memories = this.store
        .list<Memory>('memory')
        .filter(
          (m) =>
            domainAllowed(m) &&
            (includeUserMemory || m.scope !== 'user') &&
            memoryAccessible(m, conversationId) &&
            new MemoryLifecycle(this.store).evidenceValid(m),
        ),
      scores = new Map<string, number>();
    const eligible = memories.filter(
      (m) =>
        memoryValid(m, asOf) &&
        (isolatedScope
          ? m.scope === isolatedScope
          : m.scope === 'user' || (!!projectId && m.scope === 'project:' + projectId)),
    );
    let invalidVectors = 0;
    const vectors = eligible
      .map((m) => ({ m, v: this.storedVector(m.id) }))
      .filter(({ m, v }) => {
        if (v && !validVector(v.values)) {
          invalidVectors++;
          return false;
        }
        return v?.hash === hash(m) && v.model === this.embeddings.fingerprint();
      });
    let method = 'scoped-lexical',
      fallback: string | undefined;
    if (this.embeddings.enabled() && vectors.length) {
      try {
        const [q] = await this.embeddings.encode([query], signal, 'query');
        for (const { m, v } of vectors) {
          if (!validVector(v.values, q.length)) {
            invalidVectors++;
            continue;
          }
          const score = cosine(q, v.values);
          if (score >= 0.35) scores.set(m.id, score);
        }
        method = 'scoped-hybrid';
      } catch (error) {
        if (signal.aborted) throw error;
        fallback = 'Embedding unavailable; lexical recall used.';
      }
    }
    // Re-read scope/activation after any remote request; concurrent deletion or edits must win.
    const current = this.store
      .list<Memory>('memory')
      .filter(
        (m) =>
          domainAllowed(m) &&
          (includeUserMemory || m.scope !== 'user') &&
          memoryAccessible(m, conversationId) &&
          new MemoryLifecycle(this.store).evidenceValid(m),
      );
    for (const m of memories)
      if (!current.some((c) => c.id === m.id && hash(c) === hash(m))) scores.delete(m.id);
    return {
      memories: recallMemories(
        current,
        query,
        projectId,
        asOf,
        scores,
        conversationId,
        memoryActivity(this.store, current, asOf),
        isolatedScope,
      ),
      method,
      fallback,
      invalidVectors,
    };
  }
}
