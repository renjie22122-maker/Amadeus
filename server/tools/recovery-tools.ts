import { z } from 'zod';
import { assert } from '../core/errors.js';
import type { Run } from '../../shared/types.js';
import { inspectEffects } from '../services/recovery.js';
import type { ToolRegistry } from './registry.js';
const text = (value: unknown) => ({ content: JSON.stringify(value) });
export function installRecovery(registry: ToolRegistry) {
  registry.add({
    name: 'resolve_effect',
    description:
      'Ask the user to confirm a known outcome for an interrupted operation in this conversation. Supply concrete inspection evidence. Does not replay or authorize retry.',
    effect: 'coordinate',
    schema: z.object({ effectId: z.string(), evidence: z.string().min(10).max(4000) }),
    run: async (a, c) => {
      const effect = c.store.db
        .prepare('SELECT run_id,state FROM effects WHERE id=?')
        .get(a.effectId) as any;
      assert(
        effect &&
          effect.state === 'started' &&
          c.store.get<Run>('run', effect.run_id).conversationId === c.conversation.id,
        'EFFECT_SCOPE',
        'Choose an unresolved effect in this conversation.',
      );
      const inspection = await inspectEffects(c.store, c.files, c.conversation.id);
      if (inspection.resolved.includes(a.effectId))
        return text({ resolved: true, automatic: true, retryAuthorized: false });
      await c.inputs.request(
        c.run,
        'approval',
        {
          action: 'resolve-effect',
          effectId: a.effectId,
          evidence: a.evidence,
          reason: 'Confirm the inspected outcome; this does not retry execution.',
        },
        c.signal,
      );
      c.store.resolveEffect(a.effectId, a.evidence);
      return text({ resolved: true, retryAuthorized: false });
    },
  });
  registry.add({
    name: 'inspect_operations',
    description:
      'Read-only reconciliation of uncertain operations. Checks exact file postimages and host-bound command/media receipts. Unsupported non-idempotent effects require external inspection. Never reruns commands; returns remaining unknown outcomes.',
    effect: 'read',
    schema: z.object({}),
    run: async (_a, c) => text(await inspectEffects(c.store, c.files, c.conversation.id)),
  });
}
