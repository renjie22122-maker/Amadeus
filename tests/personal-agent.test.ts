import { goalProgress, goalContinuation } from '../server/services/personal-goal-progress.js';
import Fastify from 'fastify';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonalAgent } from '../server/services/personal-agent.js';
import { DeviceCommands } from '../server/services/device-commands.js';
import { Store } from '../server/storage/store.js';
import { createPersonalGateway, personalAgentRoutes } from '../server/http/personal-agent.js';
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
    config: {
      profile: () => ({ id: 'p', baseUrl: 'https://model.test', efforts: ['auto', 'high'] }),
      get: () => ({
        defaultProfileId: 'p',
        profiles: [{ id: 'p', name: 'Model', model: 'fixture', baseUrl: 'https://model.test' }],
      }),
    },
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
test('workspace conversations require a separate grant and preserve project boundaries', (t) => {
  const f = fixture(t),
    limited = f.service.authenticate(f.pair(['read', 'message']).token);
  f.store.put('conversation', {
    id: 'other',
    title: 'Other chat',
    projectId: null,
    profileId: 'p',
  });
  assert.throws(() => f.service.conversation(limited, 'other'));
  assert.equal(f.service.conversations(limited).length, 1);
  const full = f.service.authenticate(f.pair(['read', 'message', 'workspace']).token);
  assert.equal(f.service.conversations(full).length, 2);
  f.store.put('conversation', { id: 'external', remoteChatOnly: true, title: 'External' });
  assert.throws(() => f.service.conversation(full, 'external'));
  assert.equal(f.service.conversations(full).length, 2);
  f.store.put('project', { id: 'project', name: 'Project' });
  const created = f.service.createConversation(full, 'project');
  assert.equal(created.projectId, 'project');
  assert.equal(created.permission, 'ask');
  assert.equal(created.includeUserMemory, false);
  f.store.put('conversation', { ...created, archived: true });
  assert.throws(() => f.service.conversation(full, created.id));
});
test('remote memory management checks the selected scope before calling existing memory APIs', async (t) => {
  const f = fixture(t),
    calls: any[] = [];
  const gateway = createPersonalGateway(f.service, undefined, async (...args) => {
    calls.push(args);
    return { ok: true };
  });
  t.after(() => gateway.close());
  f.store.put('project', { id: 'p1', name: 'Project' });
  f.store.put('conversation', { id: 'pc', projectId: 'p1', profileId: 'p', title: 'Project chat' });
  f.store.put('memory', { id: 'private', scope: 'project:p1', content: 'Project-only' });
  const paired = f.pair(['read', 'message', 'workspace']),
    headers = { authorization: 'Bearer ' + paired.token };
  const denied = await gateway.inject({
    method: 'POST',
    url: '/v1/memory',
    headers,
    payload: { action: 'forget', conversationId: 'c', id: 'private' },
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(calls.length, 0);
  const policy = await gateway.inject({
    method: 'POST',
    url: '/v1/memory',
    headers,
    payload: { action: 'policy', conversationId: 'pc', enabled: true },
  });
  assert.equal(policy.statusCode, 200);
  assert.deepEqual(calls[0], [
    'POST',
    '/api/memory-policy',
    { scope: 'project:p1', enabled: true, profileId: 'p' },
  ]);
  const updated = await gateway.inject({
    method: 'POST',
    url: '/v1/conversations/pc/update',
    headers,
    payload: { profileId: 'p' },
  });
  assert.equal(updated.statusCode, 200);
  assert.deepEqual(calls[1], ['PATCH', '/api/conversations/pc', { profileId: 'p' }]);
  const limited = f.pair(['read', 'message']);
  assert.equal(
    (
      await gateway.inject({
        url: '/v1/memory',
        headers: { authorization: 'Bearer ' + limited.token },
      })
    ).statusCode,
    403,
  );
});
test('phone options reject unsupported effort and forward allowed reasoning and search policy', async (t) => {
  const f = fixture(t),
    calls: any[] = [];
  const gateway = createPersonalGateway(f.service, undefined, async (...args) => {
    calls.push(args);
    return { ok: true };
  });
  t.after(() => gateway.close());
  const headers = { authorization: 'Bearer ' + f.pair(['read', 'message']).token };
  const unavailable = await gateway.inject({
    method: 'POST',
    url: '/v1/conversations/c/update',
    headers,
    payload: { reasoning: 'max' },
  });
  assert.equal(unavailable.statusCode, 400);
  assert.equal(calls.length, 0);
  const accepted = await gateway.inject({
    method: 'POST',
    url: '/v1/conversations/c/update',
    headers,
    payload: { reasoning: 'high', webSearch: false },
  });
  assert.equal(accepted.statusCode, 200);
  assert.deepEqual(calls[0], [
    'PATCH',
    '/api/conversations/c',
    { reasoning: 'high', webSearch: false },
  ]);
});

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

test('desktop dot reads only its bound conversation and voice cannot stop another run', async (t) => {
  const f = fixture(t),
    app = Fastify();
  personalAgentRoutes(app, f.service);
  t.after(() => app.close());
  const state = await app.inject('/api/personal/dot');
  assert.equal(state.statusCode, 200);
  assert.equal(state.json().identity.conversationId, 'c');
  assert.deepEqual(state.json().events, []);
  assert.equal('devices' in state.json(), false);
  const voice = await app.inject({
    method: 'POST',
    url: '/api/personal/voice-turn',
    payload: { text: 'Hello' },
  });
  assert.equal(voice.statusCode, 200);
  const runId = voice.json().runId;
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].runId, runId);
  assert.equal((await app.inject('/api/personal/voice-turn/' + runId)).json().status, 'running');
  f.store.put('run', { id: 'other-run', conversationId: 'c', status: 'running' });
  const stopped: string[] = [];
  f.runtime.stop = (id: string) => stopped.push(id);
  assert.notEqual(
    (await app.inject({ method: 'POST', url: '/api/personal/voice-turn/other-run/stop' }))
      .statusCode,
    200,
  );
  assert.deepEqual(stopped, []);
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/personal/voice-turn/' + runId + '/stop' }))
      .statusCode,
    200,
  );
  assert.deepEqual(stopped, [runId]);
  f.runtime.active = () => true;
  assert.notEqual(
    (
      await app.inject({
        method: 'POST',
        url: '/api/personal/voice-turn',
        payload: { text: 'Busy' },
      })
    ).statusCode,
    200,
  );
  assert.equal(f.calls.length, 1);
  f.store.put('conversation', { ...f.store.get<any>('conversation', 'c'), archived: true });
  assert.notEqual((await app.inject('/api/personal/dot')).statusCode, 200);
});

test('goal checkpoints survive reconstruction, require evidence and never complete schedules', (t) => {
  const f = fixture(t),
    goal = f.service.createGoal({
      title: 'Plan',
      objective: 'Build',
      success: 'Verified artifact',
      intervalMs: 60000,
      maxRuns: 5,
      endAt: Date.now() + 86400000,
    });
  f.store.put('run', { id: 'source', conversationId: 'c', status: 'running' });
  const input = {
    goalId: goal.id,
    revision: 0,
    summary: 'Draft made',
    nextAction: 'Verify',
    blockers: [],
    milestones: [{ title: 'Draft', status: 'done', evidence: 'artifact: report.md' }],
  };
  assert.throws(() => goalProgress(f.store, 'other', input, 'source'));
  assert.throws(() =>
    goalProgress(
      f.store,
      'c',
      { ...input, milestones: [{ title: 'Draft', status: 'done', evidence: '' }] },
      'source',
    ),
  );
  goalProgress(f.store, 'c', input, 'source');
  assert.throws(() => goalProgress(f.store, 'c', input, 'source'));
  assert.match(goalContinuation(f.store, goal.id), /report.md/);
  assert.equal(new PersonalAgent(f.store, f.runtime).snapshot().goals[0].progress.revision, 1);
  assert.equal(f.store.get<any>('scheduled-work', goal.scheduleId).status, 'waiting');
  goalProgress(f.store, 'c', { ...input, revision: 1, summary: 'Revised' }, 'source');
  assert.equal(f.store.list('personal-goal-progress-revision').length, 2);
});
test('editing and resuming an exhausted goal keeps identity, progress and used budget', (t) => {
  const f = fixture(t),
    goal = f.service.createGoal({
      title: 'Plan',
      objective: 'Build',
      success: 'Verified',
      intervalMs: 60000,
      maxRuns: 2,
      endAt: Date.now() + 86400000,
    });
  const task = f.store.get<any>('scheduled-work', goal.scheduleId);
  f.store.put('scheduled-work', {
    ...task,
    dispatchCount: 2,
    status: 'limit_reached',
    enabled: false,
  });
  assert.throws(() => f.service.goalAction(goal.id, 'resume'));
  const updated = f.service.updateGoal(goal.id, { revision: 1, maxRuns: 4 });
  assert.equal(updated.id, goal.id);
  assert.equal(updated.scheduleId, goal.scheduleId);
  assert.equal(f.store.get<any>('scheduled-work', goal.scheduleId).dispatchCount, 2);
  assert.throws(() => f.service.updateGoal(goal.id, { revision: 1, maxRuns: 8 }));
  f.service.goalAction(goal.id, 'resume');
  assert.equal(f.store.get<any>('scheduled-work', goal.scheduleId).status, 'waiting');
  f.store.put('scheduled-work', {
    ...f.store.get<any>('scheduled-work', goal.scheduleId),
    runId: 'active',
  });
  assert.throws(() =>
    f.service.updateGoal(goal.id, { revision: 2, objective: 'Changed while running' }),
  );
});
