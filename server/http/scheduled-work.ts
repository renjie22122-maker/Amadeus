import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Store, id } from '../storage/store.js';
import { assert } from '../core/errors.js';
import { terminal } from '../core/lifecycle.js';
import { scheduleFields, type ScheduledWork } from '../services/scheduled-work.js';
export function scheduledWorkRoutes(app: FastifyInstance, store: Store, config: any) {
  const validate = (d: ScheduledWork) => {
    const c = store.get<any>('conversation', d.conversationId);
    assert(
      !c.archived && !c.parentId && !c.isolationId,
      'SCOPE',
      'Choose an available top-level conversation.',
    );
    if (c.projectId)
      assert(
        !store.get<any>('project', c.projectId).removedAt,
        'SCOPE',
        'Restore the project first.',
      );
    if (d.jobId)
      assert(
        store.get<any>('command-job', d.jobId).conversationId === c.id,
        'SCOPE',
        'Choose a job in this conversation.',
      );
    const p = config.profile(c.profileId);
    return JSON.stringify([p.id, p.baseUrl, c.projectId]);
  };
  app.post('/api/scheduled-work', async (req) => {
    const d = scheduleFields.extend({ conversationId: z.string() }).parse(req.body);
    const task: ScheduledWork = { ...d, id: id(), enabled: true, status: 'waiting' };
    return store.put('scheduled-work', { ...task, target: validate(task) });
  });
  app.patch<{ Params: { id: string } }>('/api/scheduled-work/:id', async (req) => {
    const d = scheduleFields
      .partial()
      .extend({ enabled: z.boolean().optional() })
      .strict()
      .parse(req.body);
    const old = store.get<ScheduledWork>('scheduled-work', req.params.id);
    assert(
      !old.runId || Object.keys(d).every((k) => k === 'enabled'),
      'RUN_ACTIVE',
      'Pause or wait for the dispatched run before editing.',
      409,
    );
    if (d.enabled && old.runId) {
      const run = store.maybe<any>('run', old.runId);
      assert(
        !run || !terminal(run.status) || run.status === 'completed',
        'REVIEW_RUN',
        'Inspect the interrupted run and create a fresh schedule; it will not be replayed.',
      );
    }
    const next = { ...old, ...d };
    const target = validate(next);
    return store.put('scheduled-work', {
      ...next,
      error: undefined,
      status: old.runId ? old.status : next.enabled ? 'waiting' : 'paused',
      target,
    });
  });
  app.delete<{ Params: { id: string } }>('/api/scheduled-work/:id', async (req) => {
    const task = store.get<ScheduledWork>('scheduled-work', req.params.id);
    const run = task.runId ? store.maybe<any>('run', task.runId) : undefined;
    assert(
      !run || terminal(run.status),
      'RUN_ACTIVE',
      'Pause and wait for the dispatched run to finish before removing its schedule.',
      409,
    );
    store.remove('scheduled-work', req.params.id);
    return { ok: true };
  });
  app.get('/api/schedule-notifications', async () =>
    store
      .list<any>('schedule-result')
      .filter((r) => r.unread)
      .sort((a, b) => b.finishedAt - a.finishedAt)
      .slice(0, 40),
  );
  app.get('/api/schedule-results', async () =>
    store.list<any>('schedule-result').sort((a, b) => b.finishedAt - a.finishedAt),
  );
  app.patch<{ Params: { id: string } }>('/api/schedule-results/:id', async (req) => {
    const r = store.get<any>('schedule-result', req.params.id);
    return store.put('schedule-result', { ...r, unread: false });
  });
}
