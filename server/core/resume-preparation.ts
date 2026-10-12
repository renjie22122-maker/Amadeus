import type { Run } from '../../shared/types.js';
import type { Store } from '../storage/store.js';
import type { FileScope } from '../services/paths.js';
import { inspectEffects } from '../services/recovery.js';
/** Resume preparation never replays incomplete tool calls. */
export async function prepareResume(store: Store, run: Run, files: FileScope) {
  if (run.recoveryOnly) {
    const inspection = await inspectEffects(store, files, run.conversationId);
    run.recoveryOnly = inspection.unresolved.length > 0;
    store.put('run', run);
    store.event(run.conversationId, run.id, 'recovery.inspected', inspection);
  }
  for (const message of run.checkpoints.filter((m) => m.role === 'assistant' && m.calls?.length))
    for (const call of message.calls || [])
      if (!run.checkpoints.some((t) => t.role === 'tool' && t.callId === call.id))
        run.checkpoints.push({
          role: 'tool',
          callId: call.id,
          content:
            'Interrupted before a durable result. Do not assume success or repeat an unknown effect.',
        });
}
