import { z } from 'zod';
import { scheduleFields, type ScheduledWork } from '../services/scheduled-work.js';
import { id } from '../storage/store.js';
import { assert } from '../core/errors.js';
import type { ToolRegistry } from './registry.js';
const text = (value: unknown) => ({ content: JSON.stringify(value) });
export function installScheduledTools(registry: ToolRegistry) {
  registry.add({
    name: 'schedule_followup',
    effect: 'write',
    description:
      'Schedule a requested follow-up, once or repeatedly, in this chat or a new chat per run. Configure notifications and optionally wait for a background command. Requires confirmation, preserves current permissions, and never replays unknown effects.',
    schema: scheduleFields,
    run: async (a, c) => {
      assert(
        !c.conversation.archived && !c.conversation.parentId && !c.conversation.isolationId,
        'SCOPE',
        'Choose an available top-level conversation.',
      );
      if (a.jobId)
        assert(
          c.store.get<any>('command-job', a.jobId).conversationId === c.conversation.id,
          'SCOPE',
          'Trigger must belong to this conversation.',
        );
      await c.inputs.request(
        c.run,
        'approval',
        { reason: 'Schedule future model work (uses quota)', ...a },
        c.signal,
      );
      const profile = c.config.profile(c.conversation.profileId);
      const task = c.store.put('scheduled-work', {
        id: id(),
        conversationId: c.conversation.id,
        ...a,
        enabled: true,
        status: 'waiting',
        target: JSON.stringify([profile.id, profile.baseUrl, c.conversation.projectId]),
      });
      return text(task);
    },
  });
  registry.add({
    name: 'report_scheduled_result',
    effect: 'coordinate',
    description:
      'Report the outcome of this scheduled run only. unchanged suppresses meaningful-only notifications; update notifies; complete stops future repeats after this run succeeds. This is a model report, not independent verification. Never use complete while the requested follow-up remains pending.',
    schema: z.object({
      outcome: z.enum(['unchanged', 'update', 'complete']),
      summary: z.string().trim().min(1).max(2000),
    }),
    run: async (a, c) => {
      const task = c.store
        .list<ScheduledWork>('scheduled-work')
        .find(
          (t) =>
            t.runId === c.run.id && (t.runConversationId || t.conversationId) === c.conversation.id,
        );
      assert(task, 'SCOPE', 'Only the active scheduled run can report its result.');
      return text(c.store.put('schedule-report', { id: c.run.id, scheduleId: task.id, ...a }));
    },
  });
}
