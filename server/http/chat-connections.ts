import { assert } from '../core/errors.js';
import { id } from '../storage/store.js';
import { remoteConversationStyle } from '../services/chat-style.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ChatConnections } from '../services/chat-connections.js';
export function chatConnectionRoutes(app: FastifyInstance, channels: ChatConnections) {
  app.get('/api/chat-connections', async () => ({
    connections: channels.overview(),
    mediaServices: channels.runtime.media
      .connections()
      .map(({ id, name, kind, estimatedUsd }) => ({ id, name, kind, estimatedUsd })),
  }));
  // Authenticated in-app voice turns. No platform inbox/outbox is created: browser
  // audio must not unexpectedly be posted to a group, nor consume composer drafts.
  app.post<{ Params: { id: string } }>('/api/chat-connections/:id/voice-turn', async (req) => {
    const c = channels.get(req.params.id);
    channels.authorize(c);
    const body = z
      .object({ text: z.string().trim().min(1).max(10000) })
      .strict()
      .parse(req.body);
    assert(
      !channels.runtime.active(c.conversationId),
      'CHAT_BUSY',
      'Conversation is busy; wait before speaking again.',
      409,
    );
    const runId = id();
    channels.store.put('chat-browser-voice', {
      id: runId,
      connectionId: c.id,
      revision: c.revision,
      conversationId: c.conversationId,
    });
    channels.runtime.start(
      c.conversationId,
      remoteConversationStyle +
        '[Authenticated local browser voice turn. Reply naturally in text; the browser reads the final answer aloud. Do not generate a separate speech file or send this reply to a social platform unless explicitly requested. This is alternating browser voice, not a native phone call. Existing permissions apply.]\n' +
        body.text,
      0,
      { runId, attachmentIds: [] },
    );
    return { runId };
  });
  const voiceRun = (connectionId: string, runId: string) => {
    const c = channels.get(connectionId);
    channels.authorize(c);
    const owner = channels.store.get<any>('chat-browser-voice', runId);
    assert(
      owner.connectionId === c.id &&
        owner.conversationId === c.conversationId &&
        owner.revision === c.revision,
      'CHAT_SCOPE',
      'Voice turn belongs to a different or changed connection.',
    );
    const run = channels.store.maybeRunHeader(runId);
    assert(run, 'RUN_NOT_FOUND', 'Voice turn is not available.', 404);
    return run;
  };
  app.get<{ Params: { id: string; runId: string } }>(
    '/api/chat-connections/:id/voice-turn/:runId',
    async (req) => {
      const run = voiceRun(req.params.id, req.params.runId);
      const final = channels.store
        .eventsForRun(run.id, ['assistant.message'])
        .filter((e) => e.data.final && !e.data.incomplete)
        .at(-1);
      return { status: run.status, text: final?.data.text || '' };
    },
  );
  app.post<{ Params: { id: string; runId: string } }>(
    '/api/chat-connections/:id/voice-turn/:runId/stop',
    async (req) => {
      const run = voiceRun(req.params.id, req.params.runId);
      channels.runtime.stop(run.id);
      return { ok: true };
    },
  );
  app.post('/api/chat-connections', async (req) => channels.save(req.body));
  app.put<{ Params: { id: string } }>('/api/chat-connections/:id', async (req) =>
    channels.save(req.body, req.params.id),
  );
  app.post<{ Params: { id: string } }>('/api/chat-connections/:id/pause', async (req) => {
    channels.pause(req.params.id);
    return { ok: true };
  });
  app.delete<{ Params: { id: string } }>('/api/chat-connections/:id', async (req) => {
    channels.remove(req.params.id);
    return { ok: true };
  });
  app.get<{ Params: { id: string } }>('/api/chat-connections/:id/deliveries', async (req) => {
    channels.get(req.params.id);
    return channels.store.db
      .prepare(
        "SELECT id,state,text,created_at FROM chat_outbox WHERE connection_id=? AND state IN ('uncertain','failed') ORDER BY created_at LIMIT 20",
      )
      .all(req.params.id);
  });
  app.post<{ Params: { id: string } }>('/api/chat-connections/:id/delivery', async (req) => {
    channels.get(req.params.id);
    const body = z
      .object({ id: z.string().max(200), decision: z.enum(['retry', 'dismiss']) })
      .strict()
      .parse(req.body);
    channels.store.db
      .prepare(
        "UPDATE chat_outbox SET state=?,attempts=0,retry_at=0 WHERE id=? AND connection_id=? AND state IN ('uncertain','failed')",
      )
      .run(body.decision === 'retry' ? 'pending' : 'cancelled', body.id, req.params.id);
    return { ok: true };
  });
}
