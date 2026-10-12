import type { AgentEvent } from '../shared/types';
/** Durable cursor comes from HTTP snapshots, never from potentially gapped SSE. */
export function mergeConversationEvents(
  previous: AgentEvent[],
  incoming: AgentEvent[],
  deliveries: Record<string, string> = {},
) {
  const events = new Map(previous.map((e) => [e.id, e]));
  for (const e of incoming) events.set(e.id, e);
  return [...events.values()]
    .sort((a, b) => a.id - b.id)
    .map((e) =>
      e.type === 'user.message' && deliveries[e.id] !== undefined
        ? { ...e, data: { ...e.data, delivery: deliveries[e.id] } }
        : e,
    );
}
