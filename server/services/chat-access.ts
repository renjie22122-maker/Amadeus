import type { ChatConnection, ChatIncoming } from '../../shared/chat-connections.js';
import type { Conversation } from '../../shared/types.js';
// Explicit capabilities, not effect=read (which can include private files and credentials).
export const socialChatTools = new Set([
  'inspect_schedules',
  'schedule_followup',
  'pause_scheduled_followup',
  'report_scheduled_result',
  'recall_memories',
  'search_conversation_history',
  'read_history_summary',
  'read_history_source',
  'search_memory_graph',
  'inspect_chat',
  'list_chat_members',
  'read_chat_media',
  'read_chat_message',
  'inspect_knowledge_status',
  'prepare_chat_reply',
  'retract_chat_message',
  'search_tools',
  'web_search',
  'fetch_url',
  'read_web_evidence',
  'read_image',
  'read_attachment',
  'search_knowledge',
  'list_knowledge_documents',
  'read_knowledge_document',
  'investigate_knowledge',
  'assess_retrieval',
  'inspect_retrieval_trace',
  'transcribe_media',
  'media_services',
  'generate_media',
  'media_status',
  'cancel_media',
  'list_media',
  'inspect_media',
  'list_voices',
  'ask_user',
]);
export function chatSenderAllowed(c: ChatConnection, m: ChatIncoming) {
  if ((m.peerType || 'private') !== (c.peerType || 'private') || m.peerId !== c.peerId)
    return false;
  if ((c.peerType || 'private') === 'private') return m.senderId === c.senderId;
  return (
    m.senderId === c.senderId ||
    (c.allowedSenders || []).includes(m.senderId) ||
    (c.accessMode === 'chat' && c.allGroupMembers === true)
  );
}
export function restrictedChat(c: Conversation): Conversation {
  if (!c.remoteChatOnly) return c;
  return {
    ...c,
    projectId: null,
    isolationId: undefined,
    permission: 'ask',
    allowedTools: [...socialChatTools],
    memory: c.memory ?? true,
    includeUserMemory: false,
    generateMemory: c.generateMemory ?? true,
    automaticMemory: c.automaticMemory ?? true,
    knowledge: true,
    skillIds: [],
    teamStrategy: 'off',
  };
}
