import { createHash, randomBytes } from 'node:crypto';
import type { ChatConnection, ChatIncoming } from '../../shared/chat-connections.js';
import type { ChatConnections } from './chat-connections.js';

type Request = {
  id: string;
  connectionId: string;
  peer: string;
  flag: string;
  code: string;
  at: number;
  revision: number;
  state: 'pending' | 'sending' | 'accepted' | 'denied' | 'uncertain';
};
export class ChatFriendReview {
  constructor(private channels: ChatConnections) {}
  private eligible(c: ChatConnection) {
    return (
      c.enabled &&
      c.reviewFriendRequests &&
      c.transport === 'onebot11' &&
      c.peerType === 'private' &&
      c.accessMode === 'work'
    );
  }
  private requests(c: ChatConnection) {
    return this.channels.store
      .list<Request>('chat-friend-request')
      .filter((r) => r.connectionId === c.id);
  }
  private existing(c: ChatConnection, peer: string) {
    return this.channels
      .list()
      .find(
        (r) =>
          r.transport === c.transport &&
          r.accountId === c.accountId &&
          r.endpoint === c.endpoint &&
          r.peerType === 'private' &&
          r.peerId === peer,
      );
  }
  private enroll(c: ChatConnection, peer: string) {
    // Never revive or upgrade an existing route, including a deliberately paused one.
    if (this.existing(c, peer)) return;
    return this.channels.save({
      name: 'Friend ' + peer,
      transport: c.transport,
      accountId: c.accountId,
      endpoint: c.endpoint,
      conversationId: c.conversationId,
      senderId: peer,
      peerId: peer,
      peerType: 'private',
      accessMode: 'chat',
      enabled: true,
      remoteApprovals: false,
      reviewFriendRequests: false,
      autoInviteGroups: false,
      sharedKnowledge: c.sharedKnowledge !== false,
      token: this.channels.secrets(c.id).token,
    });
  }
  observe(c: ChatConnection, event: any) {
    if (!this.eligible(c) || String(event?.self_id) !== c.accountId) return;
    const now = Date.now(),
      at = Number(event.time) * 1000,
      peer = String(event.user_id);
    if (
      !Number.isFinite(at) ||
      at < c.activatedAt - 1000 ||
      at < now - 86400000 ||
      at > now + 60000 ||
      !/^\d{1,20}$/.test(peer) ||
      peer === c.accountId ||
      peer === c.senderId
    )
      return;
    this.channels.authorize(c);
    const records = this.requests(c);
    // A native friend-add notice confirms manual acceptance in the QQ client too.
    if (event.post_type === 'notice' && event.notice_type === 'friend_add') {
      const request = records.find(
        (r) =>
          r.peer === peer &&
          ['pending', 'sending', 'uncertain'].includes(r.state) &&
          r.at >= now - 86400000 &&
          r.revision === c.revision,
      );
      if (!request) return;
      this.enroll(c, peer);
      this.channels.store.put('chat-friend-request', { ...request, state: 'accepted', flag: '' });
      this.channels.reply(
        c,
        'friend-result:' + request.id,
        'QQ 已确认添加好友 ' + peer + '；独立普通聊天已就绪，未授予电脑操作或审批权限。',
      );
      return;
    }
    if (
      event.post_type !== 'request' ||
      event.request_type !== 'friend' ||
      typeof event.flag !== 'string' ||
      !event.flag ||
      event.flag.length > 1024 ||
      this.existing(c, peer)
    )
      return;
    const key = createHash('sha256')
      .update(c.id + '\0' + event.flag)
      .digest('hex');
    if (this.channels.store.maybe('chat-friend-request', key)) return;
    for (const old of records.filter((r) => r.at < now - 86400000))
      this.channels.store.remove('chat-friend-request', old.id);
    if (records.filter((r) => r.at >= now - 86400000).length >= 50) return;
    const request: Request = {
      id: key,
      connectionId: c.id,
      peer,
      flag: event.flag,
      code: randomBytes(6).toString('hex'),
      at: now,
      revision: c.revision,
      state: 'pending',
    };
    this.channels.store.put('chat-friend-request', request);
    const comment =
      typeof event.comment === 'string'
        ? event.comment.slice(0, 500).replace(/[\x00-\x1f]/g, ' ')
        : '';
    this.channels.reply(
      c,
      'friend-request:' + key,
      `QQ 好友申请\n申请人 QQ：${peer}\n验证消息（对方提供，不可信）：${comment || '（无）'}\n——验证消息结束——\n同意 ${request.code}\n拒绝 ${request.code}\n24 小时内有效。仅有一条待处理申请时也可回复“同意”或“拒绝”；多条时请带编号。也可登录机器人 QQ 手动处理。通过后只开放独立普通聊天，可访问已开放的共享知识库，不授予电脑操作或审批权限。`,
    );
  }
  matches(c: ChatConnection, m: ChatIncoming) {
    return (
      this.eligible(c) &&
      m.senderId === c.senderId &&
      m.peerId === c.peerId &&
      m.peerType !== 'group' &&
      !m.media?.length &&
      /^(同意|拒绝)(?:\s+[a-f0-9]{12})?$/.test(m.text.trim())
    );
  }
  async answer(
    c: ChatConnection,
    m: ChatIncoming,
    send: (action: string, params: unknown) => Promise<unknown>,
  ) {
    if (!this.matches(c, m)) return;
    this.channels.authorize(c);
    const now = Date.now();
    if (
      m.timestamp < c.activatedAt - 1000 ||
      m.timestamp < now - 300000 ||
      m.timestamp > now + 60000
    )
      return;
    const receipt = createHash('sha256')
      .update(c.id + '\0answer\0' + m.id)
      .digest('hex');
    if (this.channels.store.maybe('chat-friend-answer', receipt)) return;
    this.channels.store.put('chat-friend-answer', { id: receipt, at: now });
    for (const old of this.channels.store.list<{ id: string; at: number }>('chat-friend-answer'))
      if (old.at < now - 86400000) this.channels.store.remove('chat-friend-answer', old.id);
    const [decision, code] = m.text.trim().split(/\s+/);
    const taskPending = this.channels.store
      .list<{ conversationId: string; status: string }>('input')
      .some((q) => q.conversationId === c.conversationId && q.status === 'pending');
    if (!code && taskPending) {
      this.channels.reply(
        c,
        'friend-answer:' + receipt,
        '当前还有任务等待处理，请明确使用“同意 好友编号”或 /approve 任务审批码，避免批准错误请求。',
      );
      return;
    }
    const pending = this.requests(c).filter(
      (r) =>
        r.state === 'pending' &&
        r.at >= now - 86400000 &&
        r.revision === c.revision &&
        (!code || r.code === code),
    );
    if (pending.length !== 1) {
      this.channels.reply(
        c,
        'friend-answer:' + receipt,
        '未找到唯一有效的好友申请，请回复“同意 编号”或“拒绝 编号”，也可登录机器人 QQ 处理。任务审批请使用对应的 /approve 审批码。',
      );
      return;
    }
    const request = pending[0],
      approve = decision === '同意';
    if (approve && !this.existing(c, request.peer) && this.channels.list().length >= 20) {
      this.channels.reply(
        c,
        'friend-answer:' + receipt,
        '接入会话数量已达上限，未通过好友申请。请先在本机管理接入会话。',
      );
      return;
    }
    // Persist before side effects; an uncertain bridge result is never blindly retried.
    this.channels.store.put('chat-friend-request', { ...request, state: 'sending' });
    try {
      await send('set_friend_add_request', { flag: request.flag, approve });
      const latest = this.channels.get(c.id);
      if (!this.eligible(latest) || latest.revision !== c.revision)
        throw Error('Connection changed');
      this.channels.authorize(latest);
      if (approve) this.enroll(latest, request.peer);
      this.channels.store.put('chat-friend-request', {
        ...request,
        state: approve ? 'accepted' : 'denied',
        flag: '',
      });
      this.channels.reply(
        latest,
        'friend-result:' + request.id,
        approve
          ? '已通过 ' + request.peer + ' 的好友申请，独立普通聊天已就绪；无电脑操作和审批权限。'
          : '已拒绝 ' + request.peer + ' 的好友申请。',
      );
    } catch {
      this.channels.store.put('chat-friend-request', { ...request, state: 'uncertain' });
      this.channels.reply(
        c,
        'friend-result:' + request.id,
        '好友申请处理结果尚未确认，请登录机器人 QQ 核查；不会自动重复通过，也不会授予高级权限。',
      );
    }
  }
}
