import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { conditionalState, stateRun } from '../server/http/state-response.js';
import { mergeState } from '../src/state-refresh.js';
import { api, bootstrap } from '../src/api.js';

test('state revalidation transfers no body until state changes', async () => {
  const app = Fastify();
  let state = { runs: [{ id: 'r', status: 'running' }], pendingInputs: [] };
  app.get('/state', (req, reply) => conditionalState(req, reply, state));
  try {
    const first = await app.inject('/state');
    assert.deepEqual(first.json(), state);
    assert.equal(first.headers['cache-control'], 'no-store');
    const same = await app.inject({
      url: '/state',
      headers: { 'if-none-match': first.headers.etag! },
    });
    assert.equal(same.statusCode, 304);
    assert.equal(same.body, '');
    state = { ...state, runs: [{ id: 'r', status: 'completed' }] };
    const changed = await app.inject({
      url: '/state',
      headers: { 'if-none-match': first.headers.etag! },
    });
    assert.equal(changed.statusCode, 200);
    assert.notEqual(changed.headers.etag, first.headers.etag);
    assert.deepEqual(changed.json(), state);
  } finally {
    await app.close();
  }
});

test('partial shell refresh preserves library data and unchanged references', () => {
  const old = {
    runs: [{ status: 'running' }],
    documents: [{ id: 'doc' }],
    conversations: [{ id: 'c' }],
  };
  assert.equal(mergeState(old, JSON.parse(JSON.stringify(old))), old);
  const next = mergeState(old, { runs: [{ status: 'completed' }], conversations: [{ id: 'c' }] });
  assert.notEqual(next, old);
  assert.equal(next.documents, old.documents);
  assert.equal(next.conversations, old.conversations);
  assert.equal(next.runs[0].status, 'completed');
});

test('client keeps view caches separate and clears them after session changes', async () => {
  const original = globalThis.fetch;
  const calls: Array<{ path: string; headers: Headers }> = [];
  let session = 'one';
  globalThis.fetch = async (input, init) => {
    const path = String(input),
      headers = new Headers(init?.headers);
    calls.push({ path, headers });
    if (path.endsWith('/bootstrap')) return Response.json({ csrf: session });
    if (headers.has('if-none-match')) return new Response(null, { status: 304 });
    return Response.json({ path }, { headers: { etag: '"' + path + '"' } });
  };
  try {
    await bootstrap();
    const first = await api('/state?view=shell');
    assert.equal(await api('/state?view=shell'), first);
    await api('/state?view=full');
    assert.equal(calls.at(-1)!.headers.has('if-none-match'), false);
    session = 'two';
    await bootstrap();
    await api('/state?view=shell');
    assert.equal(calls.at(-1)!.headers.has('if-none-match'), false);
  } finally {
    globalThis.fetch = original;
  }
});

test('shell omits only unused diagnostic fields without changing stored history', () => {
  const run = {
    id: 'run',
    status: 'completed',
    inputTokens: 42,
    contextSample: { large: 'diagnostic' },
    providerFingerprint: 'provider',
    checkpoints: [{ content: 'history' }],
  } as any;
  const shell = stateRun(run, true),
    full = stateRun(run, false);
  assert.equal('contextSample' in shell, false);
  assert.equal('providerFingerprint' in shell, false);
  assert.equal(shell.inputTokens, 42);
  assert.equal(full.contextSample, run.contextSample);
  assert.equal(run.checkpoints.length, 1);
  assert.equal('checkpoints' in full, false);
});
