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

test('generation diagnostics preserve safe limits and distinguish empty responses', () => {
  const details = providerFailureDiagnostic({
    code: 'MODEL_INCOMPLETE',
    finishReason: 'length',
    outputLimit: 4096,
    outputTokens: 4096,
    pendingToolCalls: 1,
    message: 'private prompt',
    answer: 'secret',
  });
  assert.equal(details.finishReason, 'length');
  assert.equal((details as any).outputLimit, 4096);
  assert(!JSON.stringify(details).includes('secret'));
  assert.equal(providerFailureDiagnostic({ code: 'EMPTY_RESPONSE' }).code, 'EMPTY_RESPONSE');
  assert(
    !JSON.stringify(
      providerFailureDiagnostic({
        code: 'MODEL_INCOMPLETE',
        outputLimit: 'secret',
        finishReason: 'secret',
      }),
    ).includes('secret'),
  );
});

test('pre-connect transient failure and HTTP busy share a bounded attempt budget', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' });
    if (calls === 2) return new Response('', { status: 503 });
    return new Response('{}');
  });
  assert.equal(
    (await request(profile, profile.baseUrl, {}, new AbortController().signal, {}, true)).status,
    200,
  );
  assert.equal(calls, 3);
});

test('persistent pre-connect failure stops at three attempts; cancellation stops backoff', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' });
  });
  await assert.rejects(
    request(profile, profile.baseUrl, {}, new AbortController().signal, {}, true),
    (e: any) => e.code === 'MODEL_NETWORK',
  );
  assert.equal(calls, 3);
  calls = 0;
  const abort = new AbortController();
  const pending = request(profile, profile.baseUrl, {}, abort.signal, {}, true);
  setTimeout(() => abort.abort(), 20);
  await assert.rejects(pending);
  assert.equal(calls, 1);
});

test('request does not retry permanent DNS, certificate or authentication failures', async (t) => {
  for (const code of ['ENOTFOUND', 'CERT_HAS_EXPIRED']) {
    let calls = 0;
    const mock = t.mock.method(globalThis, 'fetch', async () => {
      calls++;
      throw Object.assign(new Error('private'), { code });
    });
    await assert.rejects(
      request(profile, profile.baseUrl, {}, new AbortController().signal, {}, true),
    );
    assert.equal(calls, 1);
    mock.mock.restore();
  }
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response('{}', { status: 401 });
  });
  await assert.rejects(
    request(profile, profile.baseUrl, {}, new AbortController().signal, {}, true),
    (e: any) => e.code === 'MODEL_HTTP_401',
  );
  assert.equal(calls, 1);
});

test('tool-free reviewer opt-in can recover a pre-response reset; ordinary callers do not replay', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (calls === 1) throw broken();
    return new Response('{}');
  });
  assert.equal(
    (await request(profile, profile.baseUrl, {}, new AbortController().signal, {}, true)).status,
    200,
  );
  assert.equal(calls, 2);
});
