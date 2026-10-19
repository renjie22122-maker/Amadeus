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
