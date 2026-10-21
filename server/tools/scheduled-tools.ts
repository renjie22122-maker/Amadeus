import { currentChat } from '../services/chat-interaction.js';
import { z } from 'zod';
import { scheduleFields, type ScheduledWork } from '../services/scheduled-work.js';
import { id } from '../storage/store.js';
import { assert } from '../core/errors.js';
import type { ToolRegistry } from './registry.js';
const text = (value: unknown) => ({ content: JSON.stringify(value) });
// Remote scheduling is controller-managed; normal group members gain no scheduling authority.
function remoteRoute(c: any) {
  const hasInbox = c.store.db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_inbox'")
    .get();
  const row =
    hasInbox &&
    c.store.db
      .prepare("SELECT 1 FROM chat_inbox WHERE run_id=? AND state IN ('dispatching','running')")
      .get(c.run.id);
  if (!row) {
    assert(
      !c.conversation.remoteChatOnly,
      'CHAT_SCOPE',
      'Remote scheduling requires a current chat origin.',
    );
    return undefined;
  }
  const { c: connection, currentSenderId } = currentChat(c.store, c.conversation.id, c.run.id);
  assert(
    currentSenderId === connection.senderId,
    'CHAT_CONTROLLER',
    'Only the bound controller may manage remote follow-ups.',
  );
  return { connectionId: connection.id, revision: connection.revision, senderId: currentSenderId };
}
export function installScheduledTools(registry: ToolRegistry) {
  registry.add({
    name: 'inspect_schedules',
    effect: 'read',
    parallelSafe: true,
    description:
      'Inspect durable follow-ups in this conversation before creating duplicates or claiming future wake-up is unavailable. Does not run tasks or change permissions.',
    schema: z.object({}),
    run: (_a, c) => {
      const route = remoteRoute(c);
      return text({
        schedules: c.store
          .list<ScheduledWork>('scheduled-work')
          .filter((t) => t.conversationId === c.conversation.id),
        capabilities: {
          once: true,
          repeated: true,
          afterBackgroundCommand: !route,
          requiresRunningService: true,
          notifications: route ? 'original-remote-chat-and-in-app' : 'in-app',
          approvalRequired: true,
        },
        guidance:
          'Use schedule_followup for authorized future model work, optionally jobId for command completion. Technical checks do not replace semantic review. The service and computer must stay running; no wake from sleep or email notification is implied.',
      });
    },
  });
  registry.add({
    name: 'pause_scheduled_followup',
    effect: 'coordinate',
    description:
      'Pause future launches of a schedule in this conversation when no longer needed or requested. Does not interrupt an already running task, replay operations, or re-enable a schedule.',
    schema: z.object({ id: z.string() }),
    run: (a, c) => {
      remoteRoute(c);
      const task = c.store.get<ScheduledWork>('scheduled-work', a.id);
      assert(
        task.conversationId === c.conversation.id,
        'SCOPE',
        'Schedule belongs to another conversation.',
      );
      return text(
        c.store.put('scheduled-work', {
          ...task,
          enabled: false,
          status: task.runId ? task.status : 'paused',
        }),
      );
    },
  });
  registry.add({
    name: 'schedule_followup',
    effect: 'write',
    description:
      'Schedule a requested follow-up, once or repeatedly, in this chat or a new chat per run. Configure notifications and optionally wait for a background command. Requires confirmation. The service automatically starts a model turn without another user message while the computer/service stay running. Use jobId to review completed outputs before downstream work; maxRuns/endAt bound future launches. Preserves current permissions, and never replays unknown effects. Remote controller requests deliver back to this exact group/private chat; repeated remote follow-ups require a bounded duration/count, at least 15-minute intervals and a clear purpose (including consensual social check-ins). Agree on timing and quiet hours when needed; do not create unsolicited schedules.',
    schema: scheduleFields,
    run: async (a, c) => {
      const route = remoteRoute(c);
      if (route) {
        assert(
          a.destination !== 'new-chat' && !a.jobId,
          'CHAT_SCOPE',
          'Remote follow-ups stay in this chat and cannot watch host commands.',
        );
        assert(
          !a.intervalMs || (a.intervalMs >= 900000 && !!(a.maxRuns || a.endAt)),
          'CHAT_SCHEDULE_LIMIT',
          'Repeated remote follow-ups need an interval of at least 15 minutes and maxRuns or endAt.',
        );
      }
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
      assert(
        JSON.stringify(remoteRoute(c)) === JSON.stringify(route),
        'CHAT_SCOPE',
        'Chat binding changed during approval.',
      );
      const profile = c.config.profile(c.conversation.profileId);
      const task = c.store.put('scheduled-work', {
        id: id(),
        conversationId: c.conversation.id,
        ...a,
        ...(route ? { remoteDelivery: route, notifications: a.notifications || 'meaningful' } : {}),
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
