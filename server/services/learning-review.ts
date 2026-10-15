import { createHash } from 'node:crypto';
import type { Run, Memory } from '../../shared/types.js';
import { Store } from '../storage/store.js';
import { assert } from '../core/errors.js';
import { resultSucceeded } from '../core/tool-outcome.js';
import { TaskBoard } from './task-board.js';
import { Verification } from './verification.js';
import { MemoryLifecycle } from './memory-lifecycle.js';
import { MemoryChecks } from './memory-checks.js';
import { sensitive } from './memory-learning.js';
import type { FileScope } from './paths.js';
export interface LessonInput {
  failureEventId: number;
  taskId: string;
  lesson: string;
  conditions: string;
  expected: string;
  observed: string;
  causeHypothesis: string;
}
export async function proposeExperience(
  store: Store,
  run: Run,
  files: FileScope,
  input: LessonInput,
) {
  const conversation = store.get<any>('conversation', run.conversationId);
  assert(conversation.memory, 'MEMORY_DISABLED', 'Enable memory before proposing experience.');
  const board = await new Verification(store).refresh(run, files);
  const task = board.tasks.find((t) => t.id === input.taskId);
  assert(
    task?.kind === 'verify' && task.status === 'done' && task.verification?.status === 'checked',
    'LESSON_CHECK',
    'Use a completed current verify task.',
  );
  const event = (id: number) =>
    store.db.prepare('SELECT run_id,type,data FROM events WHERE id=?').get(id) as any;
  const failed = event(input.failureEventId),
    passed = event(task.verification.eventId);
  assert(
    failed?.run_id === run.id &&
      passed?.run_id === run.id &&
      failed.type === 'tool.completed' &&
      passed.type === 'tool.completed',
    'LESSON_SCOPE',
    'Both observations must belong to this run.',
  );
  const f = JSON.parse(failed.data),
    p = JSON.parse(passed.data);
  assert(
    f.outcome?.status === 'failed' && f.outcome.executionStarted === true,
    'LESSON_FAILURE',
    'Use an observed executed failure, not denial, unknown outcome or a quoted report.',
  );
  assert(
    resultSucceeded(p) &&
      p.verification?.passed === true &&
      task.verification.eventId > input.failureEventId,
    'LESSON_CHECK',
    'Successful check must follow the observed failure.',
  );
  assert(
    !sensitive(JSON.stringify(input)),
    'LESSON_SENSITIVE',
    'Remove credentials from the proposed lesson.',
  );
  const key = createHash('sha256')
    .update(JSON.stringify([run.conversationId, input, task.verification.eventId]))
    .digest('hex');
  const existing = store.maybe<Memory>('memory', key);
  if (existing) return existing;
  const memory: Memory = {
    id: key,
    scope: conversation.projectId ? 'project:' + conversation.projectId : 'user',
    content: input.lesson,
    conditions: input.conditions,
    kind: 'experience',
    active: false,
    status: 'candidate',
    revision: 1,
    expiresAt: null,
    createdAt: Date.now(),
    recallScope: 'conversation',
    sourceConversationId: run.conversationId,
    source: 'Observed failure and subsequent check; cause/generalization remain model hypotheses.',
    sourceRefs: ['event:' + input.failureEventId, 'event:' + task.verification.eventId],
    evidence: [{ conversationId: run.conversationId, eventId: task.verification.eventId }],
  };
  store.transaction(() => {
    new MemoryLifecycle(store).create(memory);
    store.put('experience-formation', {
      id: key,
      runId: run.id,
      ...input,
      checkEventId: task.verification!.eventId,
      artifactStamp: task.verification!.stamp,
      regressionPaths: task.artifacts || [],
      causalClaim: false,
      formedAt: Date.now(),
    });
  });
  return store.get<Memory>('memory', key);
}
const contract = (t: any) =>
  JSON.stringify([
    t.kind,
    t.title,
    t.acceptance,
    t.requireIndependent,
    [...(t.dependsOn || [])].sort(),
    [...(t.artifacts || [])].sort(),
    [...(t.readPaths || [])].sort(),
    [...(t.writePaths || [])].sort(),
    t.provides,
    t.requires,
    t.externalInputs,
  ]);
export function compareContracts(store: Store, run: Run, baselineId: string) {
  const baseline = store.get<Run>('run', baselineId);
  assert(
    baseline.conversationId === run.conversationId &&
      !baseline.parentRunId &&
      !run.parentRunId &&
      baseline.id !== run.id,
    'CONTRACT_SCOPE',
    'Choose an earlier root run in this same conversation.',
  );
  assert(baseline.createdAt < run.createdAt, 'CONTRACT_ORDER', 'Baseline must predate this run.');
  const before = new TaskBoard(store).get(baseline),
    after = new TaskBoard(store).get(run);
  return {
    baselineRunId: baselineId,
    currentRunId: run.id,
    removed: before.tasks
      .filter((t) => !after.tasks.some((n) => n.id === t.id))
      .map((t) => ({ id: t.id, title: t.title, acceptance: t.acceptance })),
    added: after.tasks.filter((t) => !before.tasks.some((n) => n.id === t.id)).map((t) => t.id),
    changed: after.tasks
      .filter((t) => {
        const old = before.tasks.find((n) => n.id === t.id);
        return old && contract(old) !== contract(t);
      })
      .map((t) => ({ id: t.id, before: before.tasks.find((n) => n.id === t.id), after: t })),
    limitation:
      'Structural comparison by task ID, not proof of semantic weakening. Renames appear removed/added; absent original requirements remain unknown. Scope reduction is not a verified fix.',
  };
}
export function learningOutcomes(store: Store, run: Run) {
  const conversation = store.get<any>('conversation', run.conversationId);
  if (!conversation.memory) return { enabled: false };
  const runs = store
    .runMetadata(run.conversationId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 100);
  const rows = runs.flatMap((r) => new MemoryChecks(store).list(r));
  const states = ['pending', 'checked', 'not-applicable'] as const;
  const assessments = store
    .list<any>('cognitive-assessment')
    .filter((a) => runs.some((r) => r.id === a.runId));
  return {
    enabled: true,
    sampledRuns: runs.length,
    windowLimit: 100,
    counts: Object.fromEntries(states.map((s) => [s, rows.filter((r) => r.status === s).length])),
    interventionAssessments: assessments.reduce((out: Record<string, number>, a) => {
      out[a.assessment] = (out[a.assessment] || 0) + 1;
      return out;
    }, {}),
    causalImprovement: null,
    limitation:
      'Current eligible dispositions, not all past recalls. Checked is not a discovered bug; non-applicability is model judgment. Counts do not calibrate truth or prove a benefit. No automatic ranking or permission changes.',
  };
}
