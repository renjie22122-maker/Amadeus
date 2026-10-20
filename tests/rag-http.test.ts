import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ragFetch } from '../server/services/rag-http.js';
test('local request carries deadline correlation; caller cancellation remains distinct', async (t) => {
  const received: any[] = [];
  const server = createServer((req, res) => {
    received.push(req.headers);
    if (req.url === '/ok') res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const response = await ragFetch(url + '/ok', {}, undefined, 1000);
  await response.text();
  assert.match(received[0]['x-amadeus-request-id'], /^[a-f0-9-]+$/);
  assert.equal(received[0]['x-amadeus-timeout-ms'], '1000');
  const logs: string[] = [];
  t.mock.method(console, 'warn', (s: string) => logs.push(s));
  await assert.rejects(ragFetch(url + '/wait', {}, undefined, 20));
  assert.equal(JSON.parse(logs.at(-1)!).cause, 'client_deadline');
  const controller = new AbortController();
  const pending = ragFetch(url + '/wait', {}, controller.signal, 1000);
  controller.abort();
  await assert.rejects(pending);
  assert.equal(JSON.parse(logs.at(-1)!).cause, 'caller_cancelled');
  assert(logs.every((s) => !s.includes(url)));
});
