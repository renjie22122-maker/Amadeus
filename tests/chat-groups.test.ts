import { ChatFriendReview } from '../server/services/chat-friend-review.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, id } from '../server/storage/store.js';
import { ChatConnections } from '../server/services/chat-connections.js';
import { ChatTransports } from '../server/services/chat-transports.js';
import { incoming, onebotAction } from '../server/services/chat-protocols.js';
import {
  chatSenderAllowed,
  restrictedChat,
  socialChatTools,
} from '../server/services/chat-access.js';
import { capabilityDecision } from '../server/services/capability-kernel.js';
import type { ChatConnection } from '../shared/chat-connections.js';
const group = (transport: ChatConnection['transport'] = 'onebot11'): ChatConnection => ({
  id: id(),
  name: 'group',
  transport,
  conversationId: 'work',
  senderId: '123',
  peerId: '789',
  peerType: 'group',
  accessMode: 'work',
  allowedSenders: ['124'],
  allGroupMembers: false,
  groupPrefix: '/amadeus',
  enabled: true,
  endpoint: 'ws://127.0.0.1:3001',
  accountId: '456',
  apiVersion: '',
  webhookPort: 8788,
  remoteApprovals: true,
  authorizedTarget: '',
  activatedAt: Date.now() - 1000,
  revision: 1,
});
function setup(t: any) {
  const directory = mkdtempSync(join(tmpdir(), 'chat-groups-')),
    store = new Store(join(directory, 'test.db'));
  const calls: any[] = [];
  const runtime: any = {
    config: { profile: () => ({ baseUrl: 'https://example.invalid', model: 'test' }) },
    active: () => undefined,
    start: (...a: any[]) => calls.push(a),
    stop: (...a: any[]) => calls.push(a),
    inputs: { answer: (...a: any[]) => calls.push(a) },
  };
  store.put('conversation', {
    id: 'work',
    profileId: 'test',
    projectId: null,
    knowledge: true,
    memory: true,
    skillIds: ['private'],
    permission: 'auto',
  });
  const channels = new ChatConnections(store, runtime, directory),
    c = group();
  c.authorizedTarget = channels.target('work');
  store.put('chat-connection', c);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, runtime, channels, c, calls, directory };
}
test('ordinary chat has web and media but cannot gain host tools by setting permission=auto', () => {
  const c = restrictedChat({
    id: 'c',
    remoteChatOnly: true,
    projectId: 'secret',
    permission: 'auto',
    allowedTools: ['run_command'],
    memory: true,
    skillIds: ['private'],
  } as any);
  assert.equal(c.projectId, null);
  assert.equal(c.memory, false);
  assert.deepEqual(c.skillIds, []);
  assert(socialChatTools.has('fetch_url'));
  assert(socialChatTools.has('transcribe_media'));
  const ctx: any = {
    conversation: { ...c, permission: 'auto', allowedTools: undefined },
    config: { get: () => ({ commandBackend: 'approval-host', web: { enabled: true } }) },
    run: { depth: 0 },
  };
  for (const tool of [
    'run_command',
    'read_file',
    'write_file',
    'mcp_call',
    'spawn_agent',
    'recall_memories',
    'find_skills',
  ])
    assert.equal(capabilityDecision(ctx, tool, 'read').allowed, false, tool);
  assert.equal(capabilityDecision(ctx, 'web_search', 'network').allowed, true);
});
test('ordinary conversation is freshly created, not a copied project/history', (t) => {
  const { channels, store } = setup(t);
  const template = group('telegram');
  const { id: _, revision, authorizedTarget, activatedAt, ...input } = template;
  const saved = channels.save({
    ...input,
    name: 'ordinary',
    conversationId: 'work',
    peerType: 'private',
    senderId: '999',
    peerId: '999',
    accessMode: 'chat',
    remoteApprovals: false,
    endpoint: '',
    accountId: '',
    token: '456:test',
  });
  assert.notEqual(saved.conversationId, 'work');
  const c = store.get<any>('conversation', saved.conversationId);
  assert.equal(c.remoteChatOnly, true);
  assert.equal(c.remoteSharedKnowledge, true);
  assert.equal(c.memory, false);
  assert.equal(c.projectId, null);
  assert.deepEqual(store.events(c.id), []);
});
test('explicit group membership and controller are distinct from whole-group chat access', () => {
  const c = group(),
    m = {
      id: 'm',
      senderId: '125',
      peerId: '789',
      peerType: 'group' as const,
      text: 'hello',
      timestamp: Date.now(),
    };
  assert.equal(chatSenderAllowed(c, m), false);
  assert.equal(chatSenderAllowed(c, { ...m, senderId: '124' }), true);
  assert.equal(chatSenderAllowed({ ...c, accessMode: 'chat', allGroupMembers: true }, m), true);
  assert.equal(chatSenderAllowed({ ...c, accessMode: 'work', allGroupMembers: true }, m), false);
  assert.equal(
    chatSenderAllowed(
      { ...c, accessMode: 'chat', allGroupMembers: true },
      { ...m, peerId: 'another' },
    ),
    false,
  );
});
test('group requires prefix; allowed worker cannot stop or approve for controller', (t) => {
  const { channels, c, calls, store } = setup(t),
    now = Date.now();
  const m = {
    id: 'm',
    senderId: '124',
    peerId: '789',
    peerType: 'group' as const,
    text: 'hello',
    timestamp: now,
  };
  assert.equal(channels.receive(c.id, m), 'ignored');
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM chat_inbox').get()!.n, 0);
  channels.receive(c.id, { ...m, id: 'stop', text: '/amadeus /stop' });
  assert.equal(calls.length, 0);
  channels.receive(c.id, { ...m, id: 'task', text: '/amadeus find information' });
  channels.tick();
  assert.equal(calls.length, 1);
  assert(calls[0][1].includes('Platform sender ID: 124'));
});
test('group protocols use actual sender and actual group, never the bot or display name', () => {
  const now = Date.now() / 1000;
  const cases: [ChatConnection['transport'], any, string][] = [
    [
      'telegram',
      {
        update_id: 1,
        message: {
          from: { id: 123 },
          chat: { id: -789, type: 'supergroup' },
          text: '/amadeus hello',
          date: now,
        },
      },
      '-789',
    ],
    [
      'vk',
      {
        type: 'message_new',
        object: {
          message: { id: 1, from_id: 123, peer_id: 2000000001, text: '/amadeus hello', date: now },
        },
      },
      '2000000001',
    ],
    [
      'qq',
      {
        op: 0,
        t: 'GROUP_AT_MESSAGE_CREATE',
        d: {
          id: 'm',
          group_openid: '789',
          author: { member_openid: '123' },
          content: '<@!456> /amadeus hello',
          timestamp: new Date().toISOString(),
        },
      },
      '789',
    ],
    [
      'wecom',
      {
        cmd: 'aibot_msg_callback',
        body: {
          msgid: 'm',
          aibotid: '456',
          chattype: 'group',
          chatid: '789',
          from: { userid: '123' },
          msgtype: 'text',
          text: { content: '/amadeus hello' },
        },
      },
      '789',
    ],
    [
      'onebot11',
      {
        post_type: 'message',
        message_type: 'group',
        self_id: 456,
        user_id: 123,
        group_id: 789,
        message_id: 1,
        time: now,
        message: [
          { type: 'at', data: { qq: '456' } },
          { type: 'text', data: { text: '/amadeus hello' } },
        ],
      },
      '789',
    ],
    [
      'onebot12',
      {
        type: 'message',
        detail_type: 'group',
        self: { platform: 'wechat', user_id: '456' },
        user_id: '123',
        group_id: '789',
        id: 'm',
        time: now,
        message: [{ type: 'text', data: { text: '/amadeus hello' } }],
      },
      '789',
    ],
  ];
  for (const [transport, event, peer] of cases) {
    const [m] = incoming(group(transport), event);
    assert(m, transport);
    assert.equal(m.senderId, '123');
    assert.equal(m.peerId, peer);
    assert.equal(m.peerType, 'group');
  }
  const action = onebotAction(group(), 'hello', 'echo');
  assert.equal(action.action, 'send_group_msg');
  assert.equal((action.params as any).group_id, 789);
});
test('same bot shares ingress and dispatches only to the matching destination', async (t) => {
  const { channels, c, store } = setup(t);
  c.transport = 'telegram';
  c.peerType = 'private';
  c.peerId = c.senderId;
  store.put('chat-connection', c);
  const other = { ...c, id: id(), conversationId: 'other', peerId: '777', senderId: '777' };
  store.put('chat-connection', other);
  store.put('conversation', {
    id: 'other',
    profileId: 'test',
    projectId: null,
    knowledge: true,
    memory: true,
    skillIds: ['private'],
    permission: 'auto',
  });
  other.authorizedTarget = channels.target('other');
  store.put('chat-connection', other);
  (channels as any).secrets = () => ({ token: '456:test' });
  const transports: any = new ChatTransports(channels),
    session = { abort: new AbortController(), revision: 1 };
  transports.accept(c, session, {
    update_id: 1,
    message: {
      from: { id: 777 },
      chat: { id: 777, type: 'private' },
      text: 'hello',
      date: Date.now() / 1000,
    },
  });
  const rows = store.db.prepare('SELECT connection_id FROM chat_inbox').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].connection_id, other.id);
  await transports.close();
});

import { invitedGroup } from '../server/services/chat-group-context.js';
test('only fresh platform invitation by the configured controller enrolls a group', () => {
  const now = Date.now(),
    c = { ...group(), peerType: 'private' as const, autoInviteGroups: true };
  const e = {
    post_type: 'notice',
    notice_type: 'group_increase',
    sub_type: 'invite',
    self_id: 456,
    user_id: 456,
    operator_id: 123,
    group_id: 999,
    time: now / 1000,
  };
  assert.equal(invitedGroup(c, e, now), '999');
  for (const change of [
    { operator_id: 124 },
    { self_id: 123 },
    { user_id: 123 },
    { sub_type: 'approve' },
    { post_type: 'message' },
    { time: now / 1000 - 700 },
    { group_id: 'bad' },
  ])
    assert.equal(invitedGroup(c, { ...e, ...change }, now), undefined);
  assert.equal(invitedGroup({ ...c, enabled: false }, e, now), undefined);
});
test('verified invitation creates isolated ordinary route once and never revives paused route', (t) => {
  const { channels, c, store } = setup(t);
  c.peerType = 'private';
  c.autoInviteGroups = true;
  c.sharedKnowledge = false;
  store.put('chat-connection', c);
  (channels as any).secrets = () => ({ token: 'test', appSecret: '', verifyToken: '' });
  const e = {
    post_type: 'notice',
    notice_type: 'group_increase',
    sub_type: 'invite',
    self_id: 456,
    user_id: 456,
    operator_id: 123,
    group_id: 999,
    time: Date.now() / 1000,
  };
  const created = channels.enrollInvitedGroup(c, e)!;
  assert(created);
  assert.equal(created.accessMode, 'chat');
  assert.equal(created.remoteApprovals, false);
  assert.equal(created.sharedKnowledge, false);
  assert.equal(created.allGroupMembers, true);
  assert.notEqual(created.conversationId, c.conversationId);
  assert.equal(store.get<any>('conversation', created.conversationId).memory, false);
  channels.pause(created.id);
  assert.equal(channels.enrollInvitedGroup(c, e), undefined);
  assert.equal(channels.get(created.id).enabled, false);
});
test('passive group context is bounded, deduplicated and shared by members only within that group', (t) => {
  const { channels, c, store, calls } = setup(t);
  Object.assign(c, {
    accessMode: 'chat',
    allGroupMembers: true,
    groupContext: true,
    groupReplyMode: 'mentions',
  });
  store.put('chat-connection', c);
  const now = Date.now();
  for (let n = 0; n < 50; n++)
    channels.receive(
      c.id,
      {
        id: String(n),
        senderId: String(120 + (n % 2)),
        peerId: c.peerId,
        peerType: 'group',
        text: 'message ' + n,
        timestamp: now,
      },
      now + n,
    );
  channels.receive(
    c.id,
    {
      id: '49',
      senderId: '121',
      peerId: c.peerId,
      peerType: 'group',
      text: 'message 49',
      timestamp: now,
    },
    now + 60,
  );
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM chat_group_context').get()!.n, 40);
  assert.equal(channels.groups.text(c).includes('message 0"'), false);
  assert.equal(channels.groups.text({ ...c, id: 'other' }).includes('message 49'), false);
  assert.equal(channels.groups.text(c, now + 86400100).includes('message 49'), false);
  channels.tick();
  assert.equal(calls.length, 0);
  channels.receive(c.id, {
    id: 'direct',
    senderId: '121',
    peerId: c.peerId,
    peerType: 'group',
    text: 'please answer',
    addressed: true,
    timestamp: now,
  });
  channels.tick();
  assert.equal(calls.length, 1);
  assert(calls[0][1].includes('message 49'));
  assert(calls[0][1].includes('Platform sender ID: 121'));
  const event = store.events(c.conversationId).find((e) => e.type === 'chat.origin');
  assert.equal(event?.data.senderId, '121');
});
test('unsolicited decisions debounce, need fresh content, respect cooldown and hourly budget', (t) => {
  const { channels, c } = setup(t);
  Object.assign(c, {
    accessMode: 'chat',
    allGroupMembers: true,
    groupContext: true,
    groupReplyMode: 'participate',
  });
  const now = Date.now();
  const observe = (i: number, at: number) =>
    channels.groups.observe(
      c,
      { id: String(i), senderId: '123', peerId: c.peerId, text: 'discussion', timestamp: at },
      at,
    );
  observe(0, now);
  assert.equal(channels.groups.consume(c, now + 1000), false);
  assert.equal(channels.groups.consume(c, now + 6000), true);
  assert.equal(channels.groups.consume(c, now + 7000), false);
  observe(99, now + 10000);
  assert.equal(channels.groups.consume(c, now + 16000), false);
  for (let i = 1; i <= 2; i++) {
    observe(i, now + i * 130000);
    assert.equal(channels.groups.consume(c, now + i * 130000 + 6000), true);
  }
  observe(3, now + 390000);
  assert.equal(channels.groups.consume(c, now + 396000), false);
  observe(4, now + 3601000);
  assert.equal(channels.groups.consume(c, now + 3607000), true);
});
test('proactive turn cannot generate media, execute or schedule even with permissive conversation', (t) => {
  const { store } = setup(t);
  store.put('chat-proactive-run', { id: 'r' });
  const ctx: any = {
    store,
    run: { id: 'r', depth: 0 },
    conversation: { permission: 'auto', projectId: 'p' },
    config: { get: () => ({ web: { enabled: true } }) },
  };
  for (const tool of [
    'generate_media',
    'run_command',
    'create_scheduled_task',
    'spawn_agent',
    'fetch_url',
  ])
    assert.equal(capabilityDecision(ctx, tool, 'read').allowed, false);
  assert.equal(capabilityDecision(ctx, 'search_knowledge', 'read').allowed, true);
});
test('own bot messages ignored; only real mention segment addresses a group', (t) => {
  const { channels, c } = setup(t);
  assert.equal(
    channels.receive(c.id, {
      id: 'own',
      peerId: c.peerId,
      peerType: 'group',
      senderId: c.accountId,
      text: 'hello',
      timestamp: Date.now(),
    }),
    'ignored',
  );
  const base = {
    post_type: 'message',
    message_type: 'group',
    self_id: 456,
    user_id: 123,
    group_id: 789,
    message_id: 1,
    time: Date.now() / 1000,
  };
  assert.equal(
    incoming(c, { ...base, message: [{ type: 'text', data: { text: '@456 hello' } }] })[0]
      .addressed,
    false,
  );
  assert.equal(
    incoming(c, {
      ...base,
      message: [
        { type: 'at', data: { qq: '456' } },
        { type: 'text', data: { text: 'hello' } },
      ],
    })[0].addressed,
    true,
  );
});

test('silent proactive result is not delivered even after status notice changes', (t) => {
  const { channels, c, store } = setup(t);
  store.put('chat-proactive-run', { id: 'r' });
  store.db
    .prepare(
      'INSERT INTO chat_inbox(id,connection_id,received_at,state,text,run_id,notice) VALUES(?,?,?,?,?,?,?)',
    )
    .run('in', c.id, Date.now(), 'running', '', 'r', 'waiting_user');
  (store as any).maybeRunHeader = () => ({ id: 'r', status: 'completed' });
  (store as any).eventsForRun = () => [{ data: { final: true, text: '[NO_REPLY]' } }];
  channels.tick();
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM chat_outbox').get()!.n, 0);
});
test('shared socket sends a follower queue even when owner has no messages, then fairly rotates', async (t) => {
  const { channels, c, store } = setup(t);
  c.id = '00000000-0000-4000-8000-000000000001';
  store.db.prepare("DELETE FROM records WHERE kind='chat-connection'").run();
  store.put('chat-connection', c);
  const follower = { ...c, id: '00000000-0000-4000-8000-000000000002', peerId: '888' };
  store.put('chat-connection', follower);
  (channels as any).secrets = () => ({ token: 'test' });
  (channels as any).tick = () => {};
  const transports: any = new ChatTransports(channels),
    sent: string[] = [];
  transports.connectSocket = () => {};
  const session = {
    revision: c.revision,
    abort: new AbortController(),
    sending: false,
    nextPoll: 0,
    nextSend: 0,
    pending: new Map(),
    socket: { readyState: WebSocket.OPEN, close() {} },
  };
  transports.sessions.set(c.id, session);
  transports.deliver = async (route: ChatConnection) => {
    sent.push(route.id);
    store.db.prepare("UPDATE chat_outbox SET state='sent' WHERE connection_id=?").run(route.id);
  };
  channels.reply(follower, 'f', 'hello');
  transports.tick();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent, [follower.id]);
  channels.reply(c, 'c', 'hello');
  channels.reply(follower, 'f2', 'hello');
  session.nextSend = 0;
  transports.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(sent[1], c.id);
  await transports.close();
});

test('mentioning another member and quoting a message preserves actual sender identity', () => {
  const c = group();
  const [m] = incoming(c, {
    post_type: 'message',
    message_type: 'group',
    self_id: 456,
    user_id: 123,
    group_id: 789,
    message_id: 7,
    time: Date.now() / 1000,
    message: [
      { type: 'reply', data: { id: '42' } },
      { type: 'at', data: { qq: '124' } },
      { type: 'text', data: { text: 'your idea works' } },
    ],
  });
  assert.equal(m.senderId, '123');
  assert.equal(m.addressed, false);
  assert(m.text.includes('Mention ID: 124'));
  assert(m.text.includes('Reply message ID: 42'));
});

test('model output is converted before delivery while local event and approval text remain intact', (t) => {
  const { channels, c, store } = setup(t);
  store.db
    .prepare(
      'INSERT INTO chat_inbox(id,connection_id,received_at,state,text,run_id) VALUES(?,?,?,?,?,?)',
    )
    .run('format', c.id, Date.now(), 'running', '', 'r');
  const event = { data: { final: true, text: '## 标题\n\n**正文**' } };
  (store as any).maybeRunHeader = () => ({ id: 'r', status: 'completed' });
  (store as any).eventsForRun = () => [event];
  channels.tick();
  assert.equal(store.db.prepare('SELECT text FROM chat_outbox').get()!.text, '标题\n\n正文');
  assert.equal(event.data.text, '## 标题\n\n**正文**');
  channels.reply(c, 'approval', 'Review exact payload: **literal** /approve abc');
  assert.equal(
    store.db.prepare("SELECT text FROM chat_outbox WHERE id='approval:0'").get()!.text,
    'Review exact payload: **literal** /approve abc',
  );
});

test('new routes display the authenticated shared connection without masking route errors', (t) => {
  const { channels, c, store } = setup(t);
  (channels as any).secrets = () => ({ token: 'same' });
  store.put('chat-transport-state', { id: c.id, status: 'connected' });
  const other = { ...c, id: id(), peerId: '999' };
  store.put('chat-connection', other);
  assert.equal(channels.overview().find((x) => x.id === other.id)!.status.status, 'connected');
  store.put('chat-transport-state', { id: other.id, status: 'delivery-uncertain' });
  assert.equal(
    channels.overview().find((x) => x.id === other.id)!.status.status,
    'delivery-uncertain',
  );
  channels.pause(other.id);
  assert.equal(channels.overview().find((x) => x.id === other.id)!.status.status, 'paused');
});

test('native replies carry structured mentions, quotes and faces without parsing CQ text', () => {
  const c = group();
  const action = onebotAction(c, 'literal [CQ:at,qq=all]', 'e', {
    mentions: ['123'],
    replyTo: 'm1',
    faces: ['14'],
  });
  assert.deepEqual(
    action.params.message.map((p: any) => p.type),
    ['reply', 'at', 'text', 'face'],
  );
  assert.equal(action.params.group_id, 789);
  const wechat = onebotAction(group('onebot12'), 'hello', 'e', {
    mentions: ['123'],
    replyTo: 'm1',
  });
  assert.deepEqual(wechat.params.message[0], { type: 'reply', data: { message_id: 'm1' } });
  assert.deepEqual(wechat.params.message[1], { type: 'mention', data: { user_id: '123' } });
});
test('group file notices and mixed unsupported segments preserve downloadable media', () => {
  const c = group();
  const file = incoming(c, {
    post_type: 'notice',
    notice_type: 'group_upload',
    self_id: 456,
    group_id: 789,
    user_id: 123,
    time: Date.now() / 1000,
    file: { id: 'file123', name: 'notes.pdf', url: 'https://example.org/file' },
  })[0];
  assert.equal(file.peerId, '789');
  assert.equal(file.media?.[0].kind, 'file');
  const mixed = incoming(c, {
    post_type: 'message',
    message_type: 'group',
    self_id: 456,
    group_id: 789,
    user_id: 123,
    message_id: 1,
    time: Date.now() / 1000,
    message: [
      { type: 'json', data: { data: 'bad' } },
      { type: 'image', data: { file: 'abc', url: 'https://example.org/image' } },
    ],
  })[0];
  assert.equal(mixed.media?.length, 1);
  assert.match(mixed.text, /attached media/);
});
test('reply plans cannot target another group or promote a claimed identity', async (t) => {
  const { store, channels, c } = setup(t);
  const { validateReplyPlan, currentChat } = await import('../server/services/chat-interaction.js');
  new ChatTransports(channels);
  const m = {
    id: 'm1',
    senderId: '123',
    peerId: c.peerId,
    peerType: 'group' as const,
    text: '/amadeus hello',
    timestamp: Date.now(),
  };
  channels.receive(c.id, m);
  validateReplyPlan(store, c, { mentions: ['123'], replyTo: 'm1' });
  assert.throws(() => validateReplyPlan(store, c, { mentions: ['all'] }));
  assert.throws(() => validateReplyPlan(store, c, { mentions: ['999'] }));
  assert.throws(() => validateReplyPlan(store, { ...c, id: 'other' }, { replyTo: 'm1' }));
  assert.throws(() => currentChat(store, c.conversationId, 'local-run'));
  store.db
    .prepare("UPDATE chat_inbox SET run_id='r',state='running' WHERE connection_id=?")
    .run(c.id);
  assert.equal(currentChat(store, c.conversationId, 'r').c.peerId, c.peerId);
  assert.throws(() => currentChat(store, 'other-conversation', 'r'));
});
test('passive media can be imported once without starting a model turn or reading host paths', async (t) => {
  const { store, channels, c } = setup(t);
  c.accessMode = 'chat';
  c.groupContext = true;
  c.allGroupMembers = true;
  store.put('chat-connection', c);
  const transport: any = new ChatTransports(channels);
  const session = { abort: new AbortController(), pending: new Map(), downloading: false };
  transport.chatSession = () => session;
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0d8AAAAASUVORK5CYII=',
    'base64',
  );
  let calls = 0;
  transport.socketRequest = async () => {
    calls++;
    return { base64: png.toString('base64'), url: 'C:/must-not-read' };
  };
  channels.receive(c.id, {
    id: 'pic',
    senderId: '123',
    peerId: c.peerId,
    peerType: 'group',
    text: 'image',
    timestamp: Date.now(),
    media: [{ id: 'encoded-file', kind: 'image', name: 'pic.png' }],
  });
  assert.match(channels.groups.text(c), /Media not imported/);
  const refs = await transport.importChatMedia(c, 'pic');
  assert.equal(refs.length, 1);
  const a = store.get<any>('attachment', refs[0].slice(11));
  assert.equal(a.mime, 'image/png');
  assert.ok(a.messageEventId);
  assert.deepEqual(await transport.importChatMedia(c, 'pic'), refs);
  assert.equal(calls, 1);
  assert.equal(
    store.db.prepare("SELECT count(*) AS n FROM chat_inbox WHERE state='queued'").get()!.n,
    0,
  );
  await assert.rejects(() => transport.importChatMedia({ ...c, id: 'other' }, 'pic'));
});
test('voice import requests converted audio bytes even when the source has a URL', async (t) => {
  const { channels, c } = setup(t);
  const transport: any = new ChatTransports(channels);
  const session = { abort: new AbortController(), pending: new Map(), downloading: false };
  transport.chatSession = () => session;
  let action = '';
  transport.socketRequest = async (_c: any, _s: any, a: string, params: any) => {
    action = a;
    assert.equal(params.out_format, 'mp3');
    return { base64: Buffer.from('ID3 test audio').toString('base64'), url: 'C:/never-read' };
  };
  channels.receive(c.id, {
    id: 'voice',
    senderId: '123',
    peerId: c.peerId,
    peerType: 'group',
    text: 'voice',
    timestamp: Date.now(),
    media: [
      { id: 'voice-id', url: 'http://example.org/raw.silk', kind: 'audio', name: 'voice.ogg' },
    ],
  });
  const refs = await transport.importChatMedia(c, 'voice');
  assert.equal(action, 'get_record');
  assert.equal(refs.length, 1);
});

test('legacy observed media recovery verifies group and sender, and read_chat_media returns pixels', async (t) => {
  const { store, channels, c } = setup(t);
  c.accessMode = 'chat';
  c.groupContext = true;
  store.put('chat-connection', c);
  const transport: any = new ChatTransports(channels);
  transport.chatSession = () => ({ abort: new AbortController(), pending: new Map() });
  store.db
    .prepare('INSERT INTO chat_group_context VALUES(?,?,?,?,?)')
    .run(c.id, 'old', '123', 'Please inspect the attached media.', Date.now());
  assert.match(channels.groups.text(c), /legacy-metadata-missing/);
  const sharp = (await import('sharp')).default;
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ff0000' } })
    .png()
    .toBuffer();
  let foreign = true;
  transport.socketRequest = async (_c: any, _s: any, action: string) =>
    action === 'get_msg'
      ? {
          message_id: 'old',
          group_id: foreign ? 'other' : c.peerId,
          message_type: 'group',
          user_id: 123,
          time: Date.now() / 1000,
          message: [{ type: 'image', data: { file: 'opaque' } }],
        }
      : { base64: png.toString('base64') };
  await assert.rejects(() => transport.importChatMedia(c, 'old'), /does not match/);
  await assert.rejects(() => transport.importChatMedia(c, 'unobserved'), /not observed/);
  foreign = false;
  const refs = await transport.importChatMedia(c, 'old');
  assert.equal(refs.length, 1);
  assert.match(channels.groups.text(c), /available-via-read_chat_media/);
  store.db
    .prepare(
      "INSERT INTO chat_inbox(id,connection_id,received_at,state,text,run_id) VALUES('active',?,?,'running','','r')",
    )
    .run(c.id, Date.now());
  const definitions: any[] = [];
  (await import('../server/tools/chat-tools.js')).installChatTools({
    add: (d: any) => definitions.push(d),
  } as any);
  const tool = definitions.find((d) => d.name === 'read_chat_media');
  const ctx: any = {
    store,
    conversation: { id: c.conversationId },
    run: { id: 'r', profileId: 'test' },
    config: { profile: () => ({ vision: true }) },
    media: { output: async () => ({ bytes: png, mime: 'image/png' }) },
  };
  const result = await tool.run({ messageId: 'old' }, ctx);
  assert.equal(result.images.length, 1);
  assert.match(result.images[0], /^data:image\//);
  assert.equal(JSON.parse(result.content).results[0].status, 'pixels-attached');
  ctx.config.profile = () => ({ vision: false });
  const noVision = await tool.run({ messageId: 'old' }, ctx);
  assert.equal(noVision.images, undefined);
  assert.match(noVision.content, /model-does-not-declare-vision/);
});

function friendSetup(t: any) {
  const f = setup(t);
  const c = {
    ...f.c,
    peerType: 'private' as const,
    peerId: f.c.senderId,
    reviewFriendRequests: true,
  };
  f.store.put('chat-connection', c);
  f.channels.secrets = () => ({ token: 'test-token', appSecret: '', verifyToken: '' });
  const review = new ChatFriendReview(f.channels);
  const event = (peer = '999', flag = 'request-one') => ({
    post_type: 'request',
    request_type: 'friend',
    self_id: c.accountId,
    user_id: peer,
    flag,
    comment: 'hello',
    time: Math.floor(Date.now() / 1000),
  });
  const message = (text = '同意', senderId = c.senderId) => ({
    id: id(),
    senderId,
    peerId: c.peerId,
    timestamp: Date.now(),
    text,
  });
  return { ...f, c, review, event, message };
}
test('friend requests require controller review, deduplicate and create isolated ordinary chats', async (t) => {
  const { channels, store, c, review, event, message } = friendSetup(t);
  review.observe(c, event());
  review.observe(c, event());
  assert.equal(store.list('chat-friend-request').length, 1);
  assert.equal(channels.list().length, 1);
  const calls: any[] = [];
  await review.answer(c, message('同意', '999'), async (...args) => calls.push(args));
  assert.equal(calls.length, 0);
  const m = message();
  await review.answer(c, m, async (...args) => calls.push(args));
  await review.answer(c, m, async (...args) => calls.push(args));
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'set_friend_add_request');
  assert.equal(calls[0][1].approve, true);
  const friend = channels.list().find((x) => x.peerId === '999')!;
  assert.equal(friend.accessMode, 'chat');
  assert.equal(friend.remoteApprovals, false);
  assert.equal(friend.reviewFriendRequests, false);
  assert.equal(friend.autoInviteGroups, false);
  assert.notEqual(friend.conversationId, c.conversationId);
  const conversation: any = store.get('conversation', friend.conversationId);
  assert.equal(conversation.memory, false);
  assert.equal(conversation.projectId, null);
  assert(!conversation.allowedTools.includes('run_command'));
  review.observe(c, event('998', 'second'));
  await review.answer(c, message(), async () => undefined);
  assert.notEqual(
    channels.list().find((x) => x.peerId === '998')!.conversationId,
    friend.conversationId,
  );
});
test('ambiguous assent and task approval cannot accept a friend; uncertain results are not retried', async (t) => {
  const { store, c, review, event, message } = friendSetup(t);
  review.observe(c, event());
  review.observe(c, event('998', 'second'));
  let calls = 0;
  await review.answer(c, message(), async () => calls++);
  assert.equal(calls, 0);
  const r: any = store.list('chat-friend-request')[0];
  await review.answer(c, message('同意 ' + r.code), async () => {
    calls++;
    throw Error('timeout');
  });
  await review.answer(c, message('同意 ' + r.code), async () => calls++);
  assert.equal(calls, 1);
  store.put('input', { id: 'pending-task', conversationId: c.conversationId, status: 'pending' });
  await review.answer(c, message(), async () => calls++);
  assert.equal(calls, 1);
});
test('native manual acceptance enrolls only observed requests; disabled, stale and wrong-account events do nothing', (t) => {
  const { channels, c, review, event } = friendSetup(t);
  review.observe({ ...c, reviewFriendRequests: false }, event());
  review.observe(c, { ...event(), self_id: 'other' });
  review.observe(c, { ...event(), time: 1 });
  assert.equal(channels.list().length, 1);
  review.observe(c, event());
  const notice = { ...event(), post_type: 'notice', notice_type: 'friend_add' };
  review.observe(c, notice);
  assert.equal(channels.list().length, 2);
  const friend = channels.list().find((x) => x.peerId === '999')!;
  channels.pause(friend.id);
  review.observe(c, notice);
  assert.equal(channels.get(friend.id).enabled, false);
});

test('friend denial, capacity and changed permissions cannot enroll or perform unintended actions', async (t) => {
  const { channels, store, c, review, event, message } = friendSetup(t);
  review.observe(c, event());
  let actions: any[] = [];
  await review.answer(c, message('拒绝'), async (_a, params) => actions.push(params));
  assert.equal(actions[0].approve, false);
  assert.equal(channels.list().length, 1);
  review.observe(c, event('998', 'capacity'));
  for (let n = 0; n < 19; n++)
    store.put('chat-connection', {
      ...c,
      id: 'existing-' + n,
      peerId: String(2000 + n),
      reviewFriendRequests: false,
    });
  await review.answer(c, message(), async (_a, params) => actions.push(params));
  assert.equal(actions.length, 1);
  assert.equal(channels.list().length, 20);
  store.put('conversation', {
    ...store.get<any>('conversation', c.conversationId),
    permission: 'ask',
  });
  await assert.rejects(
    review.answer(c, message(), async (_a, params) => actions.push(params)),
    /changed/,
  );
  assert.equal(actions.length, 1);
});
