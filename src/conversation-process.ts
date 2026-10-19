import type { AgentEvent } from '../shared/types';
/** Only known successful delivery folds; legacy/partial/error records stay visible. */
export function collapsibleProcess(events: AgentEvent[], runs: { id: string; status: string }[]) {
  const completed = new Set(runs.filter((r) => r.status === 'completed').map((r) => r.id));
  const finals = new Map<string, number>();
  for (const e of events)
    if (
      e.runId &&
      completed.has(e.runId) &&
      e.type === 'assistant.message' &&
      e.data.final === true &&
      !e.data.incomplete
    )
      finals.set(e.runId, e.id);
  return new Set(
    events
      .filter(
        (e) =>
          e.runId &&
          finals.has(e.runId) &&
          e.id < finals.get(e.runId)! &&
          ((e.type === 'assistant.message' && !e.data.incomplete) ||
            [
              'tool.started',
              'tool.completed',
              'model.started',
              'command.background',
              'command.progress',
              'command.yielded',
              'context.compacting',
              'context.compacted',
              'child.started',
              'model.protocol-repair',
              'model.reconnecting',
              'cognitive.intervention',
            ].includes(e.type)) &&
          !(
            e.type === 'tool.completed' &&
            e.data.outcome &&
            !['succeeded', 'not-needed'].includes(e.data.outcome.status)
          ),
      )
      .map((e) => e.id),
  );
}
