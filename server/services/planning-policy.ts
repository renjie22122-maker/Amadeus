import { Store } from '../storage/store.js';
import type { Run } from '../../shared/types.js';
import { TaskBoard } from './task-board.js';
export function planningPolicy(store: Store, run: Run) {
  const board = new TaskBoard(store).get(run);
  const events = store
    .events(run.conversationId)
    .filter((e) => e.runId === run.id && e.type === 'tool.started');
  const paths = new Set(
    events
      .filter((e) => ['write_file', 'edit_file'].includes(e.data.name))
      .map((e) => e.data.arguments?.path)
      .filter(Boolean),
  );
  const delegated = events.filter((e) => e.data.name === 'spawn_agent').length;
  const reasons = [
    ...(paths.size >= 3 ? ['Write attempts involve at least three file paths'] : []),
    ...(delegated >= 2 ? ['Multiple workers need explicit dependencies'] : []),
  ];
  return {
    version: 1,
    mode: board.tasks.length ? 'planned' : reasons.length ? 'plan-recommended' : 'direct',
    reasons,
    observedFiles: paths.size,
    delegations: delegated,
    planningRequired: false,
    guidance:
      'For underspecified work first discover update_problem_frame: separate requirements, assumptions, hypotheses and observed evidence before selecting changes. For complex work propose typed tasks with contracts, preview_plan, then create_plan. Reassess after new requirements. Simple answers need no plan. Classification is evidence-based guidance, not a semantic oracle or permission grant.',
  };
}
