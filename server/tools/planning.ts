import {
  recoveryContract,
  prepareRecovery,
  executeRecovery,
} from '../services/recovery-execution.js';
import { inspectRecovery } from '../services/recovery-actions.js';
import { deliveryEvidence } from '../services/delivery-evidence.js';
import {
  proposeExperience,
  compareContracts,
  learningOutcomes,
} from '../services/learning-review.js';
import { MemoryChecks } from '../services/memory-checks.js';
import { prepareSecurityReview, securitySurfaces } from '../services/security-review.js';
import { TaskChallenges } from '../services/task-challenges.js';
import { createHash } from 'node:crypto';
import { teamBlackboard } from '../services/team-blackboard.js';
import { compilePlan } from '../services/plan-compiler.js';
import { planningPolicy } from '../services/planning-policy.js';
import { workerExpertise } from '../services/task-routing.js';
import { Teams } from '../services/team-space.js';
import { TeamScheduler } from '../services/team-scheduler.js';
import { Verification } from '../services/verification.js';
import { z } from 'zod';
import type { ToolRegistry } from './registry.js';
import { TaskBoard, taskInput, rootRun } from '../services/task-board.js';
export function installPlanning(registry: ToolRegistry) {
  registry.add({
    name: 'prepare_recovery_action',
    effect: 'coordinate',
    description:
      'Prepare one bounded recovery action with explicit precondition paths and expected verification. Maximum three contracts per run. Not authorization. Paths must already exist; command checks observe exit status, not semantic proof.',
    schema: recoveryContract,
    run: async (a, c) => ({ content: JSON.stringify(await prepareRecovery(c, a)) }),
  });
  registry.add({
    name: 'execute_recovery_action',
    effect: 'execute',
    description:
      'Execute a prepared recovery once through normal guarded tools, then its check. No unknown-effect replay. Uses normal command timeout and background yielding. For waiting receipts, wait on the job then call again with the same ID; never repeat the command. Repeated calls return receipt; productive only means declared predicate observed.',
    schema: z.object({ id: z.string().min(1) }),
    run: async (a, c) => ({ content: JSON.stringify(await executeRecovery(c, a.id)) }),
  });

  registry.add({
    name: 'inspect_recovery_step',
    effect: 'coordinate',
    description:
      'Perform one bounded diagnostic step from this run current recovery proposal. Only recorded-effect inspection, declared verification refresh or delivery evidence inspection. Never runs commands, resolves effects, or proves acceptance. Repeated calls return the receipt.',
    schema: z.object({ proposalId: z.string().min(1), index: z.number().int().min(0).max(3) }),
    run: async (a, c) => ({
      content: JSON.stringify(
        await inspectRecovery(c.store, c.run, c.files, a.proposalId, a.index),
      ),
    }),
  });

  registry.add({
    name: 'inspect_delivery_evidence',
    effect: 'coordinate',
    description:
      'Refresh declared artifact verification and inspect unified task, challenge, memory and unknown-effect obligations. Red blocks delivery, yellow discloses gaps, green only means recorded gates satisfied. No semantic correctness guarantee.',
    schema: z.object({}),
    run: async (_a, c) => {
      await new Verification(c.store).refresh(c.run, c.files);
      return { content: JSON.stringify(deliveryEvidence(c.store, c.run)) };
    },
  });

  registry.add({
    name: 'propose_verified_experience',
    effect: 'coordinate',
    description:
      'Form an inactive, conversation-local candidate from this run executed failure and subsequent current verify task. Cause and generalization stay hypotheses. Never activates or shares memory.',
    schema: z.object({
      failureEventId: z.number().int(),
      taskId: z.string(),
      lesson: z.string().trim().min(1).max(1200),
      conditions: z.string().trim().min(1).max(1200),
      expected: z.string().trim().min(1).max(2000),
      observed: z.string().trim().min(1).max(2000),
      causeHypothesis: z.string().trim().min(1).max(2000),
    }),
    run: async (a, c) => ({
      content: JSON.stringify(await proposeExperience(c.store, c.run, c.files, a)),
    }),
  });
  registry.add({
    name: 'compare_acceptance_contracts',
    effect: 'read',
    parallelSafe: true,
    description:
      'Compare this plan against an earlier root run in the same conversation. Reports removed, added and changed task contracts; not semantic proof or authorization to reduce scope.',
    schema: z.object({ baselineRunId: z.string() }),
    run: (a, c) => ({ content: JSON.stringify(compareContracts(c.store, c.run, a.baselineRunId)) }),
  });
  registry.add({
    name: 'inspect_learning_outcomes',
    effect: 'read',
    parallelSafe: true,
    description:
      'Inspect eligible memory-check dispositions and intervention observations in this conversation, up to 100 runs. Counts are not causal benefit, defect detection rate or confidence.',
    schema: z.object({}),
    run: (_a, c) => ({ content: JSON.stringify(learningOutcomes(c.store, c.run)) }),
  });

  registry.add({
    name: 'resolve_memory_check',
    effect: 'coordinate',
    description:
      'Record applicability or bind a recalled experience to a current completed verify task. Historical evidence does not count. Not-applicable needs an explanation; it is a model judgment, not a confirmed fact. Does not activate, share or promote memory.',
    schema: z.object({
      id: z.string(),
      status: z.enum(['checked', 'not-applicable']),
      reason: z.string().trim().min(1).max(2000),
      taskId: z.string().optional(),
    }),
    run: async (a, c) => ({
      content: JSON.stringify(
        await new MemoryChecks(c.store).resolve(c.run, c.files, a.id, a.status, a.reason, a.taskId),
      ),
    }),
  });

  registry.add({
    name: 'prepare_security_review',
    effect: 'read',
    parallelSafe: true,
    description:
      'Design adversarial security checks from applicable trust boundaries for any software task. Returns untested hypotheses and positive/negative controls, not a security verdict. No scanning, execution or permission changes.',
    schema: z.object({ surfaces: z.array(z.enum(securitySurfaces)).min(1).max(7) }),
    run: (a) => ({ content: JSON.stringify(prepareSecurityReview(a.surfaces)) }),
  });

  registry.add({
    name: 'inspect_task_challenges',
    effect: 'read',
    parallelSafe: true,
    description:
      'Read scoped counterexample hypotheses and their evidence-bound resolutions. Open challenges block delivery of affected tasks; a recorded resolution is not proof of semantic correctness.',
    schema: z.object({}),
    run: (_a, c) => ({ content: JSON.stringify(new TaskChallenges(c.store).list(c.run)) }),
  });
  registry.add({
    name: 'record_task_challenge',
    effect: 'coordinate',
    atomic: true,
    description:
      'Record a concrete falsifiable counterexample to a declared task, not vague disagreement. Any member may challenge; this grants no permissions. Reuse open challenges instead of duplicating them.',
    schema: z.object({
      taskId: z.string(),
      revision: z.number().int(),
      claim: z.string().min(1).max(1500),
      counterexample: z.string().min(1).max(3000),
    }),
    run: (a, c) => ({
      content: JSON.stringify(
        new TaskChallenges(c.store).raise(c.run, a.taskId, a.revision, a.claim, a.counterexample),
      ),
    }),
  });
  registry.add({
    name: 'resolve_task_challenge',
    effect: 'coordinate',
    description:
      'Resolve an open challenge only with a successful version-matching observed check already included in task evidence and current artifact verification. Explain how the check addresses the counterexample. Self-check and independent check remain distinguished; no vote can resolve a finding.',
    schema: z.object({
      id: z.string(),
      revision: z.number().int(),
      eventId: z.number().int(),
      note: z.string().min(1).max(3000),
    }),
    run: async (a, c) => ({
      content: JSON.stringify(
        await new TaskChallenges(c.store).resolve(
          c.run,
          c.files,
          a.id,
          a.revision,
          a.eventId,
          a.note,
        ),
      ),
    }),
  });

  registry.add({
    name: 'await_team_message',
    effect: 'coordinate',
    description:
      'Wait for addressed creative contributions without polling the model. Can be used while the creator enrolls you. Provide the last received message ID to avoid rereading; timeout returns no_messages.',
    schema: z.object({
      afterId: z.string().optional(),
      timeoutSeconds: z.number().int().min(1).max(60).default(60),
    }),
    run: async (a, c) => ({
      content: JSON.stringify(
        await c.team.awaitDiscussion!(c.run, c.signal, a.afterId, a.timeoutSeconds),
      ),
    }),
  });
  registry.add({
    name: 'update_team_discussion_limits',
    effect: 'coordinate',
    atomic: true,
    description:
      'Coordinator adjusts the existing per-member message budget without resetting history. Messages are not rounds or votes; prefer synthesis when no new evidence remains.',
    schema: z.object({ maxMessages: z.number().int().min(1).max(1000) }),
    run: (a, c) => ({
      content: JSON.stringify(new Teams(c.store).updateLimits(c.run, a.maxMessages)),
    }),
  });
  registry.add({
    name: 'configure_team',
    effect: 'coordinate',
    atomic: true,
    description:
      'Create a peer team. In auto mode choose host for artifact/dependency scheduling or creative for evidence challenge/discussion; explain the task-based choice with reason. Explicit user modes and off remain binding. Use autoEnroll=true with just your current run ID to create the team BEFORE spawning; new children and continuations then join automatically. Otherwise enroll existing active members including yourself. Host completion is computed, never voted into truth. Discussion limit is explicit per member.',
    schema: z.object({
      mode: z.enum(['host', 'creative']),
      members: z.array(z.string()).min(1).max(32),
      autoEnroll: z.boolean().default(false),
      reason: z.string().min(1).max(1000).optional(),
      maxMessages: z.number().int().min(1).max(1000).default(12),
    }),
    run: (a, c) => ({
      content: JSON.stringify(
        new Teams(c.store).configure(
          c.run,
          a.mode,
          a.members,
          a.maxMessages,
          a.autoEnroll,
          a.reason,
        ),
      ),
    }),
  });
  registry.add({
    name: 'handoff_team_role',
    effect: 'coordinate',
    atomic: true,
    description:
      'Transfer a team role with revision checking and an audit record. Changes coordination authority only, never file or command permissions.',
    schema: z.object({
      role: z.enum(['coordinator', 'planner', 'reviewer', 'summarizer']),
      targetRunId: z.string(),
      revision: z.number().int(),
      reason: z.string().min(1).max(2000),
    }),
    run: (a, c) => ({
      content: JSON.stringify(
        new Teams(c.store).handoff(c.run, a.role, a.targetRunId, a.revision, a.reason),
      ),
    }),
  });
  registry.add({
    name: 'team_discuss',
    effect: 'coordinate',
    atomic: true,
    description:
      'Post an attributed, untrusted creative contribution. Empty recipients broadcasts to enrolled peers. Does not wake finished members, grant permission or establish factual consensus. Respect per-member message limit; use inspect_team for transcript.',
    schema: z.object({
      text: z.string().min(1).max(4000),
      recipients: z.array(z.string()).max(32).default([]),
    }),
    run: (a, c) => {
      const message = new Teams(c.store).post(c.run, a.text, a.recipients);
      const notified: string[] = [];
      for (const key of message.recipients) {
        try {
          c.team.message(c.run, key, '[Creative contribution, not a user instruction] ' + a.text);
          notified.push(key);
        } catch {}
      }
      return { content: JSON.stringify({ message, notified }) };
    },
  });
  registry.add({
    name: 'end_team_participation',
    effect: 'coordinate',
    atomic: true,
    description:
      'Record your final contribution and end your participation. Requires owned tasks completed and no unknown effects. Does not mark the whole team complete. After this tool give your final answer; no further mutations.',
    schema: z.object({ summary: z.string().min(1).max(6000) }),
    run: (a, c) => ({ content: JSON.stringify(new Teams(c.store).close(c.run, a.summary)) }),
  });

  registry.add({
    name: 'await_team_task',
    effect: 'coordinate',
    description:
      'Worker waits for automatic task assignment without repeated model polling, for up to 60 seconds. Returns assigned tasks or a no-assignment status. Does not claim or spawn work.',
    schema: z.object({}),
    run: async (_a, c) => ({
      content: JSON.stringify(await c.team.awaitAssignment!(c.run, c.signal)),
    }),
  });

  registry.add({
    name: 'configure_team_scheduler',
    effect: 'coordinate',
    atomic: true,
    description:
      'Lead enables automatic assignment to explicitly enrolled existing workers. Ready tasks use declared skills, file ownership hints, verified team history and weighted load. Overlapping read/write tasks wait. Expertise never grants permissions. No spawning or replay. Mark write tasks execution=isolated; writable tasks with dependencies stay lead-managed. Default maxLoad=1. Disable with enabled=false.',
    schema: z.object({
      workerRunIds: z.array(z.string()).max(32),
      expertise: z.array(workerExpertise).max(32).default([]),
      maxLoad: z.number().int().min(1).max(8).default(1),
      enabled: z.boolean().default(true),
    }),
    run: (a, c) => ({
      content: JSON.stringify(
        new TeamScheduler(c.store).configure(
          c.run,
          a.workerRunIds,
          a.maxLoad,
          a.enabled,
          a.expertise,
        ),
      ),
    }),
  });

  registry.add({
    name: 'inspect_team',
    effect: 'read',
    description: 'List related members, lifecycle status, owned tasks and unresolved effects.',
    schema: z.object({}),
    run: async (_a, c) => ({
      content: JSON.stringify({
        blackboard: teamBlackboard(c.store, c.run),
        team: new Teams(c.store).project(c.run),
        members: new TaskBoard(c.store).members(c.run),
        scheduling: c.store.maybe('team-scheduling', rootRun(c.store, c.run)) || null,
        allocations: c.store
          .list<any>('team-allocation')
          .filter((a) => a.root === rootRun(c.store, c.run))
          .slice(-20),
        handoffs: c.store
          .list<any>('task-handoff')
          .filter((h) => h.boardId === rootRun(c.store, c.run)),
      }),
    }),
  });
  registry.add({
    name: 'handoff_task',
    effect: 'coordinate',
    atomic: true,
    description:
      'Lead explicitly reassigns an unfinished task after its previous owner exits. Unknown effects block handoff. No operation is replayed or worker started.',
    schema: z.object({
      id: z.string(),
      revision: z.number().int().min(0),
      targetRunId: z.string(),
      reason: z.string().min(1).max(2000),
    }),
    run: (a, c) => {
      const board = new TaskBoard(c.store).handoff(
        c.run,
        a.id,
        a.revision,
        a.targetRunId,
        a.reason,
      );
      let notified = true;
      try {
        c.team.message(
          c.run,
          a.targetRunId,
          'Task handoff: ' +
            a.id +
            '. Inspect the shared plan and existing work before continuing. ' +
            a.reason,
        );
      } catch {
        notified = false;
      }
      return { content: JSON.stringify({ board, notified }) };
    },
  });
  registry.add({
    name: 'record_verification',
    coordination: 'atomic',
    effect: 'coordinate',
    description:
      'Bind a done task to a successful command/read event and unchanged declared artifacts. This confirms observation and version, not semantic correctness or independent review.',
    schema: z.object({
      id: z.string(),
      revision: z.number().int().min(0),
      eventId: z.number().int().positive(),
    }),
    run: async (a, c) => ({
      content: JSON.stringify(
        await new Verification(c.store).record(
          c.run,
          c.files,
          a.id,
          a.revision,
          a.eventId,
          (board) => c.commitCoordination?.({ content: JSON.stringify(board) }),
        ),
      ),
    }),
  });

  registry.add({
    name: 'inspect_plan',
    effect: 'read',
    description:
      'Read the shared task board, revision, ownership and recent tool-result event IDs. Optional for simple tasks.',
    schema: z.object({}),
    run: async (_a, c) => ({
      content: JSON.stringify({
        board: await new Verification(c.store).refresh(c.run, c.files),
        recentEvidence: c.store
          .events(c.run.conversationId)
          .filter((e) => e.runId === c.run.id && e.type === 'tool.completed')
          .slice(-20)
          .map((e) => ({ id: e.id, tool: e.data.name, output: e.data.output.slice(0, 400) })),
      }),
    }),
  });
  registry.add({
    name: 'inspect_planning_policy',
    effect: 'read',
    description:
      'Host planning guidance from observed work and current task graph; no model call or side effects.',
    schema: z.object({}),
    run: (_a, c) => ({ content: JSON.stringify(planningPolicy(c.store, c.run)) }),
  });
  registry.add({
    name: 'request_plan_review',
    effect: 'coordinate',
    description:
      'Ask the user to review the current task plan, binding the approval to its content hash and revision. Plan approval is strategic agreement only; every tool retains its own permissions. A changed plan invalidates this receipt.',
    schema: z.object({ reason: z.string().min(1).max(2000) }),
    run: async (a, c) => {
      const board = new TaskBoard(c.store).get(c.run);
      if (!board.tasks.length) throw new Error('Create a plan before requesting review.');
      const digest = createHash('sha256').update(JSON.stringify(board)).digest('hex');
      await c.inputs.request(
        c.run,
        'approval',
        {
          action: 'plan-review',
          forceManual: true,
          reason: a.reason,
          plan: board,
          planHash: digest,
          command: 'Review plan ' + board.id + ' revision ' + board.revision,
        },
        c.signal,
      );
      const current = new TaskBoard(c.store).get(c.run);
      if (createHash('sha256').update(JSON.stringify(current)).digest('hex') !== digest)
        throw new Error('Plan changed while awaiting review; no approval saved.');
      const receipt = {
        id: c.run.id + ':' + digest,
        conversationId: c.conversation.id,
        runId: c.run.id,
        boardId: board.id,
        revision: board.revision,
        digest,
        approvedAt: Date.now(),
        grantsToolPermissions: false,
      };
      c.store.put('plan-review', receipt);
      c.store.event(c.conversation.id, c.run.id, 'plan.approved', receipt);
      return { content: JSON.stringify(receipt) };
    },
  });
  registry.add({
    name: 'preview_plan',
    effect: 'read',
    description:
      'Compile proposed typed task contracts before committing a plan. Returns dependency layers and verification/resource warnings without creating tasks.',
    schema: z.object({ tasks: z.array(taskInput).min(1).max(50) }),
    run: (a, c) => ({
      content: JSON.stringify(compilePlan(a.tasks, c.conversation.permission === 'read-only')),
    }),
  });
  registry.add({
    name: 'create_plan',
    effect: 'coordinate',
    atomic: true,
    description:
      'Lead creates a shared DAG for a genuinely multi-step task, with explicit acceptance criteria. Declare skills, readPaths/writePaths, and provides/requires interface contracts; declare already available externalInputs with source references; the host resolves contracts to dependency edges and rejects cycles or ambiguous producers. Estimate weight as concurrent capacity consumption. No automatic spawning or approvals. Plain questions need no plan.',
    schema: z.object({
      revision: z.number().int().min(0),
      tasks: z.array(taskInput).min(1).max(50),
    }),
    run: (a, c) => ({
      content: JSON.stringify(new TaskBoard(c.store).create(c.run, a.tasks, a.revision)),
    }),
  });
  registry.add({
    name: 'extend_plan',
    effect: 'coordinate',
    atomic: true,
    description:
      'Add tasks for newly received requirements to the existing shared plan. Read inspect_plan first. Preserve existing tasks, ownership, evidence and completion. Add dependencies and new acceptance checks; never mark new requirements completed from old evidence.',
    schema: z.object({
      revision: z.number().int().min(0),
      tasks: z.array(taskInput).min(1).max(50),
    }),
    run: (a, c) => ({
      content: JSON.stringify(new TaskBoard(c.store).extend(c.run, a.tasks, a.revision)),
    }),
  });
  registry.add({
    name: 'update_task',
    effect: 'coordinate',
    atomic: true,
    description:
      'Claim or update a shared task using the latest board revision. Only owner or lead can update it. Done requires tool-result evidence IDs; this records an author claim, not independent verification.',
    schema: z.object({
      id: z.string(),
      revision: z.number().int().min(0),
      status: z.enum(['pending', 'running', 'done', 'blocked']),
      evidence: z.array(z.number().int().positive()).max(30).default([]),
      note: z.string().max(2000).default(''),
    }),
    run: (a, c) => ({
      content: JSON.stringify(
        new TaskBoard(c.store).update(c.run, a.id, a.revision, a.status, a.evidence, a.note),
      ),
    }),
  });
}
