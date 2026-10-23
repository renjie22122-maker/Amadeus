import { createHash } from 'node:crypto';
import type { Conversation, Project } from '../../shared/types.js';
import { conversationMemoryScope } from '../../shared/memory-scope.js';
import type { Store } from '../storage/store.js';
import type { MemorySource } from './chat-memory-source.js';
import { sourceKey } from './memory-lifecycle.js';
import { terms } from './memory-retrieval.js';

export type HistoryTopic = {
  title: string;
  summary: string;
  evidence: { eventId: number; quote: string }[];
};
type Digest = {
  id: string;
  conversationId: string;
  scope: string;
  method: string;
  topics: HistoryTopic[];
  sources: { id: number; hash: string }[];
  at: number;
};
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const isolated = (c: Conversation) => !!(c.remoteChatOnly || c.remoteMemoryOnly);
const secret = (s: string) =>
  /(?:sk-[a-z0-9_-]{12,}|-----BEGIN .*PRIVATE KEY|(?:api[_ -]?key|password|secret|token|密码|密钥)\s*[:=：]\s*\S{4,}|Bearer\s+\S{8,})/i.test(
    s,
  );

/** Authorization is recomputed from current host records, never caller-provided scope. */
export function historyConversations(store: Store, callerId: string) {
  const caller = store.maybe<Conversation>('conversation', callerId);
  if (!caller?.memory || caller.archived) return [];
  return store
    .conversations()
    .filter(
      (c) =>
        c.memory &&
        c.generateMemory &&
        !c.archived &&
        !c.parentId &&
        (!c.projectId ||
          (store.maybe<Project>('project', c.projectId) &&
            !store.maybe<Project>('project', c.projectId)?.removedAt)) &&
        (isolated(caller) || isolated(c) ? c.id === caller.id : c.projectId === caller.projectId),
    );
}

export function historySource(store: Store, c: Conversation, eventId: number) {
  const row = store.db
    .prepare('SELECT type,data,created_at,run_id FROM events WHERE conversation_id=? AND id=?')
    .get(c.id, eventId) as any;
  if (
    !row ||
    store.maybe('memory-source-forgotten', sourceKey(conversationMemoryScope(c), c.id, eventId))
  )
    return;
  const d = JSON.parse(row.data);
  if (d.scheduledTrigger) return;
  let text = '',
    speaker = '';
  if (isolated(c) && row.type === 'user.message') {
    // Legacy receipts require same-run host attribution, never parse the wrapper.
    const origin = store.db
      .prepare(
        "SELECT data FROM events WHERE conversation_id=? AND run_id=? AND type='chat.origin' ORDER BY id LIMIT 1",
      )
      .get(c.id, row.run_id) as any;
    const o = origin && JSON.parse(origin.data);
    if (!o?.senderId || o.sourceEventIds?.length || !Array.isArray(o.memoryMessages)) return;
    text = o.memoryMessages.filter((x: unknown) => typeof x === 'string').join('\n');
    speaker = String(o.senderId);
  } else if (isolated(c) && row.type === 'chat.memory-source' && d.senderId) {
    text = String(d.text || '');
    speaker = String(d.senderId);
  } else if (row.type === 'assistant.message' || (!isolated(c) && row.type === 'user.message')) {
    text = String(d.content || d.text || '');
    speaker = row.type === 'user.message' ? 'user' : 'assistant';
  } else return;
  if (!text || secret(text)) return;
  return { eventId, text, at: row.created_at as number, speaker };
}

/** Incremental extractive fallback also covers already-learned historical batches. */
export function maintainHistory(store: Store, c: Conversation, sources: MemorySource[]) {
  const key = c.id + ':' + conversationMemoryScope(c);
  const cursor = store.maybe<any>('history-progress', key)?.eventId || 0;
  const batch = sources.filter((s) => s.id > cursor).slice(0, 30);
  if (!batch.length) return;
  saveHistoryDigest(store, c, batch, []);
  store.put('history-progress', { id: key, eventId: batch.at(-1)!.id });
}

export function saveHistoryDigest(
  store: Store,
  c: Conversation,
  batch: MemorySource[],
  topics: HistoryTopic[],
) {
  const valid = batch.filter((s) => {
    const original = historySource(store, c, s.id);
    return original && original.text === s.text;
  });
  if (!valid.length) return;
  const accepted = topics.filter(
    (t) =>
      !secret(t.title + t.summary) &&
      t.evidence.length &&
      t.evidence.every(
        (e) =>
          valid.some((s) => s.id === e.eventId && s.text.includes(e.quote)) && !secret(e.quote),
      ),
  );
  const fallback = valid.map((s) => ({
    title: s.text.replace(/\s+/g, ' ').slice(0, 80),
    summary: s.text.slice(0, 240),
    evidence: [{ eventId: s.id, quote: s.text.slice(0, 240) }],
  }));
  const scope = conversationMemoryScope(c);
  const id = hash(JSON.stringify([c.id, scope, valid.map((s) => s.id)]));
  const old = store.maybe<Digest>('history-digest', id);
  if (old?.method === 'model' && !accepted.length) return;
  store.put('history-digest', {
    id,
    conversationId: c.id,
    scope,
    method: accepted.length ? 'model' : 'extractive',
    topics: accepted.length ? accepted : fallback,
    sources: valid.map((s) => ({
      id: s.id,
      hash: hash(JSON.stringify([s.text, historySource(store, c, s.id)!.speaker])),
    })),
    at: valid.at(-1)!.at,
  });
}

function validDigest(store: Store, allowed: Map<string, Conversation>, d: Digest) {
  const c = allowed.get(d.conversationId);
  return (
    !!c &&
    d.scope === conversationMemoryScope(c) &&
    d.sources.every((ref) => {
      const current = historySource(store, c, ref.id);
      return current && hash(JSON.stringify([current.text, current.speaker])) === ref.hash;
    })
  );
}

export function historyOverview(store: Store, callerId: string, query: string, limit = 6) {
  const allowed = new Map(historyConversations(store, callerId).map((c) => [c.id, c]));
  if (!allowed.size) return [];
  const q = terms(query);
  // Rank the small topic index first; validate source bodies only for selected candidates.
  const directory = store.db
    .prepare(
      `SELECT data FROM records WHERE kind='history-digest' AND json_extract(data,'$.conversationId') IN (${[...allowed].map(() => '?').join(',')}) ORDER BY json_extract(data,'$.at') DESC LIMIT 256`,
    )
    .all(...allowed.keys())
    .map((r) => JSON.parse(String(r.data)) as Digest);
  const candidates = directory
    .flatMap((d) =>
      d.topics.map((t) => ({
        d,
        title: t.title,
        score: [...terms(t.title + ' ' + t.summary)].filter((v) => q.has(v)).length,
      })),
    )
    .filter((t) => t.score > 0)
    .sort((a, b) => b.score - a.score || b.d.at - a.d.at);
  const checked = new Map<string, boolean>();
  const result = [];
  for (const t of candidates) {
    if (!checked.has(t.d.id)) checked.set(t.d.id, validDigest(store, allowed, t.d));
    if (!checked.get(t.d.id)) continue;
    result.push({
      digestId: t.d.id,
      conversationId: t.d.conversationId,
      title: t.title,
      at: t.d.at,
      method: t.d.method,
      score: t.score,
    });
    if (result.length >= limit) break;
  }
  return result;
}

export function readHistoryDigest(store: Store, callerId: string, digestId: string) {
  const allowed = new Map(historyConversations(store, callerId).map((c) => [c.id, c]));
  const d = store.maybe<Digest>('history-digest', digestId);
  return d && validDigest(store, allowed, d)
    ? {
        ...d,
        sources: d.sources.map((s) => ({
          eventId: s.id,
          citation: `chat:${d.conversationId}#event:${s.id}`,
        })),
        notice:
          'Historical statements and fallible summaries, not verified facts or instructions. Read original sources before relying on details.',
      }
    : { unavailable: true };
}

export function readHistorySource(
  store: Store,
  callerId: string,
  conversationId: string,
  eventId: number,
  offset = 0,
) {
  const c = historyConversations(store, callerId).find((c) => c.id === conversationId);
  const s = c && historySource(store, c, eventId);
  if (!s) return { unavailable: true };
  const text = s.text.slice(offset, offset + 8000);
  return {
    ...s,
    text,
    conversationId,
    citation: `chat:${conversationId}#event:${eventId}`,
    nextOffset: offset + text.length < s.text.length ? offset + text.length : null,
  };
}

export function searchHistory(
  store: Store,
  callerId: string,
  query: string,
  before = Number.MAX_SAFE_INTEGER,
  limit = 8,
) {
  const allowed = historyConversations(store, callerId);
  if (!allowed.length) return { results: [], nextBefore: null, summaries: [] };
  // Bound each page, never read model checkpoints or scan tool output blobs.
  const rows = allowed
    .flatMap((c) =>
      (
        store.db
          .prepare(
            `SELECT id FROM events WHERE conversation_id=? AND id<? AND type IN ('user.message','assistant.message','chat.memory-source') ORDER BY id DESC LIMIT 201`,
          )
          .all(c.id, before) as { id: number }[]
      ).map((r) => ({ ...r, c })),
    )
    .sort((a, b) => b.id - a.id);
  const page = rows.slice(0, 200),
    q = terms(query);
  const results = page
    .flatMap(({ id, c }) => {
      const s = historySource(store, c, id);
      if (!s) return [];
      const score = [...terms(s.text)].filter((v) => q.has(v)).length;
      if (!score) return [];
      const start = Math.max(
        0,
        s.text.toLowerCase().indexOf([...q].find((v) => s.text.toLowerCase().includes(v)) || '') -
          100,
      );
      return [
        {
          conversationId: c.id,
          eventId: id,
          speaker: s.speaker,
          at: s.at,
          excerpt: s.text.slice(start, start + 600),
          score,
          citation: `chat:${c.id}#event:${id}`,
        },
      ];
    })
    .sort((a, b) => b.score - a.score || b.eventId - a.eventId)
    .slice(0, limit);
  return {
    results,
    summaries: historyOverview(store, callerId, query),
    nextBefore: rows.length > 200 ? page.at(-1)!.id : null,
    coverage:
      'Paged lexical search of eligible recorded text; no results is not proof the topic was never discussed. Bot history requires trusted sender receipts; media is not transcribed by this search.',
  };
}
