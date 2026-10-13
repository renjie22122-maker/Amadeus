import type { Conversation } from '../../shared/types.js';
import type { ToolContext } from './registry.js';
import { executionSettings } from '../../shared/execution.js';
import { NotStartedError } from '../core/errors.js';
/** Revalidate authority after an in-tool approval; the outer registry check preceded that wait. */
export function approvalSnapshot(c: ToolContext) {
  const signature = () => {
    const current =
      c.store.maybe<Conversation>('conversation', c.conversation.id) ?? c.conversation;
    return JSON.stringify([
      current.permission,
      current.projectId,
      current.isolationId,
      current.allowedTools,
      executionSettings(c.config.get(), current),
      !!c.run.recoveryOnly,
    ]);
  };
  const initial = signature();
  return () => {
    c.signal.throwIfAborted();
    if (signature() !== initial)
      throw new NotStartedError(
        'CAPABILITY_CHANGED',
        'Permissions or execution scope changed while approval was pending. Request again.',
      );
  };
}
