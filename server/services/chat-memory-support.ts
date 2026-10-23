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
  const sources = store.events(conversationId, 0, 'user.message');
  const origins = store.events(conversationId, 0, 'chat.origin');
  return (memory.evidence || []).some((evidence) => {
    if (evidence.conversationId !== conversationId || !evidence.quote?.trim()) return false;
    const source = sources.find((e) => e.id === evidence.eventId);
    const origin = source && origins.find((e) => e.runId === source.runId)?.data;
    return (
      !!origin?.senderId &&
      (origin.memoryMessages || []).some((text: string) => text.includes(evidence.quote!))
    );
  });
}
