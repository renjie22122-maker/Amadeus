import { Store, id } from '../storage/store.js';
import { terminal } from '../core/lifecycle.js';
import type { Conversation } from '../../shared/types.js';
import { z } from 'zod';
export const scheduleFields = z.object({
  name: z.string().trim().max(120).optional(),
  prompt: z.string().trim().min(1).max(10000),
  dueAt: z.number().int().nonnegative().max(8640000000000000),
  intervalMs: z
    .number()
    .int()
    .min(60000)
    .max(366 * 86400000)
    .nullable()
    .optional(),
  maxRuns: z.number().int().min(1).max(10000).nullable().optional(),
  endAt: z.number().int().nonnegative().max(8640000000000000).nullable().optional(),
  jobId: z.string().nullable().optional(),
  destination: z.enum(['same-chat', 'new-chat']).optional(),
  notifications: z.enum(['all', 'meaningful', 'failures', 'off']).optional(),
});
export interface ScheduledWork {
  id: string;
  conversationId: string;
  name?: string;
  prompt: string;
  enabled: boolean;
  dueAt: number;
  intervalMs?: number | null;
  jobId?: string | null;
  destination?: 'same-chat' | 'new-chat';
  notifications?: 'all' | 'meaningful' | 'failures' | 'off';
  status: string;
  runId?: string;
  lastRunId?: string;
  error?: string;
  target?: string;
  runConversationId?: string;
  startedAt?: number;
  maxRuns?: number | null;
  endAt?: number | null;
  dispatchCount?: number;
}
export class ScheduledWorkService {
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    private store: Store,
    private runtime: any,
  ) {}
  start() {
    this.timer = setInterval(() => this.tick(), 5000);
    this.timer.unref();
  }
  close() {
    clearInterval(this.timer);
  }
  private record(task: ScheduledWork, status: string, now: number, error?: string) {
    const key = task.id + ':' + (task.runId || 'blocked:' + task.dueAt);
    if (this.store.maybe('schedule-result', key)) return;
    const report = task.runId ? this.store.maybe<any>('schedule-report', task.runId) : undefined;
    this.store.put('schedule-result', {
      id: key,
      scheduleId: task.id,
      name: task.name || task.prompt.slice(0, 80),
      conversationId: task.runConversationId || task.conversationId,
      runId: task.runId,
      startedAt: task.startedAt,
      finishedAt: now,
      status,
      error,
      summary: report?.summary,
      outcome: report?.outcome,
      unread:
        !(
          task.notifications === 'meaningful' &&
          status === 'completed' &&
          report?.outcome === 'unchanged'
        ) &&
        task.notifications !== 'off' &&
        (task.notifications !== 'failures' || status !== 'completed'),
    });
  }
  tick(now = Date.now()) {
    for (let task of this.store.list<ScheduledWork>('scheduled-work')) {
      if (!task.enabled && (!task.runId || task.status === 'needs_attention')) continue;
      try {
        // Settle dispatched work even while paused; never dispatch again while paused.
        if (task.runId) {
          const run = this.store.maybeRunHeader(task.runId);
          if (run && !terminal(run.status)) continue;
          if (run) {
            this.record(task, run.status, now);
            if (run.status !== 'completed')
              throw Error(
                'Scheduled run ' + run.status + '; inspect its conversation before resuming.',
              );
            const stop = this.store.maybe<any>('schedule-report', run.id)?.outcome === 'complete';
            this.store.put('scheduled-work', {
              ...task,
              lastRunId: run.id,
              runId: undefined,
              runConversationId: undefined,
              startedAt: undefined,
              enabled: task.enabled && !!task.intervalMs && !stop,
              status: !task.enabled ? 'paused' : task.intervalMs && !stop ? 'waiting' : 'completed',
              // Fixed interval, aligned to the initial due time. Missed slots coalesce.
              dueAt: task.intervalMs
                ? task.dueAt +
                  Math.max(1, Math.floor((now - task.dueAt) / task.intervalMs) + 1) *
                    task.intervalMs
                : task.dueAt,
            });
            continue;
          }
        }
        if (!task.enabled) continue;
        if (
          !task.runId &&
          ((task.maxRuns && (task.dispatchCount || 0) >= task.maxRuns) ||
            (task.endAt != null && now >= task.endAt))
        ) {
          this.store.put('scheduled-work', { ...task, enabled: false, status: 'limit_reached' });
          this.record(
            task,
            'limit_reached',
            now,
            'Schedule launch limit reached; unfinished work is not verified complete.',
          );
          continue;
        }
        const c = this.store.get<Conversation>('conversation', task.conversationId);
        if (
          c.archived ||
          c.parentId ||
          c.isolationId ||
          (c.projectId &&
            (!this.store.maybe<any>('project', c.projectId) ||
              this.store.get<any>('project', c.projectId).removedAt))
        )
          throw Error('Choose an available top-level conversation and project.');
        const profile = this.runtime.config.profile(c.profileId);
        if (
          task.target &&
          task.target !== JSON.stringify([profile.id, profile.baseUrl, c.projectId])
        )
          throw Error('Model destination or project changed; re-enable this schedule explicitly.');
        if (task.dueAt > now || this.runtime.active(c.id)) continue;
        if (task.jobId) {
          const job = this.store.maybe<any>('command-job', task.jobId);
          if (!job || job.conversationId !== c.id)
            throw Error('Trigger job missing or outside conversation.');
          if (['failed', 'cancelled', 'denied', 'unknown'].includes(job.status))
            throw Error('Trigger job ' + job.status + '; do not replay it.');
          if (job.status !== 'completed') continue;
        }
        if (this.store.unknownEffects(c.id).length)
          throw Error('Uncertain side effects require inspection; automatic replay refused.');
        const runId = task.runId || id();
        const chatId = task.runConversationId || (task.destination === 'new-chat' ? id() : c.id);
        // Persist destination before creation/dispatch, so restart reuses exactly this chat/run.
        task = {
          ...task,
          runId,
          runConversationId: chatId,
          startedAt: task.startedAt || now,
          dispatchCount: (task.dispatchCount || 0) + (task.runId ? 0 : 1),
          status: 'dispatching',
        };
        this.store.put('scheduled-work', task);
        if (chatId !== c.id && !this.store.maybe('conversation', chatId)) {
          this.store.put('conversation', {
            ...c,
            id: chatId,
            title: (task.name || task.prompt).slice(0, 100),
            parentId: null,
            forkEvent: null,
            pinned: false,
            archived: false,
            createdAt: now,
            updatedAt: now,
          });
        }
        if (this.runtime.active(chatId)) continue;
        this.runtime.start(
          chatId,
          task.prompt +
            '\n\n[Scheduled task] Before finishing, use report_scheduled_result to report unchanged, update, or complete with a short summary. Choose complete only when the requested monitoring/follow-up is finished; it stops future runs. Missing reports still notify. Existing permissions apply.',
          0,
          { runId },
        );
        this.store.put('scheduled-work', { ...task, status: 'running' });
      } catch (e: any) {
        const error = String(e.message || e);
        this.record(task, 'needs_attention', now, error);
        this.store.put('scheduled-work', {
          ...this.store.get<ScheduledWork>('scheduled-work', task.id),
          enabled: false,
          status: 'needs_attention',
          error,
        });
      }
    }
  }
}
