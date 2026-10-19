import { ChatFriendReview } from './chat-friend-review.js';
import { registerChatInteraction } from './chat-interaction.js';
import {
  downloadChatBytes,
  decryptWecomFile,
  storeChatAttachment,
  chatMediaLimit,
} from './chat-media.js';
import type { ChatRemoteFile } from '../../shared/chat-connections.js';
import { createServer, type Server } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import type { ChatConnection, ChatSecrets } from '../../shared/chat-connections.js';
import { chatSenderAllowed } from './chat-access.js';
import { ChatConnections } from './chat-connections.js';
import {
  equalSecret,
  incoming,
  onebotAction,
  whatsappSignature,
  qqSign,
  qqVerify,
} from './chat-protocols.js';
import { assert } from '../core/errors.js';
async function json(url: string, init: RequestInit = {}) {
  const response = await fetch(url, {
    ...init,
    redirect: 'error',
    signal: init.signal || AbortSignal.timeout(35000),
  });
  // Never include credential-bearing URLs or provider response bodies in user-visible errors.
  if (!response.ok) throw Error('Platform HTTP ' + response.status);
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (!reader) throw Error('Empty platform response');
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    size += r.value.length;
    if (size > 2 * 1024 * 1024) {
      await reader.cancel();
      throw Error('Platform response too large');
    }
    chunks.push(r.value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
type Session = {
  revision: number;
  abort: AbortController;
  socket?: WebSocket;
  polling?: Promise<void>;
  sending: boolean;
  lastDelivery?: string;
  downloading?: boolean;
  querying?: number;
  nextPoll: number;
  nextSend: number;
  pending: Map<string, { resolve: (v: any) => void; reject: () => void }>;
  vk?: { server: string; key: string; ts: string };
  openingAt?: number;
  ready?: boolean;
  heartbeat?: ReturnType<typeof setInterval>;
  lastAck?: number;
  qqToken?: { value: string; expires: number };
};
export class ChatTransports {
  private timer?: ReturnType<typeof setInterval>;
  private sessions = new Map<string, Session>();
  private webhooks = new Map<number, Server>();
  private closed = false;
  private mediaActive = 0;
  private jobs = new Set<Promise<unknown>>();
  private track(job: Promise<unknown>) {
    this.jobs.add(job);
    void job.then(
      () => this.jobs.delete(job),
      () => this.jobs.delete(job),
    );
  }
  private friends: ChatFriendReview;
  constructor(readonly channels: ChatConnections) {
    this.friends = new ChatFriendReview(channels);
    registerChatInteraction(channels, {
      query: (c, k) => this.queryChat(c, k),
      importMedia: (c, m) => this.importChatMedia(c, m),
    });
  }
  private chatSession(c: ChatConnection) {
    this.channels.authorize(c);
    const owner = this.channels
      .list()
      .filter((r) => r.enabled && this.accountKey(r) === this.accountKey(c))
      .sort((a, b) => a.id.localeCompare(b.id))[0];
    const s = owner ? this.sessions.get(owner.id) : undefined;
    assert(s && this.current(c, s), 'CHAT_OFFLINE', 'Current chat transport is offline.');
    return s;
  }
  private async queryChat(c: ChatConnection, kind: 'info' | 'members') {
    assert(
      c.peerType === 'group' && ['onebot11', 'onebot12'].includes(c.transport),
      'CHAT_UNSUPPORTED',
      'This adapter does not expose group/member queries.',
    );
    const s = this.chatSession(c);
    s.querying = (s.querying || 0) + 1;
    let data: any;
    try {
      data = await this.socketRequest(
        c,
        s,
        kind === 'info' ? 'get_group_info' : 'get_group_member_list',
        { group_id: c.transport === 'onebot11' ? Number(c.peerId) : c.peerId },
      );
    } finally {
      s.querying--;
    }
    assert(this.current(c, s), 'CHAT_CHANGED', 'Connection changed during query.');
    if (kind === 'info') {
      assert(String(data?.group_id) === c.peerId, 'CHAT_SCOPE', 'Platform returned another group.');
      return {
        id: c.peerId,
        name: String(data.group_name || '').slice(0, 200),
        memberCount: data.member_count,
        source: 'platform',
      };
    }
    assert(
      Array.isArray(data) && data.length <= 20000,
      'CHAT_MEMBERS',
      'Invalid or oversized member response.',
    );
    return data.map((m: any) => {
      assert(
        m.group_id === undefined || String(m.group_id) === c.peerId,
        'CHAT_SCOPE',
        'Platform returned another group.',
      );
      return {
        id: String(m.user_id),
        name: String(m.nickname || m.user_name || '').slice(0, 200),
        card: String(m.card || m.user_displayname || '').slice(0, 200),
        role: ['owner', 'admin', 'member'].includes(m.role) ? m.role : 'unknown',
      };
    });
  }
  private mediaImports = new Map<string, Promise<string[]>>();
  private async importChatMedia(c: ChatConnection, messageId: string): Promise<string[]> {
    const s = this.chatSession(c),
      store = this.channels.store;
    let envelope = store.db
      .prepare('SELECT payload FROM chat_received WHERE connection_id=? AND message_id=? AND at>?')
      .get(c.id, messageId, Date.now() - 86400000) as any;
    if (!envelope && c.transport === 'onebot11' && c.peerType === 'group') {
      // Only recover IDs already received in this route, never arbitrary historical messages.
      const observed = store.db
        .prepare(
          'SELECT sender FROM chat_group_context WHERE connection_id=? AND message_id=? AND at>?',
        )
        .get(c.id, messageId, Date.now() - 86400000) as any;
      assert(observed, 'CHAT_MEDIA_SCOPE', 'Message was not observed in this group.');
      const raw = await this.socketRequest(c, s, 'get_msg', { message_id: messageId });
      assert(
        this.current(c, s) &&
          raw?.message_type === 'group' &&
          String(raw.group_id) === c.peerId &&
          String(raw.message_id) === messageId &&
          String(raw.user_id ?? raw.sender?.user_id) === observed.sender,
        'CHAT_MEDIA_SCOPE',
        'Recovered message does not match the observed group, message and sender.',
      );
      const parsed = incoming(c, {
        ...raw,
        post_type: 'message',
        self_id: c.accountId,
        user_id: raw.user_id ?? raw.sender?.user_id,
      })[0];
      assert(
        parsed && chatSenderAllowed(c, parsed),
        'CHAT_MEDIA_SCOPE',
        'Recovered message is not permitted.',
      );
      envelope = { payload: JSON.stringify(parsed) };
      store.db
        .prepare('INSERT OR IGNORE INTO chat_received VALUES(?,?,?,?,?)')
        .run(c.id, messageId, parsed.senderId, envelope.payload, Date.now());
    }
    assert(envelope, 'CHAT_MEDIA_SCOPE', 'Message is not available in this chat.');
    const m = JSON.parse(envelope.payload),
      key = createHash('sha256')
        .update(c.id + '\0' + messageId)
        .digest('hex');
    assert(m.media?.length, 'CHAT_MEDIA_EMPTY', 'Message contains no downloadable media.');
    const existing = store.db.prepare('SELECT * FROM chat_inbox WHERE id=?').get(key) as any;
    if (existing?.attachment_ids && JSON.parse(existing.attachment_ids).length)
      return JSON.parse(existing.attachment_ids).map((id: string) => 'attachment:' + id);
    if (this.mediaImports.has(key)) return this.mediaImports.get(key)!;
    assert(
      !existing || existing.state === 'media-failed',
      'CHAT_MEDIA_PENDING',
      'Media is already being imported; retry after completion.',
    );
    assert(
      this.mediaImports.size < 2 && !s.downloading,
      'CHAT_MEDIA_BUSY',
      'Media import capacity reached.',
    );
    store.db
      .prepare(
        "INSERT OR REPLACE INTO chat_inbox(id,connection_id,received_at,state,text,media,notice) VALUES(?,?,?,'receiving','',?,'context-only')",
      )
      .run(key, c.id, Date.now(), JSON.stringify(m.media));
    const job = (async () => {
      s.downloading = true;
      await this.receiveMedia(c, s, {
        id: key,
        media: JSON.stringify(m.media),
        notice: 'context-only',
      });
      const row = store.db
        .prepare('SELECT state,attachment_ids FROM chat_inbox WHERE id=?')
        .get(key) as any;
      assert(
        row?.state === 'done',
        'CHAT_MEDIA_IMPORT',
        'Attachment import failed; no content was inspected.',
      );
      const ids: string[] = JSON.parse(row.attachment_ids);
      const event = store.event(c.conversationId, null, 'chat.media.imported', {
        messageId,
        attachmentIds: ids,
      });
      for (const id of ids) {
        const a = store.get<any>('attachment', id);
        store.put('attachment', { ...a, messageEventId: event.id });
      }
      return ids.map((id) => 'attachment:' + id);
    })();
    this.mediaImports.set(key, job);
    this.track(job);
    try {
      return await job;
    } finally {
      this.mediaImports.delete(key);
      s.downloading = false;
    }
  }
  start() {
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch {
        for (const c of this.channels.list().filter((c) => c.enabled))
          this.status(c, 'error', 'Chat dispatcher failed; inspect local configuration.');
      }
    }, 1000);
    this.timer.unref();
  }
  private current(c: ChatConnection, s: Session) {
    const latest = this.channels.store.maybe<ChatConnection>('chat-connection', c.id);
    return (
      !this.closed && !s.abort.signal.aborted && latest?.enabled && latest.revision === c.revision
    );
  }
  private status(c: ChatConnection, status: string, error?: string) {
    if (this.closed) return;
    const prior = this.channels.store.maybe<any>('chat-transport-state', c.id);
    if (prior?.status === status && prior?.error === error) return;
    this.channels.store.put('chat-transport-state', {
      id: c.id,
      status,
      error,
      updatedAt: Date.now(),
    });
  }
  private stop(s: Session) {
    s.abort.abort();
    clearInterval(s.heartbeat);
    s.socket?.close();
    for (const p of s.pending.values()) p.reject();
    s.pending.clear();
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    for (const s of this.sessions.values()) this.stop(s);
    for (const server of this.webhooks.values()) {
      server.closeAllConnections();
      server.close();
    }
    await Promise.allSettled([...this.sessions.values()].map((s) => s.polling));
    await Promise.allSettled([...this.jobs]);
    this.sessions.clear();
  }
  private accountKey(c: ChatConnection) {
    return createHash('sha256')
      .update(
        JSON.stringify([c.transport, c.accountId, c.endpoint, this.channels.secrets(c.id).token]),
      )
      .digest('hex');
  }
  private accept(c: ChatConnection, s: Session, event: any) {
    if (!this.current(c, s)) return;
    const account = this.accountKey(c);
    for (const route of this.channels
      .list()
      .filter((r) => r.enabled && this.accountKey(r) === account)) {
      try {
        this.friends.observe(route, event);
        this.channels.enrollInvitedGroup(route, event);
      } catch {
        this.status(route, 'group-enrollment-failed', 'Group authorization needs local review.');
      }
      this.acceptRoute(route, s, event);
    }
  }
  private acceptRoute(c: ChatConnection, s: Session, event: any) {
    if (!this.current(c, s)) return;
    for (const m of incoming(c, event)) {
      if (!chatSenderAllowed(c, m)) continue;
      try {
        if (this.friends.matches(c, m)) {
          this.track(
            this.friends
              .answer(c, m, (action, params) => {
                if (!this.current(c, s)) return Promise.reject(Error('Connection changed'));
                return this.socketRequest(c, s, action, params);
              })
              .catch(() =>
                this.status(c, 'friend-review-failed', 'Friend review needs local inspection.'),
              ),
          );
          continue;
        }
        const result = this.channels.receive(c.id, m);
        if (c.transport === 'qq' && result !== 'duplicate' && result !== 'ignored')
          this.channels.store.put('chat-qq-reply', {
            id: c.id,
            messageId: m.id,
            receivedAt: m.timestamp,
            sequence: 0,
          });
      } catch (error) {
        // Reject malformed/stale/over-limit input, never reflect untrusted text or secrets.
        this.status(
          c,
          'input-rejected',
          error instanceof Error && 'code' in error ? String(error.code) : 'Invalid message',
        );
      }
    }
  }
  tick() {
    if (this.closed) return;
    this.channels.tick();
    const connections = this.channels.list();
    const owners = new Map<string, ChatConnection>();
    for (const c of connections.filter((c) => c.enabled).sort((a, b) => a.id.localeCompare(b.id)))
      if (!owners.has(this.accountKey(c))) owners.set(this.accountKey(c), c);
    const ownerFor = (c: ChatConnection) => owners.get(this.accountKey(c))!;
    for (const [key, s] of this.sessions)
      if (
        !connections.some(
          (c) => c.id === key && c.enabled && c.revision === s.revision && ownerFor(c)?.id === key,
        )
      ) {
        this.stop(s);
        this.sessions.delete(key);
      }
    const ports = new Set(
      connections
        .filter((c) => c.enabled && ['whatsapp', 'qq'].includes(c.transport))
        .map((c) => c.webhookPort),
    );
    for (const [port, server] of this.webhooks)
      if (!ports.has(port)) {
        server.closeAllConnections();
        server.close();
        this.webhooks.delete(port);
      }
    const enabled = connections.filter((c) => c.enabled).sort((a, b) => a.id.localeCompare(b.id));
    const order = enabled
      .filter((c) => c.id !== this.sessions.get(ownerFor(c).id)?.lastDelivery)
      .concat(enabled.filter((c) => c.id === this.sessions.get(ownerFor(c).id)?.lastDelivery));
    for (const c of order) {
      const owner = ownerFor(c);
      let s = this.sessions.get(owner.id);
      if (!s) {
        s = {
          revision: owner.revision,
          abort: new AbortController(),
          sending: false,
          nextPoll: 0,
          nextSend: 0,
          pending: new Map(),
        };
        this.sessions.set(owner.id, s);
      }
      if (['whatsapp', 'qq'].includes(c.transport)) this.listen(c.webhookPort);
      else if (c.transport.startsWith('onebot') || c.transport === 'wecom')
        this.connectSocket(owner, s);
      else if (
        c.id === owner.id &&
        ['telegram', 'vk'].includes(c.transport) &&
        !s.polling &&
        Date.now() >= s.nextPoll
      ) {
        const session = s;
        s.polling = this.poll(c, s)
          .catch(() => {
            if (this.current(c, session)) {
              session.nextPoll = Date.now() + 10000;
              this.status(
                c,
                'disconnected',
                'Polling failed; check credentials, network and platform configuration. Retrying.',
              );
            }
          })
          .finally(() => {
            session.polling = undefined;
          });
      }
      if (
        !s.downloading &&
        this.mediaActive < 2 &&
        (!(c.transport.startsWith('onebot') || c.transport === 'wecom') ||
          s.socket?.readyState === WebSocket.OPEN)
      ) {
        const row = this.channels.store.db
          .prepare(
            "SELECT * FROM chat_inbox WHERE connection_id=? AND state='receiving' ORDER BY received_at,id LIMIT 1",
          )
          .get(c.id) as any;
        if (row) {
          s.downloading = true;
          this.mediaActive++;
          const session = s;
          this.track(
            this.receiveMedia(c, s, row).finally(() => {
              session.downloading = false;
              this.mediaActive--;
            }),
          );
        }
      }
      if (
        !s.sending &&
        (
          this.channels.store.db
            .prepare(
              "SELECT state FROM chat_outbox WHERE connection_id=? AND state<>'sent' ORDER BY created_at,rowid LIMIT 1",
            )
            .get(c.id) as any
        )?.state === 'pending' &&
        Date.now() >= s.nextSend &&
        (!(c.transport.startsWith('onebot') || c.transport === 'wecom') ||
          (s.socket?.readyState === WebSocket.OPEN && (c.transport !== 'wecom' || s.ready)))
      ) {
        s.sending = true;
        s.lastDelivery = c.id;
        const session = s;
        this.track(
          this.deliver(c, s)
            .catch(() => {
              if (this.current(c, session))
                this.status(
                  c,
                  'delivery-uncertain',
                  'Delivery could not be confirmed. Check the remote chat before manually resending.',
                );
            })
            .finally(() => {
              session.sending = false;
              session.nextSend = Date.now() + 1000;
            }),
        );
      }
    }
  }
  private async telegram(c: ChatConnection, method: string, body: unknown, s: Session) {
    const result = await json(
      `https://api.telegram.org/bot${this.channels.secrets(c.id).token}/${method}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.any([s.abort.signal, AbortSignal.timeout(35000)]),
      },
    );
    if (!result.ok) throw Error('Telegram API rejected request');
    return result.result;
  }
  private async vk(c: ChatConnection, method: string, body: Record<string, string>, s: Session) {
    const result = await json('https://api.vk.com/method/' + method, {
      method: 'POST',
      body: new URLSearchParams({
        ...body,
        access_token: this.channels.secrets(c.id).token,
        v: c.apiVersion,
      }),
      signal: AbortSignal.any([s.abort.signal, AbortSignal.timeout(35000)]),
    });
    if (result.error) throw Error('VK API rejected request');
    return result.response;
  }
  private async poll(c: ChatConnection, s: Session) {
    if (c.transport === 'telegram') {
      const cursor = this.channels.store.maybe<any>('chat-cursor', c.id)?.offset || 0;
      const updates = await this.telegram(
        c,
        'getUpdates',
        { offset: cursor, timeout: 25, limit: 50, allowed_updates: ['message'] },
        s,
      );
      if (!this.current(c, s)) return;
      for (const update of updates) {
        this.accept(c, s, update);
        if (Number.isSafeInteger(update.update_id))
          this.channels.store.put('chat-cursor', { id: c.id, offset: update.update_id + 1 });
      }
    } else {
      if (!s.vk) {
        s.vk = await this.vk(c, 'groups.getLongPollServer', { group_id: c.accountId }, s);
        const u = new URL(s.vk!.server);
        assert(
          u.protocol === 'https:' &&
            /(^|\.)(vk\.com|vk\.ru|vkuserlive\.net)$/.test(u.hostname) &&
            !u.username &&
            !u.password &&
            !u.port,
          'VK_ENDPOINT',
          'Invalid VK long-poll endpoint.',
        );
        const cursor = this.channels.store.maybe<any>('chat-cursor', c.id);
        if (cursor?.ts) s.vk!.ts = cursor.ts;
      }
      const v = s.vk!;
      const url = new URL(v.server);
      for (const [k, value] of Object.entries({
        act: 'a_check',
        key: v.key,
        ts: String(v.ts),
        wait: '25',
      }))
        url.searchParams.set(k, value);
      const result = await json(url.href, {
        signal: AbortSignal.any([s.abort.signal, AbortSignal.timeout(35000)]),
      });
      if (!this.current(c, s)) return;
      if (result.failed) {
        if (result.failed === 1 && result.ts) v.ts = String(result.ts);
        else {
          s.vk = undefined;
          this.channels.store.remove('chat-cursor', c.id);
        }
        return;
      }
      for (const event of result.updates || []) this.accept(c, s, event);
      v.ts = String(result.ts);
      this.channels.store.put('chat-cursor', { id: c.id, ts: v.ts });
    }
    if (this.current(c, s)) this.status(c, 'connected');
  }
  private connectSocket(c: ChatConnection, s: Session) {
    if (
      s.socket &&
      (s.socket.readyState === WebSocket.OPEN || s.socket.readyState === WebSocket.CONNECTING)
    ) {
      if (s.socket.readyState === WebSocket.CONNECTING && Date.now() - (s.openingAt || 0) > 15000) {
        s.socket.close();
        s.nextPoll = Date.now() + 10000;
      }
      return;
    }
    if (Date.now() < s.nextPoll) return;
    const url = new URL(c.transport === 'wecom' ? 'wss://openws.work.weixin.qq.com' : c.endpoint);
    if (c.transport !== 'wecom')
      url.searchParams.set('access_token', this.channels.secrets(c.id).token);
    const socket = new WebSocket(url);
    s.socket = socket;
    s.openingAt = Date.now();
    socket.onopen = () => {
      if (!this.current(c, s)) return socket.close();
      if (c.transport !== 'wecom') {
        this.status(c, 'connected');
        return;
      }
      s.ready = false;
      s.lastAck = Date.now();
      socket.send(
        JSON.stringify({
          cmd: 'aibot_subscribe',
          headers: { req_id: 'subscribe' },
          body: { bot_id: c.accountId, secret: this.channels.secrets(c.id).token },
        }),
      );
      s.heartbeat = setInterval(() => {
        if (!this.current(c, s) || socket.readyState !== WebSocket.OPEN) return;
        if (Date.now() - (s.lastAck || 0) > 60000) return socket.close();
        socket.send(JSON.stringify({ cmd: 'ping', headers: { req_id: 'ping-' + randomUUID() } }));
      }, 25000);
      s.heartbeat.unref();
    };
    socket.onerror = () => {
      if (this.current(c, s))
        this.status(
          c,
          'disconnected',
          'OneBot connection failed. Check the local bridge and token.',
        );
    };
    socket.onclose = () => {
      clearInterval(s.heartbeat);
      s.ready = false;
      s.nextPoll = Date.now() + 10000;
      for (const p of s.pending.values()) p.reject();
      s.pending.clear();
    };
    socket.onmessage = (event) => {
      if (
        !this.current(c, s) ||
        typeof event.data !== 'string' ||
        event.data.length >
          (s.downloading ? 72 * 1024 * 1024 : s.querying ? 2 * 1024 * 1024 : 256000)
      )
        return;
      try {
        const data = JSON.parse(event.data);
        if (c.transport === 'wecom' && data.headers?.req_id === 'subscribe') {
          if (data.errcode === 0) {
            s.ready = true;
            s.lastAck = Date.now();
            this.status(c, 'connected');
          } else {
            socket.close();
            this.status(c, 'disconnected', 'WeCom authentication rejected.');
          }
          return;
        }
        if (c.transport === 'wecom' && String(data.headers?.req_id).startsWith('ping-')) {
          if (data.errcode === 0) s.lastAck = Date.now();
          return;
        }
        if (c.transport === 'wecom' && !s.ready) return;
        const responseId = String(c.transport === 'wecom' ? data.headers?.req_id : data.echo);
        const pending = s.pending.get(responseId);
        if (pending) {
          s.pending.delete(responseId);
          pending.resolve(data);
        } else this.accept(c, s, data);
      } catch {
        this.status(c, 'input-rejected', 'Invalid bridge response.');
      }
    };
  }

  private socketRequest(c: ChatConnection, s: Session, action: string, params: any) {
    const echo = randomUUID();
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        s.pending.delete(echo);
        reject(Error('Bridge request timeout'));
      }, 30000);
      s.pending.set(echo, {
        resolve: (result) => {
          clearTimeout(timer);
          if (
            c.transport === 'wecom'
              ? result.errcode === 0
              : result.retcode === 0 && result.status === 'ok'
          )
            resolve(c.transport === 'wecom' ? result.body : result.data);
          else reject(Error('Bridge request rejected'));
        },
        reject: () => {
          clearTimeout(timer);
          reject(Error('Bridge disconnected'));
        },
      });
      const frame =
        c.transport === 'wecom'
          ? { cmd: action, headers: { req_id: echo }, body: params }
          : {
              action,
              params,
              echo,
              ...(c.transport === 'onebot12'
                ? { self: { platform: 'wechat', user_id: c.accountId } }
                : {}),
            };
      try {
        s.socket!.send(JSON.stringify(frame));
      } catch {
        s.pending.delete(echo);
        clearTimeout(timer);
        reject(Error('Bridge disconnected'));
      }
    });
  }
  private async receiveMedia(c: ChatConnection, s: Session, row: any) {
    const ids: string[] = [];
    this.channels.store.db
      .prepare("UPDATE chat_inbox SET state='downloading' WHERE id=?")
      .run(row.id);
    try {
      const media: ChatRemoteFile[] = JSON.parse(row.media);
      assert(media.length <= 10, 'CHAT_MEDIA_COUNT', 'Too many attachments.');
      for (const file of media) {
        if (
          !this.current(c, s) ||
          !this.channels.store.db
            .prepare("SELECT 1 FROM chat_inbox WHERE id=? AND state='downloading'")
            .get(row.id)
        )
          throw Error('Import cancelled');
        const signal = AbortSignal.any([s.abort.signal, AbortSignal.timeout(120000)]);
        let url = file.url,
          bytes: Buffer | undefined,
          headers: Record<string, string> = {};
        if (c.transport === 'telegram') {
          const f = await this.telegram(c, 'getFile', { file_id: file.id }, s);
          assert(
            f.file_path &&
              !String(f.file_path).includes('..') &&
              (f.file_size == null || f.file_size <= 20 * 1024 * 1024),
            'CHAT_MEDIA_SIZE',
            'Telegram download unavailable or exceeds 20 MiB.',
          );
          url =
            'https://api.telegram.org/file/bot' +
            this.channels.secrets(c.id).token +
            '/' +
            String(f.file_path).split('/').map(encodeURIComponent).join('/');
        } else if (c.transport === 'whatsapp') {
          assert(file.id && /^[0-9]+$/.test(file.id), 'CHAT_MEDIA_ID', 'Invalid media ID.');
          headers = { Authorization: 'Bearer ' + this.channels.secrets(c.id).token };
          const f = await json(`https://graph.facebook.com/${c.apiVersion}/${file.id}`, {
            headers,
            signal,
          });
          const u = new URL(f.url);
          assert(
            /(^|\.)(facebook\.com|fbcdn\.net|fbsbx\.com)$/.test(u.hostname),
            'CHAT_MEDIA_ORIGIN',
            'Unexpected Meta media origin.',
          );
          url = u.href;
        } else if (c.transport === 'onebot12') {
          const f = await this.socketRequest(c, s, 'get_file', { file_id: file.id, type: 'data' });
          assert(
            typeof f.data === 'string' && f.data.length <= 72 * 1024 * 1024,
            'CHAT_MEDIA_SIZE',
            'Unsupported or oversized bridge file.',
          );
          bytes = Buffer.from(f.data, 'base64');
        } else if (c.transport === 'onebot11' && !!file.id) {
          const action =
            file.kind === 'image' ? 'get_image' : file.kind === 'audio' ? 'get_record' : 'get_file';
          const f = await this.socketRequest(c, s, action, {
            file: file.id,
            file_id: file.id,
            ...(c.peerType === 'group' ? { group_id: Number(c.peerId) } : {}),
            out_format: 'mp3',
          });
          url = f.url;
          if (typeof f.base64 === 'string') {
            assert(
              f.base64.length <= Math.ceil(chatMediaLimit / 3) * 4 &&
                /^[A-Za-z0-9+/]*={0,2}$/.test(f.base64),
              'CHAT_MEDIA_BYTES',
              'Invalid bridge file bytes.',
            );
            bytes = Buffer.from(f.base64, 'base64');
          }
        }
        if (!bytes) {
          assert(
            url,
            'CHAT_MEDIA_UNSUPPORTED',
            'The platform did not provide downloadable file bytes.',
          );
          bytes = await downloadChatBytes(
            url,
            signal,
            headers,
            c.transport === 'telegram' ? 20 * 1024 * 1024 : chatMediaLimit,
          );
        }
        if (c.transport === 'wecom' && file.aeskey) bytes = decryptWecomFile(bytes, file.aeskey);
        if (
          !this.current(c, s) ||
          !this.channels.store.db
            .prepare("SELECT 1 FROM chat_inbox WHERE id=? AND state='downloading'")
            .get(row.id)
        )
          throw Error('Import cancelled');
        ids.push(
          await storeChatAttachment(
            this.channels.store,
            this.channels.directory,
            c.conversationId,
            row.id,
            file,
            bytes,
            signal,
          ),
        );
      }
      if (
        !this.current(c, s) ||
        !this.channels.store.db
          .prepare("SELECT 1 FROM chat_inbox WHERE id=? AND state='downloading'")
          .get(row.id)
      )
        throw Error('Import cancelled');
      this.channels.store.db
        .prepare(
          "UPDATE chat_inbox SET state=CASE WHEN notice='context-only' THEN 'done' ELSE 'queued' END,attachment_ids=?,media=NULL WHERE id=? AND state='downloading'",
        )
        .run(JSON.stringify(ids), row.id);
    } catch {
      if (
        !this.closed &&
        this.channels.store.db
          .prepare("SELECT 1 FROM chat_inbox WHERE id=? AND state='downloading'")
          .get(row.id)
      ) {
        this.channels.store.db
          .prepare(
            "UPDATE chat_inbox SET state='media-failed',media=NULL WHERE id=? AND state='downloading'",
          )
          .run(row.id);
        if (row.notice !== 'context-only')
          this.channels.reply(
            c,
            row.id + ':media-error',
            'Attachment could not be imported: unsupported type, size limit, network or parse failure. No task was started. Retry with a smaller supported attachment or inspect Amadeus.',
          );
      }
      // Imported partial attachments are retained as provenance, never picked up by local drafts.
    }
  }
  private async mediaBytes(c: ChatConnection, s: Session, reference: string) {
    const output = this.channels.runtime.media.streamOutput(
      reference,
      c.conversationId,
      s.abort.signal,
    );
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of output.chunks) {
      size += chunk.length;
      assert(
        size <= chatMediaLimit,
        'CHAT_MEDIA_SIZE',
        'Output exceeds the remote transfer budget.',
      );
      chunks.push(chunk);
    }
    return { bytes: Buffer.concat(chunks), mime: output.metadata.mime, name: output.metadata.name };
  }
  private async sendMedia(c: ChatConnection, s: Session, row: any) {
    const { bytes, mime, name } = await this.mediaBytes(c, s, row.reference);
    const signal = AbortSignal.any([s.abort.signal, AbortSignal.timeout(120000)]);
    const kind = mime.startsWith('image/')
      ? 'image'
      : mime.startsWith('audio/')
        ? 'audio'
        : mime.startsWith('video/')
          ? 'video'
          : 'file';
    if (c.transport === 'telegram') {
      const type = /^image\/(png|jpeg)$/.test(mime)
        ? 'photo'
        : mime === 'video/mp4'
          ? 'video'
          : mime === 'audio/ogg'
            ? 'voice'
            : /^audio\/(mpeg|mp4)$/.test(mime)
              ? 'audio'
              : 'document';
      const form = new FormData();
      form.set('chat_id', c.peerId);
      form.set(type, new Blob([new Uint8Array(bytes)], { type: mime }), name);
      const result = await json(
        `https://api.telegram.org/bot${this.channels.secrets(c.id).token}/send${type[0].toUpperCase() + type.slice(1)}`,
        { method: 'POST', body: form, signal },
      );
      if (!result.ok) throw Error('Telegram media rejected');
    } else if (c.transport === 'whatsapp') {
      const base = `https://graph.facebook.com/${c.apiVersion}/${c.accountId}`;
      const headers = { Authorization: 'Bearer ' + this.channels.secrets(c.id).token };
      const form = new FormData();
      form.set('messaging_product', 'whatsapp');
      form.set('type', mime);
      form.set('file', new Blob([new Uint8Array(bytes)], { type: mime }), name);
      const uploaded = await json(base + '/media', { method: 'POST', headers, body: form, signal });
      assert(uploaded.id, 'CHAT_MEDIA_UPLOAD', 'Media upload failed.');
      const type = kind === 'file' ? 'document' : kind;
      const result = await json(base + '/messages', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: c.peerId,
          type,
          [type]: { id: uploaded.id, ...(type === 'document' ? { filename: name } : {}) },
        }),
        signal,
      });
      if (!result.messages?.[0]?.id) throw Error('WhatsApp media send unconfirmed');
    } else if (c.transport === 'vk') {
      const target = await this.vk(
        c,
        'docs.getMessagesUploadServer',
        { peer_id: c.peerId, type: 'doc' },
        s,
      );
      const u = new URL(target.upload_url);
      assert(
        u.protocol === 'https:' &&
          /(^|\.)(vk\.com|userapi\.com)$/.test(u.hostname) &&
          !u.username &&
          !u.password &&
          !u.port,
        'CHAT_MEDIA_ORIGIN',
        'Invalid VK upload origin.',
      );
      const form = new FormData();
      form.set('file', new Blob([new Uint8Array(bytes)], { type: mime }), name);
      const uploaded = await json(u.href, { method: 'POST', body: form, signal });
      const saved = await this.vk(c, 'docs.save', { file: uploaded.file, title: name }, s);
      const doc = saved.doc;
      assert(doc?.owner_id && doc?.id, 'CHAT_MEDIA_UPLOAD', 'VK upload failed.');
      await this.vk(
        c,
        'messages.send',
        {
          peer_id: c.peerId,
          attachment: `doc${doc.owner_id}_${doc.id}`,
          random_id: String(
            createHash('sha256').update(row.id).digest().readUInt32BE(0) & 0x7fffffff,
          ),
        },
        s,
      );
    } else if (c.transport === 'qq') {
      const token = await this.qqToken(c, s);
      const base =
        'https://api.sgroup.qq.com/v2/' +
        (c.peerType === 'group' ? 'groups/' : 'users/') +
        encodeURIComponent(c.peerId);
      const headers = { Authorization: 'QQBot ' + token, 'Content-Type': 'application/json' };
      const file = await json(base + '/files', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          file_type: kind === 'image' ? 1 : kind === 'video' ? 2 : kind === 'audio' ? 3 : 4,
          file_data: bytes.toString('base64'),
          file_name: name,
          srv_send_msg: false,
        }),
        signal,
      });
      assert(file.file_info, 'CHAT_MEDIA_UPLOAD', 'QQ file upload failed.');
      const reply = this.qqReply(c, row);
      const result = await json(base + '/messages', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          content: ' ',
          msg_type: 7,
          media: { file_info: file.file_info },
          msg_id: reply.messageId,
          msg_seq: reply.sequence,
        }),
        signal,
      });
      if (!result.id) throw Error('QQ media send unconfirmed');
    } else if (c.transport === 'wecom') {
      // Unsupported voice codecs travel as downloadable files; never rename bytes as AMR.
      const type = kind === 'audio' ? 'file' : kind;
      const total = Math.ceil(bytes.length / (512 * 1024));
      const init = await this.socketRequest(c, s, 'aibot_upload_media_init', {
        type,
        filename: name,
        total_size: bytes.length,
        total_chunks: total,
        md5: createHash('md5').update(bytes).digest('hex'),
      });
      assert(init?.upload_id, 'CHAT_MEDIA_UPLOAD', 'WeCom upload not initialized.');
      for (let index = 0; index < total; index++)
        await this.socketRequest(c, s, 'aibot_upload_media_chunk', {
          upload_id: init.upload_id,
          chunk_index: index,
          base64_data: bytes
            .subarray(index * 512 * 1024, (index + 1) * 512 * 1024)
            .toString('base64'),
        });
      const final = await this.socketRequest(c, s, 'aibot_upload_media_finish', {
        upload_id: init.upload_id,
      });
      assert(final?.media_id, 'CHAT_MEDIA_UPLOAD', 'WeCom upload incomplete.');
      await this.socketRequest(c, s, 'aibot_send_msg', {
        chatid: c.peerId,
        chat_type: c.peerType === 'group' ? 2 : 1,
        msgtype: type,
        [type]: { media_id: final.media_id },
      });
    } else if (c.transport === 'onebot12') {
      const file = await this.socketRequest(c, s, 'upload_file', {
        type: 'data',
        name,
        data: bytes.toString('base64'),
      });
      assert(file?.file_id, 'CHAT_MEDIA_UPLOAD', 'Bridge upload failed.');
      await this.socketRequest(c, s, 'send_message', {
        detail_type: c.peerType || 'private',
        [c.peerType === 'group' ? 'group_id' : 'user_id']: c.peerId,
        message: [{ type: kind === 'audio' ? 'voice' : kind, data: { file_id: file.file_id } }],
      });
    } else {
      if (kind === 'file') {
        // NapCat accepts a base64 file body; no arbitrary local source path is requested.
        await this.socketRequest(
          c,
          s,
          c.peerType === 'group' ? 'upload_group_file' : 'upload_private_file',
          {
            [c.peerType === 'group' ? 'group_id' : 'user_id']: Number(c.peerId),
            file: 'base64://' + bytes.toString('base64'),
            name,
          },
        );
      } else
        await this.socketRequest(
          c,
          s,
          c.peerType === 'group' ? 'send_group_msg' : 'send_private_msg',
          {
            [c.peerType === 'group' ? 'group_id' : 'user_id']: Number(c.peerId),
            message: [
              {
                type: kind === 'audio' ? 'record' : kind,
                data: { file: 'base64://' + bytes.toString('base64') },
              },
            ],
          },
        );
    }
  }
  private async qqToken(c: ChatConnection, s: Session) {
    if (!s.qqToken || s.qqToken.expires < Date.now() + 60000) {
      const t = await json('https://bots.qq.com/app/getAppAccessToken', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          appId: c.accountId,
          clientSecret: this.channels.secrets(c.id).token,
        }),
        signal: AbortSignal.any([s.abort.signal, AbortSignal.timeout(15000)]),
      });
      assert(t.access_token, 'CHAT_TOKEN', 'QQ token unavailable.');
      s.qqToken = {
        value: t.access_token,
        expires: Date.now() + Number(t.expires_in || 7200) * 1000,
      };
    }
    return s.qqToken.value;
  }
  private qqReply(c: ChatConnection, row: any) {
    let delivery = this.channels.store.maybe<any>('chat-qq-delivery', row.id);
    if (delivery) return delivery;
    const context = this.channels.store.get<any>('chat-qq-reply', c.id);
    assert(
      context.sequence < 5 && Date.now() - context.receivedAt < 3600000,
      'CHAT_REPLY_WINDOW',
      'QQ reply window/limit exceeded; send a new message.',
    );
    delivery = { id: row.id, messageId: context.messageId, sequence: context.sequence + 1 };
    this.channels.store.put('chat-qq-delivery', delivery);
    this.channels.store.put('chat-qq-reply', { ...context, sequence: delivery.sequence });
    return delivery;
  }
  private async send(c: ChatConnection, s: Session, row: any) {
    if (c.transport === 'telegram')
      await this.telegram(
        c,
        'sendMessage',
        { chat_id: c.peerId, text: row.text, link_preview_options: { is_disabled: true } },
        s,
      );
    else if (c.transport === 'vk')
      await this.vk(
        c,
        'messages.send',
        {
          peer_id: c.peerId,
          message: row.text,
          random_id: String(
            createHash('sha256').update(row.id).digest().readUInt32BE(0) & 0x7fffffff,
          ),
        },
        s,
      );
    else if (c.transport === 'whatsapp') {
      const result = await json(
        `https://graph.facebook.com/${c.apiVersion}/${c.accountId}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + this.channels.secrets(c.id).token,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: c.peerId,
            type: 'text',
            text: { body: row.text, preview_url: false },
          }),
          signal: AbortSignal.any([s.abort.signal, AbortSignal.timeout(35000)]),
        },
      );
      if (!result.messages?.[0]?.id) throw Error('Missing WhatsApp receipt');
    } else if (c.transport === 'qq') {
      const token = await this.qqToken(c, s),
        reply = this.qqReply(c, row);
      const result = await json(
        'https://api.sgroup.qq.com/v2/' +
          (c.peerType === 'group' ? 'groups/' : 'users/') +
          encodeURIComponent(c.peerId) +
          '/messages',
        {
          method: 'POST',
          headers: { Authorization: 'QQBot ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: row.text,
            msg_type: 0,
            msg_id: reply.messageId,
            msg_seq: reply.sequence,
          }),
          signal: AbortSignal.any([s.abort.signal, AbortSignal.timeout(35000)]),
        },
      );
      if (!result.id) throw Error('QQ send unconfirmed');
    } else {
      const echo = randomUUID();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          s.pending.delete(echo);
          reject(Error('OneBot send timeout'));
        }, 15000);
        s.pending.set(echo, {
          resolve: (result) => {
            clearTimeout(timer);
            (
              c.transport === 'wecom'
                ? result.errcode === 0
                : result.retcode === 0 && result.status === 'ok'
            )
              ? resolve()
              : reject(Error('OneBot rejected send'));
          },
          reject: () => {
            clearTimeout(timer);
            reject(Error('OneBot disconnected'));
          },
        });
        try {
          s.socket!.send(
            JSON.stringify(
              c.transport === 'wecom'
                ? {
                    cmd: 'aibot_send_msg',
                    headers: { req_id: echo },
                    body: {
                      chatid: c.peerId,
                      chat_type: c.peerType === 'group' ? 2 : 1,
                      msgtype: 'markdown',
                      markdown: { content: row.text },
                    },
                  }
                : onebotAction(
                    c,
                    row.text,
                    echo,
                    row.reply_plan ? JSON.parse(row.reply_plan) : undefined,
                  ),
            ),
          );
        } catch {
          clearTimeout(timer);
          s.pending.delete(echo);
          reject(Error('OneBot disconnected'));
        }
      });
    }
  }
  private async deliver(c: ChatConnection, s: Session) {
    if (!this.current(c, s)) return;
    this.channels.authorize(this.channels.get(c.id));
    // Stop at an uncertain delivery to preserve the ordering of multipart responses.
    const row = this.channels.store.db
      .prepare(
        "SELECT * FROM chat_outbox WHERE connection_id=? AND state<>'sent' ORDER BY created_at,rowid LIMIT 1",
      )
      .get(c.id) as any;
    if (!row || row.state !== 'pending') return;
    if (c.transport === 'qq') {
      const context = this.channels.store.maybe<any>('chat-qq-reply', c.id);
      if (!context || context.sequence >= 5 || Date.now() - context.receivedAt >= 3600000) {
        this.status(
          c,
          'reply-window',
          'QQ requires a new private message to reopen its reply window/quota. Pending replies are retained.',
        );
        return;
      }
    }
    if (row.reference && this.mediaActive >= 2) return;
    if (row.reference) this.mediaActive++;

    this.channels.store.db.prepare("UPDATE chat_outbox SET state='sending' WHERE id=?").run(row.id);
    try {
      if (row.reference) await this.sendMedia(c, s, row);
      else await this.send(c, s, row);
      if (!this.closed)
        this.channels.store.db
          .prepare("UPDATE chat_outbox SET state='sent',text='' WHERE id=?")
          .run(row.id);
    } catch {
      if (!this.closed)
        this.channels.store.db
          .prepare("UPDATE chat_outbox SET state='uncertain' WHERE id=?")
          .run(row.id);
      throw Error('Delivery uncertain');
    } finally {
      if (row.reference) this.mediaActive--;
    }
  }
  private listen(port: number) {
    if (this.webhooks.has(port)) return;
    const server = createServer(async (req, res) => {
      const finish = (status: number, text: string) => {
        res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(text);
      };
      try {
        const url = new URL(req.url || '', 'http://localhost');
        const match = url.pathname.match(/^\/(whatsapp|qq)\/([a-f0-9-]{36})$/);
        const key = match?.[2];
        const c = key
          ? this.channels.store.maybe<ChatConnection>('chat-connection', key)
          : undefined;
        if (
          !c?.enabled ||
          !['whatsapp', 'qq'].includes(c.transport) ||
          c.webhookPort !== port ||
          c.transport !== match?.[1]
        )
          return finish(404, 'Not found');
        const secret: ChatSecrets = this.channels.secrets(c.id);
        if (req.method === 'GET' && c.transport === 'whatsapp') {
          if (
            url.searchParams.get('hub.mode') === 'subscribe' &&
            equalSecret(url.searchParams.get('hub.verify_token') || '', secret.verifyToken)
          )
            return finish(200, url.searchParams.get('hub.challenge') || '');
          return finish(403, 'Forbidden');
        }
        if (req.method !== 'POST') return finish(405, 'Method not allowed');
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 256000) return finish(413, 'Too large');
          chunks.push(chunk);
        }
        const body = Buffer.concat(chunks);
        if (c.transport === 'qq') {
          const event = JSON.parse(body.toString('utf8'));
          if (event.op === 13) {
            const token = event.d?.plain_token,
              ts = event.d?.event_ts;
            if (
              typeof token !== 'string' ||
              token.length > 512 ||
              typeof ts !== 'string' ||
              !/^\d+$/.test(ts)
            )
              return finish(400, 'Invalid validation');
            return finish(
              200,
              JSON.stringify({ plain_token: token, signature: qqSign(secret.token, ts + token) }),
            );
          }
          if (
            !qqVerify(
              secret.token,
              body,
              String(req.headers['x-signature-timestamp'] || ''),
              String(req.headers['x-signature-ed25519'] || ''),
            )
          )
            return finish(403, 'Forbidden');
          const owner = this.channels
            .list()
            .filter((r) => r.enabled && this.accountKey(r) === this.accountKey(c))
            .sort((a, b) => a.id.localeCompare(b.id))[0];
          const s = owner ? this.sessions.get(owner.id) : undefined;
          if (!s) return finish(503, 'Not ready');
          this.accept(c, s, event);
          this.status(c, 'connected');
          return finish(200, JSON.stringify({ op: 12 }));
        }
        if (
          !whatsappSignature(
            body,
            String(req.headers['x-hub-signature-256'] || ''),
            secret.appSecret,
          )
        )
          return finish(403, 'Forbidden');
        const owner = this.channels
          .list()
          .filter((r) => r.enabled && this.accountKey(r) === this.accountKey(c))
          .sort((a, b) => a.id.localeCompare(b.id))[0];
        const s = owner ? this.sessions.get(owner.id) : undefined;
        if (!s) return finish(503, 'Not ready');
        this.accept(c, s, JSON.parse(body.toString('utf8')));
        this.status(c, 'connected');
        finish(200, 'EVENT_RECEIVED');
      } catch {
        if (!res.headersSent) finish(400, 'Invalid webhook');
      }
    });
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    server.maxConnections = 32;
    server.on('error', () => {
      for (const c of this.channels
        .list()
        .filter((c) => c.webhookPort === port && ['whatsapp', 'qq'].includes(c.transport)))
        this.status(c, 'disconnected', 'Webhook listener could not start. Check the port.');
    });
    // Only this dedicated, signed webhook receiver may be reverse-proxied. Never the app.
    server.listen(port, '127.0.0.1');
    this.webhooks.set(port, server);
  }
}
