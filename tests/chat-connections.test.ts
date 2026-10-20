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
  channel.tick();
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
  channel.tick();
  assert.equal(calls.length, 0);
  channel.receive(
    c.id,
    { id: 'stop', senderId: '123', peerId: '123', text: '/stop', timestamp: now },
    now + 2,
  );
  channel.tick();
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
  channel.tick();
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
    payload: { action: 'write_file', path: 'report.txt' },
  };
  store.put('input', q);
  channel.tick();
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
  channel.tick();
  channel.tick();
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
  channel.tick();
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
  channel.tick();
  const ticket = store.db.prepare('SELECT * FROM chat_approval').get() as any;
  assert(ticket.expires_at - Date.now() <= remoteReviewPolicy(c).ttlMs);
  const row = store.db.prepare('SELECT * FROM chat_outbox LIMIT 1').get() as any;
  deliveryReceipt(store, c, row, 'approval-platform-id');
  store.db.prepare("UPDATE chat_outbox SET state='sent' WHERE id=?").run(row.id);
  store.db.prepare('UPDATE chat_approval SET expires_at=?').run(Date.now() - 1);
  channel.tick();
  assert.equal(store.db.prepare('SELECT state FROM chat_delivery').get()!.state, 'cleanup-pending');
  assert.equal(store.get<any>('input', q.id).status, 'pending');
  assert.equal(calls.filter((x) => x[0] === 'answer').length, 0);
  const expiry = store.db
    .prepare("SELECT count(*) n FROM chat_outbox WHERE id LIKE 'approval-expired:%'")
    .get()!.n;
  channel.tick();
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
