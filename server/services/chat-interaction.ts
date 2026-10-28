import type { Store } from '../storage/store.js';
import type { ChatConnections } from './chat-connections.js';
import type { ChatConnection } from '../../shared/chat-connections.js';
import { assert } from '../core/errors.js';
export interface ChatReplyPlan {
  messages?: string[];
  mediaOnly?: boolean;
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
  saveSticker?(c: ChatConnection, input: unknown): Promise<unknown>;
  importFavorites?(c: ChatConnection, count?: number): Promise<unknown>;
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
export function localChatBridge(store: Store, c: ChatConnection) {
  const service = services.get(store);
  assert(service, 'CHAT_UNAVAILABLE', 'Chat transport unavailable.');
  service.channels.authorize(c);
  return service.bridge;
}
export function chatCapabilities(c: ChatConnection) {
  return {
    groupInfo: c.peerType === 'group' && ['onebot11', 'onebot12'].includes(c.transport),
    members: c.peerType === 'group' && ['onebot11', 'onebot12'].includes(c.transport),
    mentions: c.peerType === 'group' && ['onebot11', 'onebot12'].includes(c.transport),
    quotedReply: ['onebot11', 'onebot12'].includes(c.transport),
    nativeFaces: c.transport === 'onebot11',
    images: true,
    stickerLibrary: true,
    nativeFavoriteCollection: c.transport === 'onebot11',
    favoriteStickersImport: c.transport === 'onebot11',
    subscriptionStickerPacks: false,
    socialFeedPublishing: false,
    scheduledFollowups: { supported: true, controllerApproval: true, destination: 'same-chat' },
    browserVoice: {
      supported: true,
      location: 'authenticated Chat Connections page',
      mode: 'alternating speech turns',
      nativePhoneCall: false,
    },
    voiceCalls: {
      outbound: false,
      inbound: false,
      reason:
        'This adapter implements voice messages, not native real-time call signaling or audio transport.',
    },
    retractOwnMessages: ['onebot11', 'onebot12', 'telegram'].includes(c.transport),
    note: 'Bridge features require backend support. Unsupported actions fail explicitly; image stickers use the media upload path, not a universal native sticker format.',
  };
}

export function memberCacheRoute(c: ChatConnection) {
  return JSON.stringify([
    c.transport,
    c.accountId,
    c.peerType,
    c.peerId,
    c.conversationId,
    c.revision,
  ]);
}
export function cacheChatMembers(store: Store, c: ChatConnection, members: any[]) {
  assert(
    Array.isArray(members) &&
      members.every((m) => m && typeof m.id === 'string' && m.id.length > 0),
    'CHAT_MEMBERS',
    'Invalid member list.',
  );
  store.put('chat-member-cache', { id: c.id, route: memberCacheRoute(c), at: Date.now(), members });
}
/** Names are resolved only against the exact current platform roster, never prose or memory. */
export async function resolveReplyMentions(
  store: Store,
  c: ChatConnection,
  bridge: ChatBridge,
  requested: string[],
) {
  if (!requested.length) return [];
  assert(
    chatCapabilities(c).mentions,
    'CHAT_UNSUPPORTED',
    'Native mentions unavailable on this adapter.',
  );
  let members: any[] | undefined;
  const known = store.maybe<any>('chat-member-cache', c.id);
  if (known?.route === memberCacheRoute(c) && known.at > Date.now() - 300000)
    members = known.members;
  let refreshed = false;
  const refresh = async () => {
    const result = await bridge.query(c, 'members');
    const latest = store.maybe<ChatConnection>('chat-connection', c.id);
    assert(
      latest?.enabled && memberCacheRoute(latest) === memberCacheRoute(c),
      'CHAT_CHANGED',
      'Chat changed during member lookup; prepare the reply again in the current chat.',
    );
    cacheChatMembers(store, c, result);
    members = result;
    refreshed = true;
  };
  const resolved: string[] = [];
  for (const token of requested) {
    const who = token.trim();
    assert(
      who && who !== 'all' && who !== c.accountId,
      'CHAT_MENTION',
      'Mention an individual member, not everyone or this bot.',
    );
    try {
      validateReplyPlan(store, c, { mentions: [who] });
      resolved.push(who);
      continue;
    } catch (error) {
      if ((error as any)?.code !== 'CHAT_MEMBER') throw error;
    }
    if (!members) await refresh();
    const matches = () => {
      const exact = members!.filter((m) => m.id === who);
      return exact.length
        ? exact
        : members!.filter((m) =>
            [m.name, m.card].some(
              (n) => typeof n === 'string' && n.trim() === who.replace(/^@/, ''),
            ),
          );
    };
    let found = matches();
    if (!found.length && !refreshed) {
      await refresh();
      found = matches();
    }
    const ids = [...new Set(found.map((m) => m.id))];
    assert(
      ids.length !== 0,
      'CHAT_MEMBER',
      'No exact member ID or name match in this current group. Use list_chat_members to obtain the platform ID; this is a lookup failure, not a missing mention capability.',
    );
    assert(
      ids.length === 1,
      'CHAT_MEMBER_AMBIGUOUS',
      'Several members share this name. Use list_chat_members and choose the intended platform ID; do not guess.',
    );
    validateReplyPlan(store, c, { mentions: [ids[0]] });
    resolved.push(ids[0]);
  }
  return [...new Set(resolved)];
}

export function validateReplyPlan(store: Store, c: ChatConnection, plan: ChatReplyPlan) {
  assert(
    !plan.messages ||
      (Array.isArray(plan.messages) &&
        plan.messages.length > 0 &&
        plan.messages.length <= 8 &&
        plan.messages.every(
          (x) => typeof x === 'string' && x.trim().length > 0 && x.length <= 4000,
        )),
    'CHAT_REPLY_MESSAGES',
    'Use one to eight nonempty text messages, at most 4000 characters each.',
  );
  assert(
    !plan.mediaOnly || !plan.messages?.length,
    'CHAT_REPLY_MODE',
    'Media-only delivery cannot also specify text messages.',
  );
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
      observed ||
        (known?.route === memberCacheRoute(c) &&
          known.at > Date.now() - 300000 &&
          known.members.some((m: any) => m.id === who)),
      'CHAT_MEMBER',
      'Use a platform member ID from this chat, not a display name. Query list_chat_members for an unknown or expired member; mentions are supported.',
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
