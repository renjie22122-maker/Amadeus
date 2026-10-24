import type { ModelMessage } from '../../shared/types.js';

const replaceable = new Set<ModelMessage['contextKind']>([
  'runtime-snapshot',
  'task-snapshot',
  'workflow-guidance',
]);
export const isContextSnapshot = (message: ModelMessage) => replaceable.has(message.contextKind);

// Only host projections are replaceable. User requests, tool results, advice and
// trust/source ledgers must retain their own history and protection semantics.
export function latestContextSnapshots(messages: ModelMessage[], task?: ModelMessage) {
  const latest = new Map<ModelMessage['contextKind'], ModelMessage>();
  for (const message of [...messages, ...(task ? [task] : [])]) {
    if (!isContextSnapshot(message)) continue;
    latest.delete(message.contextKind);
    latest.set(message.contextKind, message);
  }
  return [...latest.values()];
}
