import { CognitiveController } from '../server/core/cognitive-controller.js';
import { teamBlackboard } from '../server/services/team-blackboard.js';
import { recoveryProposal, assessIntervention } from '../server/core/recovery-planner.js';
import { cacheStableTools, promptCacheMode } from '../server/providers/prompt-cache.js';
import { chatPayload } from '../server/providers/openai-chat.js';
import { standardUsage } from '../server/providers/protocol.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { Store } from '../server/storage/store.js';
import { sampleContext, contextBudget } from '../server/core/context-budget.js';
import { selectTaskContext } from '../server/services/task-context.js';
import {
  startTaskMeasurement,
  finishTaskMeasurement,
} from '../server/services/routing-outcomes.js';
import { prefixObservation, comparePrefix } from '../server/core/cache-observation.js';
const profile: any = {
  transport: 'openai-chat',
  baseUrl: 'https://example.com',
  model: 'x',
  efforts: ['none'],
  reasoning: 'none',
  reasoningFormat: 'deepseek',
  contextWindow: 64000,
  maxOutputTokens: 4096,
};
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-matrix-'));
  return join(dir, 'db.sqlite');
}
const run = (id: string, status: string, parentRunId: string | null = null): any => ({
  id,
  conversationId: id,
  status,
  parentRunId,
  createdAt: 1,
  updatedAt: 1,
  checkpoints: [],
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  modelCalls: 0,
  maxSteps: 0,
  profileId: 'x',
  reasoning: 'none',
  error: null,
  depth: parentRunId ? 1 : 0,
  estimatedUsd: null,
});
test('restart matrix preserves uncertain effects, cancels approvals, and is idempotent across parent/child states', (t) => {
  const path = fixture();
  t.after(() => rmSync(dirname(path), { recursive: true, force: true }));
  const statuses = [
    'queued',
    'running',
    'waiting_user',
    'waiting_approval',
    'waiting_children',
    'completed',
    'failed',
    'interrupted',
  ];
  for (const parentStatus of statuses)
    for (const childStatus of statuses) {
      let s = new Store(path);
      const suffix = parentStatus + '-' + childStatus,
        p = 'p-' + suffix,
        c = 'c-' + suffix;
      s.put('run', run(p, parentStatus));
      s.put('run', run(c, childStatus, p));
      s.put('input', {
        id: 'q-' + suffix,
        runId: c,
        status: 'pending',
        payload: {},
        kind: 'approval',
      });
      const effect = s.beginEffect(c, 'run_command', { command: 'never replay' });
      s.close();
      s = new Store(path);
      s.recover();
      for (const id of [p, c])
        assert.ok(['completed', 'failed', 'interrupted'].includes(s.get<any>('run', id).status));
      assert.equal(s.get<any>('input', 'q-' + suffix).status, 'cancelled');
      assert.equal(s.unknownEffects(c)[0].id, effect);
      const events = s.events(c).length;
      s.recover();
      assert.equal(s.events(c).length, events);
      s.close();
    }
});
test('injected failure during approval cancellation rolls back run transition and emitted events', (t) => {
  const s = new Store(fixture());
  t.after(() => {
    s.close();
    rmSync(dirname(s.path), { recursive: true, force: true });
  });
  s.put('run', run('r', 'waiting_approval'));
  s.put('input', { id: 'q', runId: 'r', status: 'pending', payload: {} });
  const original = s.put.bind(s);
  let emitted = 0;
  s.onEvent = () => emitted++;
  s.put = ((kind: string, value: any) => {
    if (kind === 'input') throw Error('injected crash');
    return original(kind, value);
  }) as typeof s.put;
  assert.throws(() => s.recover(), /injected crash/);
  assert.equal(s.get<any>('run', 'r').status, 'waiting_approval');
  assert.equal(s.get<any>('input', 'q').status, 'pending');
  assert.equal(s.events('r').length, 0);
  assert.equal(emitted, 0);
  s.put = original;
  s.recover();
  assert.equal(s.get<any>('run', 'r').status, 'interrupted');
});
test('reasoning changes invalidate context calibration and route/schema changes prevent reusable-prefix claims', () => {
  const messages: any[] = [{ role: 'system', content: 'stable' }];
  const sample = sampleContext(messages, [], profile, 1000);
  assert.equal(contextBudget(messages, [], profile, 0.8, sample).method, 'measured');
  assert.equal(
    contextBudget(messages, [], { ...profile, reasoning: 'high' }, 0.8, sample).method,
    'estimated',
  );
  const a = prefixObservation(messages, [], profile);
  const b = prefixObservation(messages, [], { ...profile, model: 'other' });
  assert.equal(
    comparePrefix(a, b, { input: 10, cached: 20, output: 1, measured: true }).cacheRatio,
    null,
  );
  assert.equal(
    comparePrefix(a, b, { input: 10, cached: 2, output: 1, measured: true }).reusablePrefixMessages,
    0,
  );
});
test('selective task projection retains late owned work and transitive dependencies ahead of unrelated tasks', () => {
  const tasks: any[] = Array.from({ length: 40 }, (_, i) => ({
    id: 'unrelated-' + i,
    owner: null,
    status: 'pending',
    dependsOn: [],
  }));
  tasks.push(
    { id: 'mine', owner: 'worker', status: 'running', dependsOn: ['dep'] },
    { id: 'dep', owner: 'other', status: 'done', dependsOn: ['base'] },
    { id: 'base', owner: null, status: 'done', dependsOn: [] },
  );
  const p = selectTaskContext(tasks, 'worker', 4);
  assert.deepEqual(
    new Set(p.selected.slice(0, 3).map((t) => t.id)),
    new Set(['mine', 'dep', 'base']),
  );
  assert.equal(p.omitted, 39);
  assert.equal(tasks[0].id, 'unrelated-0');
});
test('routing feedback honors structured outcomes over misleading output text', (t) => {
  const s = new Store(fixture());
  t.after(() => {
    s.close();
    rmSync(dirname(s.path), { recursive: true, force: true });
  });
  const r = run('r', 'running');
  s.put('run', r);
  s.put('conversation', { id: 'r', projectId: 'p' });
  const task: any = { id: 't', skills: ['code'] };
  startTaskMeasurement(s, { id: 'b', tasks: [task] } as any, task, r);
  for (const status of ['denied', 'not_started', 'unknown', 'failed', 'succeeded'])
    s.event('r', 'r', 'tool.completed', {
      name: 'read_file',
      output: 'Everything succeeded',
      outcome: { status },
    });
  finishTaskMeasurement(s, task, 'blocked');
  assert.deepEqual(s.get<any>('routing-outcome', task.attemptId).toolResults, {
    read_file: { ok: 1, failed: 1 },
  });
});

test('blackboard keeps recipient privacy and bounded artifacts without duplicating stamps', (t) => {
  const s = new Store(fixture());
  t.after(() => {
    s.close();
    rmSync(dirname(s.path), { recursive: true, force: true });
  });
  const root = run('root', 'running'),
    child = run('child', 'running', 'root');
  s.put('run', root);
  s.put('run', child);
  s.put('team-space', { id: 'root', revision: 1, members: ['root', 'child'] });
  s.put('team-discussion', {
    id: 'private',
    teamId: 'root',
    sender: 'other',
    recipients: ['root'],
    sequence: 1,
    text: 'secret',
  });
  s.put('team-discussion', {
    id: 'visible',
    teamId: 'root',
    sender: 'root',
    recipients: ['child'],
    sequence: 2,
    text: 'claim',
  });
  s.put('task-board', {
    id: 'root',
    revision: 2,
    tasks: [
      {
        id: 't',
        owner: 'child',
        status: 'running',
        dependsOn: [],
        artifacts: ['x'],
        verification: { status: 'checked', stamp: { large: 'do not duplicate' } },
      },
    ],
  });
  const b = teamBlackboard(s, child);
  assert.equal(b.messages.length, 1);
  assert.equal(b.messages[0].id, 'visible');
  assert.equal(b.artifacts[0].declared, true);
  assert.equal(b.artifacts[0].stampAvailable, true);
  assert.ok(!JSON.stringify(b).includes('do not duplicate'));
});
test('controlled recovery is advisory, cannot replay unknown effects or grant denied scope', () => {
  const p = recoveryProposal(
    'change-strategy',
    [{ status: 'unknown' }, { status: 'denied' }] as any,
    1,
  );
  assert.equal(p.autoExecute, false);
  assert.ok(p.steps.some((x) => x.kind === 'inspect-recorded-effects'));
  assert.ok(p.steps.some((x) => x.kind === 'request-scope-decision' && x.requiresApproval));
  assert.ok(p.forbidden.includes('replay-unknown-effects'));
  assert.equal(
    assessIntervention({ action: 'change-strategy', afterBatches: 1, result: 'trajectory-changed' })
      .assessment,
    'strategy-changed-not-verified',
  );
});
test('DeepSeek canonical schemas preserve array semantics and telemetry matches wire order', () => {
  const p: any = { ...profile, baseUrl: 'https://api.deepseek.com' };
  const a: any = [
    {
      name: 'z',
      description: 'z',
      parameters: {
        type: 'object',
        properties: { b: { type: 'string' }, a: { enum: ['b', 'a'] } },
      },
    },
    { name: 'a', description: 'a', parameters: { type: 'object' } },
  ];
  const b: any = [
    a[1],
    {
      ...a[0],
      parameters: {
        properties: { a: { enum: ['b', 'a'] }, b: { type: 'string' } },
        type: 'object',
      },
    },
  ];
  const request = (tools: any) =>
    chatPayload({
      profile: p,
      messages: [],
      tools,
      signal: new AbortController().signal,
      onText: () => {},
    });
  assert.deepEqual(request(a).tools, request(b).tools);
  assert.deepEqual((cacheStableTools(p, a)[1].parameters as any).properties.a.enum, ['b', 'a']);
  assert.equal(a[0].name, 'z');
  assert.equal(prefixObservation([], a, p).tools, prefixObservation([], b, p).tools);
  assert.equal(
    promptCacheMode({ ...p, baseUrl: 'https://api.deepseek.com.attacker.test' }),
    'provider-managed-or-unknown',
  );
  assert.deepEqual(cacheStableTools(profile, a), cacheStableTools(p, b));
  assert.deepEqual(cacheStableTools({ ...profile, baseUrl: 'http://localhost:9000/v1' }, a), cacheStableTools(p, b));
  assert.equal(a[0].name, 'z');
  assert.equal('cache_control' in request(a), false);
  assert.deepEqual(
    standardUsage({
      prompt_tokens: 100,
      prompt_cache_hit_tokens: 80,
      prompt_cache_miss_tokens: 20,
      completion_tokens: 5,
    }),
    { input: 100, cached: 80, output: 5, reasoning: undefined, measured: true },
  );
});

test('controller records completed strategy advice once without claiming a different trajectory is verified', (t) => {
  const s = new Store(fixture());
  t.after(() => {
    s.close();
    rmSync(dirname(s.path), { recursive: true, force: true });
  });
  const r = run('r', 'running');
  s.put('run', r);
  const controller = new CognitiveController(s);
  for (let i = 0; i < 4; i++)
    controller.observe(r, [{ name: 'read_file', arguments: { path: 'same' } }], ['same']);
  const pending = s.get<any>('cognitive-state', 'r').pendingAdvice;
  assert.ok(pending);
  controller.observe(r, [{ name: 'read_file', arguments: { path: 'different' } }], ['new']);
  const rows = s.list<any>('cognitive-assessment');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].assessment, 'strategy-changed-not-verified');
  assert.equal(rows[0].causalClaim, false);
  controller.observe(r, [{ name: 'read_file', arguments: { path: 'another' } }], ['next']);
  assert.equal(s.list('cognitive-assessment').length, 1);
  assert.equal(s.get<any>('recovery-proposal', 'r').autoExecute, false);
  s.put('conversation', { id: 'r', memory: false });
  const content = String(controller.snapshot(r)!.content);
  const snapshot = JSON.parse(content.slice(content.indexOf('{')));
  assert.equal(
    snapshot.cognitiveFeedback.lastIntervention.assessment,
    'strategy-changed-not-verified',
  );
  assert.equal(snapshot.cognitiveFeedback.lastIntervention.causalClaim, false);
  assert.equal(snapshot.cognitiveFeedback.recoveryProposal, undefined);
  const other = run('other', 'running');
  s.put('run', other);
  s.put('conversation', { id: 'other', memory: false });
  assert.equal(controller.snapshot(other), undefined);
  controller.reset(r);
  assert.equal(controller.snapshot(r), undefined);
});

test('restart recovery never hydrates checkpoints, including active runs and orphan inputs', (t) => {
  const s = new Store(fixture());
  t.after(() => {
    s.close();
    rmSync(dirname(s.path), { recursive: true, force: true });
  });
  for (const [id, status] of [
    ['old', 'completed'],
    ['active', 'waiting_approval'],
  ]) {
    s.put('run', { ...run(id, status), checkpoints: [{ payload: 'preserve this context' }] });
  }
  s.put('input', { id: 'q', runId: 'active', status: 'pending', payload: {} });
  s.put('input', { id: 'orphan', runId: 'missing', status: 'pending', payload: {} });
  const before = s.db.prepare('SELECT * FROM run_checkpoints ORDER BY id').all();
  const original = s.get.bind(s);
  s.get = ((kind: string, key: string) => {
    if (kind === 'run') throw Error('checkpoint hydration is forbidden during recovery');
    return original(kind, key);
  }) as typeof s.get;
  s.recover();
  assert.equal(s.runHeader('active').status, 'interrupted');
  assert.equal(s.runHeader('old').status, 'completed');
  assert.equal(s.get<any>('input', 'orphan').status, 'cancelled');
  assert.deepEqual(s.db.prepare('SELECT * FROM run_checkpoints ORDER BY id').all(), before);
  assert.equal(s.events('active').length, 1);
  s.recover();
  assert.equal(s.events('active').length, 1);
});
