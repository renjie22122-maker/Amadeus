import { deliveryEvidence } from '../services/delivery-evidence.js';
import type { Run } from '../../shared/types.js';
import type { Store } from '../storage/store.js';
import type { FileScope } from '../services/paths.js';
import { Verification } from '../services/verification.js';
import { assert } from './errors.js';
// Host completion authority. No model calls, scheduling or command execution.
export async function finalizeRun(store: Store, run: Run, files: FileScope) {
  if (run.recoveryOnly && store.unknownEffects(run.conversationId).length) {
    store.transition(
      run.id,
      'interrupted',
      'Read-only inspection finished. Some operation outcomes remain unresolved; no side effects were replayed.',
    );
    return;
  }
  assert(
    !store.unknownEffects(run.conversationId).length,
    'OUTCOME_UNKNOWN',
    'An operation has an unknown outcome. Inspect it before treating the task as complete.',
  );
  assert(
    !store
      .list<any>('recovery-action')
      .some(
        (r) =>
          r.runId === run.id &&
          ['executing', 'waiting-action', 'waiting-check', 'unknown'].includes(r.status),
      ),
    'RECOVERY_PENDING',
    'Recovery is pending or unknown. Inspect its recorded job and continue the same contract; do not replay.',
  );
  await new Verification(store).refresh(run, files);
  const report = deliveryEvidence(store, run);
  store.event(run.conversationId, run.id, 'delivery.assessed', report);
  assert(
    !report.blockers.tasks.length,
    'PLAN_INCOMPLETE',
    'Declared plan has unfinished tasks: ' +
      report.blockers.tasks.join(', ') +
      '. Inspect the board and continue or explain blockers.',
  );
  assert(
    !report.blockers.challenges.length,
    'CHALLENGE_OPEN',
    'Unresolved task challenges: ' +
      report.blockers.challenges.join(', ') +
      '. Inspect counterexamples and resolve with current evidence.',
  );
  assert(
    !report.blockers.memories.length,
    'MEMORY_CHECK_PENDING',
    'Recalled experience checks remain pending: ' +
      report.blockers.memories.join(', ') +
      '. Verify applicability or record a concrete reason with resolve_memory_check.',
  );
  assert(
    !report.blockers.collaboration.length,
    'TEAM_REVIEW_PENDING',
    'Required peer collaboration remains open: ' +
      report.blockers.collaboration.join('; ') +
      '. Inspect proposals; request response/revision or explicitly retain unresolved limits. Do not add empty discussion.',
  );
  store.transition(run.id, 'completed');
}
