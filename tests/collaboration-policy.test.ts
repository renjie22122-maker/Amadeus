import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/storage/store.js';
import { collaborationPolicy } from '../server/services/collaboration-policy.js';
function fixture(t: any) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const run: any = { id: 'lead', conversationId: 'chat', depth: 0, status: 'running' };
  store.put('run', run);
  const conversation: any = {
    id: 'chat',
    profileId: 'p',
    teamStrategy: 'auto',
    permission: 'read-only',
  };
  const settings: any = {
    maxChildren: 8,
    maxAgentDepth: 3,
    maxParallelRuns: 3,
    profiles: [{ id: 'p', model: 'test' }],
  };
  const ctx: any = { store, run, conversation, config: { get: () => settings } };
  const task = (id: string, dependsOn: string[] = [], extra: any = {}) => ({
    id,
    title: id,
    acceptance: 'Cited evidence',
    dependsOn,
    status: 'pending',
    owner: null,
    evidence: [],
    note: '',
    ...extra,
  });
  return { ctx, settings, task };
}
test('research readiness follows dependencies and ownership, not task title keywords', (t) => {
  const { ctx, task } = fixture(t);
  const tasks = [
    task('A'),
    task('B'),
    task('synthesis', ['A', 'B']),
    task('owned', [], { owner: 'member', status: 'running' }),
  ];
  const report = collaborationPolicy(ctx, tasks);
  assert.deepEqual(report.independentReadyTaskIds, ['A', 'B']);
  assert.equal(report.recommendation, 'consider-bounded-delegation');
  tasks[1].dependsOn = ['A'];
  assert.equal(collaborationPolicy(ctx, tasks).recommendation, 'assess-task-decomposition');
});
test('off, recovery, depth, tool policy and removed model block recommendations', (t) => {
  const { ctx, settings } = fixture(t);
  ctx.conversation.teamStrategy = 'off';
  assert.equal(collaborationPolicy(ctx).eligible, false);
  ctx.conversation.teamStrategy = 'auto';
  ctx.run.recoveryOnly = true;
  assert.equal(collaborationPolicy(ctx).eligible, false);
  ctx.run.recoveryOnly = false;
  ctx.run.depth = 3;
  assert.ok(collaborationPolicy(ctx).blockers.includes('depth-limit'));
  ctx.run.depth = 0;
  ctx.conversation.allowedTools = ['read_file'];
  assert.equal(collaborationPolicy(ctx).eligible, false);
  delete ctx.conversation.allowedTools;
  settings.profiles = [];
  assert.ok(collaborationPolicy(ctx).blockers.includes('default-model-unavailable'));
});
test('child execution budget is tree scoped and zero means unlimited', (t) => {
  const { ctx, settings } = fixture(t);
  ctx.store.put('run', {
    id: 'child',
    parentRunId: 'lead',
    conversationId: 'other',
    status: 'completed',
  });
  ctx.store.put('run', { id: 'unrelated', conversationId: 'private', status: 'running' });
  settings.maxChildren = 1;
  assert.equal(collaborationPolicy(ctx).remainingChildExecutions, 0);
  settings.maxChildren = 0;
  assert.equal(collaborationPolicy(ctx).remainingChildExecutions, null);
  assert.equal(collaborationPolicy(ctx).eligible, true);
});
test('resource-conflicting tasks are not advertised as independent', (t) => {
  const { ctx, task } = fixture(t);
  const tasks = [
    task('a', [], { execution: 'isolated', writePaths: ['shared/file'] }),
    task('b', [], { execution: 'isolated', writePaths: ['shared/file'] }),
  ];
  assert.deepEqual(collaborationPolicy(ctx, tasks).independentReadyTaskIds, ['a']);
});
