import { createHash } from 'node:crypto';
import type { ChatConnection } from '../../shared/chat-connections.js';
import type { MediaConnection } from '../../shared/media.js';
import type { Store } from '../storage/store.js';
import { assert } from '../core/errors.js';
import { chatSenderAllowed } from './chat-access.js';
export const mediaFingerprint = (service: MediaConnection) =>
  createHash('sha256').update(JSON.stringify(service)).digest('hex');
export function installChatMediaGrants(store: Store) {
  store.db.exec(
    'CREATE TABLE IF NOT EXISTS chat_media_use (operation TEXT PRIMARY KEY, connection_id TEXT NOT NULL, sender_id TEXT NOT NULL, service_id TEXT NOT NULL, at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS chat_media_use_recent ON chat_media_use(connection_id,at);',
  );
}
/** Only direct, admitted group turns may consume locally configured media authority. */
export function authorizeGroupMedia(c: any, service: MediaConnection, options: unknown = {}) {
  if (!c.conversation.remoteChatOnly) return false;
  const row = c.store.db
    .prepare("SELECT * FROM chat_inbox WHERE run_id=? AND state='running'")
    .get(c.run.id);
  if (!row) return false;
  const connection = c.store.maybe('chat-connection', row.connection_id) as
    ChatConnection | undefined;
  if (!connection?.groupMediaEnabled) return false;
  assert(
    connection.enabled &&
      connection.accessMode === 'chat' &&
      connection.peerType === 'group' &&
      connection.conversationId === c.conversation.id &&
      !c.run.recoveryOnly,
    'CHAT_MEDIA_SCOPE',
    'Group media authority is unavailable.',
  );
  assert(
    !c.store.maybe('chat-proactive-run', c.run.id) &&
      row.sender_id &&
      chatSenderAllowed(connection, {
        peerId: connection.peerId,
        peerType: 'group',
        senderId: row.sender_id,
      } as any),
    'CHAT_MEDIA_SENDER',
    'Only an admitted member request can generate media; unsolicited participation cannot.',
  );
  const grant = c.store.maybe('chat-media-grant', connection.id);
  assert(
    grant?.revision === connection.revision &&
      grant.services[service.id] === mediaFingerprint(service),
    'CHAT_MEDIA_SERVICE',
    'This service is not authorized or has changed. Ask the local owner to review group media settings.',
  );
  assert(
    service.estimatedUsd != null &&
      Number.isFinite(service.estimatedUsd) &&
      service.estimatedUsd >= 0 &&
      service.estimatedUsd <= (connection.groupMediaMaxUsd ?? 0),
    'CHAT_MEDIA_COST',
    'Unknown or excessive estimated cost requires local review.',
  );
  // Group users may supply conversation attachment handles, not raw provider paths/URLs.
  const strings = (x: any): string[] =>
    typeof x === 'string'
      ? [x]
      : x && typeof x === 'object'
        ? Object.values(x).flatMap(strings)
        : [];
  assert(
    !strings(options).some((v) =>
      /(?:https?:|file:|data:|[a-z]:[\\/]|^\/|^\\\\|\.\.[\\/])/i.test(v),
    ),
    'CHAT_MEDIA_REFERENCE',
    'Use same-conversation reference attachments instead of raw URLs or file paths.',
  );
  const operation = c.run.id + ':' + c.callId;
  c.store.transaction(() => {
    if (c.store.db.prepare('SELECT 1 FROM chat_media_use WHERE operation=?').get(operation)) return;
    const count = c.store.db
      .prepare('SELECT COUNT(*) AS n FROM chat_media_use WHERE connection_id=? AND at>?')
      .get(connection.id, Date.now() - 3600000) as any;
    assert(
      count.n < (connection.groupMediaHourlyLimit ?? 12),
      'CHAT_MEDIA_QUOTA',
      'Group media hourly quota reached.',
    );
    c.store.db
      .prepare('INSERT INTO chat_media_use VALUES(?,?,?,?,?)')
      .run(operation, connection.id, row.sender_id, service.id, Date.now());
    c.store.event(c.conversation.id, c.run.id, 'chat.media-authorized', {
      connectionId: connection.id,
      senderId: row.sender_id,
      serviceId: service.id,
      estimatedUsd: service.estimatedUsd,
    });
  });
  return true;
}
