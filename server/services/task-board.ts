import { resultSucceeded } from '../core/tool-outcome.js';
import { compilePlan } from './plan-compiler.js';
import { startTaskMeasurement, finishTaskMeasurement } from './routing-outcomes.js';
import { Teams } from './team-space.js';
import { z } from 'zod';
import type { Conversation, Run } from '../../shared/types.js';
import { Store } from '../storage/store.js';
import { terminal } from '../core/lifecycle.js';
import type { ArtifactStamp } from './verification.js';
import { assert } from '../core/errors.js';
export const taskInput = z.object({
  id: z.string().min(1).max(80),
  kind: z.enum(['inspect', 'implement', 'verify', 'deliver']).optional(),
  title: z.string().min(1).max(300),
  dependsOn: z.array(z.string()).max(50).default([]),
  acceptance: z.string().min(1).max(2000),
  requireIndependent: z.boolean().optional(),
  requireSemantic: z.boolean().optional(),
  execution: z.enum(['read-only', 'isolated']).optional(),
  weight: z.number().int().min(1).max(8).optional(),
  priority: z.number().int().min(0).max(10).optional(),
  requiredTools: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  skills: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  readPaths: z.array(z.string().min(1).max(2048)).max(30).optional(),
  writePaths: z.array(z.string().min(1).max(2048)).max(30).optional(),
  provides: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
  requires: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
  artifacts: z.array(z.string().min(1).max(2048)).max(30).optional(),
  externalInputs: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(100),
        source: z.string().trim().min(1).max(1000),
      }),
    )
    .max(20)
    .optional(),
});
export interface BoardTask {
  id: string;
  kind?: 'inspect' | 'implement' | 'verify' | 'deliver';
  attemptId?: string;
  title: string;
  dependsOn: string[];
  acceptance: string;
  requireIndependent?: boolean;
  requireSemantic?: boolean;
  status: 'pending' | 'running' | 'done' | 'blocked';
  owner: string | null;
  evidence: number[];
  note: string;
  execution?: 'read-only' | 'isolated';
  weight?: number;
  priority?: number;
  artifacts?: string[];
  skills?: string[];
  requiredTools?: string[];
  readPaths?: string[];
  writePaths?: string[];
  provides?: string[];
  requires?: string[];
  externalInputs?: { name: string; source: string }[];
  verification?: {
    status: 'checked' | 'stale';
    independent?: boolean;
    checkKind?: 'file-observation' | 'command-check';
    eventId: number;
    checkedBy: string;
    stamp: ArtifactStamp;
  };
}
export interface Board {
  id: string;
  revision: number;
  tasks: BoardTask[];
}
export function rootRun(store: Store, run: Run): string {
  const seen = new Set<string>();
  while (run.parentRunId) {
    assert(!seen.has(run.id), 'TEAM_CYCLE', 'Corrupt run ancestry.');
    seen.add(run.id);
    run = store.runHeader(run.parentRunId);
  }
  return run.id;
}
export class TaskBoard {
  constructor(private store: Store) {}
  get(run: Run): Board {
    const id = rootRun(this.store, run);
    return this.store.maybe<Board>('task-board', id) || { id, revision: 0, tasks: [] };
  }
  create(run: Run, input: z.infer<typeof taskInput>[], revision: number) {
    assert(
      new Teams(this.store).authority(run, 'planner'),
      'PLAN_OWNER',
      'Only the lead creates the shared plan.',
    );
    return this.store.transaction(() => {
      const board = this.get(run);
      assert(board.revision === revision, 'PLAN_CHANGED', 'Read the latest plan revision.');
      assert(
        board.tasks.length === 0,
        'PLAN_EXISTS',
        'Update existing tasks rather than discarding work.',
      );
      const compiled = compilePlan(
        input,
        this.store.get<any>('conversation', run.conversationId).permission === 'read-only',
      );
      input = compiled.tasks;
      this.store.put('compiled-plan', { id: board.id, ...compiled, createdAt: Date.now() });
      return this.save({
        ...board,
        revision: board.revision + 1,
        tasks: input.map((t) => ({
          ...t,
          status: 'pending',
          owner: null,
          evidence: [],
          note: '',
        })),
      });
    });
  }
  extend(run: Run, input: z.infer<typeof taskInput>[], revision: number) {
    assert(
      new Teams(this.store).authority(run, 'planner'),
      'PLAN_OWNER',
      'Only the planner extends the shared plan.',
    );
    return this.store.transaction(() => {
      const board = this.get(run);
      assert(board.revision === revision, 'PLAN_CHANGED', 'Read the latest plan revision.');
      assert(board.tasks.length > 0, 'PLAN_MISSING', 'Create the initial plan first.');
      assert(
        board.tasks.length + input.length <= 100,
        'PLAN_SIZE',
        'Split larger work into separate plans.',
      );
      const ids = new Set(board.tasks.map((t) => t.id));
      assert(
        input.every((t) => !ids.has(t.id)),
        'TASK_EXISTS',
        'Use new task IDs; existing work is preserved.',
      );
      const compiled = compilePlan(
        [...board.tasks.map((t) => taskInput.parse(t)), ...input],
        this.store.get<any>('conversation', run.conversationId).permission === 'read-only',
      );
      // Extending scope cannot silently change dependencies of work already underway.
      for (const old of board.tasks) {
        const next = compiled.tasks.find((t) => t.id === old.id)!;
        assert(
          JSON.stringify([...old.dependsOn].sort()) === JSON.stringify([...next.dependsOn].sort()),
          'PLAN_DEPENDENCY_CHANGE',
          'New tasks must not change dependencies of existing work.',
        );
      }
      const additions = compiled.tasks
        .filter((t) => !ids.has(t.id))
        .map((t) => ({
          ...t,
          status: 'pending' as const,
          owner: null,
          evidence: [],
          note: '',
        }));
      this.store.put('compiled-plan', { id: board.id, ...compiled, createdAt: Date.now() });
      return this.save({
        ...board,
        revision: board.revision + 1,
        tasks: [...board.tasks, ...additions],
      });
    });
  }
  update(
    run: Run,
    taskId: string,
    revision: number,
    status: BoardTask['status'],
    evidence: number[],
    note: string,
  ) {
    return this.store.transaction(() => {
      const board = this.get(run);
      assert(board.revision === revision, 'PLAN_CHANGED', 'Read the latest plan revision.');
      const task = board.tasks.find((t) => t.id === taskId);
      assert(task, 'TASK_MISSING', 'Task not found in this team.');
      assert(
        !task.owner || task.owner === run.id || new Teams(this.store).authority(run),
        'TASK_OWNER',
        'Another worker owns this task.',
      );
      if (status === 'running' || status === 'done')
        assert(
          task.dependsOn.every(
            (d) =>
              board.tasks.find((t) => t.id === d)?.status === 'done' &&
              board.tasks.find((t) => t.id === d)?.verification?.status !== 'stale',
          ),
          'TASK_DEPENDENCY',
          'Complete dependencies first.',
        );
      if (status !== 'done' && task.status === 'done')
        assert(
          !board.tasks.some(
            (t) => t.dependsOn.includes(taskId) && ['done', 'running'].includes(t.status),
          ),
          'TASK_DEPENDENTS',
          'Reopen downstream tasks first.',
        );
      if (status === 'done' || status === 'pending')
        assert(
          !this.store.unknownEffects(run.conversationId).length,
          'OUTCOME_UNKNOWN',
          'Inspect uncertain effects before completion or release.',
        );
      if (status === 'done') {
        assert(
          evidence.length > 0,
          'TASK_EVIDENCE',
          'Completion needs actual tool-result event IDs.',
        );
        for (const id of evidence) {
          const row = this.store.db
            .prepare('SELECT run_id,type,data FROM events WHERE id=?')
            .get(id) as any;
          assert(
            row?.type === 'tool.completed' && row.run_id,
            'TASK_EVIDENCE',
            'Evidence must be an existing tool result.',
          );
          const data = JSON.parse(row.data);
          assert(
            ![
              'update_task',
              'create_plan',
              'preview_plan',
              'prepare_security_review',
              'resolve_memory_check',
              'propose_verified_experience',
              'compare_acceptance_contracts',
              'inspect_learning_outcomes',
              'inspect_delivery_evidence',
              'inspect_recovery_step',
              'prepare_recovery_action',
              'execute_recovery_action',
              'record_task_challenge',
              'resolve_task_challenge',
              'inspect_task_challenges',
              'inspect_planning_policy',
              'inspect_plan',
              'handoff_task',
              'inspect_team',
              'record_verification',
              'record_task_acceptance',
              'configure_team_scheduler',
              'await_team_task',
              'await_team_message',
              'configure_team',
              'update_team_roster',
              'configure_team_group',
              'update_team_discussion_limits',
              'team_discuss',
              'handoff_team_role',
              'end_team_participation',
            ].includes(data.name) && resultSucceeded(data),
            'TASK_EVIDENCE',
            'A failed tool or plan update is not completion evidence.',
          );
          if (task.kind === 'verify')
            assert(
              data.verification?.passed === true,
              'TASK_CHECK_REQUIRED',
              'Verification tasks need a successful observed check, not merely a tool result.',
            );
          assert(
            rootRun(this.store, this.store.get<Run>('run', row.run_id)) === board.id,
            'TASK_EVIDENCE_SCOPE',
            'Evidence belongs to another task tree.',
          );
        }
      }
      if (status === 'running')
        startTaskMeasurement(
          this.store,
          board,
          task,
          this.store.get<Run>('run', task.owner || run.id),
        );
      if (status === 'done' || status === 'blocked')
        finishTaskMeasurement(this.store, task, status);
      Object.assign(task, {
        status,
        owner: status === 'pending' ? null : task.owner || run.id,
        evidence,
        note,
        verification: undefined,
      });
      return this.save({ ...board, revision: board.revision + 1 });
    });
  }
  members(run: Run) {
    const root = rootRun(this.store, run);
    return this.store
      .runMetadata()
      .filter((r) => rootRun(this.store, r) === root)
      .map((r) => ({
        runId: r.id,
        name:
          this.store.get<Conversation>('conversation', r.conversationId).title ||
          (r.id === root ? 'Coordinator' : 'Member'),
        status: r.status,
        depth: r.depth,
        role: r.id === root ? 'lead' : 'worker',
        unresolvedEffects: this.store.unknownEffects(r.conversationId).length,
        tasks: this.get(run)
          .tasks.filter((t) => t.owner === r.id)
          .map((t) => t.id),
      }));
  }
  handoff(run: Run, taskId: string, revision: number, targetId: string, reason: string) {
    return this.store.transaction(() => {
      const board = this.get(run);
      assert(
        new Teams(this.store).authority(run),
        'PLAN_OWNER',
        'Only the lead can hand off tasks.',
      );
      assert(board.revision === revision, 'PLAN_CHANGED', 'Read the latest plan revision.');
      const task = board.tasks.find((t) => t.id === taskId),
        target = this.store.get<Run>('run', targetId);
      assert(
        task && task.status !== 'done',
        'TASK_HANDOFF',
        'Only unfinished tasks can be handed off.',
      );
      assert(
        rootRun(this.store, target) === board.id && !terminal(target.status),
        'TEAM_SCOPE',
        'Target must be an active member of this team.',
      );
      if (task.owner) {
        const owner = this.store.get<Run>('run', task.owner);
        assert(
          terminal(owner.status),
          'OWNER_ACTIVE',
          'Stop or wait for the current owner before handoff.',
        );
        assert(
          !this.store.runs().some((r) => {
            let p: Run | undefined = r;
            while (p) {
              if (p.id === owner.id)
                return (
                  !terminal(r.status) || this.store.unknownEffects(r.conversationId).length > 0
                );
              p = p.parentRunId ? this.store.get<Run>('run', p.parentRunId) : undefined;
            }
            return false;
          }),
          'OUTCOME_UNKNOWN',
          'Wait for previous descendants and resolve uncertain effects first; no replay is authorized.',
        );
      }
      assert(
        task.dependsOn.every((d) =>
          board.tasks.some(
            (t) => t.id === d && t.status === 'done' && t.verification?.status !== 'stale',
          ),
        ),
        'TASK_DEPENDENCY',
        'Dependencies are not ready.',
      );
      const previous = task.owner;
      Object.assign(task, {
        owner: targetId,
        status: 'running',
        evidence: [],
        verification: undefined,
        note: reason,
      });
      board.revision++;
      this.save(board);
      this.store.put('task-handoff', {
        id: board.id + ':' + board.revision,
        boardId: board.id,
        taskId,
        previous,
        targetId,
        reason,
        at: Date.now(),
      });
      return board;
    });
  }
  private save(board: Board) {
    this.store.put('task-board', board);
    const root = this.store.runHeader(board.id);
    this.store.event(root.conversationId, root.id, 'plan.updated', { revision: board.revision });
    return board;
  }
}
