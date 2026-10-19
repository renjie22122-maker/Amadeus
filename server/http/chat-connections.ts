import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ChatConnections } from '../services/chat-connections.js';
export function chatConnectionRoutes(app: FastifyInstance, channels: ChatConnections) {
  app.get('/api/chat-connections', async () => ({ connections: channels.overview() }));
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
        "SELECT id,state,text,created_at FROM chat_outbox WHERE connection_id=? AND state='uncertain' ORDER BY created_at LIMIT 20",
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
        "UPDATE chat_outbox SET state=? WHERE id=? AND connection_id=? AND state='uncertain'",
      )
      .run(body.decision === 'retry' ? 'pending' : 'sent', body.id, req.params.id);
    return { ok: true };
  });
}
