import { acceptanceStatus } from './task-acceptance.js';
import type { Run } from '../../shared/types.js';
import type { Store } from '../storage/store.js';
import { TaskBoard } from './task-board.js';
import { TaskChallenges } from './task-challenges.js';
import { MemoryChecks } from './memory-checks.js';
import { Teams } from './team-space.js';
export interface EvidenceItem {
  id: string;
  kind: 'task' | 'challenge' | 'memory' | 'effect' | 'recovery';
  state: string;
  blocking: boolean;
  next: string;
}
/** One read-only projection over existing authorities, not another writable ledger. */
export function deliveryEvidence(store: Store, run: Run) {
  const board = new TaskBoard(store).get(run),
    team = new Teams(store).get(run);
  const tasks = board.tasks.filter((t) => (run.id === board.id && !team) || t.owner === run.id);
  const unfinished = tasks.filter(
    (t) =>
      t.status !== 'done' ||
      acceptanceStatus(store, board.id, t).semanticAssessment === 'rejected' ||
      (t.requireSemantic === true &&
        acceptanceStatus(store, board.id, t).semanticAssessment !== 'accepted') ||
      (t.requireIndependent === true &&
        (t.verification?.status !== 'checked' || t.verification.independent !== true)) ||
      t.verification?.status === 'stale' ||
      (!!t.artifacts?.length && t.verification?.status !== 'checked'),
  );
  const challenges = new TaskChallenges(store)
    .list(run)
    .filter(
      (c) =>
        c.status === 'open' &&
        (run.id === board.id || board.tasks.some((t) => t.id === c.taskId && t.owner === run.id)),
    );
  const memories = new MemoryChecks(store).list(run);
  const effects = store.unknownEffects(run.conversationId);
  const recovery = store
    .list<any>('recovery-action')
    .filter(
      (r) =>
        r.runId === run.id &&
        ['executing', 'waiting-action', 'waiting-check', 'unknown'].includes(r.status),
    );
  const entries: EvidenceItem[] = [
    ...recovery.map((r) => ({
      id: r.id,
      kind: 'recovery' as const,
      state: r.status,
      blocking: true,
      next: 'Inspect recorded background job and continue the same contract. Never resubmit unknown commands.',
    })),
    ...tasks.map((t) => ({
      id: t.id,
      kind: 'task' as const,
      state:
        t.requireIndependent &&
        (t.verification?.status !== 'checked' || t.verification.independent !== true)
          ? 'independent-review-required'
          : t.status === 'blocked'
            ? 'blocked'
            : t.verification?.status === 'stale'
              ? 'stale'
              : t.status === 'done'
                ? t.verification?.status === 'checked'
                  ? 'checked'
                  : 'declared-done-unverified'
                : t.status === 'running'
                  ? 'attempted'
                  : 'open',
      blocking: unfinished.some((u) => u.id === t.id),
      acceptanceState: acceptanceStatus(store, board.id, t),
      next:
        t.status === 'blocked'
          ? 'Resolve prerequisite; blocked is not passed.'
          : 'Verify acceptance against current artifacts.',
    })),
    ...challenges.map((c) => ({
      id: c.id,
      kind: 'challenge' as const,
      state: 'open',
      blocking: true,
      next: 'Test the counterexample with fresh version-bound evidence.',
    })),
    ...memories.map((c) => ({
      id: c.id,
      kind: 'memory' as const,
      state: c.status,
      blocking: c.status === 'pending',
      next: 'Check applicability and current evidence; non-applicability is a model judgment.',
    })),
    ...effects.map((e) => ({
      id: e.id,
      kind: 'effect' as const,
      state: 'unknown',
      blocking: true,
      next: 'Inspect outcome; do not replay unknown effects.',
    })),
  ];
  const impact = tasks
    .filter((t) => t.artifacts?.length)
    .map((t) => {
      const checks = board.tasks.filter((v) => v.kind === 'verify' && v.dependsOn.includes(t.id));
      return {
        taskId: t.id,
        acceptance: t.acceptance,
        declaredArtifacts: t.artifacts,
        verificationTasks: checks.map((v) => ({
          id: v.id,
          state: v.status,
          check: v.verification?.status ?? 'not-recorded',
        })),
        ownCheck: t.verification?.status ?? 'not-recorded',
        coverage:
          checks.length > 0 &&
          checks.every((v) => v.status === 'done' && v.verification?.status === 'checked')
            ? 'declared-successor-checked'
            : t.verification?.status === 'checked'
              ? 'artifact-check-only'
              : 'unknown',
      };
    });
  const blocking = entries.filter((e) => e.blocking);
  const gaps =
    entries.some((e) => e.state === 'declared-done-unverified') ||
    impact.some((i) => i.coverage !== 'declared-successor-checked');
  return {
    version: 1,
    verdict: blocking.length ? 'red' : gaps ? 'yellow' : entries.length ? 'green' : 'unassessed',
    meaning:
      'Green means recorded required gates satisfied, not correctness or security proof. Yellow reports coverage gaps without inventing a pass. Snapshot checks may become stale; finalization refreshes versions.',
    counts: {
      total: entries.length,
      blocking: blocking.length,
      omitted: Math.max(0, entries.length - 100),
    },
    entries: entries.slice(0, 100),
    impact: impact.slice(0, 50),
    omittedImpact: Math.max(0, impact.length - 50),
    limitations:
      'Declared artifacts and direct verification dependencies only; no complete semantic impact graph or test-to-behavior proof.',
    blockers: {
      recoveries: recovery.map((r) => r.id),
      effects: effects.map((e) => e.id),
      tasks: unfinished.map((t) => t.id),
      challenges: challenges.map((c) => c.id),
      memories: memories.filter((c) => c.status === 'pending').map((c) => c.id),
    },
  };
}
