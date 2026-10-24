import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/storage/store.js';
import { inspectProblemFrame, updateProblemFrame } from '../server/services/problem-framing.js';
import { CognitiveController } from '../server/core/cognitive-controller.js';

function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'problem-frame-'));
  const store = new Store(join(dir, 'db.sqlite'));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const run: any = { id: 'r', conversationId: 'c', parentRunId: null };
  store.put('run', run);
  store.put('conversation', { id: 'c' });
  const input = {
    revision: 0,
    objective: 'Improve reliability',
    requirements: ['Preserve supported inputs'],
    assumptions: ['Failure may be in recovery'],
    unknowns: ['Target service unavailable'],
    hypotheses: [],
    acceptance: [],
    decision: 'investigate',
    reason: 'Need a reproducer',
    nextCheck: 'Inspect recovery transitions',
    investigationBudget: 2,
  };
  const event = (runId = 'r', name = 'read_file') => {
    store.event('c', runId, 'tool.completed', { name, output: 'observed failure' });
    return (store.db.prepare('SELECT MAX(id) AS id FROM events').get() as any).id as number;
  };
  return { store, run, input, event };
}

test('optional investigation persists into snapshots even before a plan or tool batch', (t) => {
  const { store, run, input } = fixture(t);
  assert.equal(inspectProblemFrame(store, run), null);
  assert.equal(new CognitiveController(store).snapshot(run), undefined);
  updateProblemFrame(store, run, input);
  const snapshot = new CognitiveController(store).snapshot(run)!;
  assert.match(snapshot.content as string, /Improve reliability/);
  new CognitiveController(store).reset(run);
  assert.equal(inspectProblemFrame(store, run)?.revision, 1);
  assert.equal(inspectProblemFrame(store, { ...run, id: 'other' }), null);
});

test('investigation reassessment budget survives revisions and excludes framing calls', (t) => {
  const { store, run, input, event } = fixture(t);
  event(); // Work preceding the frame is not charged to its allowance.
  updateProblemFrame(store, run, input);
  event('r', 'update_problem_frame');
  event();
  assert.equal(inspectProblemFrame(store, run)?.reviewDue, false);
  updateProblemFrame(store, run, { ...input, revision: 1, investigationBudget: 20 });
  event();
  const frame = inspectProblemFrame(store, run)!;
  assert.equal(frame.observedCalls, 2);
  assert.equal(frame.investigationBudget, 2);
  assert.equal(frame.reviewDue, true);
  assert.throws(() => updateProblemFrame(store, run, input), /current problem frame/);
  assert.equal(inspectProblemFrame(store, run)?.revision, 2);
});

test('planning requires acceptance and scoped observations; diagnostic failures remain evidence', (t) => {
  const { store, run, input, event } = fixture(t);
  const propose = (evidence: number[], acceptance = ['Recovery preserves unknown effects']) => ({
    ...input,
    decision: 'plan',
    acceptance,
    hypotheses: [
      {
        explanation: 'Recovery loses state',
        discriminator: 'Reproduce restart',
        evidence,
        assessment: 'supported',
      },
    ],
  });
  assert.throws(() => updateProblemFrame(store, run, propose([])), /require observed evidence/);
  for (const id of [99999, event('other'), event('r', 'update_problem_frame')]) {
    assert.throws(() => updateProblemFrame(store, run, propose([id])), /actual tool result/);
  }
  const evidence = event('r', 'run_command');
  assert.throws(
    () => updateProblemFrame(store, run, propose([evidence], [])),
    /acceptance criteria/,
  );
  assert.equal(inspectProblemFrame(store, run), null);
  const result = updateProblemFrame(store, run, propose([evidence]));
  assert.equal(result?.decision, 'plan');
  assert.equal(result?.reviewDue, false);
  assert.equal(store.events('c').filter((e) => e.type === 'problem.framed').length, 1);
});

test('oversized frames cannot crowd out the working context', (t) => {
  const { store, run, input } = fixture(t);
  assert.throws(
    () =>
      updateProblemFrame(store, run, {
        ...input,
        requirements: Array(12).fill('x'.repeat(1200)),
        assumptions: Array(12).fill('y'.repeat(1200)),
      }),
    /16000 characters/,
  );
  assert.equal(inspectProblemFrame(store, run), null);
});

test('feature planning uses observed design context without inventing a defect hypothesis', (t) => {
  const { store, run, input, event } = fixture(t);
  const evidence = event();
  const frame = updateProblemFrame(store, run, {
    ...input,
    objective: 'Add an export option',
    decision: 'plan',
    hypotheses: [],
    decisionEvidence: [evidence],
    acceptance: ['Existing output remains supported'],
    verificationGaps: ['Target service is unavailable locally'],
  });
  assert.equal(frame?.decision, 'plan');
  assert.deepEqual(frame?.hypotheses, []);
  assert.equal(frame?.verificationGaps.length, 1);
  assert.throws(
    () =>
      updateProblemFrame(store, run, {
        ...input,
        revision: 1,
        decisionEvidence: [event('other')],
        changeReason: 'Clarify objective',
      }),
    /actual tool result/,
  );
});

test('scope revisions require an explicit explanation and retain the removed requirements in audit', (t) => {
  const { store, run, input } = fixture(t);
  updateProblemFrame(store, run, input);
  const change = {
    ...input,
    revision: 1,
    objective: 'Different objective',
    requirements: ['New scope'],
  };
  assert.throws(() => updateProblemFrame(store, run, change), /changeReason/);
  assert.equal(inspectProblemFrame(store, run)?.revision, 1);
  updateProblemFrame(store, run, { ...change, changeReason: 'User changed the requested outcome' });
  const audit = store
    .events('c')
    .filter((e) => e.type === 'problem.framed')
    .at(-1)!;
  assert.deepEqual(audit.data.removedRequirements, input.requirements);
  assert.equal(audit.data.previousObjective, input.objective);
});
