import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OfflineNotice, validateConfig, eligible, loopbackUrl } from './offline-core.mjs';
function fixture() {
  const c = validateConfig({
    version: 1,
    database: 'db',
    accountId: '7',
    statusFile: 'status',
    ledgerFile: 'ledger',
    lockFile: 'lock',
    bridgeUrl: 'ws://127.0.0.1:3011',
    healthUrl: 'http://127.0.0.1:8810/api/health',
  });
  let now = 1000000,
    online = false,
    routes = [
      {
        id: 'r',
        enabled: true,
        transport: 'onebot11',
        accountId: '7',
        endpoint: c.bridgeUrl,
        peerType: 'group',
        peerId: '8',
        senderId: '9',
        accessMode: 'chat',
        allGroupMembers: true,
      },
    ];
  const event = {
    post_type: 'message',
    message_id: '1',
    user_id: 9,
    self_id: 7,
    message_type: 'group',
    group_id: 8,
    time: 1000,
    message: [{ type: 'at', data: { qq: '7' } }],
  };
  const sends = [],
    saves = [];
  const io = {
    now: () => now,
    healthy: async () => online,
    routes: async () => routes,
    connected: () => true,
    save: async (s) => saves.push(s),
    send: async (m) => sends.push(m),
  };
  const engine = new OfflineNotice(c, io);
  return {
    c,
    event,
    engine,
    io,
    sends,
    saves,
    get routes() {
      return routes;
    },
    set routes(v) {
      routes = v;
    },
    set online(v) {
      online = v;
    },
    advance(n) {
      now += n;
      event.time = now / 1000;
    },
    async down() {
      for (let i = 0; i < c.failureThreshold; i++) await engine.poll();
    },
  };
}
test('only loopback, credential-free config; bounded timing', () => {
  for (const u of [
    'https://example.com',
    'http://127.0.0.1/?token=x',
    'http://user:pass@localhost',
  ])
    assert.throws(() => loopbackUrl(u, ['http:', 'https:']));
  assert.throws(() => validateConfig({ ...fixture().c, failureThreshold: 0 }));
});
test('healthy and transient failures do not send', async () => {
  const f = fixture();
  await f.engine.poll();
  assert.equal(await f.engine.receive(f.event), false);
  f.online = true;
  await f.down();
  assert.equal(await f.engine.receive(f.event), false);
});
test('confirmed outage sends to same group once; ledger saved before send', async () => {
  const f = fixture();
  await f.down();
  f.io.send = async (m) => {
    assert.equal(f.saves.length, 1);
    f.sends.push(m);
  };
  assert.equal(await f.engine.receive(f.event), true);
  assert.equal(f.sends[0].params.group_id, 8);
  assert.equal(await f.engine.receive(f.event), false);
});
test('ordinary chatter, cross group, self, stale, disabled and unknown sender rejected', async () => {
  const f = fixture();
  await f.down();
  for (const e of [
    { ...f.event, group_id: 88 },
    { ...f.event, user_id: 7 },
    { ...f.event, time: 1 },
    { ...f.event, message: [] },
    { ...f.event, self_id: 99 },
  ])
    assert.equal(await f.engine.receive(e), false);
  f.routes[0].allGroupMembers = false;
  assert.equal(await f.engine.receive({ ...f.event, user_id: 10 }), false);
  f.routes[0].enabled = false;
  assert.equal(await f.engine.receive(f.event), false);
});
test('recovery during send check suppresses notice', async () => {
  const f = fixture();
  await f.down();
  f.online = true;
  assert.equal(await f.engine.receive(f.event), false);
});
test('revoked permission during health check suppresses notice', async () => {
  const f = fixture();
  await f.down();
  f.io.healthy = async () => {
    f.routes[0].enabled = false;
    return false;
  };
  assert.equal(await f.engine.receive(f.event), false);
});
test('parallel messages cannot both emit; restart ledger prevents replay', async () => {
  const f = fixture();
  await f.down();
  await Promise.all([f.engine.receive(f.event), f.engine.receive({ ...f.event, message_id: '2' })]);
  assert.equal(f.sends.length, 1);
  const restart = new OfflineNotice(f.c, f.io, f.saves[0]);
  restart.failures = 3;
  assert.equal(await restart.receive(f.event), false);
});
test('cooldown expires but old event is not replayed', async () => {
  const f = fixture();
  await f.down();
  await f.engine.receive(f.event);
  f.advance(121000);
  assert.equal(await f.engine.receive({ ...f.event, message_id: '2' }), true);
});
test('failed send is not automatically retried', async () => {
  const f = fixture();
  await f.down();
  f.io.send = async () => {
    throw Error('network');
  };
  await assert.rejects(f.engine.receive(f.event));
  assert.equal(await f.engine.receive(f.event), false);
});
test('ledger save failure prevents delivery', async () => {
  const f = fixture();
  await f.down();
  f.io.save = async () => {
    throw Error('disk');
  };
  await assert.rejects(f.engine.receive(f.event));
  assert.equal(f.sends.length, 0);
});
test('private reauthorization notice works while agent healthy, manual pause stays silent', async () => {
  const f = fixture();
  f.online = true;
  f.routes = [
    {
      ...f.routes[0],
      peerType: 'private',
      peerId: '9',
      enabled: false,
      pauseReason: 'reauthorize',
    },
  ];
  const e = { ...f.event, message_type: 'private' };
  assert.equal(await f.engine.receive(e), true);
  assert.match(f.sends[0].params.message[0].data.text, /reauthorization/);
  f.routes[0].pauseReason = 'paused';
  assert.equal(eligible(e, f.routes, f.c, 1000000), null);
  assert.equal(eligible({ ...e, user_id: 10 }, f.routes, f.c, 1000000), null);
});
test('reauthorization never sends to whole group', () => {
  const f = fixture();
  f.routes[0].enabled = false;
  f.routes[0].pauseReason = 'reauthorize';
  assert.equal(eligible(f.event, f.routes, f.c, 1000000), null);
});
