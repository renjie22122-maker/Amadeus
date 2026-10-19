import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mediaRoutes } from '../server/http/media.js';

test('native read-aloud proxy scopes access, requires capability and does not create media jobs', async () => {
  const original = globalThis.fetch;
  const app = Fastify();
  let permission = 'ask',
    local = true,
    supported = true,
    calls = 0,
    submitted = 0;
  const c = { id: 'chat', permission };
  mediaRoutes(app, {
    store: {
      get: (_type: string, id: string) => {
        assert.equal(id, 'chat');
        return { ...c, permission };
      },
    },
    media: {
      connection: () => ({
        id: local ? 'amadeus-local-cosyvoice' : 'remote',
        kind: 'speech',
        protocol: 'openai-speech',
        baseUrl: 'http://127.0.0.1:8812/v1',
        apiKey: 'private-fixture',
        defaults: { voice: 'voice' },
      }),
      submit: () => {
        submitted++;
        throw Error('read aloud must not create media jobs');
      },
    },
  } as any);
  app.setErrorHandler((error: any, _req, reply) =>
    reply.code(error.status || error.statusCode || 400).send({ error: error.message }),
  );
  globalThis.fetch = (async (url, options) => {
    calls++;
    assert.equal((options?.headers as any).Authorization, 'Bearer private-fixture');
    if (String(url).endsWith('/health')) return Response.json({ streaming: supported });
    const body = JSON.parse(String(options?.body));
    assert.equal(body.stream, true);
    assert.equal(body.voice, 'voice');
    return new Response('{"type":"waiting"}\n{"type":"done","chunks":1}\n', {
      headers: { 'Content-Type': 'application/x-ndjson' },
    });
  }) as typeof fetch;
  const request = () =>
    app.inject({
      method: 'POST',
      url: '/api/conversations/chat/read-aloud',
      payload: { serviceId: 'local', text: 'Hello' },
    });
  try {
    permission = 'read-only';
    assert.notEqual((await request()).statusCode, 200);
    assert.equal(calls, 0);
    permission = 'ask';
    local = false;
    assert.notEqual((await request()).statusCode, 200);
    assert.equal(calls, 0);
    local = true;
    supported = false;
    assert.notEqual((await request()).statusCode, 200);
    assert.equal(calls, 1);
    supported = true;
    const result = await request();
    assert.equal(result.statusCode, 200);
    assert.match(result.headers['content-type']!, /ndjson/);
    assert.match(result.body, /"type":"done"/);
    assert.equal(submitted, 0);
    assert.equal(calls, 3);
    assert(!result.body.includes('private-fixture'));
  } finally {
    globalThis.fetch = original;
    await app.close();
  }
});
