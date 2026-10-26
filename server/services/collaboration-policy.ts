import type { ToolContext } from '../tools/registry.js';
import { TaskBoard, rootRun, type BoardTask } from './task-board.js';
import { capabilityDecision } from './capability-kernel.js';
import { delegationModels } from './delegation-models.js';
import { resourceConflict } from './task-routing.js';

/** Advisory only: concrete dependency/resource facts, never keyword-based auto-spawning. */
export function collaborationPolicy(
  ctx: ToolContext,
  tasks = new TaskBoard(ctx.store).get(ctx.run).tasks,
) {
  const settings = ctx.config.get();
  const admission = capabilityDecision(ctx, 'spawn_agent', 'coordinate');
  const root = rootRun(ctx.store, ctx.run);
  const counts = ctx.store.db
    .prepare(
      `WITH RECURSIVE tree(id) AS (
    SELECT ? UNION SELECT r.id FROM run_metadata r JOIN tree t
    ON json_extract(r.data,'$.parentRunId')=t.id
  ) SELECT count(*) AS children FROM tree JOIN run_metadata r ON r.id=tree.id WHERE r.id != ? AND coalesce(json_extract(r.data,'$.status'),'unknown') NOT IN ('completed','failed','interrupted')`,
    )
    .get(root, root) as { children: number };
  const remaining =
    settings.maxChildren === 0 ? null : Math.max(0, settings.maxChildren - counts.children);
  const defaultModel =
    ctx.conversation.subagentModels?.defaultProfileId || ctx.conversation.profileId;
  const reasons = [
    ...(!admission.allowed ? [admission.reason] : []),
    ...(ctx.run.depth >= settings.maxAgentDepth ? ['depth-limit'] : []),
    ...(remaining === 0 ? ['child-limit'] : []),
    ...(!delegationModels(ctx.conversation, settings.profiles).some((p) => p.id === defaultModel)
      ? ['default-model-unavailable']
      : []),
  ];
  const ready = tasks.filter(
    (t) =>
      t.status === 'pending' &&
      !t.owner &&
      t.dependsOn.every((id) => tasks.some((d) => d.id === id && d.status === 'done')),
  );
  const independent: BoardTask[] = [];
  for (const task of ready)
    if (!independent.some((t) => resourceConflict(t, task))) independent.push(task);
  return {
    mode: ctx.conversation.teamStrategy || 'auto',
    eligible: !reasons.length,
    blockers: reasons,
    remainingChildExecutions: remaining, // Compatibility alias; active slots, not lifetime executions.
    remainingActiveChildren: remaining,
    activeChildren: counts.children,
    modelConcurrencyLimit: settings.maxParallelRuns,
    readyTaskIds: ready.map((t) => t.id),
    independentReadyTaskIds: independent.map((t) => t.id),
    recommendation: reasons.length
      ? 'stay-local-or-resolve-blocker'
      : independent.length > 1
        ? 'consider-bounded-delegation'
        : 'assess-task-decomposition',
    meaning:
      'Snapshot, not a slot reservation or semantic proof of independence. Zero concurrency and null remaining slots mean unlimited; approval and spawn gates still apply. Completed children release capacity; continuations have no cumulative execution quota. A single model slot may serialize workers.',
    guidance:
      'For substantive multi-source research, compare the value of independent question/source/method investigations before doing all searches serially. Delegate bounded independent work when it reduces latency or adds a distinct check; keep synthesis and an independent strand with the lead. Give question, scope, source/date requirements, exclusions, stop condition and cited deliverable. Workers return URLs/document IDs, direct evidence, uncertainty and source overlap, not copied search summaries. Do not split a simple lookup or a sequential evidence chain, duplicate the same search, spawn just to wait, or equate agent count with source independence. Ordinary workers need no team; use a team only for real ongoing shared decisions. No required roster or fixed number of agents.',
  };
}
