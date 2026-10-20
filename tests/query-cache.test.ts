import test from 'node:test';
import assert from 'node:assert/strict';
import { QueryCache } from '../server/services/query-cache.js';
import { Embeddings } from '../server/services/embedding.js';
import { createServer } from 'node:http';
test('shared query cancellation is per subscriber; cached values cannot be mutated', async () => {
  const cache = new QueryCache<number[]>(2);
  let release!: (x: number[]) => void;
  let calls = 0;
  let shared!: AbortSignal;
  const compute = (s: AbortSignal) => {
    shared = s;
    calls++;
    return new Promise<number[]>((r) => (release = r));
  };
  const controller = new AbortController();
  const a = cache.get('same', compute, controller.signal);
  const b = cache.get('same', compute);
  await Promise.resolve();
  controller.abort();
  await assert.rejects(a);
  assert(!shared.aborted);
  release([1]);
  const first = await b;
  first[0] = 9;
  assert.deepEqual(await cache.get('same', compute), [1]);
  assert.equal(calls, 1);
});
test('cache bounds, expiry, failures and all-cancelled jobs', async () => {
  const cache = new QueryCache<number>(1, 5);
  let n = 0;
  const compute = async () => ++n;
  await cache.get('a', compute);
  await cache.get('b', compute);
  assert.equal(await cache.get('a', compute), 3);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(await cache.get('a', compute), 4);
  await assert.rejects(
    cache.get('bad', async () => {
      throw Error('failure');
    }),
  );
  assert.equal(await cache.get('bad', compute), 5);
  const stop = new AbortController();
  let shared!: AbortSignal;
  const p = cache.get(
    'cancel',
    async (s) => {
      shared = s;
      return new Promise<number>((_r, j) => s.addEventListener('abort', () => j(Error('abort'))));
    },
    stop.signal,
  );
  await Promise.resolve();
  stop.abort();
  await assert.rejects(p);
  assert(shared.aborted);
  assert.equal(await cache.get('cancel', compute), 6);
});
test('embedding query reuse invalidates on credentials/model and does not cache passage requests', async (t) => {
  let calls = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) {
    }
    calls++;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const settings: any = {
    baseUrl: 'http://127.0.0.1:' + (server.address() as any).port,
    model: 'fixture',
    apiKey: 'a',
  };
  const e = new Embeddings(() => settings);
  await Promise.all([
    e.encode(['question'], undefined, 'query'),
    e.encode(['question'], undefined, 'query'),
  ]);
  assert.equal(calls, 1);
  await e.encode(['question'], undefined, 'query');
  assert.equal(calls, 1);
  settings.apiKey = 'b';
  await e.encode(['question'], undefined, 'query');
  assert.equal(calls, 2);
  settings.model = 'other';
  await e.encode(['question'], undefined, 'query');
  assert.equal(calls, 3);
  await e.encode(['question']);
  await e.encode(['question']);
  assert.equal(calls, 5);
});
