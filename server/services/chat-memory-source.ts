import { chatSenderAllowed } from './chat-access.js';
import { createHash } from 'node:crypto';
import type { Store } from '../storage/store.js';
import type { Conversation } from '../../shared/types.js';
import type { ChatConnection, ChatIncoming } from '../../shared/chat-connections.js';
export type MemorySource = {
  id: number;
  at: number;
  text: string;
  sender?: string;
  peerType?: string;
  evidenceRole?: 'verified-tool';
  experienceOutcome?: 'success' | 'failure';
};
/** Only host-created receipts/origins establish authorship; never parse prompt wrappers. */
export function chatMemorySources(store: Store, conversationId: string): MemorySource[] {
  const raw = store
    .events(conversationId, 0, 'chat.memory-source')
    .filter((e) => e.data.senderId && typeof e.data.text === 'string');
  const origins = new Map(
    store
      .events(conversationId, 0, 'chat.origin')
      .filter(
        (e) =>
          e.data.senderId && !e.data.sourceEventIds?.length && Array.isArray(e.data.memoryMessages),
      )
      .map((e) => [e.runId, e.data]),
  );
  // Modern source receipts already contain authorship. Do not decode old, often huge
  // prompt envelopes unless a legacy origin actually needs its message event ID.
  const legacyEvents = [...origins.keys()].flatMap((runId) =>
    runId ? store.eventsForRun(runId, ['user.message']) : [],
  );
  const legacy = legacyEvents
    .filter((e) => e.conversationId === conversationId)
    .flatMap((e) => {
      const o = origins.get(e.runId);
      if (
        e.data.scheduledTrigger ||
        !o?.senderId ||
        o.sourceEventIds?.length ||
        !Array.isArray(o.memoryMessages)
      )
        return [];
      return [
        {
          id: e.id,
          at: e.createdAt,
          text: o.memoryMessages.filter((x: unknown) => typeof x === 'string').join('\n'),
          sender: String(o.senderId),
          peerType: o.peerType,
        },
      ];
    });
  return [
    ...legacy,
    ...raw.map((e) => ({
      id: e.id,
      at: e.data.receivedAt || e.createdAt,
      text: e.data.text as string,
      sender: String(e.data.senderId),
      peerType: e.data.peerType,
    })),
  ].sort((a, b) => a.id - b.id);
}
export function recordChatMemorySource(store: Store, c: ChatConnection, m: ChatIncoming) {
  const conversation = store.maybe<Conversation>('conversation', c.conversationId);
  if (
    !c.enabled ||
    !chatSenderAllowed(c, m) ||
    (c.peerType === 'group' &&
      !c.groupContext &&
      !m.addressed &&
      !m.text.startsWith((c.groupPrefix || '/amadeus') + ' ')) ||
    !conversation?.generateMemory ||
    !(conversation.remoteChatOnly || conversation.remoteMemoryOnly) ||
    !m.senderId ||
    m.senderId === c.accountId ||
    m.peerId !== c.peerId ||
    (c.peerType !== 'group' && m.senderId !== c.senderId) ||
    (m.textOrigin && m.textOrigin !== 'user') ||
    !m.text?.trim() ||
    m.text.trim().startsWith('/') ||
    /^(?:Please inspect the attached media|\[Media |\[Bot mentioned)/.test(m.text)
  )
    return;
  const key = createHash('sha256')
    .update(c.id + '\0' + m.id)
    .digest('hex');
  const old = store.maybe<any>('chat-memory-receipt', key);
  if (old) return old.eventId as number;
  return store.transaction(() => {
    const e = store.event(c.conversationId, null, 'chat.memory-source', {
      connectionId: c.id,
      transport: c.transport,
      accountId: c.accountId,
      messageId: m.id,
      senderId: m.senderId,
      peerId: m.peerId,
      peerType: c.peerType || 'private',
      text: m.text,
      receivedAt: m.timestamp,
    });
    store.put('chat-memory-receipt', { id: key, conversationId: c.conversationId, eventId: e.id });
    return e.id;
  });
}
export function backfillChatMemorySources(store: Store, conversationId: string) {
  if (
    !store.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_received'")
      .get()
  )
    return;
  const sources = chatMemorySources(store, conversationId);
  for (const c of store
    .list<ChatConnection>('chat-connection')
    .filter((c) => c.conversationId === conversationId)) {
    const rows = store.db
      .prepare('SELECT payload,sender_id FROM chat_received WHERE connection_id=? ORDER BY at')
      .all(c.id) as any[];
    for (const row of rows) {
      try {
        const m: ChatIncoming = JSON.parse(row.payload);
        if (
          m.senderId !== row.sender_id ||
          sources.some((s) => s.sender === m.senderId && s.text === m.text)
        )
          continue;
        recordChatMemorySource(store, c, m);
      } catch {
        /* Bad legacy receipts do not authorize guessing a speaker. */
      }
    }
  }
}
