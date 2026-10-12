import { Teams } from './team-space.js';
import { createHash } from 'node:crypto';
import type { Run } from '../../shared/types.js';
import type { Store } from '../storage/store.js';
import type { FileScope } from './paths.js';
import { assert } from '../core/errors.js';
import { TaskBoard, type BoardTask } from './task-board.js';
import { sameStamp, stamp } from './verification.js';
import { verificationPaths } from './verification-inputs.js';
const contract = (task: BoardTask) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        task.title,
        task.acceptance,
        task.artifacts,
        task.readPaths,
        task.requireIndependent,
        task.requireSemantic,
        task.dependsOn,
        task.provides,
        task.requires,
        task.externalInputs,
      ]),
    )
    .digest('hex');
export function acceptanceStatus(store: Store, boardId: string, task: BoardTask) {
  const record = store.maybe<any>('task-acceptance', boardId + ':' + task.id);
  const valid =
    record &&
    record.contract === contract(task) &&
    task.verification?.status === 'checked' &&
    sameStamp(record.stamp, task.verification.stamp);
  return {
    execution: task.status,
    machineObservation: task.verification?.status || 'not-recorded',
    semanticAssessment: !record ? 'not-recorded' : valid ? record.verdict : 'stale',
    assessmentKind: 'reviewer-judgment-not-proof',
    reviewedBy: valid ? record.reviewedBy : undefined,
    humanAcceptance: 'not-recorded',
    notice:
      'Permission to execute is not human acceptance. A successful check is not a semantic verdict.',
  };
}
export class TaskAcceptance {
  constructor(private store: Store) {}
  async record(
    run: Run,
    files: FileScope,
    args: {
      taskId: string;
      revision: number;
      verdict: 'accepted' | 'rejected' | 'uncertain';
      rationale: string;
      counterexample: string;
      eventIds: number[];
    },
  ) {
    const board = new TaskBoard(this.store).get(run),
      task = board.tasks.find((t) => t.id === args.taskId);
    assert(
      task && board.revision === args.revision,
      'PLAN_CHANGED',
      'Read the current task board.',
    );
    assert(
      new Teams(this.store).authority(run, 'reviewer') || task.owner === run.id,
      'ACCEPTANCE_AUTHORITY',
      'Only the task owner or authorized reviewer can record acceptance.',
    );
    assert(
      task.status === 'done' && task.verification?.status === 'checked',
      'ACCEPTANCE_UNCHECKED',
      'Record current machine observations before semantic assessment.',
    );
    assert(
      !task.requireIndependent || task.owner !== run.id,
      'ACCEPTANCE_INDEPENDENT',
      'This contract requires a reviewer distinct from its author.',
    );
    const current = await stamp(files, verificationPaths(task));
    assert(
      sameStamp(current, task.verification.stamp),
      'ACCEPTANCE_STALE',
      'Artifacts changed; repeat verification.',
    );
    for (const eventId of args.eventIds) {
      const row = this.store.db
        .prepare('SELECT run_id,type,data FROM events WHERE id=?')
        .get(eventId) as any;
      assert(
        row && task.evidence.includes(eventId) && row.type === 'tool.completed',
        'ACCEPTANCE_EVIDENCE',
        'Cite checks already attached to this task.',
      );
      const data = JSON.parse(row.data),
        v = data.verification;
      assert(
        v?.passed === true && sameStamp(v.before, current) && sameStamp(v.after, current),
        'ACCEPTANCE_EVIDENCE',
        'Cite successful observations against current inputs.',
      );
      assert(
        !task.requireIndependent || row.run_id !== task.owner,
        'ACCEPTANCE_INDEPENDENT',
        'Author evidence alone does not satisfy independent review.',
      );
    }
    assert(
      args.eventIds.length > 0,
      'ACCEPTANCE_EVIDENCE',
      'At least one observed check is required.',
    );
    return this.store.transaction(() => {
      assert(
        new TaskBoard(this.store).get(run).revision === args.revision,
        'PLAN_CHANGED',
        'Task changed during assessment.',
      );
      const result = this.store.put('task-acceptance', {
        id: board.id + ':' + task.id,
        root: board.id,
        reviewedBy: run.id,
        ...args,
        contract: contract(task),
        stamp: current,
        createdAt: Date.now(),
        kind: 'reviewer-judgment-not-proof',
      });
      this.store.event(run.conversationId, run.id, 'task.acceptance', {
        taskId: task.id,
        verdict: args.verdict,
        kind: result.kind,
        eventIds: args.eventIds,
      });
      return result;
    });
  }
}
