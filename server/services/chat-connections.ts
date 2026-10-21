import { remoteConversationStyle } from './chat-style.js';
import { installChatMediaGrants, mediaFingerprint } from './chat-media-grant.js';
import { installChatTranscriptions, continueChatTranscription } from './chat-transcription.js';
import { installDeliveryReceipts, remoteReviewPolicy } from './chat-recall.js';
import { canRememberApproval, rememberedApprovalScope } from '../../shared/approval-grants.js';
import { chatApprovalSummary } from './chat-approval-format.js';
import { validateReplyPlan, type ChatReplyPlan } from './chat-interaction.js';
import { chatPlainText } from './chat-format.js';
import { existsSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { createHash, randomBytes } from 'node:crypto';
import type { Conversation, PendingInput } from '../../shared/types.js';
import type { ChatConnection, ChatIncoming, ChatSecrets } from '../../shared/chat-connections.js';
import { Store, id } from '../storage/store.js';
import type { Runtime } from '../core/runtime.js';
import { assert } from '../core/errors.js';
import { terminal } from '../core/lifecycle.js';
import { writePrivate } from './private-file.js';
import { windowsSecrets } from './credential-storage.js';
import { chatSenderAllowed, restrictedChat } from './chat-access.js';
import { ChatGroupContext, invitedGroup } from './chat-group-context.js';
import { messageParts } from './chat-protocols.js';
export const connectionInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    transport: z.enum(['telegram', 'whatsapp', 'vk', 'qq', 'wecom', 'onebot11', 'onebot12']),
    conversationId: z.string().min(1),
    senderId: z.string().trim().min(1).max(160),
    peerId: z.string().trim().min(1).max(160),
    enabled: z.boolean().default(false),
    endpoint: z.string().max(500).default(''),
    accountId: z.string().trim().max(160).default(''),
    apiVersion: z.string().max(30).default(''),
    webhookPort: z.number().int().min(1024).max(65535).default(8788),
    remoteApprovals: z.boolean().default(false),
    groupMediaEnabled: z.boolean().default(false),
    groupMediaServiceIds: z.array(z.string().min(1)).max(30).default([]),
    groupMediaMaxUsd: z.number().finite().min(0).max(1000).default(0),
    groupMediaHourlyLimit: z.number().int().min(1).max(200).default(12),
    peerType: z.enum(['private', 'group']).default('private'),
    accessMode: z.enum(['chat', 'work']).default('chat'),
    allowedSenders: z.array(z.string().trim().min(1).max(160)).max(200).default([]),
    allGroupMembers: z.boolean().default(false),
    groupPrefix: z.string().trim().min(1).max(30).default('/amadeus'),
    sharedKnowledge: z.boolean().default(true),
    groupContext: z.boolean().default(false),
    groupReplyMode: z.enum(['mentions', 'participate']).default('mentions'),
    autoInviteGroups: z.boolean().default(false),
    reviewFriendRequests: z.boolean().default(false),
    token: z.string().max(4096).optional(),
    appSecret: z.string().max(4096).optional(),
    verifyToken: z.string().max(4096).optional(),
  })
  .strict();
export class ChatConnections {
  readonly groups: ChatGroupContext;
  private secretsCache = new Map<string, ChatSecrets>();
  constructor(
    readonly store: Store,
    readonly runtime: Runtime,
    readonly directory: string,
  ) {
    this.groups = new ChatGroupContext(store);
    installDeliveryReceipts(store);
    installChatTranscriptions(store);
    installChatMediaGrants(store);
    store.db.exec(
      'CREATE TABLE IF NOT EXISTS chat_received(connection_id TEXT NOT NULL,message_id TEXT NOT NULL,sender_id TEXT NOT NULL,payload TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(connection_id,message_id)); CREATE INDEX IF NOT EXISTS chat_received_recent ON chat_received(connection_id,at);',
    );
    store.db.exec(`CREATE TABLE IF NOT EXISTS chat_inbox(
      id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, received_at INTEGER NOT NULL, state TEXT NOT NULL,
      text TEXT NOT NULL, run_id TEXT, notice TEXT);
      CREATE INDEX IF NOT EXISTS chat_inbox_queue ON chat_inbox(connection_id,state,received_at);
      CREATE TABLE IF NOT EXISTS chat_outbox(id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, state TEXT NOT NULL,
      text TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS chat_outbox_queue ON chat_outbox(connection_id,state,created_at);`);
    store.db
      .exec(`CREATE TABLE IF NOT EXISTS chat_approval(code TEXT PRIMARY KEY,connection_id TEXT NOT NULL,input_id TEXT UNIQUE NOT NULL,
      run_id TEXT NOT NULL,digest TEXT NOT NULL,expires_at INTEGER NOT NULL,revision INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0);`);
    for (const [table, column, definition] of [
      ['chat_inbox', 'media', 'TEXT'],
      ['chat_inbox', 'sender_id', 'TEXT'],
      ['chat_inbox', 'attachment_ids', "TEXT NOT NULL DEFAULT '[]'"],
      ['chat_outbox', 'reference', 'TEXT'],
      ['chat_outbox', 'reply_plan', 'TEXT'],
      ['chat_outbox', 'attempts', 'INTEGER NOT NULL DEFAULT 0'],
      ['chat_outbox', 'retry_at', 'INTEGER NOT NULL DEFAULT 0'],
    ] as const) {
      if (
        !(store.db.prepare('PRAGMA table_info(' + table + ')').all() as any[]).some(
          (c) => c.name === column,
        )
      )
        store.db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + definition);
    }
    store.db.prepare("UPDATE chat_inbox SET state='media-failed' WHERE state='downloading'").run();
    // A crash after send may have delivered it. Never silently replay uncertain sends.
    store.db.prepare("UPDATE chat_outbox SET state='uncertain' WHERE state='sending'").run();
  }
  list() {
    return this.store.list<ChatConnection>('chat-connection');
  }
  get(key: string) {
    return this.store.get<ChatConnection>('chat-connection', key);
  }
  private secretFile(key: string) {
    z.uuid().parse(key);
    return join(this.directory, 'chat-secrets', key + '.json');
  }
  secrets(key: string): ChatSecrets {
    if (this.secretsCache.has(key)) return this.secretsCache.get(key)!;
    const file = this.secretFile(key);
    if (!existsSync(file)) return { token: '', appSecret: '', verifyToken: '' };
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const value = raw.protected ? JSON.parse(windowsSecrets.open(raw.protected)) : raw;
    this.secretsCache.set(key, value);
    return value;
  }
  target(conversationId: string) {
    const c = this.store.get<Conversation>('conversation', conversationId);
    assert(
      !c.archived && !c.parentId && !c.isolationId,
      'CHAT_TARGET',
      'Choose an available top-level conversation.',
    );
    const project = c.projectId ? this.store.get<any>('project', c.projectId) : null;
    assert(!project?.removedAt, 'CHAT_TARGET', 'Restore the project first.');
    const p = this.runtime.config.profile(c.profileId);
    return createHash('sha256')
      .update(
        JSON.stringify([
          c.projectId,
          project?.folders,
          c.profileId,
          p.baseUrl,
          p.model,
          c.permission,
          c.execution,
          c.allowedTools,
          c.knowledge,
          c.memory,
          c.skillIds,
          c.remoteChatOnly,
          c.remoteSharedKnowledge,
        ]),
      )
      .digest('hex');
  }
  save(raw: unknown, key: string = id()) {
    z.uuid().parse(key);
    const old = this.store.maybe<ChatConnection>('chat-connection', key);
    const { token, appSecret, verifyToken, ...data } = connectionInput.parse({
      accessMode: old?.accessMode || (old ? 'work' : 'chat'),
      ...(raw as any),
    });
    assert(
      !old ||
        [
          'transport',
          'conversationId',
          'senderId',
          'peerId',
          'accountId',
          'endpoint',
          'peerType',
          'accessMode',
        ].every(
          (field) =>
            ((old as any)[field] ??
              (field === 'peerType' ? 'private' : field === 'accessMode' ? 'work' : undefined)) ===
            (data as any)[field],
        ),
      'CHAT_BINDING',
      'Create a new connection to change the recipient, account, endpoint or conversation. Existing deliveries must never be rerouted.',
    );
    assert(
      old || this.list().length < 20,
      'CHAT_CAPACITY',
      'At most 20 connections may be configured.',
    );
    assert(
      (!old && data.accessMode === 'chat') ||
        !this.list().some((c) => c.id !== key && c.conversationId === data.conversationId),
      'CHAT_BOUND',
      'Use a separate conversation for each connection.',
    );
    assert(
      !old || !this.runtime.active(old.conversationId),
      'CHAT_BUSY',
      'Wait for the active conversation before editing; pause is available immediately.',
    );
    assert(
      !old ||
        !this.store.db
          .prepare(
            "SELECT 1 FROM chat_inbox WHERE connection_id=? AND state IN ('queued','receiving','downloading','dispatching','running') LIMIT 1",
          )
          .get(key),
      'CHAT_BUSY',
      'Pause and cancel queued messages before changing the binding.',
    );
    if (data.transport.startsWith('onebot')) {
      const u = new URL(data.endpoint);
      assert(
        ['ws:', 'wss:'].includes(u.protocol) &&
          ['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname) &&
          !u.username &&
          !u.password &&
          !u.search &&
          !u.hash,
        'CHAT_ENDPOINT',
        'OneBot must use a loopback WebSocket endpoint without credentials or query parameters.',
      );
      assert(data.accountId, 'CHAT_ACCOUNT', 'Bot account ID required.');
    }
    if (!['onebot12', 'wecom', 'qq'].includes(data.transport))
      assert(
        /^\d+$/.test(data.senderId) &&
          (data.transport === 'telegram' && data.peerType === 'group'
            ? /^-\d+$/.test(data.peerId)
            : /^\d+$/.test(data.peerId)),
        'CHAT_PEER',
        'Use numeric private sender/chat IDs.',
      );
    assert(
      data.peerType === 'group' || data.senderId === data.peerId,
      'CHAT_PEER',
      'Only a single trusted private peer is supported.',
    );
    assert(
      !data.autoInviteGroups || (data.transport === 'onebot11' && data.peerType === 'private'),
      'CHAT_INVITE_PROTOCOL',
      'Automatic invitation authorization currently requires a OneBot 11 private controller route.',
    );
    assert(
      !data.reviewFriendRequests ||
        (data.transport === 'onebot11' &&
          data.peerType === 'private' &&
          data.accessMode === 'work'),
      'CHAT_FRIEND_REVIEW',
      'Friend review requires a private OneBot 11 controller work connection.',
    );
    assert(
      !data.reviewFriendRequests ||
        !this.list().some(
          (x) =>
            x.id !== key &&
            x.reviewFriendRequests &&
            x.transport === data.transport &&
            x.accountId === data.accountId &&
            x.endpoint === data.endpoint,
        ),
      'CHAT_FRIEND_CONTROLLER',
      'Only one friend-review controller may be configured per bot account.',
    );
    assert(
      data.accessMode === 'chat' || (!data.groupContext && data.groupReplyMode !== 'participate'),
      'CHAT_GROUP_AUTHORITY',
      'Ambient group context is only available to isolated ordinary chat.',
    );
    assert(
      data.groupReplyMode !== 'participate' || data.groupContext,
      'CHAT_GROUP_CONTEXT',
      'Participation requires group context.',
    );
    assert(
      data.transport !== 'whatsapp' || data.peerType === 'private',
      'CHAT_GROUP_UNSUPPORTED',
      'This WhatsApp adapter only supports private conversations.',
    );
    assert(
      !(data.accessMode === 'work' && data.allGroupMembers),
      'CHAT_WORK_MEMBERS',
      'Remote work requires explicit user IDs.',
    );
    assert(
      data.accessMode === 'work' || !data.remoteApprovals,
      'CHAT_APPROVAL',
      'Computer-operation approvals are only available to work connections.',
    );
    if (data.transport === 'onebot11')
      assert(Number.isSafeInteger(Number(data.peerId)), 'CHAT_PEER', 'Invalid QQ ID.');
    if (['vk', 'whatsapp', 'qq'].includes(data.transport))
      assert(
        /^\d+$/.test(data.accountId),
        'CHAT_ACCOUNT',
        'Numeric community/phone-number ID required.',
      );
    if (data.transport === 'whatsapp')
      assert(
        /^v\d+\.\d+$/.test(data.apiVersion),
        'CHAT_VERSION',
        'Enter the Graph API version from your Meta application.',
      );
    if (data.transport === 'vk')
      assert(
        /^\d+\.\d+$/.test(data.apiVersion),
        'CHAT_VERSION',
        'Enter a supported VK API version.',
      );
    const secrets = { ...this.secrets(key) };
    for (const [k, v] of Object.entries({ token, appSecret, verifyToken }))
      if (v?.trim()) (secrets as any)[k] = v.trim();
    assert(secrets.token, 'CHAT_TOKEN', 'Service token required.');
    assert(
      !this.list().some(
        (c) =>
          c.id !== key &&
          c.transport === data.transport &&
          c.accountId === data.accountId &&
          c.endpoint === data.endpoint &&
          (data.transport !== 'telegram' ||
            this.secrets(c.id).token.split(':')[0] === secrets.token.split(':')[0]) &&
          c.peerId === data.peerId &&
          (c.peerType || 'private') === data.peerType,
      ),
      'CHAT_ROUTE_DUPLICATE',
      'This account/chat already has a route. Use separate chats for ordinary chat and remote work.',
    );
    if (data.transport === 'telegram')
      assert(
        /^\d+:[A-Za-z0-9_-]+$/.test(secrets.token),
        'CHAT_TOKEN',
        'Invalid Telegram bot token format.',
      );
    if (data.transport === 'qq')
      assert(
        /^[\x21-\x7e]{1,4096}$/.test(secrets.token),
        'CHAT_TOKEN',
        'QQ AppSecret must be printable ASCII.',
      );
    if (data.transport === 'wecom') assert(data.accountId, 'CHAT_ACCOUNT', 'Bot ID required.');
    if (data.transport === 'whatsapp')
      assert(
        secrets.appSecret && secrets.verifyToken,
        'CHAT_TOKEN',
        'Meta app secret and webhook verification token required.',
      );
    const mediaServices: Record<string, string> = {};
    if (data.groupMediaEnabled) {
      assert(
        data.accessMode === 'chat' && data.peerType === 'group',
        'CHAT_MEDIA_SCOPE',
        'Media sharing is only for isolated group chat.',
      );
      assert(
        data.groupMediaServiceIds.length > 0,
        'CHAT_MEDIA_SERVICE',
        'Select at least one media service.',
      );
      for (const serviceId of data.groupMediaServiceIds) {
        const service = this.runtime.media.connection(serviceId);
        assert(
          service.estimatedUsd != null &&
            service.estimatedUsd >= 0 &&
            service.estimatedUsd <= data.groupMediaMaxUsd,
          'CHAT_MEDIA_COST',
          'Set a known service estimate within the group limit.',
        );
        mediaServices[serviceId] = mediaFingerprint(service);
      }
    }
    if (data.accessMode === 'chat') {
      if (!old) {
        const template = this.store.get<Conversation>('conversation', data.conversationId);
        const clean = restrictedChat({
          id: id(),
          title: data.name,
          projectId: null,
          profileId: template.profileId,
          reasoning: template.reasoning || 'auto',
          permission: 'ask',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          pinned: false,
          archived: false,
          parentId: null,
          forkEvent: null,
          skillIds: [],
          knowledge: true,
          memory: false,
          remoteChatOnly: true,
          remoteSharedKnowledge: data.sharedKnowledge,
        });
        this.store.put('conversation', clean);
        data.conversationId = clean.id;
      } else {
        const clean = this.store.get<Conversation>('conversation', data.conversationId);
        assert(
          clean.remoteChatOnly,
          'CHAT_ISOLATION',
          'Ordinary chat must use its isolated conversation.',
        );
        this.store.put(
          'conversation',
          restrictedChat({ ...clean, remoteSharedKnowledge: data.sharedKnowledge }),
        );
      }
    }
    const next: ChatConnection = {
      ...data,
      id: key,
      revision: (old?.revision || 0) + 1,
      activatedAt: Date.now(),
      authorizedTarget: this.target(data.conversationId),
    };
    const file = this.secretFile(key);
    writePrivate(
      file + '.tmp',
      JSON.stringify(
        process.platform === 'win32'
          ? { protected: windowsSecrets.seal(JSON.stringify(secrets)) }
          : secrets,
      ),
    );
    renameSync(file + '.tmp', file);
    this.secretsCache.set(key, secrets);
    this.store.transaction(() => {
      this.store.put('chat-media-grant', {
        id: key,
        revision: next.revision,
        services: mediaServices,
      });
      this.store.put('chat-connection', next);
    });
    this.store.remove('chat-transport-state', key);
    this.store.remove('chat-cursor', key);
    return next;
  }
  pause(key: string) {
    const c = this.get(key);
    this.store.put('chat-connection', { ...c, enabled: false, revision: c.revision + 1 });
    this.store.put('chat-transport-state', {
      id: c.id,
      status: 'paused',
      reason: 'manual',
      updatedAt: Date.now(),
    });
    this.store.db
      .prepare(
        "UPDATE chat_inbox SET state='cancelled',text='',media=NULL WHERE connection_id=? AND state IN ('queued','receiving','downloading')",
      )
      .run(key);
  }
  remove(key: string) {
    const c = this.get(key);
    assert(
      !c.enabled && !this.runtime.active(c.conversationId),
      'CHAT_BUSY',
      'Pause and stop/wait for the conversation first.',
    );
    this.groups.clear(key);
    this.store.db.prepare('DELETE FROM chat_received WHERE connection_id=?').run(key);
    this.store.remove('chat-member-cache', key);
    this.store.remove('chat-group-authorization', key);
    this.store.remove('chat-connection', key);
    this.store.remove('chat-transport-state', key);
    this.store.db.prepare('DELETE FROM chat_inbox WHERE connection_id=?').run(key);
    this.store.db.prepare('DELETE FROM chat_outbox WHERE connection_id=?').run(key);
    this.store.db.prepare('DELETE FROM chat_approval WHERE connection_id=?').run(key);
    this.store.remove('chat-cursor', key);
    this.store.remove('chat-file-cursor', key);
    this.store.remove('chat-qq-reply', key);
    const file = this.secretFile(key);
    if (existsSync(file)) unlinkSync(file);
    this.secretsCache.delete(key);
  }
  authorize(c: ChatConnection) {
    assert(
      c.enabled && c.authorizedTarget === this.target(c.conversationId),
      'CHAT_REAUTHORIZE',
      'Conversation scope or model changed. Review and save the connection again.',
    );
  }
  enrollInvitedGroup(c: ChatConnection, event: unknown) {
    const peer = invitedGroup(c, event);
    if (!peer) return;
    this.authorize(c);
    if (
      this.list().some(
        (x) =>
          x.transport === c.transport &&
          x.accountId === c.accountId &&
          x.endpoint === c.endpoint &&
          x.peerId === peer &&
          x.peerType === 'group',
      )
    )
      return;
    const created = this.save({
      name: 'Group ' + peer,
      transport: c.transport,
      accountId: c.accountId,
      endpoint: c.endpoint,
      conversationId: c.conversationId,
      senderId: c.senderId,
      peerId: peer,
      peerType: 'group',
      accessMode: 'chat',
      allGroupMembers: true,
      groupContext: true,
      groupReplyMode: 'participate',
      sharedKnowledge: c.sharedKnowledge !== false,
      enabled: true,
      remoteApprovals: false,
      token: this.secrets(c.id).token,
    });
    this.store.put('chat-group-authorization', {
      id: created.id,
      sourceConnectionId: c.id,
      operatorId: c.senderId,
      groupId: peer,
      at: Date.now(),
      basis: 'platform-group-increase-invite',
    });
    this.reply(
      created,
      'group-disclosure:' + created.id,
      '本群已由指定控制人开启普通 AI 聊天。群消息可能发送给配置的模型服务，近期上下文仅用于本群。可 @机器人 或使用 /amadeus 提问；未开放电脑操作。',
    );
    return created;
  }
  receive(key: string, m: ChatIncoming, now = Date.now()) {
    const c = this.get(key);
    this.authorize(c);
    if (c.peerType === 'group' && m.senderId === c.accountId) return 'ignored';
    assert(chatSenderAllowed(c, m), 'CHAT_SENDER', 'Unbound sender.', 403);
    assert(
      m.id.length <= 256 &&
        m.text.length <= 16000 &&
        m.text.trim() &&
        m.timestamp >= c.activatedAt - 1000 &&
        m.timestamp > now - 86400000 &&
        m.timestamp < now + 60000,
      'CHAT_MESSAGE',
      'Stale or invalid message.',
    );
    this.store.db
      .prepare('INSERT OR IGNORE INTO chat_received VALUES(?,?,?,?,?)')
      .run(c.id, m.id, m.senderId, JSON.stringify(m), now);
    this.store.db
      .prepare(
        'DELETE FROM chat_received WHERE connection_id=? AND (at<? OR rowid NOT IN (SELECT rowid FROM chat_received WHERE connection_id=? ORDER BY at DESC,rowid DESC LIMIT 40))',
      )
      .run(c.id, now - 86400000, c.id);
    let helpRequested =
      !m.media?.length &&
      !m.mentionedIds?.length &&
      (m.text.trim() === '/help' || m.textOrigin === 'mention-only');
    if (c.peerType === 'group') {
      this.groups.observe(c, m, now);
      const prefix = c.groupPrefix || '/amadeus';
      const prefixed = m.text.startsWith(prefix + ' ') || m.text === prefix;
      if (!prefixed && !m.addressed && !helpRequested)
        return c.groupContext ? 'observed' : 'ignored';
      if (prefixed) m = { ...m, text: m.text.slice(prefix.length).trim() };
      helpRequested = !m.media?.length && (helpRequested || m.text.trim() === '/help');
      if (!m.text && !helpRequested) return 'ignored';
      this.groups.addressed(c, now);
      if (!helpRequested && c.accessMode === 'chat' && c.groupContext && !m.text.startsWith('/'))
        m = {
          ...m,
          text: this.groups.text(c, now) + '\nCurrent explicitly addressed message:\n' + m.text,
        };
    }
    const keyId = createHash('sha256')
      .update(key + '\0' + m.id)
      .digest('hex');
    if (this.store.db.prepare('SELECT 1 FROM chat_inbox WHERE id=?').get(keyId)) return 'duplicate';
    const recent = this.store.db
      .prepare('SELECT count(*) AS n FROM chat_inbox WHERE connection_id=? AND received_at>?')
      .get(key, now - 60000) as { n: number };
    assert(recent.n < 20, 'CHAT_RATE', 'Too many messages; wait a minute.', 429);
    const pending = this.store.db
      .prepare(
        "SELECT count(*) AS n FROM chat_inbox WHERE connection_id=? AND state IN ('queued','receiving','downloading','running','dispatching')",
      )
      .get(key) as { n: number };
    const approval = m.text
      .trim()
      .match(/^\/(approve|deny|answer|details|allow-similar|renew) ([a-f0-9]{24})(?: ([\s\S]+))?$/);
    const command =
      !m.media?.length &&
      (helpRequested ||
        ['/stop', '/status', '/grants', '/revoke-grants'].includes(m.text.trim()) ||
        !!approval);
    assert(command || pending.n < 20, 'CHAT_QUEUE', 'Message queue is full.', 429);
    this.store.db
      .prepare(
        'INSERT INTO chat_inbox (id,connection_id,received_at,state,text,run_id,notice) VALUES(?,?,?,?,?,?,?)',
      )
      .run(
        keyId,
        key,
        now,
        command ? 'done' : m.media?.length ? 'receiving' : 'queued',
        command
          ? ''
          : c.peerType === 'group'
            ? '[Platform sender ID: ' + m.senderId + ']\n' + m.text
            : m.text,
        null,
        null,
      );
    this.store.db.prepare('UPDATE chat_inbox SET sender_id=? WHERE id=?').run(m.senderId, keyId);
    if (m.media?.length)
      this.store.db
        .prepare('UPDATE chat_inbox SET media=? WHERE id=?')
        .run(JSON.stringify(m.media), keyId);
    if (helpRequested) {
      const group = c.peerType === 'group',
        controller = m.senderId === c.senderId;
      const prefix = group ? (c.groupPrefix || '/amadeus') + ' ' : '';
      const lines = [
        'Amadeus · 聊天帮助',
        group
          ? '@我＋问题：聊天；@我＋图片、语音或文件：请我处理附件。'
          : '直接发送问题、图片、语音或文件；能否处理取决于已配置能力。',
        '想撤回我的回复：明确说“撤回刚才那条”，或引用我的消息。仅支持有回执且平台允许撤回的消息。',
        group
          ? '普通成员只能撤回我对自己的回复；控制人和平台管理员可处理其他回复。'
          : '撤回不删除本地记录，也不取消已执行操作。',
        '只 @我 或 /help：显示本帮助。',
      ];
      if (controller) {
        lines.push(prefix + '/status：运行状态；' + prefix + '/stop：停止本入口任务。');
        if (c.accessMode === 'work' && c.remoteApprovals)
          lines.push(
            prefix +
              '/grants：查看已记住的授权；' +
              prefix +
              '/revoke-grants：撤销。审批码只在有待审批请求时发送，过期后可用 /renew 原码重新获取。',
          );
      }
      this.reply(
        c,
        keyId,
        lines.join('\n'),
        group && ['onebot11', 'onebot12'].includes(c.transport)
          ? { mentions: [m.senderId] }
          : undefined,
      );
      return 'done';
    }
    if (command && m.senderId !== c.senderId) {
      this.reply(
        c,
        keyId,
        'Only the configured controller may approve, stop or inspect remote work.',
      );
      return 'done';
    }
    if (command) {
      if (approval) {
        try {
          this.answer(c, approval[1], approval[2], approval[3] || '', now);
          if (!['details', 'renew'].includes(approval[1]))
            this.reply(
              c,
              keyId,
              approval[1] === 'allow-similar'
                ? '已允许，并记住已说明的范围；/grants 查看，/revoke-grants 撤销。'
                : '已记录，仅对本次请求生效。',
            );
        } catch {
          this.reply(
            c,
            keyId,
            'Decision rejected: request expired, changed, already answered, or not authorized. Check Amadeus.',
          );
        }
        return 'done';
      }
      if (['/grants', '/revoke-grants'].includes(m.text.trim())) {
        assert(
          c.remoteApprovals && c.accessMode === 'work',
          'CHAT_APPROVAL',
          'Only the enabled work controller may manage remembered approvals.',
        );
        if (m.text.trim() === '/revoke-grants')
          this.runtime.inputs.grants.revokeConversation(c.conversationId);
        const grants = this.runtime.inputs.grants.list(c.conversationId);
        this.reply(
          c,
          keyId,
          m.text.trim() === '/revoke-grants'
            ? '本会话记住的授权已全部撤销，后续操作重新审核。'
            : grants.length
              ? grants
                  .map(
                    (g) =>
                      g.label +
                      ' · 剩余 ' +
                      g.remaining +
                      ' 次 · ' +
                      new Date(g.expiresAt).toISOString(),
                  )
                  .join('\n') + '\n/revoke-grants 撤销本会话全部授权。'
              : '本会话没有有效的记住授权。',
        );
        return 'done';
      }
      const active = this.runtime.active(c.conversationId);
      if (m.text.trim() === '/stop') {
        this.store.db
          .prepare(
            "UPDATE chat_transcription SET state='stopped' WHERE connection_id=? AND state='waiting'",
          )
          .run(c.id);
        this.store.db
          .prepare(
            "UPDATE chat_inbox SET state='cancelled',text='',media=NULL WHERE connection_id=? AND state IN ('queued','receiving','downloading')",
          )
          .run(key);
        if (active) this.runtime.stop(active.id);
      }
      this.reply(
        c,
        keyId,
        m.text.trim() === '/stop'
          ? 'Stop requested; queued remote messages cancelled.'
          : `Amadeus: ${active?.status || 'idle'}. Pending remote tasks: ${pending.n}.`,
      );
    }
    return command ? 'done' : 'queued';
  }
  reply(c: ChatConnection, key: string, text: string, plan?: ChatReplyPlan) {
    for (const [n, part] of messageParts(text).entries())
      this.store.db
        .prepare(
          'INSERT OR IGNORE INTO chat_outbox (id,connection_id,state,text,created_at,reply_plan) VALUES(?,?,?,?,?,?)',
        )
        .run(
          key + ':' + n,
          c.id,
          'pending',
          part,
          Date.now(),
          n === 0 && plan ? JSON.stringify(plan) : null,
        );
  }
  private belongs(c: ChatConnection, runId: string): boolean {
    let key: string | null = runId;
    for (let depth = 0; key && depth < 20; depth++) {
      if (
        this.store.db
          .prepare(
            "SELECT 1 FROM chat_inbox WHERE connection_id=? AND run_id=? AND state='running'",
          )
          .get(c.id, key)
      )
        return true;
      key = this.store.maybeRunHeader(key)?.parentRunId || null;
    }
    return false;
  }
  private approvalDigest(q: PendingInput) {
    return createHash('sha256')
      .update(JSON.stringify([q.id, q.runId, q.conversationId, q.kind, q.payload]))
      .digest('hex');
  }
  private offerApprovals(c: ChatConnection) {
    const rows = this.store.db
      .prepare(
        "SELECT data FROM records WHERE kind='input' AND json_extract(data,'$.status')='pending' ORDER BY json_extract(data,'$.createdAt') DESC LIMIT 100",
      )
      .all() as { data: string }[];
    for (const row of rows) {
      const q: PendingInput = JSON.parse(row.data);
      if (
        !this.belongs(c, q.runId) ||
        this.store.db.prepare('SELECT 1 FROM chat_approval WHERE input_id=?').get(q.id)
      )
        continue;
      const payload = JSON.stringify(q.payload, null, 2);
      // If exact review information cannot safely fit, do not offer a blind approval.
      const localOnly =
        !c.remoteApprovals ||
        payload.length > 6500 ||
        /(?:api[_-]?key|access[_-]?token|authorization|password|secret|bearer\s|BEGIN .*PRIVATE KEY)/i.test(
          payload,
        ) ||
        q.payload.action === 'resolve-effect';
      const code = randomBytes(12).toString('hex');
      this.store.db
        .prepare('INSERT INTO chat_approval VALUES(?,?,?,?,?,?,?,0)')
        .run(
          code,
          c.id,
          q.id,
          q.runId,
          this.approvalDigest(q),
          Date.now() + remoteReviewPolicy(c).ttlMs,
          c.revision,
        );
      this.store.put('chat-approval-lifecycle', {
        id: code,
        connectionId: c.id,
        inputId: q.id,
        remote: !localOnly,
      });
      if (localOnly) {
        this.reply(
          c,
          'approval:' + q.id + ':' + code,
          'Amadeus needs a local decision. Request ' +
            q.id +
            '. ' +
            (!c.remoteApprovals
              ? c.accessMode === 'chat'
                ? 'Ordinary chat uses local approval. Review this request in Amadeus. Saying yes in chat does not approve it; do not grant the whole group computer-control access.'
                : 'Remote approval is disabled for this connection. Review locally, or enable remote approval in Chat Connections for the bound controller. Saying yes is not an approval command.'
              : q.payload.action === 'resolve-effect'
                ? 'Recovery inspection requires local review.'
                : payload.length > 6500
                  ? 'The full operation exceeds the remote review size limit. Review locally.'
                  : 'The operation may contain credentials; review locally.'),
        );
        continue;
      }
      this.reply(
        c,
        'approval:' + q.id + ':' + code,
        (q.kind === 'approval'
          ? chatApprovalSummary(q.payload) +
            `\n有效期：${remoteReviewPolicy(c).label}（包含发送耗时）；超时不执行。` +
            '\n查看全文：' +
            (c.peerType === 'group' ? (c.groupPrefix || '/amadeus') + ' ' : '') +
            '/details ' +
            code +
            '\n'
          : `Amadeus ${q.kind}\n${payload}\nValid for ${remoteReviewPolicy(c).label}.\n`) +
          (c.peerType === 'group'
            ? 'In this group prefix commands with ' + (c.groupPrefix || '/amadeus') + ' .\n'
            : '') +
          (q.kind === 'approval'
            ? '同意／拒绝：复制下方对应命令发送。'
            : `/answer ${code} your answer`),
      );
      if (q.kind === 'approval') {
        const prefix = c.peerType === 'group' ? (c.groupPrefix || '/amadeus') + ' ' : '';
        this.reply(c, 'approval-allow:' + q.id + ':' + code, prefix + '/approve ' + code);
        this.reply(c, 'approval-deny:' + q.id + ':' + code, prefix + '/deny ' + code);
        if (canRememberApproval(q.payload)) {
          this.reply(
            c,
            'approval-scope:' + q.id + ':' + code,
            '可选：本次允许，并记住以下范围：' +
              rememberedApprovalScope(q.payload) +
              '\n查看 /grants；撤销 /revoke-grants（群聊需加触发前缀）。',
          );
          this.reply(
            c,
            'approval-remember:' + q.id + ':' + code,
            prefix + '/allow-similar ' + code,
          );
        }
      }
    }
  }
  private answer(c: ChatConnection, action: string, code: string, text: string, now: number) {
    assert(c.remoteApprovals, 'CHAT_APPROVAL', 'Remote approvals disabled.');
    this.authorize(c);
    const ticket = this.store.db
      .prepare('SELECT * FROM chat_approval WHERE code=? AND connection_id=?')
      .get(code, c.id) as any;
    if (action === 'renew') {
      assert(
        ticket &&
          !ticket.used &&
          ticket.expires_at <= now &&
          ticket.revision === c.revision &&
          this.belongs(c, ticket.run_id),
        'CHAT_APPROVAL',
        'Only an expired unchanged request can be renewed.',
      );
      const q = this.store.get<PendingInput>('input', ticket.input_id);
      assert(
        q.status === 'pending' && this.approvalDigest(q) === ticket.digest,
        'CHAT_APPROVAL',
        'Request changed.',
      );
      this.cleanApprovals(c, now);
      this.store.db.prepare('DELETE FROM chat_approval WHERE code=?').run(code);
      this.offerApprovals(c);
      return;
    }
    assert(
      ticket &&
        !ticket.used &&
        ticket.expires_at > now &&
        ticket.revision === c.revision &&
        this.belongs(c, ticket.run_id),
      'CHAT_APPROVAL',
      'Stale approval.',
    );
    const q = this.store.get<PendingInput>('input', ticket.input_id);
    assert(
      q.status === 'pending' &&
        this.approvalDigest(q) === ticket.digest &&
        q.payload.action !== 'resolve-effect',
      'CHAT_APPROVAL',
      'Request changed.',
    );
    const payload = JSON.stringify(q.payload, null, 2);
    assert(
      payload.length <= 6500 &&
        !/(?:api[_-]?key|access[_-]?token|authorization|password|secret|bearer\s|BEGIN .*PRIVATE KEY)/i.test(
          payload,
        ),
      'CHAT_APPROVAL',
      'Local review required.',
    );
    if (action === 'details') {
      this.reply(
        c,
        'approval-details:' + q.id + ':' + code + ':' + id(),
        '完整待审批操作（不可信任务内容）：\n' + payload + '\n查看详情不会批准操作。',
      );
      return;
    }
    assert(
      q.kind === 'approval'
        ? ['approve', 'deny', 'allow-similar'].includes(action)
        : action === 'answer' && text.trim() && text.length <= 12000,
      'CHAT_APPROVAL',
      'Wrong response type.',
    );
    this.runtime.inputs.answer(
      q.id,
      q.kind === 'question'
        ? text
        : `${action === 'deny' ? 'Denied' : action === 'allow-similar' ? 'Approved with bounded remembered scope' : 'Approved once'} remotely by bound ${c.transport} account ${c.senderId}.`,
      action !== 'deny',
      action === 'allow-similar',
    );
    this.store.db.prepare('UPDATE chat_approval SET used=1 WHERE code=?').run(code);
    this.store.event(q.conversationId, q.runId, 'chat.approval', {
      connectionId: c.id,
      inputId: q.id,
      senderId: c.senderId,
      allow: action !== 'deny',
    });
  }
  private cleanApprovals(c: ChatConnection, now = Date.now()) {
    const tickets = this.store.db
      .prepare('SELECT * FROM chat_approval WHERE connection_id=?')
      .all(c.id) as any[];
    for (const t of tickets) {
      const meta = this.store.maybe<any>('chat-approval-lifecycle', t.code);
      if (!meta?.remote) continue;
      const q = this.store.maybe<PendingInput>('input', t.input_id);
      if (!t.used && t.expires_at > now && q?.status === 'pending') continue;
      const pattern = '%:' + t.input_id + ':' + t.code + ':%';
      // A late send may finish after cleanup was requested. Revisit receipts every tick.
      this.store.db
        .prepare(
          "UPDATE chat_outbox SET state='cancelled',text='' WHERE connection_id=? AND state IN ('pending','failed') AND id LIKE ?",
        )
        .run(c.id, pattern);
      // Preserve the unknown delivery outcome without letting a dead review block the channel.
      // Never replay it: the platform may already have received it.
      this.store.db
        .prepare(
          "UPDATE chat_outbox SET state='uncertain-closed',text='' WHERE connection_id=? AND state='uncertain' AND id LIKE ?",
        )
        .run(c.id, pattern);
      if (t.used || q?.status !== 'pending') {
        // A failed expiry notice is obsolete once the local review is resolved too.
        this.store.db
          .prepare(
            "UPDATE chat_outbox SET state=CASE WHEN state='uncertain' THEN 'uncertain-closed' ELSE 'cancelled' END,text='' WHERE connection_id=? AND state IN ('pending','uncertain','failed') AND id LIKE ?",
          )
          .run(c.id, 'approval-expired:' + t.code + ':%');
      }
      if (remoteReviewPolicy(c).cleanup)
        this.store.db
          .prepare(
            "UPDATE chat_delivery SET state='cleanup-pending' WHERE connection_id=? AND state='sent' AND id LIKE ?",
          )
          .run(c.id, pattern);
      if (!meta.closed) {
        this.store.put('chat-approval-lifecycle', { ...meta, closed: true });
        if (!t.used && q?.status === 'pending') {
          const prefix = c.peerType === 'group' ? (c.groupPrefix || '/amadeus') + ' ' : '';
          this.reply(
            c,
            'approval-expired:' + t.code,
            '审批码已超时，未批准操作。本地请求仍保留；重新获取：' +
              prefix +
              '/renew ' +
              t.code +
              (remoteReviewPolicy(c).cleanup
                ? '。将尝试撤回旧审批消息，平台拒绝时消息可能保留。'
                : '。此平台暂不支持自动撤回。'),
          );
        }
      }
    }
  }
  tick(now = Date.now()) {
    for (const c of this.list()) {
      if (!c.enabled) continue;
      try {
        this.authorize(c);
      } catch {
        this.pause(c.id);
        this.store.put('chat-transport-state', {
          id: c.id,
          status: 'reauthorize',
          error: 'Conversation changed. Review and save again.',
        });
        continue;
      }
      this.cleanApprovals(c);
      this.offerApprovals(c);
      this.queueFiles(c);
      const rows = this.store.db
        .prepare(
          "SELECT * FROM chat_inbox WHERE connection_id=? AND state IN ('dispatching','running') ORDER BY received_at LIMIT 20",
        )
        .all(c.id) as any[];
      for (const row of rows) {
        const run = row.run_id ? this.store.maybeRunHeader(row.run_id) : undefined;
        if (!run) {
          this.store.db
            .prepare("UPDATE chat_inbox SET state='uncertain',text='' WHERE id=?")
            .run(row.id);
          this.reply(
            c,
            row.id,
            'Task dispatch was interrupted. Inspect the local conversation before resending.',
          );
          continue;
        }
        if (terminal(run.status)) {
          if (
            continueChatTranscription(this.store, c, row, run, (key, text) =>
              this.reply(c, key, text),
            )
          )
            continue;
          const result = this.store
            .eventsForRun(run.id, ['assistant.message'])
            .filter((e) => e.data.final && !e.data.incomplete)
            .at(-1);
          const proactive = this.store.maybe<{ createdAt: number }>('chat-proactive-run', run.id);
          const noReply =
            !!result?.data.text && chatPlainText(result.data.text).trim() === '[NO_REPLY]';
          const scheduled = this.store.maybe<any>('chat-scheduled-run', run.id);
          const report = this.store.maybe<any>('schedule-report', run.id);
          const scheduleSilent =
            scheduled &&
            (scheduled.notifications === 'off' ||
              (scheduled.notifications === 'meaningful' &&
                report?.outcome === 'unchanged' &&
                run.status === 'completed') ||
              (scheduled.notifications === 'failures' && run.status === 'completed'));
          const silent =
            !!scheduleSilent ||
            (!!proactive &&
              (!result?.data.text || noReply || this.groups.superseded(c, proactive.createdAt)));
          let plan = this.store.maybe<any>('chat-reply-plan', run.id);
          if (plan) {
            try {
              if (plan.connectionId !== c.id || plan.revision !== c.revision)
                throw Error('Changed target');
              validateReplyPlan(this.store, c, plan);
            } catch {
              plan = undefined;
              this.store.event(c.conversationId, run.id, 'chat.reply.warning', {
                reason: 'Reply metadata expired or target changed; sent text only.',
              });
            }
          }
          if (
            !proactive &&
            !plan?.mediaOnly &&
            c.peerType === 'group' &&
            ['onebot11', 'onebot12'].includes(c.transport) &&
            row.sender_id &&
            !plan?.mentions?.length
          ) {
            const targeted = { ...plan, mentions: [row.sender_id] };
            try {
              validateReplyPlan(this.store, c, targeted);
              plan = targeted;
            } catch {
              /* Expired/unknown recipients are never guessed. */
            }
          }
          if (!silent && plan)
            for (const reference of plan.references || [])
              this.store.db
                .prepare(
                  'INSERT OR IGNORE INTO chat_outbox(id,connection_id,state,text,created_at,reference) VALUES(?,?,?,?,?,?)',
                )
                .run(c.id + ':' + reference, c.id, 'pending', '', Date.now(), reference);
          if (!silent) {
            const jobs = new Map<string, any>();
            for (const event of this.store.eventsForRun(run.id, ['media.updated'])) {
              const job = event.data.job;
              if (
                job?.runId === run.id &&
                job.kind !== 'transcription' &&
                job.purpose !== 'read-aloud'
              )
                jobs.set(job.id, job);
            }
            const deliverable =
              !!plan?.references?.length ||
              this.store
                .eventsForRun(run.id, ['file.attached'])
                .some((e) => e.data.attachment?.id) ||
              [...jobs.values()].some(
                (j) =>
                  ['submitting', 'queued', 'running'].includes(j.status) ||
                  (j.status === 'completed' && j.outputs?.length),
              );
            if (plan?.mediaOnly && deliverable) {
              const pendingJobs = [...jobs.values()]
                .filter((j) => ['submitting', 'queued', 'running'].includes(j.status))
                .map((j) => j.id);
              if (pendingJobs.length)
                this.store.put('chat-media-only-run', {
                  id: run.id,
                  connectionId: c.id,
                  jobIds: pendingJobs,
                });
            } else {
              const texts: string[] = plan?.mediaOnly
                ? ['未能生成可发送的媒体，请稍后重试。']
                : plan?.messages || [
                    noReply
                      ? '收到你的消息了，但这次未生成有效答复。请重新提问或说明希望我回应的内容。'
                      : result?.data.text
                        ? chatPlainText(result.data.text)
                        : `Task ${run.status}. Inspect the local conversation for details.`,
                  ];
              for (const [index, message] of texts.entries())
                this.reply(
                  c,
                  row.id + ':message:' + index,
                  chatPlainText(message),
                  index === 0 && !plan?.mediaOnly ? plan : undefined,
                );
            }
          }
          this.store.db
            .prepare("UPDATE chat_inbox SET state='done',text='' WHERE id=?")
            .run(row.id);
          this.store.remove('chat-reply-plan', run.id);
        } else if (
          ['waiting_user', 'waiting_approval'].includes(run.status) &&
          row.notice !== run.status &&
          !this.store.db
            .prepare('SELECT 1 FROM chat_approval WHERE connection_id=? AND run_id=?')
            .get(c.id, run.id)
        ) {
          this.reply(
            c,
            row.id + ':' + run.status,
            'Action required in Amadeus on your computer: ' +
              run.status +
              '. Remote chat cannot grant new permissions.',
          );
          this.store.db
            .prepare('UPDATE chat_inbox SET notice=? WHERE id=?')
            .run(run.status, row.id);
        }
      }
      if (this.runtime.active(c.conversationId)) continue;
      const next = this.store.db
        .prepare(
          "SELECT * FROM chat_inbox WHERE connection_id=? AND state='queued' ORDER BY received_at,id LIMIT 1",
        )
        .get(c.id) as any;
      if (!next) {
        const waiting = this.store.db
          .prepare(
            "SELECT 1 FROM chat_inbox WHERE connection_id=? AND state IN ('receiving','downloading','dispatching','running') LIMIT 1",
          )
          .get(c.id);
        if (!waiting && this.groups.consume(c)) {
          const runId = id(),
            keyId = 'group-observation:' + runId;
          this.store.put('chat-proactive-run', { id: runId, createdAt: Date.now() });
          this.store.db
            .prepare(
              'INSERT INTO chat_inbox(id,connection_id,received_at,state,text,run_id,notice) VALUES(?,?,?,?,?,?,?)',
            )
            .run(keyId, c.id, Date.now(), 'dispatching', '', runId, 'proactive');
          try {
            this.runtime.start(
              c.conversationId,
              'This is an unsolicited participation check, not a request from the controller or a particular member. Media notifications are not requests to inspect or describe images. Decide whether a brief reply is useful now. Do not chatter, repeat others, or start tasks. If not useful, output exactly [NO_REPLY]. Do not create media, schedule tasks, or execute actions.\n' +
                remoteConversationStyle +
                this.groups.text(c),
              0,
              { runId, attachmentIds: [] },
            );
            this.store.db.prepare("UPDATE chat_inbox SET state='running' WHERE id=?").run(keyId);
          } catch {
            this.store.db.prepare("UPDATE chat_inbox SET state='uncertain' WHERE id=?").run(keyId);
          }
        }
        continue;
      }
      const earlier = this.store.db
        .prepare(
          "SELECT 1 FROM chat_inbox WHERE connection_id=? AND state IN ('receiving','downloading') AND received_at<=? LIMIT 1",
        )
        .get(c.id, next.received_at);
      if (earlier) continue;
      // Coalesce only contiguous queued text from the same sender. Media, commands,
      // another sender and older bursts are boundaries; keep original receipts intact.
      const burst = [next];
      let burstChars = next.text.length;
      if (!next.media && next.attachment_ids === '[]') {
        const following = this.store.db
          .prepare(
            'SELECT * FROM chat_inbox WHERE connection_id=? AND (received_at>? OR (received_at=? AND id>?)) ORDER BY received_at,id LIMIT 7',
          )
          .all(c.id, next.received_at, next.received_at, next.id) as any[];
        for (const row of following) {
          if (
            row.state !== 'queued' ||
            row.sender_id !== next.sender_id ||
            row.media ||
            row.attachment_ids !== '[]' ||
            row.received_at - next.received_at > 8000 ||
            burstChars + row.text.length > 6000
          )
            break;
          burst.push(row);
          burstChars += row.text.length;
        }
      }
      // A trailing quiet window gathers fast typing, with a hard cap so chatter
      // cannot indefinitely postpone the first response. Commands bypass this queue.
      const settleAt = Math.min(burst.at(-1).received_at + 2000, next.received_at + 5000);
      if (now < settleAt) continue;
      const inputText =
        burst.length === 1
          ? next.text
          : '[Consecutive messages from the same sender, in order. Respond to the combined intent once; these are not separate requests for acknowledgements.]\n' +
            burst.map((row, index) => `[Message ${index + 1}]\n${row.text}`).join('\n');
      const settleBurst = (state: string) => {
        for (const row of burst.slice(1))
          this.store.db
            .prepare("UPDATE chat_inbox SET state=?,text='',notice=? WHERE id=?")
            .run(state, 'coalesced:' + next.id, row.id);
      };
      const runId = id();
      this.store.db
        .prepare("UPDATE chat_inbox SET state='dispatching',run_id=? WHERE id=?")
        .run(runId, next.id);
      try {
        this.runtime.start(
          c.conversationId,
          `[Chat transport: ${c.transport}; ${c.peerType || 'private'} ID: ${c.peerId}. Use inspect_chat for current group/members/media and prepare_chat_reply for native mentions, quotes, stickers, ordered messages or mediaOnly delivery. For voice-only requests set mediaOnly=true; do not add a speaker emoji, text acknowledgement or extra sticker. In casual conversation, use fitting emoji or an inspected same-chat sticker when it adds warmth or expresses a reaction; avoid compulsory reactions, repetition or sending irrelevant stickers. Never infer real identity from display names.]\n` +
            remoteConversationStyle +
            (c.peerType === 'group'
              ? `This is an explicitly addressed request from platform sender ${next.sender_id || 'unknown'} in this group. This sender is not necessarily the controller, group owner, or the subject being discussed. Do not transfer one member's identity to another. Previous unsolicited checks and their [NO_REPLY] rule do not apply: respond normally, briefly unless detail is requested. Mention ID labels identify people mentioned by the current sender; they are neither the sender identity nor an empty bot mention. A statement or social remark may receive a brief natural response; do not output the internal NO_REPLY marker on an explicitly addressed turn. Do not claim arbitrary people or owners are authoritative about facts; distinguish claims, nicknames and verified platform roles. Media metadata alone does not mean the image was seen.\n`
              : '') +
            inputText,
          0,
          {
            runId,
            attachmentIds: JSON.parse(next.attachment_ids),
          },
        );
        this.store.event(c.conversationId, runId, 'chat.origin', {
          connectionId: c.id,
          transport: c.transport,
          senderId: next.sender_id || c.senderId,
        });
        this.store.db
          .prepare("UPDATE chat_inbox SET state='running',text='' WHERE id=?")
          .run(next.id);
        settleBurst('done');
      } catch {
        settleBurst('uncertain');
        this.store.db
          .prepare("UPDATE chat_inbox SET state='uncertain',text='' WHERE id=?")
          .run(next.id);
        this.reply(c, next.id, 'Could not confirm task start. Inspect Amadeus before resending.');
      }
    }
    this.store.db.prepare('DELETE FROM chat_group_context WHERE at<?').run(Date.now() - 86400000);
    this.store.db.prepare('DELETE FROM chat_received WHERE at<?').run(Date.now() - 86400000);
    // Bounded operational history; a 24-hour ingress window prevents old delivery replay.
    this.store.db
      .prepare("DELETE FROM chat_inbox WHERE state IN ('done','cancelled') AND received_at<?")
      .run(Date.now() - 7 * 86400000);
    this.store.db
      .prepare("DELETE FROM chat_outbox WHERE state='sent' AND created_at<?")
      .run(Date.now() - 7 * 86400000);
  }
  private queueFiles(c: ChatConnection) {
    const last = this.store.maybe<any>('chat-file-cursor', c.id)?.eventId || 0;
    const events = this.store.db
      .prepare(
        "SELECT e.id,e.type,e.data,e.run_id FROM events e JOIN chat_inbox i ON e.run_id=i.run_id WHERE i.connection_id=? AND e.id>? AND e.type IN ('file.attached','media.updated') ORDER BY e.id LIMIT 100",
      )
      .all(c.id, last) as any[];
    for (const event of events) {
      const scheduled = this.store.maybe<any>('chat-scheduled-run', event.run_id);
      if (scheduled) {
        const run = this.store.maybeRunHeader(event.run_id);
        // Wait for the run report before deciding whether its media should notify.
        if (!run || !terminal(run.status)) break;
        const report = this.store.maybe<any>('schedule-report', event.run_id);
        if (
          scheduled.notifications === 'off' ||
          (run.status === 'completed' &&
            (scheduled.notifications === 'failures' ||
              (scheduled.notifications === 'meaningful' && report?.outcome === 'unchanged')))
        ) {
          this.store.put('chat-file-cursor', { id: c.id, eventId: event.id });
          continue;
        }
      }
      const data = JSON.parse(event.data);
      if (
        event.type === 'media.updated' &&
        ['completed', 'failed', 'cancelled', 'unknown'].includes(data.job?.status)
      ) {
        const mode = this.store.maybe<any>('chat-media-only-run', event.run_id);
        if (mode?.connectionId === c.id && mode.jobIds.includes(data.job.id)) {
          if (data.job.status !== 'completed' || !data.job.outputs?.length)
            this.reply(c, 'media-only-failed:' + data.job.id, '媒体生成未成功完成，请稍后重试。');
          const remaining = mode.jobIds.filter((id: string) => id !== data.job.id);
          if (remaining.length)
            this.store.put('chat-media-only-run', { ...mode, jobIds: remaining });
          else this.store.remove('chat-media-only-run', event.run_id);
        }
      }
      let files: { reference: string; name: string }[] = [];
      if (event.type === 'file.attached' && data.attachment?.id)
        files = [{ reference: 'attachment:' + data.attachment.id, name: data.attachment.name }];
      if (
        event.type === 'media.updated' &&
        data.job?.status === 'completed' &&
        data.job.runId === event.run_id
      )
        files = (data.job.outputs || []).map((o: any) => ({
          reference: 'media:' + data.job.id + ':' + o.id,
          name: o.name,
        }));
      for (const file of files)
        this.store.db
          .prepare(
            'INSERT OR IGNORE INTO chat_outbox (id,connection_id,state,text,created_at,reference) VALUES(?,?,?,?,?,?)',
          )
          .run(c.id + ':' + file.reference, c.id, 'pending', file.name, Date.now(), file.reference);
      this.store.put('chat-file-cursor', { id: c.id, eventId: event.id });
    }
  }
  private connectionStatus(c: ChatConnection) {
    const own = this.store.maybe<any>('chat-transport-state', c.id);
    if (!c.enabled)
      return own?.status === 'reauthorize' ? own : { status: 'paused', reason: 'manual' };
    if (own) return own;
    const peer = this.list().find(
      (x) =>
        x.id !== c.id &&
        x.enabled &&
        x.transport === c.transport &&
        x.accountId === c.accountId &&
        x.endpoint === c.endpoint &&
        this.secrets(x.id).token === this.secrets(c.id).token &&
        this.store.maybe<any>('chat-transport-state', x.id)?.status === 'connected',
    );
    return peer ? { status: 'connected', sharedTransport: true } : { status: 'connecting' };
  }
  overview() {
    return this.list().map((c) => ({
      ...c,
      authorizedTarget: undefined,
      status: this.connectionStatus(c),
      deliveries: this.store.db
        .prepare(
          'SELECT state,count(*) AS count FROM chat_outbox WHERE connection_id=? GROUP BY state',
        )
        .all(c.id),
      queued: (
        this.store.db
          .prepare("SELECT count(*) AS n FROM chat_inbox WHERE connection_id=? AND state='queued'")
          .get(c.id) as any
      ).n,
    }));
  }
}
