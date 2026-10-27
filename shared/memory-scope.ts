import type { Conversation, Memory } from './types.js';
export function conversationMemoryScope(
  c: Pick<Conversation, 'projectId'> &
    Partial<Pick<Conversation, 'id' | 'remoteChatOnly' | 'remoteMemoryOnly'>>,
) {
  return c.remoteChatOnly || c.remoteMemoryOnly
    ? 'chat:' + c.id
    : c.projectId
      ? 'project:' + c.projectId
      : 'user';
}
export function memoryConversation(m: Memory) {
  return m.sourceConversationId || /^chat:(.+)#event:\d+$/.exec(m.source)?.[1];
}
export function memoryReach(m: Memory): 'conversation' | 'scope' {
  if (m.scope.startsWith('chat:')) return 'conversation';
  if (m.recallScope && m.recallScope !== 'auto') return m.recallScope;
  if (m.applicability === 'scope') return 'scope';
  if (m.applicability === 'conversation' || m.applicability === 'uncertain') return 'conversation';
  // Preserve legacy defaults. New extraction independently assesses applicability.
  return m.kind === 'episode' || (m.scope === 'user' && m.kind === 'decision')
    ? 'conversation'
    : 'scope';
}
export function memoryAccessible(m: Memory, conversationId?: string) {
  if (m.scope.startsWith('chat:'))
    return (
      !!conversationId &&
      m.scope === 'chat:' + conversationId &&
      memoryConversation(m) === conversationId
    );
  return (
    memoryReach(m) === 'scope' || (!!conversationId && memoryConversation(m) === conversationId)
  );
}
export function memoryPartition(m: Memory) {
  return memoryReach(m) === 'scope' ? 'scope' : 'conversation:' + (memoryConversation(m) || m.id);
}

export function memoryReachReason(
  m: Memory,
): 'isolated-chat' | 'manual' | 'local' | 'uncertain' | 'shared' | 'legacy' {
  if (m.scope.startsWith('chat:')) return 'isolated-chat';
  if (m.recallScope && m.recallScope !== 'auto') return 'manual';
  if (m.applicability === 'uncertain') return 'uncertain';
  if (memoryReach(m) === 'conversation') return 'local';
  return m.applicability === 'scope' ? 'shared' : 'legacy';
}
