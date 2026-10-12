import type { FastifyInstance } from 'fastify';
import type { Attachment, Conversation } from '../../shared/types.js';
import type { Runtime } from '../core/runtime.js';
import { assert } from '../core/errors.js';
import { Teams } from '../services/team-space.js';
import { rootRun, TaskBoard } from '../services/task-board.js';
export function conversationViewRoutes(app: FastifyInstance, runtime: Runtime) {
  const store = runtime.store;
  app.get<{ Params: { id: string }; Querystring: { runId?: string; after?: string } }>(
    '/api/conversations/:id',
    async (req) => {
      const after = Number(req.query.after || 0);
      assert(
        Number.isSafeInteger(after) && after >= 0,
        'EVENT_CURSOR',
        'Invalid event cursor.',
        400,
      );
      const c = store.get<Conversation>('conversation', req.params.id);
      const history = store.runMetadata(c.id);
      const latest = req.query.runId
        ? history.find((r) => r.id === req.query.runId)
        : history.at(-1);
      assert(!req.query.runId || latest, 'RUN_SCOPE', 'Run does not belong to this conversation.');
      const deliveries = new Map(
        store.forConversation<any>('user-inbox', c.id).map((m) => [Number(m.id), m.state]),
      );
      const boardService = new TaskBoard(store);
      const taskBoard = latest ? boardService.get(latest) : null;
      const members = latest ? boardService.members(latest) : [];
      return {
        conversation: c,
        deliveries: Object.fromEntries(deliveries),
        events: store
          .events(c.id, after)
          .map((e) =>
            e.type === 'user.message' && deliveries.has(e.id)
              ? { ...e, data: { ...e.data, delivery: deliveries.get(e.id) } }
              : e,
          ),
        inputs: store.forConversation<any>('input', c.id),
        attachments: store
          .forConversation<Attachment>('attachment', c.id)
          .map(({ path, text, ...a }) => a),
        teamAutomation: latest ? store.maybe('team-automation', rootRun(store, latest!)) : null,
        teamRecovery: latest
          ? (new Teams(store).get(latest!)?.members || []).map((key) =>
              runtime.teamAutomation.plan(store.runHeader(key)),
            )
          : [],
        teamControlEvents: latest
          ? store
              .list<any>('team-control-event')
              .filter((e) => e.root === rootRun(store, latest!))
              .slice(-20)
          : [],
        teamSpace: latest ? new Teams(store).project(latest!) : null,
        teamMembers: members,
        teamScheduling: latest
          ? {
              ...(store.maybe<any>('team-scheduling', rootRun(store, latest!)) || {}),
              blocked:
                store.maybe<any>('team-scheduler-diagnostics', rootRun(store, latest!))?.blocked ||
                [],
              loads: members.map((m) => ({
                runId: m.runId,
                load: taskBoard!.tasks
                  .filter((t) => t.owner === m.runId && ['running', 'blocked'].includes(t.status))
                  .reduce((n, t) => n + (t.weight || 1), 0),
              })),
            }
          : null,
        taskBoard,
        unknownEffects: store.unknownEffects(c.id),
        streams: [...runtime.streams.entries()]
          .filter(([, v]) => v.conversationId === c.id)
          .map(([runId, v]) => ({ runId, ...v })),
      };
    },
  );
}
