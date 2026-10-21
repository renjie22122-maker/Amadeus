import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { mediaRoutes } from '../server/http/media.js';
import { mediaCapabilityTarget } from '../shared/media-capabilities.js';
test('preview is scoped and provisional, never submits a job or model turn', async (t) => {
  const app = Fastify();
  await app.register(multipart);
  t.after(() => app.close());
  const connection: any = {
    id: 'stt',
    kind: 'transcription',
    protocol: 'openai-transcription',
    baseUrl: 'http://127.0.0.1:8812/v1',
    model: 'whisper',
    apiKey: 'test',
    defaults: {},
  };
  connection.capabilities = {
    transcriptionPreview: {
      protocol: 'audio-snapshot-v1',
      target: mediaCapabilityTarget(connection),
    },
  };
  let calls = 0;
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async () => {
    calls++;
    return new Response(
      JSON.stringify({ text: 'draft', hasSpeech: true, speechEnd: 1, audioSeconds: 2 }),
      { status: 200 },
    );
  };
  mediaRoutes(app, {
    store: {
      get: (_kind: string, id: string) => {
        assert.equal(id, 'chat');
        return { id };
      },
    },
    media: { connection: () => connection },
  } as any);
  const payload =
    '--boundary\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\nsample\r\n--boundary--\r\n';
  const request = () =>
    app.inject({
      method: 'POST',
      url: '/api/conversations/chat/transcription-preview?serviceId=stt&sequence=3',
      headers: { 'content-type': 'multipart/form-data; boundary=boundary' },
      payload,
    });
  const response = await request();
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().provisional, true);
  assert.equal(response.json().sequence, 3);
  assert.equal(calls, 1);
  connection.baseUrl = 'http://127.0.0.1:9999/v1';
  assert.notEqual((await request()).statusCode, 200);
  assert.equal(calls, 1);
});
