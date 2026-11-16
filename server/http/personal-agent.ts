import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, assert } from '../core/errors.js';
import { PersonalAgent } from '../services/personal-agent.js';
import { DeviceCommands } from '../services/device-commands.js';

const scopes = z
  .array(z.enum(['read', 'message', 'stop', 'approve', 'goals', 'device-control']))
  .min(1)
  .max(6);
type Upload = (conversationId: string, name: string, data: Buffer) => Promise<unknown>;
export function createPersonalGateway(service: PersonalAgent, upload?: Upload) {
  const app = Fastify({ logger: false, bodyLimit: 12 * 1024 * 1024 });
  const commands = new DeviceCommands(service.store);
  app.setErrorHandler((e, _req, reply) =>
    reply.code(e instanceof AppError ? e.status : e instanceof z.ZodError ? 400 : 500).send({
      error:
        e instanceof z.ZodError
          ? 'Invalid request.'
          : e instanceof AppError
            ? e.message
            : 'Operation failed.',
    }),
  );
  app.addHook('onRequest', async (req, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
    // Native clients only. Browser cross-origin access and cookie authentication are not supported.
    assert(
      !req.headers.origin,
      'ORIGIN',
      'Browser origins are not accepted by the device gateway.',
      403,
    );
    if (req.url === '/v1/pair' && req.method === 'POST') return;
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '')?.[1];
    assert(token, 'AUTH', 'Device authorization required.', 401);
    service.authenticate(token);
  });
  const device = (req: any) => service.authenticate(req.headers.authorization.slice(7));
  app.post('/v1/pair', async (req) =>
    service.pair(z.object({ code: z.string().min(30).max(100) }).parse(req.body).code),
  );
  app.get('/v1/state', async (req) => {
    const d = device(req);
    service.require(d, 'read');
    const s = service.snapshot();
    return {
      identity: s.identity,
      now: s.now,
      goals: s.goals.filter((g) => g.conversationId === d.conversationId),
      events: service.store.selectedEvents(
        d.conversationId,
        ['user.message', 'assistant.message', 'run.status'],
        80,
      ),
      runs: service.store
        .runMetadata(d.conversationId)
        .slice(-10)
        .map(({ id, status, createdAt }) => ({ id, status, createdAt })),
      inputs: d.scopes.includes('approve')
        ? service.store.pendingInputs().filter((q) => q.conversationId === d.conversationId)
        : [],
      device: { id: d.id, name: d.name, scopes: d.scopes },
    };
  });
  app.post('/v1/message', async (req) => {
    const body = z
      .object({
        requestId: z.string().uuid(),
        text: z.string().trim().min(1).max(10000),
        attachmentIds: z.array(z.string().uuid()).max(4).default([]),
      })
      .parse(req.body);
    return service.message(device(req), body.requestId, body.text, body.attachmentIds);
  });
  app.post('/v1/attachments', async (req) => {
    const d = device(req);
    service.require(d, 'message');
    assert(upload, 'UNAVAILABLE', 'Upload unavailable.');
    const b = z
      .object({
        name: z.string().regex(/^[^\r\n"\\/]{1,120}$/),
        base64: z
          .string()
          .max(12 * 1024 * 1024)
          .regex(/^[A-Za-z0-9+/]*={0,2}$/),
      })
      .parse(req.body);
    const data = Buffer.from(b.base64, 'base64');
    assert(data.length > 0 && data.length <= 8 * 1024 * 1024, 'SIZE', 'Select a file up to 8 MB.');
    return upload(d.conversationId, b.name, data);
  });
  app.post('/v1/stop', async (req) => {
    const d = device(req);
    service.require(d, 'stop');
    service.runtime.stop(d.conversationId);
    return { ok: true };
  });
  app.post('/v1/input', async (req) => {
    const d = device(req);
    service.require(d, 'approve');
    const body = z
      .object({
        id: z.string(),
        answer: z.string().max(10000).optional(),
        allow: z.boolean().optional(),
      })
      .parse(req.body);
    const input = service.store
      .pendingInputs()
      .find((q) => q.id === body.id && q.conversationId === d.conversationId);
    assert(input, 'SCOPE', 'Input is no longer pending in this conversation.', 403);
    service.runtime.inputs.answer(body.id, body.answer || '', body.allow ?? false, false);
    return { ok: true };
  });
  app.post('/v1/goals', async (req) => {
    const d = device(req);
    service.require(d, 'goals');
    return service.createGoal(req.body);
  });
  app.post<{ Params: { id: string } }>('/v1/goals/:id/action', async (req) => {
    const d = device(req);
    service.require(d, 'goals');
    assert(
      service.store.get<any>('personal-goal', req.params.id).conversationId === d.conversationId,
      'SCOPE',
      'Goal belongs to another conversation.',
      403,
    );
    const body = z
      .object({
        action: z.enum(['pause', 'resume', 'wake']),
        eventId: z.string().uuid().optional(),
      })
      .parse(req.body);
    return service.goalAction(req.params.id, body.action, body.eventId);
  });
  app.post('/v1/device/poll', async (req) => {
    const d = device(req);
    const { capabilities } = z
      .object({ capabilities: z.array(z.string().regex(/^[a-z][a-z0-9_.]{1,80}$/)).max(100) })
      .parse(req.body);
    service.store.put('paired-device', {
      ...d,
      capabilities: d.scopes.includes('device-control') ? capabilities : [],
      lastSeenAt: Date.now(),
    });
    const last = d.scopes.includes('read')
      ? service.store.selectedEvents(d.conversationId, ['assistant.message'], 1).at(-1)
      : undefined;
    return {
      command: d.scopes.includes('device-control') ? commands.claim(d) : null,
      latestEventId: last?.id || null,
    };
  });
  app.post<{ Params: { id: string } }>('/v1/device/results/:id', async (req) => {
    const d = device(req);
    service.require(d, 'device-control');
    const body = z
      .object({ status: z.enum(['completed', 'failed', 'unknown']), result: z.unknown() })
      .parse(req.body);
    return commands.result(d, req.params.id, body.status, body.result);
  });
  return app;
}
export function personalAgentRoutes(app: FastifyInstance, service: PersonalAgent, upload?: Upload) {
  const gateway = createPersonalGateway(service, upload);
  let address: string | undefined, starting: Promise<string> | undefined;
  let gatewayError: string | undefined;
  const start = () => {
    starting ||= gateway
      .listen({
        host: '127.0.0.1',
        port: Number(
          process.env.AMADEUS_REMOTE_PORT ||
            service.store.maybe<any>('personal-gateway', 'listener')?.port ||
            0,
        ),
      })
      .then((url) => {
        address = url;
        gatewayError = undefined;
        service.store.put('personal-gateway', {
          id: 'listener',
          enabled: true,
          port: Number(new URL(url).port),
        });
        return url;
      })
      .catch((e) => {
        starting = undefined;
        gatewayError = String(e.message);
        throw e;
      });
    return starting;
  };
  app.addHook('onReady', async () => {
    if (service.store.maybe<any>('personal-gateway', 'listener')?.enabled)
      await start().catch(() => {});
  });
  app.get('/api/personal', async () => ({
    ...service.snapshot(),
    gateway: {
      address: address || null,
      publicUrl: process.env.AMADEUS_REMOTE_PUBLIC_URL || null,
      error: gatewayError,
    },
  }));
  app.post('/api/personal/identity', async (req) => {
    const b = z
      .object({ name: z.string().trim().min(1).max(60), conversationId: z.string() })
      .parse(req.body);
    return service.configure(b.name, b.conversationId);
  });
  app.post('/api/personal/goals', async (req) => service.createGoal(req.body));
  app.post<{ Params: { id: string } }>('/api/personal/goals/:id/action', async (req) => {
    const b = z
      .object({
        action: z.enum(['pause', 'resume', 'wake']),
        eventId: z.string().uuid().optional(),
      })
      .parse(req.body);
    return service.goalAction(req.params.id, b.action, b.eventId);
  });
  app.post('/api/personal/invites', async (req) => {
    const b = z.object({ name: z.string().trim().min(1).max(60), scopes }).parse(req.body);
    return service.invite(b.name, b.scopes);
  });
  app.post<{ Params: { id: string } }>('/api/personal/devices/:id/revoke', async (req) =>
    service.revoke(req.params.id),
  );
  app.post('/api/personal/gateway/start', async () => {
    // TLS is terminated by a trusted local reverse proxy/tunnel. Never bind plaintext to LAN.
    return { address: await start() };
  });
  app.addHook('onClose', async () => {
    if (starting) await starting.catch(() => {});
    await gateway.close();
  });
  return gateway;
}
