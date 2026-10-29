import { nextWindowTime, executionWindowSchema } from '../server/services/schedule-window.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { Store } from '../server/storage/store.js';
import { ScheduledWorkService, scheduleFields } from '../server/services/scheduled-work.js';
import { scheduledWorkRoutes } from '../server/http/scheduled-work.js';
import { installScheduledTools } from '../server/tools/scheduled-tools.js';
function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'scheduled-work-'));
  const store = new Store(join(dir, 'db'));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  store.put('project', { id: 'p' });
  store.put('conversation', {
    id: 'c',
    title: 'source',
    projectId: 'p',
    profileId: 'm',
    permission: 'read-only',
    execution: { backend: 'docker', network: 'deny' },
    parentId: null,
    skillIds: ['s'],
    memory: true,
  });
  const calls: any[] = [];
  const runtime: any = {
    config: { profile: () => ({ id: 'm', baseUrl: 'https://example.test' }) },
    active: () => false,
    start: (chat: string, prompt: string, _n: number, options: any) => {
      calls.push({ chat, prompt, ...options });
      store.put('run', { id: options.runId, conversationId: chat, status: 'running' });
    },
  };
  const scheduler = new ScheduledWorkService(store, runtime);
  const save = (extra: any = {}) =>
    store.put('scheduled-work', {
      id: 's',
      conversationId: 'c',
      name: 'Check',
      prompt: 'inspect',
      enabled: true,
      dueAt: 0,
      status: 'waiting',
      ...extra,
    });
  return { store, runtime, scheduler, calls, save };
}
test('new chat inherits scope/security but not conversation history; restart does not duplicate', (t) => {
  const f = fixture(t);
  f.save({ destination: 'new-chat', intervalMs: 60000 });
  f.scheduler.tick(1);
  assert.equal(f.calls.length, 1);
  assert.notEqual(f.calls[0].chat, 'c');
  const c = f.store.get<any>('conversation', f.calls[0].chat);
  assert.equal(c.permission, 'read-only');
  assert.equal(c.projectId, 'p');
  assert.deepEqual(c.execution, { backend: 'docker', network: 'deny' });
  assert.equal(c.parentId, null);
  assert.equal(c.forkEvent, null);
  new ScheduledWorkService(f.store, f.runtime).tick(2);
  assert.equal(f.calls.length, 1);
  f.store.put('run', { id: f.calls[0].runId, status: 'completed' });
  f.scheduler.tick(180001);
  assert.equal(f.store.get<any>('scheduled-work', 's').dueAt, 240000);
  f.scheduler.tick(239999);
  assert.equal(f.calls.length, 1);
  f.scheduler.tick(240000);
  assert.equal(f.calls.length, 2);
  assert.notEqual(f.calls[1].chat, c.id);
});
test('paused dispatched run settles once and cannot schedule more work', (t) => {
  const f = fixture(t);
  f.save({ intervalMs: 60000 });
  f.scheduler.tick(1);
  f.store.put('scheduled-work', { ...f.store.get<any>('scheduled-work', 's'), enabled: false });
  f.store.put('run', { id: f.calls[0].runId, status: 'completed' });
  f.scheduler.tick(2);
  f.scheduler.tick(999999);
  assert.equal(f.calls.length, 1);
  assert.equal(f.store.get<any>('scheduled-work', 's').status, 'paused');
  assert.equal(f.store.list('schedule-result').length, 1);
});
test('meaningful notifications suppress unchanged, completion stops repeat, missing report not silent', (t) => {
  const f = fixture(t);
  f.save({ intervalMs: 60000, notifications: 'meaningful' });
  f.scheduler.tick(1);
  const finish = (outcome?: string) => {
    const runId = f.calls.at(-1).runId;
    if (outcome) f.store.put('schedule-report', { id: runId, outcome, summary: 'observed' });
    f.store.put('run', { id: runId, status: 'completed' });
  };
  finish('unchanged');
  f.scheduler.tick(2);
  assert.equal(f.store.list<any>('schedule-result')[0].unread, false);
  f.scheduler.tick(60000);
  finish();
  f.scheduler.tick(60001);
  assert.equal(f.store.list<any>('schedule-result').filter((r) => r.unread).length, 1);
  f.scheduler.tick(120000);
  finish('complete');
  f.scheduler.tick(120001);
  f.scheduler.tick(999999);
  assert.equal(f.calls.length, 3);
  assert.equal(f.store.get<any>('scheduled-work', 's').enabled, false);
});
test('failure notifies once, survives restart, and does not replay', (t) => {
  const f = fixture(t);
  f.save({ intervalMs: 60000, notifications: 'failures' });
  f.scheduler.tick(1);
  f.store.put('run', { id: f.calls[0].runId, status: 'interrupted' });
  f.scheduler.tick(2);
  new ScheduledWorkService(f.store, f.runtime).tick(999999);
  assert.equal(f.calls.length, 1);
  assert.equal(f.store.list('schedule-result').length, 1);
  assert.equal(f.store.list<any>('schedule-result')[0].unread, true);
});
test('archived source, removed project and changed provider are blocked', (t) => {
  const f = fixture(t);
  f.save({ target: 'different' });
  f.scheduler.tick(1);
  assert.equal(f.calls.length, 0);
  f.save();
  f.store.put('project', { id: 'p', removedAt: 1 });
  f.scheduler.tick(2);
  assert.equal(f.calls.length, 0);
  f.store.put('project', { id: 'p' });
  f.store.put('conversation', { ...f.store.get<any>('conversation', 'c'), archived: true });
  f.save();
  f.scheduler.tick(3);
  assert.equal(f.calls.length, 0);
});
test('result reporting cannot alter another schedule', async (t) => {
  const f = fixture(t);
  f.save();
  f.scheduler.tick(1);
  const tools: any[] = [];
  installScheduledTools({ add: (v: any) => tools.push(v) } as any);
  const report = tools.find((x) => x.name === 'report_scheduled_result');
  const c: any = { store: f.store, run: { id: 'other' }, conversation: { id: 'c' } };
  await assert.rejects(() => report.run({ outcome: 'complete', summary: 'done' }, c));
  assert.equal(f.store.list('schedule-report').length, 0);
  c.run.id = f.calls[0].runId;
  await report.run({ outcome: 'complete', summary: 'done' }, c);
  assert.equal(f.store.list('schedule-report').length, 1);
});
test('HTTP edit preserves omitted fields; running edit denied, pause accepted; history can be acknowledged', async (t) => {
  const f = fixture(t);
  const app = Fastify();
  scheduledWorkRoutes(app, f.store, f.runtime.config);
  t.after(() => app.close());
  let res = await app.inject({
    method: 'POST',
    url: '/api/scheduled-work',
    payload: {
      conversationId: 'c',
      prompt: 'check',
      dueAt: 0,
      intervalMs: 60000,
      notifications: 'failures',
    },
  });
  assert.equal(res.statusCode, 200);
  const s = res.json();
  res = await app.inject({
    method: 'PATCH',
    url: '/api/scheduled-work/' + s.id,
    payload: { name: 'Renamed', intervalMs: null },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().notifications, 'failures');
  assert.equal(res.json().intervalMs, null);
  f.scheduler.tick(1);
  res = await app.inject({
    method: 'PATCH',
    url: '/api/scheduled-work/' + s.id,
    payload: { prompt: 'change' },
  });
  assert.notEqual(res.statusCode, 200);
  res = await app.inject({
    method: 'PATCH',
    url: '/api/scheduled-work/' + s.id,
    payload: { enabled: false },
  });
  assert.equal(res.statusCode, 200);
  f.store.put('run', { id: f.calls[0].runId, status: 'completed' });
  f.scheduler.tick(2);
  const results = (await app.inject({ method: 'GET', url: '/api/schedule-results' })).json();
  assert.equal(results.length, 1);
  res = await app.inject({
    method: 'PATCH',
    url: '/api/schedule-results/' + encodeURIComponent(results[0].id),
    payload: {},
  });
  assert.equal(res.json().unread, false);
});
test('interval validation rejects zero, fraction and excessive values', () => {
  for (const intervalMs of [0, 1, 60000.5, Infinity, 367 * 86400000])
    assert.equal(scheduleFields.safeParse({ prompt: 'x', dueAt: 0, intervalMs }).success, false);
});

test('launch limits survive restart and do not mark pending work verified complete', (t) => {
  const f = fixture(t);
  f.save({ intervalMs: 60000, maxRuns: 1 });
  f.scheduler.tick(1);
  assert.equal(f.store.get<any>('scheduled-work', 's').dispatchCount, 1);
  f.store.put('run', { id: f.calls[0].runId, status: 'completed' });
  f.scheduler.tick(2);
  new ScheduledWorkService(f.store, f.runtime).tick(60001);
  assert.equal(f.calls.length, 1);
  assert.equal(f.store.get<any>('scheduled-work', 's').status, 'limit_reached');
  assert.equal(f.store.get<any>('scheduled-work', 's').enabled, false);
});
test('deadline stops new work but does not interrupt an active scheduled run', (t) => {
  const f = fixture(t);
  f.save({ endAt: 10 });
  f.scheduler.tick(10);
  assert.equal(f.calls.length, 0);
  f.save({ endAt: 10 });
  f.scheduler.tick(1);
  f.scheduler.tick(11);
  assert.equal(f.calls.length, 1);
  assert.equal(f.store.get<any>('scheduled-work', 's').status, 'running');
});
test('schedule discovery never exposes another conversation task', (t) => {
  const f = fixture(t);
  f.save();
  f.store.put('scheduled-work', { id: 'private', conversationId: 'other', prompt: 'private' });
  const defs: any[] = [];
  installScheduledTools({ add: (x: any) => defs.push(x) } as any);
  const result = JSON.parse(
    defs
      .find((x) => x.name === 'inspect_schedules')
      .run({}, { store: f.store, conversation: { id: 'c' } }).content,
  );
  assert.deepEqual(
    result.schedules.map((x: any) => x.id),
    ['s'],
  );
  assert.equal(result.capabilities.afterBackgroundCommand, true);
});

test('agent pause stops new launches without interrupting active work or crossing scope', (t) => {
  const f = fixture(t);
  f.save({ intervalMs: 60000 });
  f.scheduler.tick(1);
  const defs: any[] = [];
  installScheduledTools({ add: (x: any) => defs.push(x) } as any);
  const tool = defs.find((x) => x.name === 'pause_scheduled_followup');
  assert.throws(
    () => tool.run({ id: 's' }, { store: f.store, conversation: { id: 'other' } }),
    /another conversation/,
  );
  tool.run({ id: 's' }, { store: f.store, conversation: { id: 'c' } });
  assert.equal(f.store.get<any>('run', f.calls[0].runId).status, 'running');
  f.scheduler.tick(999999);
  assert.equal(f.calls.length, 1);
});

test('conversation cards return only scoped schedules, commands and cross-chat results', async (t) => {
  const f = fixture(t);
  f.save();
  f.store.put('scheduled-work', { id: 'other', conversationId: 'elsewhere' });
  f.store.put('command-job', { id: 'ours', conversationId: 'c', status: 'completed' });
  f.store.put('command-job', { id: 'theirs', conversationId: 'elsewhere', status: 'running' });
  f.store.put('schedule-result', {
    id: 'r1',
    scheduleId: 's',
    conversationId: 'generated-chat',
    finishedAt: 2,
  });
  f.store.put('schedule-result', {
    id: 'r2',
    scheduleId: 'other',
    conversationId: 'elsewhere',
    finishedAt: 3,
  });
  const app = Fastify();
  scheduledWorkRoutes(app, f.store, f.runtime.config);
  t.after(() => app.close());
  const response = await app.inject('/api/conversation-schedules?conversationId=c');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    response.json().schedules.map((s: any) => s.id),
    ['s'],
  );
  assert.deepEqual(
    response.json().commands.map((s: any) => s.id),
    ['ours'],
  );
  const results = await app.inject('/api/schedule-results?conversationId=c');
  assert.deepEqual(
    results.json().map((s: any) => s.id),
    ['r1'],
  );
  f.scheduler.tick(1);
  assert.deepEqual(f.calls[0].scheduledTrigger, { id: 's', name: 'Check' });
});

test('interrupted schedule clears active pointers but retains inspection link and stays paused', (t) => {
  const f = fixture(t);
  f.save({ intervalMs: 60000 });
  f.scheduler.tick(1);
  const runId = f.calls[0].runId;
  f.store.put('run', { id: runId, status: 'interrupted' });
  f.scheduler.tick(2);
  const task = f.store.get<any>('scheduled-work', 's');
  assert.equal(task.status, 'needs_attention');
  assert.equal(task.enabled, false);
  assert.equal(task.lastRunId, runId);
  assert.equal(task.runId, undefined);
  assert.equal(task.startedAt, undefined);
  f.scheduler.tick(999999);
  assert.equal(f.calls.length, 1);
});

test('legacy failed schedule pointers repair silently without replay', (t) => {
  const f = fixture(t);
  f.store.put('run', { id: 'old', status: 'interrupted' });
  f.save({ status: 'needs_attention', enabled: false, runId: 'old', startedAt: 1 });
  f.scheduler.tick(100);
  assert.equal(f.store.get<any>('scheduled-work', 's').runId, undefined);
  assert.equal(f.store.get<any>('scheduled-work', 's').lastRunId, 'old');
  assert.equal(f.calls.length, 0);
  assert.equal(f.store.list('schedule-result').length, 0);
});

const dailyWindow = {
  timeZone: 'Asia/Shanghai',
  start: '08:00',
  end: '23:30',
  weekdays: [0, 1, 2, 3, 4, 5, 6],
};
test('host window defers overnight without model, run count or notifications; restart coalesces', (t) => {
  const f = fixture(t),
    night = Date.parse('2026-10-28T15:48:00Z'),
    morning = Date.parse('2026-10-29T00:00:00Z');
  f.save({ dueAt: night, intervalMs: 1800000, maxRuns: 3, executionWindow: dailyWindow });
  f.scheduler.tick(night);
  assert.equal(f.calls.length, 0);
  const task = f.store.get<any>('scheduled-work', 's');
  assert.equal(task.deferredUntil, morning);
  assert.equal(task.status, 'waiting_window');
  assert.equal(task.dispatchCount || 0, 0);
  assert.equal(f.store.list('schedule-result').length, 0);
  new ScheduledWorkService(f.store, f.runtime).tick(morning - 1);
  assert.equal(f.calls.length, 0);
  f.scheduler.tick(morning);
  f.scheduler.tick(morning);
  assert.equal(f.calls.length, 1);
  assert.equal(f.store.get<any>('scheduled-work', 's').dispatchCount, 1);
});
test('window boundaries, overnight weekdays and DST use the configured zone', () => {
  const at = Date.parse('2026-10-28T15:30:00Z');
  assert.equal(nextWindowTime(dailyWindow, at - 1), at - 1);
  assert.equal(nextWindowTime(dailyWindow, at), Date.parse('2026-10-29T00:00:00Z'));
  const overnight = { timeZone: 'UTC', start: '22:00', end: '02:00', weekdays: [5] };
  const saturday = Date.parse('2026-10-31T01:00:00Z');
  assert.equal(nextWindowTime(overnight, saturday), saturday);
  assert.equal(
    nextWindowTime(overnight, Date.parse('2026-10-31T02:00:00Z')),
    Date.parse('2026-11-06T22:00:00Z'),
  );
  const dst = { timeZone: 'America/New_York', start: '03:00', end: '04:00', weekdays: [0] };
  assert.equal(
    nextWindowTime(dst, Date.parse('2026-03-08T06:59:00Z')),
    Date.parse('2026-03-08T07:00:00Z'),
  );
  assert(!executionWindowSchema.safeParse({ ...dailyWindow, timeZone: 'invalid' }).success);
  assert(!executionWindowSchema.safeParse({ ...dailyWindow, weekdays: [] }).success);
  assert(!executionWindowSchema.safeParse({ ...dailyWindow, start: '24:00' }).success);
});
test('deadline still stops a host-deferred task without an API call', (t) => {
  const f = fixture(t),
    night = Date.parse('2026-10-28T16:00:00Z');
  f.save({ dueAt: night, endAt: night + 60000, executionWindow: dailyWindow });
  f.scheduler.tick(night);
  f.scheduler.tick(night + 60000);
  assert.equal(f.calls.length, 0);
  assert.equal(f.store.get<any>('scheduled-work', 's').status, 'limit_reached');
});
test('model deferral only slows approved cadence and does not reset launch bounds', (t) => {
  const f = fixture(t);
  f.save({ intervalMs: 60000, maxRuns: 2 });
  f.scheduler.tick(1);
  const runId = f.calls[0].runId;
  f.store.put('schedule-report', { id: runId, outcome: 'unchanged', nextCheckAt: 240000 });
  f.store.put('run', { id: runId, status: 'completed' });
  f.scheduler.tick(2);
  assert.equal(f.store.get<any>('scheduled-work', 's').dueAt, 240000);
  f.scheduler.tick(239999);
  assert.equal(f.calls.length, 1);
  f.scheduler.tick(240000);
  assert.equal(f.calls.length, 2);
});
test('model update preserves task identity and refuses changes during approval', async (t) => {
  const f = fixture(t);
  f.save();
  const tools: any[] = [];
  installScheduledTools({ add: (tool: any) => tools.push(tool) } as any);
  const update = tools.find((tool) => tool.name === 'update_scheduled_followup');
  const c: any = {
    store: f.store,
    conversation: { id: 'c' },
    run: { id: 'caller' },
    inputs: { request: async () => {} },
  };
  await update.run({ id: 's', changes: { executionWindow: dailyWindow } }, c);
  assert.equal(f.store.list('scheduled-work').length, 1);
  assert.deepEqual(f.store.get<any>('scheduled-work', 's').executionWindow, dailyWindow);
  c.inputs.request = async () => {
    f.store.put('scheduled-work', { ...f.store.get<any>('scheduled-work', 's'), runId: 'active' });
  };
  await assert.rejects(() => update.run({ id: 's', changes: { prompt: 'new' } }, c));
  assert.equal(f.store.get<any>('scheduled-work', 's').prompt, 'inspect');
  await assert.rejects(() =>
    update.run({ id: 's', changes: {} }, { ...c, conversation: { id: 'other' } }),
  );
});

test('paused schedules resume in place, retain history and enforce exhausted limits', async (t) => {
  const f = fixture(t);
  f.save({ enabled: false, status: 'paused', dispatchCount: 2, maxRuns: 3 });
  f.store.put('schedule-result', { id: 'history', scheduleId: 's' });
  const tools: any[] = [];
  installScheduledTools({ add: (tool: any) => tools.push(tool) } as any);
  const update = tools.find((tool) => tool.name === 'update_scheduled_followup');
  const c: any = {
    store: f.store,
    conversation: { id: 'c' },
    run: { id: 'caller' },
    inputs: { request: async () => {} },
  };
  await update.run(update.schema.parse({ id: 's', changes: { dueAt: 100 } }), c);
  assert.equal(f.store.get<any>('scheduled-work', 's').status, 'paused');
  await update.run(update.schema.parse({ id: 's', changes: { enabled: true } }), c);
  const task = f.store.get<any>('scheduled-work', 's');
  assert.equal(task.status, 'waiting');
  assert.equal(task.dispatchCount, 2);
  assert.equal(f.store.list('scheduled-work').length, 1);
  assert.equal(f.store.list('schedule-result').length, 1);
  await assert.rejects(
    () => update.run({ id: 's', changes: { enabled: true, maxRuns: 2 } }, c),
    /limit exhausted/,
  );
  await assert.rejects(
    () => update.run({ id: 's', changes: { enabled: true, endAt: 1 } }, c),
    /deadline/,
  );
});

test('schedule deletion preserves results and rejects foreign, active and changed tasks', async (t) => {
  const f = fixture(t);
  f.save();
  f.store.put('schedule-result', { id: 'history', scheduleId: 's' });
  const tools: any[] = [];
  installScheduledTools({ add: (tool: any) => tools.push(tool) } as any);
  const remove = tools.find((tool) => tool.name === 'delete_scheduled_followup');
  const c: any = {
    store: f.store,
    conversation: { id: 'c' },
    run: { id: 'caller' },
    inputs: { request: async () => {} },
  };
  await assert.rejects(() => remove.run({ id: 's' }, { ...c, conversation: { id: 'other' } }));
  c.inputs.request = async () =>
    f.store.put('scheduled-work', { ...f.store.get<any>('scheduled-work', 's'), runId: 'active' });
  await assert.rejects(() => remove.run({ id: 's' }, c));
  await assert.rejects(() => remove.run({ id: 's' }, c));
  f.save();
  c.inputs.request = async () => {};
  await remove.run({ id: 's' }, c);
  assert.equal(f.store.list('scheduled-work').length, 0);
  assert.equal(f.store.list('schedule-result').length, 1);
});
