import { onebotSendError, ChatSendRejected } from '../server/services/chat-send-error.js';
import Fastify from 'fastify';
import { chatConnectionRoutes } from '../server/http/chat-connections.js';
import { ScheduledWorkService } from '../server/services/scheduled-work.js';
import { installScheduledTools } from '../server/tools/scheduled-tools.js';
import { authorizeGroupMedia, mediaFingerprint } from '../server/services/chat-media-grant.js';
import {
  trackChatTranscription,
  observeChatTranscript,
  continueChatTranscription,
} from '../server/services/chat-transcription.js';
import {
  deliveryReceipt,
  recallTarget,
  remoteReviewPolicy,
} from '../server/services/chat-recall.js';
import { chatApprovalSummary } from '../server/services/chat-approval-format.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, createHmac, randomBytes } from 'node:crypto';
import { Store, id } from '../server/storage/store.js';
import { ChatConnections } from '../server/services/chat-connections.js';
import {
  incoming,
  messageParts,
  qqSign,
  qqVerify,
  whatsappSignature,
  onebotAction,
} from '../server/services/chat-protocols.js';
import {
  decryptWecomFile,
  downloadChatBytes,
  storeChatAttachment,
} from '../server/services/chat-media.js';
import type { ChatConnection } from '../shared/chat-connections.js';
import { Runtime } from '../server/core/runtime.js';
import { ChatTransports } from '../server/services/chat-transports.js';

const base = (transport: ChatConnection['transport']): ChatConnection => ({
  id: id(),
  name: 'test',
  transport,
  conversationId: 'chat',
  senderId: '123',
  peerId: '123',
  enabled: true,
  endpoint: '',
  accountId: '456',
  apiVersion: '',
  webhookPort: 8788,
  remoteApprovals: false,
  authorizedTarget: '',
  activatedAt: Date.now() - 1000,
  revision: 1,
});
function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'amadeus-chat-'));
  const store = new Store(join(dir, 'test.db'));
  const calls: any[] = [];
  const runtime: any = {
    config: { profile: () => ({ baseUrl: 'https://example.invalid', model: 'test' }) },
    active: () => undefined,
    start: (...args: any[]) => calls.push(args),
    stop: (key: string) => calls.push(['stop', key]),
    inputs: { answer: (...args: any[]) => calls.push(['answer', ...args]) },
  };
  store.put('conversation', { id: 'chat', profileId: 'model', permission: 'ask' });
  const channel = new ChatConnections(store, runtime, dir),
    c = base('telegram');
  c.authorizedTarget = channel.target('chat');
  store.put('chat-connection', c);
  t.after(() => {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, store, runtime, channel, c, calls };
}
test('all transports normalize private media without interpreting embedded commands', () => {
  const now = Date.now() / 1000;
  const cases: [ChatConnection['transport'], any][] = [
    [
      'telegram',
      {
        update_id: 1,
        message: {
          from: { id: 123 },
          chat: { id: 123, type: 'private' },
          date: now,
          caption: 'look',
          photo: [{ file_id: 'small' }, { file_id: 'large' }],
        },
      },
    ],
    [
      'whatsapp',
      {
        object: 'whatsapp_business_account',
        entry: [
          {
            changes: [
              {
                field: 'messages',
                value: {
                  metadata: { phone_number_id: '456' },
                  messages: [
                    { id: 'm', from: '123', timestamp: now, type: 'audio', audio: { id: '9' } },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
    [
      'vk',
      {
        type: 'message_new',
        object: {
          message: {
            id: 1,
            from_id: 123,
            peer_id: 123,
            date: now,
            text: 'listen',
            attachments: [
              {
                type: 'audio_message',
                audio_message: { link_mp3: 'https://example.com/test.mp3' },
              },
            ],
          },
        },
      },
    ],
    [
      'qq',
      {
        op: 0,
        t: 'C2C_MESSAGE_CREATE',
        d: {
          id: 'm',
          author: { user_openid: '123' },
          timestamp: new Date().toISOString(),
          attachments: [{ url: 'https://example.com/image.jpg', content_type: 'image/jpeg' }],
        },
      },
    ],
    [
      'wecom',
      {
        cmd: 'aibot_msg_callback',
        body: {
          msgid: 'm',
          aibotid: '456',
          chattype: 'single',
          from: { userid: '123' },
          msgtype: 'image',
          image: { url: 'https://example.com/image', aeskey: 'key' },
        },
      },
    ],
    [
      'onebot11',
      {
        post_type: 'message',
        message_type: 'private',
        self_id: 456,
        user_id: 123,
        message_id: 1,
        time: now,
        message: [{ type: 'image', data: { file: 'image' } }],
      },
    ],
    [
      'onebot12',
      {
        type: 'message',
        detail_type: 'private',
        self: { platform: 'wechat', user_id: '456' },
        user_id: '123',
        id: 'm',
        time: now,
        message: [{ type: 'video', data: { file_id: 'video' } }],
      },
    ],
  ];
  for (const [transport, event] of cases) {
    const result = incoming(base(transport), event);
    assert.equal(result.length, 1, transport);
    assert.equal(result[0].senderId, '123');
    assert.equal(result[0].media?.length, 1);
    assert(result[0].text);
  }
  assert.equal(incoming(base('telegram'), { message: { chat: { type: 'group' } } }).length, 0);
  assert.equal(
    incoming(base('onebot11'), {
      post_type: 'message',
      message_type: 'private',
      self_id: 456,
      user_id: 123,
      message_id: 1,
      time: now,
      message: [{ type: 'forward', data: { id: 'x' } }],
    }).length,
    1,
  );
  assert.equal(
    incoming(base('wecom'), {
      cmd: 'aibot_msg_callback',
      body: { chattype: 'single', aibotid: 'different' },
    }).length,
    0,
  );
  assert.equal(
    onebotAction(base('onebot11'), '[CQ:record,file=secret]', 'e').params.message[0].type,
    'text',
  );
});
test('signatures reject modified bodies, incorrect secrets and stale QQ timestamps', () => {
  const body = Buffer.from('{"message":"中文"}'),
    secret = 'test-secret',
    ts = String(Math.floor(Date.now() / 1000));
  const sig = qqSign(secret, ts + body.toString());
  assert(qqVerify(secret, body, ts, sig));
  assert(!qqVerify(secret, Buffer.from('changed'), ts, sig));
  assert(!qqVerify(secret, body, ts, sig, Date.now() + 600000));
  const h = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  assert(whatsappSignature(body, h, secret));
  assert(!whatsappSignature(body, h, 'wrong'));
});
test('UTF8 response splitting preserves every character and byte budgets', () => {
  const text = '中文🙂'.repeat(1800);
  const parts = messageParts(text);
  assert.equal(parts.join(''), text);
  assert(parts.every((p) => Buffer.byteLength(p) <= 2800));
});
test('inbox rejects outsiders and replay; binds only explicit media to the new run', (t) => {
  const { channel, c, calls, store } = fixture(t);
  const m = { id: 'one', senderId: '123', peerId: '123', text: 'read', timestamp: Date.now() };
  assert.throws(() => channel.receive(c.id, { ...m, senderId: '999' }), /Unbound/);
  assert.equal(channel.receive(c.id, m), 'queued');
  assert.equal(channel.receive(c.id, m), 'duplicate');
  channel.tick(Date.now() + 20000);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][3].attachmentIds, []);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM chat_inbox').get()!.n, 1);
});
test('pending media prevents later text overtaking; stop cancels both without starting work', (t) => {
  const { channel, c, calls, store } = fixture(t),
    now = Date.now();
  channel.receive(
    c.id,
    {
      id: 'media',
      senderId: '123',
      peerId: '123',
      text: 'photo',
      timestamp: now,
      media: [{ id: 'f', kind: 'image', name: 'photo.jpg' }],
    },
    now,
  );
  channel.receive(
    c.id,
    { id: 'later', senderId: '123', peerId: '123', text: 'describe it', timestamp: now },
    now + 1,
  );
  channel.tick(Date.now() + 20000);
  assert.equal(calls.length, 0);
  channel.receive(
    c.id,
    { id: 'stop', senderId: '123', peerId: '123', text: '/stop', timestamp: now },
    now + 2,
  );
  channel.tick(Date.now() + 20000);
  assert.equal(calls.length, 0);
  assert.equal(
    store.db.prepare("SELECT count(*) AS n FROM chat_inbox WHERE state='cancelled'").get()!.n,
    2,
  );
});
test('changed local permissions pause remote access and recipients cannot be rebound', (t) => {
  const { channel, c, store } = fixture(t);
  const { id: _, authorizedTarget, activatedAt, revision, ...input } = c;
  assert.throws(
    () => channel.save({ ...input, peerId: '789', senderId: '789' }, c.id),
    /Create a new connection/,
  );
  store.put('conversation', { id: 'chat', profileId: 'model', permission: 'full' });
  assert.throws(
    () =>
      channel.receive(c.id, {
        id: 'x',
        senderId: '123',
        peerId: '123',
        text: 'run',
        timestamp: Date.now(),
      }),
    /scope or model changed/,
  );
  channel.tick(Date.now() + 20000);
  assert.equal(channel.get(c.id).enabled, false);
});
test('runtime keeps local draft attachments separate from remote and scheduled messages', (t) => {
  const { store } = fixture(t);
  for (const [id, remoteInboxId] of [
    ['draft', undefined],
    ['remote', 'inbox'],
    ['other', 'different'],
  ] as const)
    store.put('attachment', { id, conversationId: 'chat', name: id, remoteInboxId });
  const record = (Runtime.prototype as any).recordUserMessage;
  assert.deepEqual(
    record.call({ store }, 'chat', 'r', 'remote message', false, undefined, ['remote'])
      .attachmentIds,
    ['remote'],
  );
  assert.equal(store.get<any>('attachment', 'draft').messageEventId, undefined);
  assert.deepEqual(
    record.call({ store }, 'chat', 'r', 'timer', false, { id: 'timer', name: 'timer' })
      .attachmentIds,
    [],
  );
  assert.deepEqual(record.call({ store }, 'chat', 'r', 'local message').attachmentIds, ['draft']);
  assert.equal(store.get<any>('attachment', 'other').messageEventId, undefined);
});
test('remote approvals are bound, single-use and invalidated by changed payloads', (t) => {
  const { store, channel, c, calls } = fixture(t);
  c.remoteApprovals = true;
  store.put('chat-connection', c);
  store.put('run', {
    id: 'r',
    conversationId: 'chat',
    status: 'waiting_approval',
    createdAt: Date.now(),
  });
  store.db
    .prepare(
      'INSERT INTO chat_inbox(id,connection_id,received_at,state,text,run_id) VALUES(?,?,?,?,?,?)',
    )
    .run('origin', c.id, Date.now(), 'running', '', 'r');
  const q = {
    id: 'approval',
    runId: 'r',
    conversationId: 'chat',
    kind: 'approval',
    status: 'pending',
    createdAt: Date.now(),
    payload: {
      action: 'write_file',
      path: 'report.txt',
      serviceContext: { localityIsAuthorization: false },
    },
  };
  store.put('input', q);
  channel.tick(Date.now() + 20000);
  const notices = store.db
    .prepare('SELECT text FROM chat_outbox')
    .all()
    .map((r) => String(r.text))
    .join('\n');
  assert(notices.includes('/approve '));
  const texts = store.db
    .prepare('SELECT text FROM chat_outbox')
    .all()
    .map((r) => String(r.text));
  assert(texts.some((text) => /^\/approve [a-f0-9]{24}$/.test(text)));
  assert(texts.some((text) => /^\/deny [a-f0-9]{24}$/.test(text)));
  assert(!notices.includes('Action required in Amadeus on your computer'));
  const ticket = store.db.prepare('SELECT code FROM chat_approval').get()!;
  channel.receive(c.id, {
    id: 'details',
    senderId: c.senderId,
    peerId: c.peerId,
    timestamp: Date.now(),
    text: '/details ' + ticket.code,
  });
  assert.equal(calls.filter((x) => x[0] === 'answer').length, 0);
  assert.equal(
    store.db.prepare('SELECT used FROM chat_approval WHERE code=?').get(ticket.code)!.used,
    0,
  );
  assert(
    store.db
      .prepare('SELECT text FROM chat_outbox')
      .all()
      .some((r) => String(r.text).includes('report.txt')),
  );

  const send = (id: string) =>
    channel.receive(c.id, {
      id,
      senderId: c.senderId,
      peerId: c.peerId,
      timestamp: Date.now(),
      text: '/approve ' + ticket.code,
    });
  store.put('input', { ...q, payload: { ...q.payload, path: 'changed.txt' } });
  send('changed');
  assert.equal(calls.length, 0);
  store.put('input', q);
  send('valid');
  assert.equal(calls.filter((x) => x[0] === 'answer').length, 1);
  send('repeat');
  assert.equal(calls.filter((x) => x[0] === 'answer').length, 1);
});
test('only registered outputs from remote runs are queued, without duplicate media', (t) => {
  const { store, channel, c } = fixture(t);
  store.db
    .prepare(
      'INSERT INTO chat_inbox(id,connection_id,received_at,state,text,run_id) VALUES(?,?,?,?,?,?)',
    )
    .run('origin', c.id, Date.now(), 'done', '', 'r');
  store.event('chat', 'local', 'file.attached', {
    attachment: { id: 'private', name: 'local.txt' },
  });
  store.event('chat', 'r', 'file.attached', { attachment: { id: 'result', name: 'result.txt' } });
  for (let i = 0; i < 2; i++)
    store.event('chat', 'r', 'media.updated', {
      job: {
        id: 'media',
        runId: 'r',
        status: 'completed',
        outputs: [{ id: '0', name: 'voice.wav' }],
      },
    });
  channel.tick(Date.now() + 20000);
  channel.tick(Date.now() + 20000);
  const rows = store.db.prepare('SELECT reference FROM chat_outbox ORDER BY reference').all();
  assert.deepEqual(
    rows.map((x) => x.reference),
    ['attachment:result', 'media:media:0'],
  );
});
test('media transport sends the registered bytes and waits for the platform receipt', async (t) => {
  const { channel, c, runtime, store } = fixture(t);
  (channel as any).secrets = () => ({ token: '123:test' });
  runtime.media = {
    streamOutput: () => ({
      metadata: { mime: 'audio/wav', name: 'speech.wav' },
      chunks: (async function* () {
        yield Buffer.from('wav-test');
      })(),
    }),
  };
  const requests: any[] = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (input: any, init: any) => {
    requests.push({ url: String(input), body: init.body });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  };
  t.after(() => {
    globalThis.fetch = previous;
  });
  const transport = new ChatTransports(channel),
    s: any = { abort: new AbortController(), revision: c.revision };
  store.db
    .prepare(
      'INSERT INTO chat_outbox(id,connection_id,state,text,created_at,reference) VALUES(?,?,?,?,?,?)',
    )
    .run('file', c.id, 'pending', 'speech.wav', Date.now(), 'media:m:0');
  await (transport as any).deliver(c, s);
  assert(requests[0].url.endsWith('/sendDocument'));
  assert.equal(await requests[0].body.get('document').text(), 'wav-test');
  assert.equal(store.db.prepare('SELECT state FROM chat_outbox').get()!.state, 'sent');
  await transport.close();
});
test('restart marks ambiguous sends uncertain rather than automatically duplicating them', (t) => {
  const { channel, c, store, runtime, dir } = fixture(t);
  channel.reply(c, 'result', 'done');
  store.db.prepare("UPDATE chat_outbox SET state='sending'").run();
  new ChatConnections(store, runtime, dir);
  assert.equal(store.db.prepare('SELECT state FROM chat_outbox').get()!.state, 'uncertain');
});
test('WeCom file decrypt supports 32-byte PKCS7 and rejects corrupt padding', () => {
  const key = randomBytes(32),
    plain = Buffer.from('ordinary test audio bytes'),
    pad = 32 - (plain.length % 32);
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  const bytes = Buffer.concat([
    cipher.update(Buffer.concat([plain, Buffer.alloc(pad, pad)])),
    cipher.final(),
  ]);
  assert.deepEqual(decryptWecomFile(bytes, key.toString('base64')), plain);
  assert.throws(() => decryptWecomFile(bytes.subarray(1), key.toString('base64')));
});
test('media download rejects local schemes and loopback before any HTTP request', async () => {
  const signal = AbortSignal.timeout(1000);
  await assert.rejects(downloadChatBytes('file:///C:/secret', signal));
  await assert.rejects(downloadChatBytes('https://127.0.0.1/private', signal));
});
test('imported media is owned by its inbox and filenames cannot escape attachment storage', async (t) => {
  const { store, dir } = fixture(t),
    signal = AbortSignal.timeout(2000);
  const key = await storeChatAttachment(
    store,
    dir,
    'chat',
    'inbox',
    { name: '../../clip.wav', kind: 'audio' },
    Buffer.from('RIFF\x00\x00\x00\x00WAVEfmt '),
    signal,
  );
  const a = store.get<any>('attachment', key);
  assert.equal(a.name, 'clip.wav');
  assert.equal(a.remoteInboxId, 'inbox');
  assert(a.path.startsWith(join(dir, 'attachments', key)));
  await assert.rejects(
    storeChatAttachment(
      store,
      dir,
      'chat',
      'inbox',
      { name: 'bad.exe', kind: 'file' },
      Buffer.from('test'),
      signal,
    ),
  );
});
test('reauthorization remains visible; explicit pause clears its notice reason', (t) => {
  const { store, channel, c } = fixture(t);
  store.put('conversation', { id: 'chat', profileId: 'model', permission: 'auto' });
  channel.tick(Date.now() + 20000);
  assert.equal(channel.get(c.id).enabled, false);
  assert.equal(channel.overview()[0].status.status, 'reauthorize');
  channel.pause(c.id);
  assert.equal(channel.overview()[0].status.status, 'paused');
  assert.equal(store.get<any>('chat-transport-state', c.id).reason, 'manual');
});

test('approval summaries preview media prose without changing payload or hiding command targets', () => {
  const payload = {
    command: 'Generate speech',
    backend: 'media-service',
    cwd: 'http://127.0.0.1:8812',
    estimatedUsd: 0,
    request: { model: 'tts', prompt: '語'.repeat(500), options: { voice: 'voice-a' } },
    risk: { level: 'high', zh: '需要人工确认' },
  };
  const before = JSON.stringify(payload),
    summary = chatApprovalSummary(payload);
  assert(summary.includes('共 500 字符'));
  assert(summary.includes('voice-a'));
  assert(summary.includes('http://127.0.0.1:8812'));
  assert(!summary.includes('語'.repeat(101)));
  assert.equal(JSON.stringify(payload), before);
  const command = 'echo ' + 'long '.repeat(150);
  const shell = chatApprovalSummary({
    command,
    backend: 'shell',
    cwd: 'D:/work',
    path: 'D:/work/result.txt',
  });
  assert(shell.includes(command));
  assert(shell.includes('D:/work/result.txt'));
});

test('recall receipts bind bot ownership, exact route and original requester', (t) => {
  const { store, c } = fixture(t);
  c.transport = 'onebot11';
  store.db
    .prepare(
      'INSERT INTO chat_inbox(id,connection_id,received_at,state,text,sender_id) VALUES(?,?,?,?,?,?)',
    )
    .run('request', c.id, Date.now(), 'done', '', 'member');
  deliveryReceipt(store, c, { id: 'request:0' }, 'msg1');
  assert.equal(recallTarget(store, c, 'request:0', 'member').message_id, 'msg1');
  assert.throws(() => recallTarget(store, c, 'request:0', 'stranger'));
  assert.throws(() => recallTarget(store, { ...c, peerId: 'elsewhere' }, 'request:0', c.senderId));
  assert.throws(() => recallTarget(store, c, 'incoming-message', c.senderId));
  assert.equal(recallTarget(store, c, 'request:0', 'admin', true).message_id, 'msg1');
  store.db.prepare("UPDATE chat_delivery SET state='retracted'").run();
  assert.throws(() => recallTarget(store, c, 'request:0', c.senderId));
});
test('expired review cancels queued fragments, cleans only its receipts, and renews without answering locally', (t) => {
  const { store, channel, c, calls } = fixture(t);
  c.remoteApprovals = true;
  store.put('chat-connection', c);
  store.put('run', {
    id: 'review',
    conversationId: 'chat',
    status: 'waiting_approval',
    createdAt: Date.now(),
  });
  store.db
    .prepare(
      'INSERT INTO chat_inbox(id,connection_id,received_at,state,text,run_id) VALUES(?,?,?,?,?,?)',
    )
    .run('request', c.id, Date.now(), 'running', '', 'review');
  const q = {
    id: id(),
    runId: 'review',
    conversationId: 'chat',
    kind: 'approval',
    status: 'pending',
    createdAt: Date.now(),
    payload: { command: 'test', backend: 'test' },
  };
  store.put('input', q);
  channel.tick(Date.now() + 20000);
  const ticket = store.db.prepare('SELECT * FROM chat_approval').get() as any;
  assert(ticket.expires_at - Date.now() <= remoteReviewPolicy(c).ttlMs);
  const row = store.db.prepare('SELECT * FROM chat_outbox LIMIT 1').get() as any;
  deliveryReceipt(store, c, row, 'approval-platform-id');
  store.db.prepare("UPDATE chat_outbox SET state='sent' WHERE id=?").run(row.id);
  store.db.prepare('UPDATE chat_approval SET expires_at=?').run(Date.now() - 1);
  channel.tick(Date.now() + 20000);
  assert.equal(store.db.prepare('SELECT state FROM chat_delivery').get()!.state, 'cleanup-pending');
  assert.equal(store.get<any>('input', q.id).status, 'pending');
  assert.equal(calls.filter((x) => x[0] === 'answer').length, 0);
  const expiry = store.db
    .prepare("SELECT count(*) n FROM chat_outbox WHERE id LIKE 'approval-expired:%'")
    .get()!.n;
  channel.tick(Date.now() + 20000);
  assert.equal(
    store.db.prepare("SELECT count(*) n FROM chat_outbox WHERE id LIKE 'approval-expired:%'").get()!
      .n,
    expiry,
  );
  channel.receive(c.id, {
    id: 'renew-command',
    senderId: c.senderId,
    peerId: c.peerId,
    text: '/renew ' + ticket.code,
    timestamp: Date.now(),
  });
  const renewed = store.db.prepare('SELECT code FROM chat_approval').get()!.code;
  assert.notEqual(renewed, ticket.code);
  assert.equal(store.get<any>('input', q.id).status, 'pending');
});
test('platform windows reserve bridge recall time without claiming a universal OneBot limit', () => {
  assert.equal(remoteReviewPolicy(base('onebot11')).ttlMs, 90000);
  assert.equal(remoteReviewPolicy(base('telegram')).ttlMs, 300000);
  assert.equal(remoteReviewPolicy(base('whatsapp')).cleanup, false);
});

function voiceFixture(t: any) {
  const f = fixture(t),
    run = { id: 'voice-run', status: 'completed', conversationId: f.c.conversationId };
  const row = { id: 'voice-input', sender_id: f.c.senderId };
  f.store.db
    .prepare(
      "INSERT INTO chat_inbox(id,connection_id,received_at,state,text,run_id,sender_id,attachment_ids) VALUES(?,?,?,'running','',?,?,?)",
    )
    .run(row.id, f.c.id, Date.now(), run.id, row.sender_id, JSON.stringify(['voice-audio']));
  trackChatTranscription(f.store, run.id, 'voice-job', 'attachment:voice-audio');
  const job = {
    id: 'voice-job',
    kind: 'transcription',
    status: 'submitting',
    runId: run.id,
    conversationId: f.c.conversationId,
  };
  f.store.put('media-job', job);
  const replies: string[] = [];
  return {
    ...f,
    run,
    row,
    job,
    replies,
    advance: () =>
      continueChatTranscription(f.store, f.c, row, run, (_key, text) => replies.push(text)),
  };
}
test('voice completion queues one same-sender continuation without consuming a composer draft', (t) => {
  const f = voiceFixture(t);
  f.store.put('attachment', {
    id: 'unsent-draft',
    conversationId: f.c.conversationId,
    messageEventId: null,
  });
  assert(f.advance());
  assert.equal(
    f.store.db.prepare("SELECT count(*) n FROM chat_inbox WHERE state='queued'").get()!.n,
    0,
  );
  f.store.put('media-job', {
    ...f.job,
    status: 'completed',
    text: 'Can you understand this voice message?',
  });
  assert(f.advance());
  assert(!f.advance());
  const queued = f.store.db.prepare("SELECT * FROM chat_inbox WHERE state='queued'").get() as any;
  assert.equal(queued.connection_id, f.c.id);
  assert.equal(queued.sender_id, f.c.senderId);
  assert.equal(queued.attachment_ids, '[]');
  assert(queued.text.includes('Can you understand'));
  assert.equal(f.store.get<any>('attachment', 'unsent-draft').messageEventId, null);
  assert.equal(f.replies.length, 0);
});
test('already consumed voice transcripts do not duplicate model replies; changed authority cannot continue', (t) => {
  const f = voiceFixture(t);
  const done = { ...f.job, status: 'completed', text: 'hello' };
  f.store.put('media-job', done);
  observeChatTranscript(f.store, f.run.id, done);
  assert(!f.advance());
  f.store.db.prepare("UPDATE chat_transcription SET state='waiting'").run();
  f.c.revision++;
  assert(!f.advance());
  assert.equal(f.store.db.prepare('SELECT state FROM chat_transcription').get()!.state, 'stopped');
});
test('voice failure and timeout give one clear notice and do not execute transcript tasks', (t) => {
  const f = voiceFixture(t);
  f.store.put('media-job', { ...f.job, status: 'failed' });
  assert(f.advance());
  assert.equal(f.replies.length, 1);
  assert(!f.advance());
  assert.equal(
    f.store.db.prepare("SELECT count(*) n FROM chat_inbox WHERE state='queued'").get()!.n,
    0,
  );
});
test('unrelated audio and draft recording do not register remote continuations', (t) => {
  const f = voiceFixture(t);
  trackChatTranscription(f.store, f.run.id, 'other', 'attachment:unsent-draft');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM chat_transcription').get()!.n, 1);
  f.store.db.prepare('UPDATE chat_transcription SET created_at=?').run(Date.now() - 900001);
  assert(f.advance());
  assert(f.replies[0].includes('超时'));
});

test('group media grant is isolated, metered, revocable, and never applies to proactive turns', (t) => {
  const { store, c } = fixture(t);
  const group = {
    ...c,
    peerType: 'group',
    accessMode: 'chat',
    allGroupMembers: true,
    groupMediaEnabled: true,
    groupMediaMaxUsd: 0,
    groupMediaHourlyLimit: 2,
  };
  store.put('chat-connection', group);
  const service: any = {
    id: 'speech',
    kind: 'speech',
    estimatedUsd: 0,
    baseUrl: 'http://127.0.0.1:8812',
    model: 'test',
    defaults: {},
    apiKey: 'private',
  };
  store.put('chat-media-grant', {
    id: c.id,
    revision: c.revision,
    services: { speech: mediaFingerprint(service) },
  });
  store.db
    .prepare(
      "INSERT INTO chat_inbox(id,connection_id,received_at,state,text,run_id,sender_id) VALUES(?,?,?,'running','request',?,?)",
    )
    .run('in', c.id, Date.now(), 'run', 'member');
  const ctx: any = {
    store,
    conversation: { id: 'chat', remoteChatOnly: true },
    run: { id: 'run' },
    callId: 'first',
  };
  assert.equal(authorizeGroupMedia(ctx, service, { voice: 'saved-voice' }), true);
  assert.equal(authorizeGroupMedia(ctx, service), true); // same tool call cannot double consume
  assert.throws(
    () => authorizeGroupMedia(ctx, { ...service, baseUrl: 'https://changed.example' }),
    /changed/,
  );
  assert.throws(
    () => authorizeGroupMedia(ctx, service, { audio: 'file:///private.wav' }),
    /reference/,
  );
  assert.throws(
    () =>
      authorizeGroupMedia({ ...ctx, conversation: { id: 'other', remoteChatOnly: true } }, service),
    /unavailable/,
  );
  store.put('chat-proactive-run', { id: 'run' });
  assert.throws(() => authorizeGroupMedia(ctx, service), /unsolicited/);
  store.remove('chat-proactive-run', 'run');
  assert.equal(authorizeGroupMedia({ ...ctx, callId: 'second' }, service), true);
  assert.throws(() => authorizeGroupMedia({ ...ctx, callId: 'third' }, service), /quota/);
  store.put('chat-connection', { ...group, revision: 2 });
  assert.throws(() => authorizeGroupMedia(ctx, service), /changed/);
  store.put('chat-connection', { ...group, groupMediaEnabled: false });
  assert.equal(authorizeGroupMedia(ctx, service), false);
});
test('group media never authorizes unknown costs, outsiders or recovery', (t) => {
  const { store, c } = fixture(t);
  const group = {
    ...c,
    peerType: 'group',
    accessMode: 'chat',
    allGroupMembers: false,
    groupMediaEnabled: true,
    groupMediaMaxUsd: 0,
  };
  store.put('chat-connection', group);
  const service: any = { id: 's', estimatedUsd: null };
  store.put('chat-media-grant', {
    id: c.id,
    revision: c.revision,
    services: { s: mediaFingerprint(service) },
  });
  store.db
    .prepare(
      "INSERT INTO chat_inbox(id,connection_id,received_at,state,text,run_id,sender_id) VALUES(?,?,?,'running','request',?,?)",
    )
    .run('in', c.id, Date.now(), 'run', 'outsider');
  const ctx: any = {
    store,
    conversation: { id: 'chat', remoteChatOnly: true },
    run: { id: 'run' },
    callId: 'c',
  };
  assert.throws(() => authorizeGroupMedia(ctx, service), /admitted/);
  store.db.prepare('UPDATE chat_inbox SET sender_id=?').run(c.senderId);
  assert.throws(() => authorizeGroupMedia(ctx, service), /cost/);
  assert.throws(
    () => authorizeGroupMedia({ ...ctx, run: { id: 'run', recoveryOnly: true } }, service),
    /unavailable/,
  );
});

test('local group media settings snapshot service authority without granting remote work', (t) => {
  const { channel, runtime, store } = fixture(t);
  const service: any = {
    id: 'speech',
    kind: 'speech',
    estimatedUsd: 0,
    baseUrl: 'http://127.0.0.1:8812',
    model: 'test',
    defaults: {},
    apiKey: 'private',
  };
  runtime.media = {
    connection: (key: string) => {
      assert.equal(key, 'speech');
      return service;
    },
  };
  const raw: any = {
    name: 'media group',
    transport: 'onebot11',
    conversationId: 'chat',
    senderId: '123',
    peerId: '999',
    accountId: '456',
    peerType: 'group',
    accessMode: 'chat',
    enabled: false,
    endpoint: 'ws://127.0.0.1:3999',
    token: 'local-test-token',
    groupMediaEnabled: true,
    groupMediaServiceIds: ['speech'],
    groupMediaMaxUsd: 0,
  };
  const saved = channel.save(raw);
  assert.equal(saved.remoteApprovals, false);
  const isolated = store.get<any>('conversation', saved.conversationId);
  assert.equal(isolated.remoteChatOnly, true);
  assert.equal(isolated.allowedTools.includes('run_command'), false);
  assert.equal(isolated.allowedTools.includes('read_file'), false);
  assert.equal(
    store.get<any>('chat-media-grant', saved.id).services.speech,
    mediaFingerprint(service),
  );
  assert.throws(
    () => channel.save({ ...raw, peerType: 'private', peerId: '123' }),
    /isolated group/,
  );
});

function completedRemoteReply(t: any, plan: any, final = 'local final') {
  const f = fixture(t);
  f.store.put('run', {
    id: 'delivery-run',
    conversationId: 'chat',
    status: 'completed',
    createdAt: Date.now(),
  });
  f.store.db
    .prepare(
      'INSERT INTO chat_inbox(id,connection_id,received_at,state,text,run_id) VALUES(?,?,?,?,?,?)',
    )
    .run('delivery-inbox', f.c.id, Date.now(), 'running', '', 'delivery-run');
  f.store.put('chat-reply-plan', {
    id: 'delivery-run',
    connectionId: f.c.id,
    revision: f.c.revision,
    ...plan,
  });
  f.store.event('chat', 'delivery-run', 'assistant.message', { final: true, text: final });
  return f;
}
test('explicit chat messages replace final text, preserve order and are queued once', (t) => {
  const { store, channel } = completedRemoteReply(t, { messages: ['first', 'second', 'third'] });
  channel.tick(Date.now() + 20000);
  channel.tick(Date.now() + 20000);
  const rows = store.db.prepare('SELECT text FROM chat_outbox ORDER BY created_at,rowid').all();
  assert.deepEqual(
    rows.map((r) => r.text),
    ['first', 'second', 'third'],
  );
});
test('media-only reply suppresses final emoji and duplicate explicit media references', (t) => {
  const { store, channel } = completedRemoteReply(
    t,
    { mediaOnly: true, references: ['media:voice:0'] },
    '🔊',
  );
  store.event('chat', 'delivery-run', 'media.updated', {
    job: {
      id: 'voice',
      runId: 'delivery-run',
      kind: 'speech',
      status: 'completed',
      outputs: [{ id: '0', name: 'voice.wav' }],
    },
  });
  channel.tick(Date.now() + 20000);
  channel.tick(Date.now() + 20000);
  const rows = store.db.prepare('SELECT text,reference FROM chat_outbox').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reference, 'media:voice:0');
  assert(!rows.some((r) => r.text === '🔊'));
});
test('media-only pending generation sends no placeholder and reports a late failure once', (t) => {
  const { store, channel } = completedRemoteReply(t, { mediaOnly: true }, '🔊');
  store.event('chat', 'delivery-run', 'media.updated', {
    job: { id: 'voice', runId: 'delivery-run', kind: 'speech', status: 'running', outputs: [] },
  });
  channel.tick(Date.now() + 20000);
  assert.equal((store.db.prepare('SELECT count(*) AS n FROM chat_outbox').get() as any).n, 0);
  store.event('chat', 'delivery-run', 'media.updated', {
    job: { id: 'voice', runId: 'delivery-run', kind: 'speech', status: 'failed', outputs: [] },
  });
  channel.tick(Date.now() + 20000);
  channel.tick(Date.now() + 20000);
  const rows = store.db.prepare('SELECT text FROM chat_outbox').all();
  assert.equal(rows.length, 1);
  assert.match(String(rows[0].text), /未成功/);
});
test('media-only without a deliverable reports failure rather than silently dropping the request', (t) => {
  const { store, channel } = completedRemoteReply(t, { mediaOnly: true }, '🔊');
  channel.tick(Date.now() + 20000);
  const rows = store.db.prepare('SELECT text FROM chat_outbox').all();
  assert.equal(rows.length, 1);
  assert.match(String(rows[0].text), /未能生成/);
});
test('changed chat revision invalidates an old multi-message delivery plan', (t) => {
  const { store, channel } = completedRemoteReply(
    t,
    { revision: -1, messages: ['stale reply'] },
    'current reply',
  );
  channel.tick(Date.now() + 20000);
  assert.deepEqual(
    store.db
      .prepare('SELECT text FROM chat_outbox')
      .all()
      .map((r) => r.text),
    ['current reply'],
  );
});

test('remote private style is transient and leaves local conversation settings untouched', (t) => {
  const { channel, c, calls, store } = fixture(t);
  const before = store.get('conversation', 'chat');
  channel.receive(c.id, {
    id: 'casual',
    senderId: '123',
    peerId: '123',
    text: 'hello!',
    timestamp: Date.now(),
  });
  channel.tick(Date.now() + 20000);
  assert.equal(calls.length, 1);
  assert.match(calls[0][3].chatContext, /Remote conversation style/);
  assert.match(calls[0][3].chatContext, /serious factual questions/);
  assert.match(calls[0][3].chatContext, /never relaxes permissions/);
  assert.deepEqual(store.get('conversation', 'chat'), before);
});

test('queued short text burst dispatches once and preserves message order', (t) => {
  const { channel, c, calls, store } = fixture(t);
  const at = Date.now();
  for (const [i, text] of ['ok', 'nice', 'thanks'].entries())
    channel.receive(
      c.id,
      { id: 'burst' + i, senderId: '123', peerId: '123', text, timestamp: at + i * 2000 },
      at + i * 2000,
    );
  channel.tick(Date.now() + 20000);
  assert.equal(calls.length, 1);
  assert.match(calls[0][1], /combined intent once/);
  assert(calls[0][1].indexOf('ok') < calls[0][1].indexOf('nice'));
  assert.equal(
    store.db.prepare("SELECT count(*) AS n FROM chat_inbox WHERE state='done'").get()!.n,
    2,
  );
  channel.tick(Date.now() + 20000);
  assert.equal(calls.length, 1);
});

test('separate bursts are not swallowed by text coalescing', (t) => {
  const { channel, c, calls } = fixture(t);
  const at = Date.now();
  channel.receive(
    c.id,
    { id: 'first', senderId: '123', peerId: '123', text: 'first', timestamp: at },
    at,
  );
  channel.receive(
    c.id,
    { id: 'later', senderId: '123', peerId: '123', text: 'later', timestamp: at + 10000 },
    at + 10000,
  );
  channel.tick(Date.now() + 20000);
  assert.equal(calls.length, 1);
  assert(!calls[0][1].includes('[Message 2]'));
});

test('remote quiet window waits two seconds after last text with five second cap', (t) => {
  const { channel, c, calls } = fixture(t);
  const at = Date.now();
  const send = (id: string, offset: number) =>
    channel.receive(
      c.id,
      { id, senderId: '123', peerId: '123', text: id, timestamp: at + offset },
      at + offset,
    );
  send('a', 0);
  channel.tick(at);
  assert.equal(calls.length, 0);
  send('b', 1500);
  channel.tick(at + 2000);
  assert.equal(calls.length, 0);
  send('c', 3000);
  channel.tick(at + 3500);
  assert.equal(calls.length, 0);
  send('d', 4500);
  channel.tick(at + 4999);
  assert.equal(calls.length, 0);
  channel.tick(at + 5000);
  assert.equal(calls.length, 1);
  assert.match(calls[0][1], /Message 4/);
});

test('single remote message waits briefly and status commands bypass the window', (t) => {
  const { channel, c, calls, store } = fixture(t);
  const at = Date.now();
  channel.receive(
    c.id,
    { id: 'single', senderId: '123', peerId: '123', text: 'hello', timestamp: at },
    at,
  );
  channel.tick(at + 1999);
  assert.equal(calls.length, 0);
  channel.receive(
    c.id,
    { id: 'status-now', senderId: '123', peerId: '123', text: '/status', timestamp: at },
    at,
  );
  assert(store.db.prepare('SELECT count(*) AS n FROM chat_outbox').get()!.n);
  channel.tick(at + 2000);
  assert.equal(calls.length, 1);
});

for (const outcome of ['update', 'unchanged'])
  test('remote scheduled ' + outcome + ' respects notification and route', (t) => {
    const { channel, c, store, runtime, calls } = fixture(t);
    new ChatTransports(channel);
    runtime.start = (chat: string, prompt: string, _n: number, options: any) => {
      calls.push([chat, prompt, 0, options]);
      store.put('run', { id: options.runId, conversationId: chat, status: 'running' });
    };
    store.put('scheduled-work', {
      id: 'followup',
      conversationId: 'chat',
      prompt: 'check in',
      dueAt: 0,
      enabled: true,
      status: 'waiting',
      notifications: 'meaningful',
      remoteDelivery: { connectionId: c.id, revision: c.revision, senderId: c.senderId },
    });
    const scheduler = new ScheduledWorkService(store, runtime);
    scheduler.tick();
    assert.equal(calls.length, 1);
    const runId = calls[0][3].runId;
    assert.equal(
      store.db.prepare('SELECT connection_id FROM chat_inbox WHERE run_id=?').get(runId)!
        .connection_id,
      c.id,
    );
    store.put('run', { id: runId, conversationId: 'chat', status: 'completed' });
    store.event('chat', runId, 'assistant.message', { final: true, text: 'followup reply' });
    store.event('chat', runId, 'file.attached', {
      attachment: { id: 'followup', name: 'report.txt' },
    });
    store.put('schedule-report', { id: runId, outcome, summary: 'done' });
    channel.tick();
    channel.tick();
    assert.equal(
      store.db.prepare('SELECT count(*) AS n FROM chat_outbox').get()!.n,
      outcome === 'update' ? 2 : 0,
    );
  });

test('changed or paused route cannot receive scheduled launches', (t) => {
  const { channel, c, store, runtime, calls } = fixture(t);
  new ChatTransports(channel);
  store.put('scheduled-work', {
    id: 'followup',
    conversationId: 'chat',
    prompt: 'check in',
    dueAt: 0,
    enabled: true,
    status: 'waiting',
    remoteDelivery: { connectionId: c.id, revision: c.revision - 1, senderId: c.senderId },
  });
  new ScheduledWorkService(store, runtime).tick();
  assert.equal(calls.length, 0);
  assert.equal(store.get<any>('scheduled-work', 'followup').status, 'needs_attention');
});

test('remote schedule needs controller and bounds, and snapshots route only after approval', async (t) => {
  const { channel, c, store, runtime } = fixture(t);
  new ChatTransports(channel);
  store.db
    .prepare(
      "INSERT INTO chat_inbox(id,connection_id,received_at,state,text,run_id,sender_id) VALUES('schedule-source',?,?,'running','', 'schedule-run',?)",
    )
    .run(c.id, Date.now(), '999');
  const defs: any[] = [];
  installScheduledTools({ add: (d: any) => defs.push(d) } as any);
  const tool = defs.find((d) => d.name === 'schedule_followup');
  let approvals = 0;
  const ctx: any = {
    store,
    run: { id: 'schedule-run' },
    conversation: store.get('conversation', 'chat'),
    config: runtime.config,
    inputs: {
      request: async () => {
        approvals++;
      },
    },
    signal: new AbortController().signal,
  };
  await assert.rejects(() => tool.run({ prompt: 'hi', dueAt: Date.now() }, ctx), /controller/);
  store.db.prepare("UPDATE chat_inbox SET sender_id=? WHERE id='schedule-source'").run(c.senderId);
  await assert.rejects(
    () => tool.run({ prompt: 'hi', dueAt: Date.now(), intervalMs: 60000 }, ctx),
    /15 minutes/,
  );
  await tool.run({ prompt: 'hi', dueAt: Date.now(), intervalMs: 900000, maxRuns: 2 }, ctx);
  assert.equal(approvals, 1);
  assert.deepEqual(store.list<any>('scheduled-work')[0].remoteDelivery, {
    connectionId: c.id,
    revision: c.revision,
    senderId: c.senderId,
  });
});

test('browser voice is scoped, excludes drafts, and never creates platform outbox work', async (t) => {
  const { channel, c, store, runtime, calls } = fixture(t);
  const app = Fastify();
  t.after(() => app.close());
  runtime.start = (chat: string, prompt: string, _n: number, options: any) => {
    calls.push([chat, prompt, options]);
    store.put('run', { id: options.runId, conversationId: chat, status: 'running' });
  };
  chatConnectionRoutes(app, channel);
  const response = await app.inject({
    method: 'POST',
    url: '/api/chat-connections/' + c.id + '/voice-turn',
    payload: { text: 'hello' },
  });
  assert.equal(response.statusCode, 200);
  const { runId } = response.json();
  assert.deepEqual(calls[0][2].attachmentIds, []);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM chat_inbox').get()!.n, 0);
  channel.tick();
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM chat_outbox').get()!.n, 0);
  store.event('chat', runId, 'assistant.message', { final: true, text: 'hello back' });
  const poll = await app.inject('/api/chat-connections/' + c.id + '/voice-turn/' + runId);
  assert.equal(poll.json().text, 'hello back');
  const other = { ...c, id: 'other', peerId: '999', senderId: '999' };
  store.put('chat-connection', other);
  const denied = await app.inject('/api/chat-connections/other/voice-turn/' + runId);
  assert.notEqual(denied.statusCode, 200);
  runtime.active = () => ({ id: 'busy' });
  const busy = await app.inject({
    method: 'POST',
    url: '/api/chat-connections/' + c.id + '/voice-turn',
    payload: { text: 'again' },
  });
  assert.notEqual(busy.statusCode, 200);
  assert.equal(calls.length, 1);
});

for (const messages of [
  undefined,
  ['Short reaction.', 'A separate follow-up.'],
  ['One thought.\n\nIts explanation belongs here.'],
])
  test(
    'remote bubble boundaries are explicit, not inferred from paragraphs: ' +
      JSON.stringify(messages),
    (t) => {
      const final = 'First paragraph.\n\nSecond paragraph.';
      const { store, channel } = completedRemoteReply(t, messages ? { messages } : {}, final);
      channel.tick(Date.now() + 20000);
      channel.tick(Date.now() + 20000);
      const rows = store.db.prepare('SELECT text FROM chat_outbox ORDER BY created_at,rowid').all();
      assert.deepEqual(
        rows.map((row) => row.text),
        messages || [final],
      );
      assert.equal(
        store.eventsForRun('delivery-run', ['assistant.message']).at(-1)?.data.text,
        final,
      );
    },
  );

for (const resolution of ['expired', 'answered']) {
  test(`closed ${resolution} approval releases uncertain queue head without replay or approval`, async (t) => {
    const { store, channel, c, calls } = fixture(t);
    c.remoteApprovals = true;
    store.put('chat-connection', c);
    const inputId = id(),
      code = 'abcdef012345678901234567';
    store.put('input', {
      id: inputId,
      kind: 'approval',
      status: resolution === 'answered' ? 'answered' : 'pending',
    });
    store.db
      .prepare(
        'INSERT INTO chat_approval(code,connection_id,input_id,run_id,expires_at,used,revision,digest) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(
        code,
        c.id,
        inputId,
        'run',
        resolution === 'expired' ? Date.now() - 1 : Date.now() + 60000,
        0,
        c.revision,
        'digest',
      );
    store.put('chat-approval-lifecycle', { id: code, connectionId: c.id, inputId, remote: true });
    const head = `approval:${inputId}:${code}:0`;
    const insert = store.db.prepare(
      'INSERT INTO chat_outbox(id,connection_id,state,text,created_at) VALUES(?,?,?,?,?)',
    );
    insert.run(head, c.id, 'uncertain', 'summary', 1);
    insert.run(`approval-allow:${inputId}:${code}:0`, c.id, 'pending', '/approve secret', 2);
    if (resolution === 'answered')
      insert.run(`approval-expired:${code}:0`, c.id, 'uncertain', 'obsolete expiry', 2);
    insert.run('later', c.id, 'pending', 'later reply', 3);
    (channel as any).cleanApprovals(c);
    assert.equal(
      store.db.prepare('SELECT state FROM chat_outbox WHERE id=?').get(head)!.state,
      'uncertain-closed',
    );
    const transport: any = new ChatTransports(channel);
    transport.current = () => true;
    const sent: string[] = [];
    transport.send = async (_c: any, _s: any, row: any) => {
      sent.push(row.text);
      return { message_id: 'receipt' };
    };
    await transport.deliver(c, {});
    assert.deepEqual(sent, ['later reply']);
    assert.equal(calls.length, 0);
    assert.equal(store.db.prepare('SELECT used FROM chat_approval').get()!.used, 0);
    assert.equal(
      store.get<any>('input', inputId).status,
      resolution === 'answered' ? 'answered' : 'pending',
    );
  });
}
test('uncertain delivery records bounded cause without provider content or automatic replay', async (t) => {
  const { store, channel, c } = fixture(t);
  store.db
    .prepare('INSERT INTO chat_outbox(id,connection_id,state,text,created_at) VALUES(?,?,?,?,?)')
    .run('test-send', c.id, 'pending', 'hello', 1);
  const transport: any = new ChatTransports(channel);
  transport.current = () => true;
  let attempts = 0;
  transport.send = async () => {
    attempts++;
    throw Error('OneBot send timeout secret-token-and-content');
  };
  await assert.rejects(() => transport.deliver(c, {}), /Delivery uncertain/);
  await transport.deliver(c, {});
  assert.equal(attempts, 1);
  const diagnostic = store.get<any>('chat-delivery-failure', c.id);
  assert.equal(diagnostic.category, 'timeout');
  assert.equal(JSON.stringify(diagnostic).includes('secret-token'), false);
});

test('explicit network rejection retries at most five times and persists failed state', async (t) => {
  const { store, channel, c } = fixture(t);
  store.db
    .prepare('INSERT INTO chat_outbox(id,connection_id,state,text,created_at) VALUES(?,?,?,?,?)')
    .run('network', c.id, 'pending', 'test', 1);
  const transport: any = new ChatTransports(channel);
  transport.current = () => true;
  let calls = 0;
  transport.send = async () => {
    calls++;
    throw onebotSendError({
      status: 'failed',
      retcode: 1200,
      message: 'EventRet: {"result":1006514,"errMsg":"private content"}',
    });
  };
  await transport.deliver(c, {});
  await transport.deliver(c, {});
  assert.equal(calls, 1, 'backoff is persisted');
  for (let i = 0; i < 5; i++) {
    store.db.prepare('UPDATE chat_outbox SET retry_at=0').run();
    await transport.deliver(c, {});
  }
  await transport.deliver(c, {});
  assert.equal(calls, 6, 'one initial attempt plus five retries');
  assert.equal(store.db.prepare('SELECT state FROM chat_outbox').get()!.state, 'failed');
  const failure = store.get<any>('chat-delivery-failure', c.id);
  assert.equal(failure.platformCode, 1006514);
  assert.equal(failure.outcome, 'rejected');
  assert.equal(JSON.stringify(failure).includes('private content'), false);
});
test('unknown OneBot errors remain uncertain; confirmed recovery sends the queued text once', async (t) => {
  assert(
    !(
      onebotSendError({ status: 'failed', retcode: 1200, message: 'operation timeout' }) instanceof
      ChatSendRejected
    ),
  );
  const { store, channel, c } = fixture(t);
  store.db
    .prepare('INSERT INTO chat_outbox(id,connection_id,state,text,created_at) VALUES(?,?,?,?,?)')
    .run('recover', c.id, 'pending', 'hello', 1);
  const transport: any = new ChatTransports(channel);
  transport.current = () => true;
  let calls = 0;
  transport.send = async () => {
    calls++;
    if (calls === 1) throw new ChatSendRejected(1200, 1006514, true);
    return { message_id: 'received' };
  };
  await transport.deliver(c, {});
  store.db.prepare('UPDATE chat_outbox SET retry_at=0').run();
  await transport.deliver(c, {});
  await transport.deliver(c, {});
  assert.equal(calls, 2);
  assert.equal(store.db.prepare('SELECT state FROM chat_outbox').get()!.state, 'sent');
  assert.equal(store.get<any>('chat-transport-state', c.id).status, 'connected');
});

test('controller can remotely continue only the latest interrupted task, with durable dedup and no draft attachments', (t) => {
  const { channel, c, store, calls } = fixture(t);
  store.put('run', {
    id: 'old',
    conversationId: 'chat',
    status: 'interrupted',
    createdAt: 1,
    updatedAt: 1,
  });
  const msg = {
    id: 'continue1',
    senderId: '123',
    peerId: '123',
    text: '/continue',
    timestamp: Date.now(),
  };
  assert.equal(channel.receive(c.id, msg), 'queued');
  assert.equal(channel.receive(c.id, msg), 'duplicate');
  channel.receive(c.id, { ...msg, id: 'continue2' });
  channel.tick(Date.now() + 20000);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'chat');
  assert.equal(calls[0][3].recoveredFrom, 'old');
  assert.deepEqual(calls[0][3].attachmentIds, []);
});
test('remote continuation revalidates queued state and never continues another newly completed task', (t) => {
  const { channel, c, store, calls } = fixture(t);
  store.put('run', {
    id: 'old',
    conversationId: 'chat',
    status: 'interrupted',
    createdAt: 1,
    updatedAt: 1,
  });
  channel.receive(c.id, {
    id: 'continue',
    senderId: '123',
    peerId: '123',
    text: '/continue',
    timestamp: Date.now(),
  });
  store.put('run', {
    id: 'new',
    conversationId: 'chat',
    status: 'completed',
    createdAt: 2,
    updatedAt: 2,
  });
  channel.tick(Date.now() + 20000);
  assert.equal(calls.length, 0);
  assert.equal(store.db.prepare('SELECT state FROM chat_inbox').get()!.state, 'cancelled');
});
test('remote continuation blocks unknown effects and retains ordinary group member restrictions', (t) => {
  const { channel, c, store, calls } = fixture(t);
  store.put('run', {
    id: 'old',
    conversationId: 'chat',
    status: 'interrupted',
    createdAt: 1,
    updatedAt: 1,
  });
  const effect = store.beginEffect('old', 'command', { command: 'unknown command result' });
  assert(effect);
  channel.receive(c.id, {
    id: 'blocked',
    senderId: '123',
    peerId: '123',
    text: '/continue',
    timestamp: Date.now(),
  });
  channel.tick(Date.now() + 20000);
  assert.equal(calls.length, 0);
  const group = {
    ...c,
    peerType: 'group' as const,
    accessMode: 'chat' as const,
    peerId: 'group',
    allGroupMembers: true,
  };
  store.put('chat-connection', group);
  channel.receive(group.id, {
    id: 'member',
    senderId: '4567',
    peerType: 'group',
    peerId: 'group',
    text: '/amadeus /continue',
    timestamp: Date.now(),
  });
  channel.tick(Date.now() + 20000);
  assert.equal(calls.length, 0);
});

test('controller can continue a protected-context failure through the normal checkpoint path', (t) => {
  const { channel, c, store, calls } = fixture(t);
  store.put('run', {
    id: 'full',
    conversationId: 'chat',
    status: 'failed',
    createdAt: 1,
    updatedAt: 1,
    error:
      'Protected requests and current state exceed the available context. Narrow the active task or use a larger context; no protected sources were discarded.',
  });
  assert.equal(
    channel.receive(c.id, {
      id: 'continue-context',
      senderId: '123',
      peerId: '123',
      text: '/continue',
      timestamp: Date.now(),
    }),
    'queued',
  );
  channel.tick(Date.now() + 20000);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][3].recoveredFrom, 'full');
  assert.deepEqual(calls[0][3].attachmentIds, []);
});

test('a previously sent image can be selected again in another run, once per run', (t) => {
  const ref = 'attachment:reusable',
    f = completedRemoteReply(t, { references: [ref, ref] });
  f.store.db
    .prepare(
      'INSERT INTO chat_outbox(id,connection_id,state,text,created_at,reference) VALUES(?,?,?,?,?,?)',
    )
    .run(f.c.id + ':' + ref, f.c.id, 'sent', '', Date.now(), ref);
  f.channel.tick(Date.now() + 20000);
  f.channel.tick(Date.now() + 20000);
  let rows = f.store.db.prepare('SELECT * FROM chat_outbox WHERE reference=?').all(ref) as any[];
  assert.equal(rows.length, 2);
  assert.equal(rows.filter((x) => x.state === 'pending').length, 1);
  f.store.put('run', {
    id: 'another-run',
    conversationId: 'chat',
    status: 'completed',
    createdAt: Date.now(),
  });
  f.store.db
    .prepare(
      'INSERT INTO chat_inbox(id,connection_id,received_at,state,text,run_id) VALUES(?,?,?,?,?,?)',
    )
    .run('another-inbox', f.c.id, Date.now(), 'running', '', 'another-run');
  f.store.put('chat-reply-plan', {
    id: 'another-run',
    connectionId: f.c.id,
    revision: f.c.revision,
    references: [ref],
  });
  f.store.event('chat', 'another-run', 'assistant.message', { final: true, text: 'again' });
  f.channel.tick(Date.now() + 20000);
  f.channel.tick(Date.now() + 20000);
  rows = f.store.db.prepare('SELECT * FROM chat_outbox WHERE reference=?').all(ref) as any[];
  assert.equal(rows.length, 3);
  assert.equal(new Set(rows.map((x) => x.id)).size, 3);
});
