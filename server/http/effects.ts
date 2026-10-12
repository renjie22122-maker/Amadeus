import type { FastifyInstance } from 'fastify';
import type { Runtime } from '../core/runtime.js';
import type { Store } from '../storage/store.js';
import { z } from 'zod';
import { assert } from '../core/errors.js';
export function effectRoutes(app: FastifyInstance, store: Store, runtime: Runtime) {
  app.post<{ Params: { id: string } }>('/api/effects/:id/allow-retry', async (req) => {
    const effect = store.db
      .prepare("SELECT * FROM effects WHERE id=? AND state='started'")
      .get(req.params.id) as any;
    assert(effect, 'EFFECT_NOT_PENDING', 'Operation is no longer awaiting a decision.', 409);
    const run = store.get<any>('run', effect.run_id);
    assert(
      !runtime.active(run.conversationId),
      'RUN_ACTIVE',
      'Wait for the active run to finish.',
      409,
    );
    store.endEffect(
      effect.id,
      'User explicitly permits another attempt. Prior outcome remains unknown; no command was replayed by this action.',
      'retry_authorized',
    );
    store.event(run.conversationId, run.id, 'effect.retry-authorized', {
      effectId: effect.id,
      tool: effect.tool,
      args: JSON.parse(effect.args),
    });
    return { ok: true, executed: false };
  });
  app.post<{ Params: { id: string } }>('/api/effects/:id/resolve', async (req) => {
    const { note } = z.object({ note: z.string().trim().min(5).max(4000) }).parse(req.body);
    const effect = store.db
      .prepare("SELECT * FROM effects WHERE id=? AND state='started'")
      .get(req.params.id) as any;
    assert(effect, 'EFFECT_NOT_PENDING', 'Operation is no longer awaiting a decision.', 409);
    const run = store.get<any>('run', effect.run_id);
    assert(
      !runtime.active(run.conversationId),
      'RUN_ACTIVE',
      'Wait for active execution before attesting its outcome.',
      409,
    );
    store.transaction(() => {
      store.resolveEffect(req.params.id, note);
      store.event(run.conversationId, run.id, 'effect.user-attested', {
        effectId: effect.id,
        note,
        replayed: false,
        verifiedByHost: false,
      });
    });
    return { ok: true };
  });
}
