import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { McpHub } from '../server/services/mcp.js';
import { Store } from '../server/storage/store.js';
import type { Settings } from '../shared/types.js';

for (const stateful of [false, true])
  test(`restart follows persisted ${stateful ? 'session-bound' : 'stateless'} task without resubmission`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'mcp-recovery-'));
    let submissions = 0,
      cancellations = 0,
      initializations = 0,
      polls = 0;
    let status = 'working',
      missing = false,
      outage = false;
    const task = () => ({
      taskId: 'durable-task',
      status,
      createdAt: new Date().toISOString(),
      lastUpdatedAt: new Date().toISOString(),
      ttl: 600000,
      pollInterval: 10,
    });
    const http = createServer(async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end();
        return;
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      const message = JSON.parse(body);
      if (message.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      let result: unknown, error: unknown;
      if (message.method === 'initialize') {
        initializations++;
        result = {
          protocolVersion: '2025-11-25',
          serverInfo: { name: 'durable', version: '1' },
          capabilities: { tools: {}, tasks: { requests: { tools: { call: {} } }, cancel: {} } },
        };
      } else {
        if (stateful) assert.equal(req.headers['mcp-session-id'], 'private-session');
        if (message.method === 'tools/list')
          result = {
            tools: [
              {
                name: 'build',
                inputSchema: { type: 'object' },
                execution: { taskSupport: 'required' },
              },
            ],
          };
        else if (message.method === 'tools/call') {
          submissions++;
          result = { task: task() };
        } else if (message.method === 'tasks/get') {
          polls++;
          assert.equal(message.params.taskId, 'durable-task');
          if (outage) {
            outage = false;
            res.writeHead(503);
            res.end();
            return;
          }
          if (missing) error = { code: -32602, message: 'expired' };
          else result = task();
        } else if (message.method === 'tasks/result')
          result = { content: [{ type: 'text', text: 'durable-result' }] };
        else if (message.method === 'tasks/cancel') {
          cancellations++;
          result = { ...task(), status: 'cancelled' };
        } else error = { code: -32601, message: 'unknown method' };
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        ...(stateful ? { 'Mcp-Session-Id': 'private-session' } : {}),
      });
      res.end(
        JSON.stringify({ jsonrpc: '2.0', id: message.id, ...(error ? { error } : { result }) }),
      );
    });
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    const server: Settings['mcp'][number] = {
      id: 'durable',
      name: 'Durable',
      command: '',
      args: [],
      enabled: true,
      transport: 'http',
      url: `http://127.0.0.1:${(http.address() as any).port}/mcp`,
    };
    let store = new Store(join(directory, 'db.sqlite'));
    let hub = new McpHub(undefined, store);
    t.after(async () => {
      await hub.close();
      store.close();
      http.closeAllConnections();
      await new Promise<void>((r) => http.close(() => r()));
      rmSync(directory, { recursive: true, force: true });
    });
    store.put('conversation', { id: 'chat' });
    const run: any = { id: 'run', conversationId: 'chat', status: 'running', checkpoints: [] };
    store.put('run', run);
    const signal = new AbortController().signal;
    const job = hub.jobs!.start(
      run,
      server.id,
      'build',
      (s, update) => hub.call(server, 'build', {}, s, 'chat', update),
      signal,
    );
    const until = async (predicate: () => boolean) => {
      for (let i = 0; i < 200; i++) {
        if (predicate()) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.fail('condition not reached');
    };
    await until(() => !!hub.jobs!.get('chat', job.id).remoteTask);
    await hub.close();
    assert.equal(cancellations, 0, 'shutdown detaches instead of cancelling');
    assert.equal(submissions, 1);
    const saved = store.get<any>('mcp-job', job.id);
    assert.equal(saved.recovery.sessionId, stateful ? 'private-session' : undefined);
    assert.equal(JSON.stringify(hub.jobs!.get('chat', job.id)).includes('private-session'), false);
    store.close();
    store = new Store(join(directory, 'db.sqlite'));
    hub = new McpHub(undefined, store);
    hub.jobs!.configureRecovery((receipt, s, update) => hub.followTask(server, receipt, s, update));
    status = 'completed';
    outage = true;
    hub.jobs!.recover();
    await Promise.all([hub.jobs!.resume('chat', job.id), hub.jobs!.resume('chat', job.id)]);
    await until(() => hub.jobs!.get('chat', job.id).status === 'completed');
    assert.equal((hub.jobs!.get('chat', job.id).result as any).content[0].text, 'durable-result');
    assert.equal(submissions, 1, 'recovery never calls tools/call');
    assert.equal(initializations, stateful ? 1 : 2);
    assert.equal(store.unknownEffects('chat').length, 0);
    assert.ok(store.maybe('runtime-inbox', job.id));
    await assert.rejects(hub.jobs!.resume('another-chat', job.id));
    await assert.rejects(hub.jobs!.resume('chat', job.id), /No resumable/);

    // Crash window: task ID persisted but no final receipt. A lost task remains unknown.
    store.put('mcp-job', { ...saved, id: 'crashed', status: 'running' });
    await hub.close();
    hub = new McpHub(undefined, store);
    hub.jobs!.configureRecovery((receipt, s, update) => hub.followTask(server, receipt, s, update));
    missing = true;
    hub.jobs!.recover();
    await until(() => hub.jobs!.get('chat', 'crashed').status === 'unknown');
    assert.equal(submissions, 1);
    const before = polls;
    await assert.rejects(hub.followTask({ ...server, enabled: false }, saved, signal, () => {}));
    const incompatible = { ...saved, recovery: { ...saved.recovery, protocol: '2026-07-28' } };
    await assert.rejects(hub.followTask(server, incompatible, signal, () => {}));
    assert.equal(polls, before);
    hub.jobs!.configureRecovery((receipt, s, update) =>
      hub.followTask({ ...server, url: server.url + '/changed' }, receipt, s, update),
    );
    await hub.jobs!.resume('chat', 'crashed');
    await until(() => hub.jobs!.get('chat', 'crashed').status === 'unknown');
    assert.equal(polls, before, 'changed destination rejected before network');
    hub.jobs!.configureRecovery((receipt, s, update) => hub.followTask(server, receipt, s, update));
    missing = false;
    status = 'input_required';
    await hub.jobs!.resume('chat', 'crashed');
    await until(() => hub.jobs!.get('chat', 'crashed').status === 'unknown');
    assert.match(hub.jobs!.get('chat', 'crashed').note!, /requires input/);
    await hub.jobs!.cancel('chat', 'crashed');
    assert.equal(cancellations, 1);
    const cancelledPolls = polls;
    hub.jobs!.recover();
    await new Promise((r) => setImmediate(r));
    assert.equal(polls, cancelledPolls);
    await assert.rejects(hub.jobs!.resume('chat', 'crashed'));
    assert.equal(submissions, 1);
  });
