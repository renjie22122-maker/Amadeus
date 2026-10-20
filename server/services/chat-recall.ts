import { createHash } from 'node:crypto';
import type { Store } from '../storage/store.js';
import type { ChatConnection } from '../../shared/chat-connections.js';
import { assert } from '../core/errors.js';
export function chatRoute(c: ChatConnection) {
  return createHash('sha256')
    .update(JSON.stringify([c.id, c.transport, c.accountId, c.endpoint, c.peerType, c.peerId]))
    .digest('hex');
}
export function recallSupported(c: ChatConnection) {
  return ['onebot11', 'onebot12', 'telegram'].includes(c.transport);
}
export function installDeliveryReceipts(store: Store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS chat_delivery (
    id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, route TEXT NOT NULL,
    message_id TEXT NOT NULL, recipient TEXT, sent_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'sent', approval_id TEXT);
    CREATE INDEX IF NOT EXISTS chat_delivery_scope ON chat_delivery(connection_id,sent_at);`);
}
export function deliveryReceipt(store: Store, c: ChatConnection, row: any, messageId: unknown) {
  if (messageId === undefined || messageId === null || String(messageId) === '') return;
  const key = String(row.id).replace(/:\d+$/, '');
  const inbox = store.db
    .prepare('SELECT sender_id FROM chat_inbox WHERE id=? AND connection_id=?')
    .get(key, c.id) as any;
  const approval =
    /^approval(?:-allow|-deny|-scope|-remember|-details)?:([a-f0-9-]{36})(?::|$)/.exec(row.id)?.[1];
  store.db
    .prepare(
      'INSERT OR IGNORE INTO chat_delivery(id,connection_id,route,message_id,recipient,sent_at,approval_id) VALUES(?,?,?,?,?,?,?)',
    )
    .run(
      row.id,
      c.id,
      chatRoute(c),
      String(messageId),
      inbox?.sender_id || null,
      Date.now(),
      approval || null,
    );
}
export function recallTarget(
  store: Store,
  c: ChatConnection,
  deliveryId: string,
  senderId: string | null,
  isAdmin = false,
) {
  assert(
    recallSupported(c),
    'CHAT_UNSUPPORTED',
    'This adapter does not support message retraction.',
  );
  const row = store.db
    .prepare('SELECT * FROM chat_delivery WHERE id=? AND connection_id=?')
    .get(deliveryId, c.id) as any;
  assert(
    row && row.route === chatRoute(c),
    'CHAT_RECALL_SCOPE',
    'Only verified bot messages in this exact chat may be retracted.',
  );
  assert(
    senderId &&
      (senderId === c.senderId || isAdmin || (row.recipient === senderId && !row.approval_id)),
    'CHAT_RECALL_PERMISSION',
    'Only your own bot replies or a verified administrator may retract this message.',
  );
  assert(
    row.state === 'sent',
    'CHAT_RECALL_STATE',
    'Message already retracted or its retraction outcome is uncertain.',
  );
  return row;
}

// Approval security lifetime is distinct from the provider's deletion limit.
// OneBot protocols do not specify a universal recall deadline: use a conservative
// application window, not a claim about QQ/WeChat account-specific entitlements.
export function remoteReviewPolicy(c: ChatConnection) {
  return c.transport === 'telegram'
    ? { ttlMs: 300000, minimumReadMs: 30000, label: '5 分钟', cleanup: true }
    : c.transport.startsWith('onebot')
      ? { ttlMs: 90000, minimumReadMs: 30000, label: '90 秒（为撤回预留余量）', cleanup: true }
      : { ttlMs: 120000, minimumReadMs: 30000, label: '2 分钟', cleanup: false };
}
