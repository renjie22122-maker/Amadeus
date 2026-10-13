import test from 'node:test';
import assert from 'node:assert/strict';
import { request, sse } from '../server/providers/protocol.js';
import {
  normalizeProviderFailure,
  providerFailureDiagnostic,
} from '../server/providers/failure.js';
import { transientModelFailure } from '../server/core/model-recovery.js';
import { profileSchema } from '../server/services/settings.js';
const profile = profileSchema.parse({
  id: 'test',
  name: 'test',
  transport: 'openai-chat',
  baseUrl: 'https://example.test',
  model: 'test',
  apiKey: 'sk-private',
});
const broken = () =>
  new TypeError('fetch failed', {
    cause: Object.assign(new Error('secret URL https://example.test/?key=sk-private'), {
      code: 'ECONNRESET',
    }),
  });
test('connection failure has a safe typed cause, no implicit request replay', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    throw broken();
  });
  await assert.rejects(
    () => request(profile, profile.baseUrl, {}, new AbortController().signal),
    (e: any) => {
      assert.equal(e.code, 'MODEL_NETWORK');
      assert.equal(transientModelFailure(e), true);
      const d = providerFailureDiagnostic(e);
      assert.equal(d.transportCode, 'ECONNRESET');
      assert.equal(d.phase, 'connect');
      assert(!JSON.stringify(d).includes('private'));
      assert(!e.message.includes('private'));
      return true;
    },
  );
  assert.equal(calls, 1);
});
test('broken response body is classified separately and does not replay fetch', async () => {
  const response = new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"partial":true}\n\n'));
      },
      pull(c) {
        c.error(
          new TypeError('terminated', {
            cause: Object.assign(new Error('socket'), { code: 'UND_ERR_SOCKET' }),
          }),
        );
      },
    }),
  );
  const events = sse(response);
  assert.deepEqual((await events.next()).value, { partial: true });
  await assert.rejects(
    () => events.next(),
    (e: any) => e.code === 'MODEL_NETWORK' && providerFailureDiagnostic(e).phase === 'stream',
  );
});
test('TLS/configuration errors, programming bugs and caller cancellation are not retried', () => {
  const tls = normalizeProviderFailure(
    new TypeError('fetch failed', {
      cause: Object.assign(new Error('private'), { code: 'CERT_HAS_EXPIRED' }),
    }),
    'connect',
  );
  assert.equal((tls as any).code, 'MODEL_TLS');
  assert.equal(transientModelFailure(tls), false);
  const bug = new TypeError('Cannot read properties of undefined');
  assert.equal(normalizeProviderFailure(bug, 'connect'), bug);
  assert.equal(transientModelFailure(bug), false);
  const abort = Object.assign(new Error('stop'), { name: 'AbortError', cause: broken() });
  assert.equal(normalizeProviderFailure(abort, 'stream'), abort);
  assert.equal(transientModelFailure(abort), false);
  const cyclic: any = new Error('cycle');
  cyclic.cause = cyclic;
  assert.equal(transientModelFailure(cyclic), false);
});
