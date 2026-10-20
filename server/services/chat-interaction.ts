import type { Store } from '../storage/store.js';
import type { ChatConnections } from './chat-connections.js';
import type { ChatConnection } from '../../shared/chat-connections.js';
import { assert } from '../core/errors.js';
export interface ChatReplyPlan {
  mentions?: string[];
  replyTo?: string;
  faces?: string[];
  references?: string[];
}
export interface ChatBridge {
  query(c: ChatConnection, kind: 'info' | 'members'): Promise<any>;
  readMessage?(
    c: ChatConnection,
    messageId: string,
    forwardIndex: number,
    offset: number,
    limit: number,
  ): Promise<any>;
  importMedia(c: ChatConnection, messageId: string): Promise<string[]>;
  retract?(c: ChatConnection, deliveryId: string, senderId: string | null): Promise<unknown>;
}
const services = new WeakMap<Store, { channels: ChatConnections; bridge: ChatBridge }>();
export function registerChatInteraction(channels: ChatConnections, bridge: ChatBridge) {
  services.set(channels.store, { channels, bridge });
}
export function currentChat(store: Store, conversationId: string, runId: string) {
  const service = services.get(store);
  assert(service, 'CHAT_UNAVAILABLE', 'Chat transport is unavailable.');
  const row = store.db
    .prepare(
      "SELECT connection_id,sender_id FROM chat_inbox WHERE run_id=? AND state IN ('dispatching','running')",
    )
    .get(runId) as any;
  assert(row, 'CHAT_SCOPE', 'Only the current remote chat run can use this tool.');
  const c = service.channels.get(row.connection_id);
  assert(
    c.enabled && c.conversationId === conversationId,
    'CHAT_SCOPE',
    'Current chat is disabled or outside this conversation.',
  );
  service.channels.authorize(c);
  return { ...service, c, currentSenderId: row.sender_id || null };
}
export function chatCapabilities(c: ChatConnection) {
  return {
    groupInfo: c.peerType === 'group' && ['onebot11', 'onebot12'].includes(c.transport),
    members: c.peerType === 'group' && ['onebot11', 'onebot12'].includes(c.transport),
    mentions: c.peerType === 'group' && ['onebot11', 'onebot12'].includes(c.transport),
    quotedReply: ['onebot11', 'onebot12'].includes(c.transport),
    nativeFaces: c.transport === 'onebot11',
    images: true,
    retractOwnMessages: ['onebot11', 'onebot12', 'telegram'].includes(c.transport),
    note: 'Bridge features require backend support. Unsupported actions fail explicitly; image stickers use the media upload path, not a universal native sticker format.',
  };
}
export function validateReplyPlan(store: Store, c: ChatConnection, plan: ChatReplyPlan) {
  const caps = chatCapabilities(c);
  assert(
    !plan.mentions?.length || caps.mentions,
    'CHAT_UNSUPPORTED',
    'Native mentions unavailable on this adapter.',
  );
  for (const who of plan.mentions || []) {
    assert(
      who !== 'all' && who !== c.accountId,
      'CHAT_MENTION',
      'Mention an individual observed member only.',
    );
    const observed = store.db
      .prepare('SELECT 1 FROM chat_received WHERE connection_id=? AND sender_id=? AND at>? LIMIT 1')
      .get(c.id, who, Date.now() - 86400000);
    const known = store.maybe<any>('chat-member-cache', c.id);
    assert(
      observed || (known?.at > Date.now() - 300000 && known.members.some((m: any) => m.id === who)),
      'CHAT_MEMBER',
      'Member was not observed or queried in this chat.',
    );
  }
  if (plan.replyTo) {
    assert(caps.quotedReply, 'CHAT_UNSUPPORTED', 'Native quote unavailable on this adapter.');
    assert(
      store.db
        .prepare('SELECT 1 FROM chat_received WHERE connection_id=? AND message_id=? AND at>?')
        .get(c.id, plan.replyTo, Date.now() - 86400000),
      'CHAT_REPLY_SCOPE',
      'Quote must refer to a recent message received in this exact chat.',
    );
  }
  assert(
    !plan.faces?.length || caps.nativeFaces,
    'CHAT_UNSUPPORTED',
    'Native face IDs are only supported by this adapter on OneBot 11.',
  );
}
