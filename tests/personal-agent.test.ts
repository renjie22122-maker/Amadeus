import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonalAgent } from '../server/services/personal-agent.js';
import { DeviceCommands } from '../server/services/device-commands.js';
import { Store } from '../server/storage/store.js';
import { createPersonalGateway } from '../server/http/personal-agent.js';
import { ScheduledWorkService } from '../server/services/scheduled-work.js';
function fixture(t: any) {
  const directory = mkdtempSync(join(tmpdir(), 'personal-agent-')),
    store = new Store(join(directory, 'db'));
  t.after(() => {
    store.close();
    rmSync(directory, { force: true, recursive: true });
  });
  store.put('conversation', {
    id: 'c',
    title: 'Primary',
    projectId: null,
    profileId: 'p',
    permission: 'ask',
    parentId: null,
  });
  const calls: any[] = [];
  const runtime: any = {
    config: { profile: () => ({ id: 'p', baseUrl: 'https://model.test' }) },
    active: () => false,
    start: (conversationId: string, text: string, _steps: number, options: any) => {
      calls.push({ text, ...options });
      store.put('run', { id: options.runId, conversationId, status: 'running' });
    },
    stop: () => {},
  };
  const service = new PersonalAgent(store, runtime);
  service.configure('Dot', 'c');
  const pair = (scopes = ['read', 'message', 'device-control', 'goals']) =>
    service.pair(service.invite('Phone', scopes).code);
  return { store, service, runtime, calls, pair };
}
test('one-use pairing survives service reconstruction, tokens stay out of snapshots and revocation is immediate', (t) => {
  const f = fixture(t),
    invitation = f.service.invite('Phone', ['read']);
  const paired = f.service.pair(invitation.code);
  assert.throws(() => f.service.pair(invitation.code));
  const restored = new PersonalAgent(f.store, f.runtime);
  assert.equal(restored.authenticate(paired.token).id, paired.deviceId);
  assert.ok(!JSON.stringify(restored.snapshot()).includes(paired.token));
  assert.ok(!JSON.stringify(restored.snapshot()).includes('tokenHash'));
  restored.revoke(paired.deviceId);
  assert.throws(() => restored.authenticate(paired.token));
});
test('message replay across restarts dispatches once and refuses changed payload', (t) => {
  const f = fixture(t),
    p = f.pair(),
    d = f.service.authenticate(p.token),
    key = 'same-request';
  const first = f.service.message(d, key, 'do work');
  const restored = new PersonalAgent(f.store, f.runtime);
  assert.equal(restored.message(d, key, 'do work').runId, first.runId);
  assert.equal(f.calls.length, 1);
  assert.throws(() => restored.message(d, key, 'different work'));
  const reader = f.service.authenticate(f.pair(['read']).token);
  assert.throws(() => restored.message(reader, 'new', 'unauthorized'));
});
test('a reserved but uncertain message never re-executes after failure', (t) => {
  const f = fixture(t),
    d = f.service.authenticate(f.pair().token);
  f.runtime.start = () => {
    throw Error('interrupted');
  };
  assert.throws(() => f.service.message(d, 'request', 'work'));
  assert.equal(
    new PersonalAgent(f.store, f.runtime).message(d, 'request', 'work').status,
    'needs_attention',
  );
});
test('goals use durable scheduler and preserve limits, pauses and wake deduplication', (t) => {
  const f = fixture(t),
    now = Date.now();
  const goal = f.service.createGoal({
    title: 'Research',
    objective: 'Read new data',
    success: 'A verified report',
    intervalMs: 60000,
    maxRuns: 2,
    endAt: now + 86400000,
  });
  f.service.goalAction(goal.id, 'pause');
  const scheduler = new ScheduledWorkService(f.store, f.runtime);
  scheduler.tick(now + 10);
  assert.equal(f.calls.length, 0);
  f.service.goalAction(goal.id, 'wake', 'event1');
  scheduler.tick(Date.now() + 10);
  assert.equal(f.calls.length, 1);
  new ScheduledWorkService(f.store, f.runtime).tick(Date.now() + 20);
  assert.equal(f.calls.length, 1);
  assert.throws(() => f.service.goalAction(goal.id, 'wake', 'event2'));
});
test('device actions are scoped, delivered at most once and results are idempotent', (t) => {
  const f = fixture(t),
    p = f.pair(),
    d = f.service.authenticate(p.token);
  f.store.put('paired-device', { ...d, lastSeenAt: Date.now(), capabilities: ['alarm.create'] });
  const commands = new DeviceCommands(f.store);
  assert.throws(() => commands.queue('other', d.id, 'alarm.create', {}));
  assert.throws(() => commands.queue('c', d.id, 'screen.tap', {}));
  const action = commands.queue('c', d.id, 'alarm.create', { hour: 8, minute: 0 });
  assert.equal(commands.claim(d)?.id, action.id);
  assert.equal(new DeviceCommands(f.store).claim(d), null);
  const other = f.service.authenticate(f.pair().token);
  assert.throws(() => commands.result(other, action.id, 'completed', {}));
  commands.result(d, action.id, 'unknown', 'lost connection');
  commands.result(d, action.id, 'completed', 'cannot overwrite unknown outcome');
  assert.equal(f.store.get<any>('device-command', action.id).status, 'unknown');
});
test('gateway has no admin proxy, requires scoped bearer auth and refuses browser origins', async (t) => {
  const f = fixture(t),
    gateway = createPersonalGateway(f.service);
  t.after(() => gateway.close());
  assert.equal((await gateway.inject('/v1/state')).statusCode, 401);
  const paired = f.pair(['read']),
    headers = { authorization: 'Bearer ' + paired.token };
  f.store.event('c', null, 'assistant.message', { text: 'hello' });
  const state = await gateway.inject({ url: '/v1/state', headers });
  assert.equal(state.statusCode, 200);
  assert.equal(state.json().events[0].data.text, 'hello');
  assert.equal((await gateway.inject({ url: '/api/bootstrap', headers })).statusCode, 404);
  assert.equal(
    (
      await gateway.inject({
        url: '/v1/state',
        headers: { ...headers, origin: 'https://evil.test' },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await gateway.inject({
        method: 'POST',
        url: '/v1/message',
        headers,
        payload: { requestId: '00112233-4455-4677-8899-aabbccddeeff', text: 'do work' },
      })
    ).statusCode,
    403,
  );
  f.service.revoke(paired.deviceId);
  assert.equal((await gateway.inject({ url: '/v1/state', headers })).statusCode, 401);
});
