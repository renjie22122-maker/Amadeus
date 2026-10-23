import type { Memory } from './types.js';
export function memoryConversation(m: Memory) {
  return m.sourceConversationId || /^chat:(.+)#event:\d+$/.exec(m.source)?.[1];
}
export function memoryReach(m: Memory): 'conversation' | 'scope' {
  return (
    (m.recallScope !== 'auto' ? m.recallScope : undefined) ||
    (m.applicability === 'conversation' ||
    m.applicability === 'uncertain' ||
    m.kind === 'episode' ||
    (m.scope === 'user' && m.kind === 'decision')
      ? 'conversation'
      : 'scope')
  );
}
export function memoryAccessible(m: Memory, conversationId?: string) {
  return (
    memoryReach(m) === 'scope' || (!!conversationId && memoryConversation(m) === conversationId)
  );
}
export function memoryPartition(m: Memory) {
  return memoryReach(m) === 'scope' ? 'scope' : 'conversation:' + (memoryConversation(m) || m.id);
}

export function memoryReachReason(
  m: Memory,
): 'manual' | 'local' | 'uncertain' | 'shared' | 'legacy' {
  if (m.recallScope && m.recallScope !== 'auto') return 'manual';
  if (m.applicability === 'uncertain') return 'uncertain';
  if (memoryReach(m) === 'conversation') return 'local';
  return m.applicability === 'scope' ? 'shared' : 'legacy';
}
