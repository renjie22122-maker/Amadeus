import { chatMemorySource } from './chat-memory-source.js';
import type { Memory } from '../../shared/types.js';
import type { Store } from '../storage/store.js';
/** Semantic intent is assessed by the model; the host verifies provenance and isolation. */
export function sharedChatMemorySupported(store: Store, memory: Memory) {
  if (
    !memory.scope.startsWith('chat:') ||
    !memory.chatSubject ||
    memory.chatSubject === 'participant'
  )
    return true;
  // A provisional suggestion is not an adopted setting. No member-count or owner gate.
  if (!memory.basis || memory.basis === 'proposal') return false;
  const conversationId = memory.scope.slice(5);
  return (memory.evidence || []).some((e) => {
    if (e.conversationId !== conversationId || !e.quote?.trim()) return false;
    const source = chatMemorySource(store, conversationId, e.eventId);
    return !!source?.sender && source.text.includes(e.quote);
  });
}
