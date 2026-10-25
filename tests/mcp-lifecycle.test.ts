import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { McpOAuth } from '../server/services/mcp-oauth.js';
import { McpJobs } from '../server/services/mcp-jobs.js';
import { McpHub } from '../server/services/mcp.js';
import { Store } from '../server/storage/store.js';
import type { Settings } from '../shared/types.js';
import { mcpExamples } from '../shared/mcp-examples.js';
import { Configuration } from '../server/services/settings.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

test('OAuth discovery, DCR, PKCE exchange, issuer/state rejection, persisted refresh and logout', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mcp-oauth-'));
  const codec = {
    seal: (s: string) => Buffer.from(s).toString('base64'),
    open: (s: string) => Buffer.from(s, 'base64').toString(),
  };
  let base = '',
    challenge = '',
    exchanges = 0,
    registrations = 0,
    refreshes = 0;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => 'oauth-session',
    enableJsonResponse: true,
  });
  const service = new McpServer({ name: 'oauth-fixture', version: '1' });
  service.registerTool('protected_read', { inputSchema: {} }, async () => ({
    content: [{ type: 'text', text: 'protected' }],
  }));
  await service.connect(transport);
  const http = createServer(async (req, res) => {
    if (req.url === '/mcp') {
      if (req.headers.authorization !== 'Bearer refreshed-secret') {
        res.writeHead(401, {
          'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
        });
        res.end();
        return;
      }
      return transport.handleRequest(req, res);
    }
    res.setHeader('content-type', 'application/json');
    const send = (value: unknown) => res.end(JSON.stringify(value));
    if (req.url?.startsWith('/.well-known/oauth-protected-resource'))
      return send({ resource: base + '/mcp', authorization_servers: [base] });
    if (req.url?.startsWith('/.well-known/oauth-authorization-server'))
      return send({
        issuer: base,
        authorization_endpoint: base + '/authorize',
        token_endpoint: base + '/token',
        registration_endpoint: base + '/register',
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        authorization_response_iss_parameter_supported: true,
      });
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.url === '/register') {
      registrations++;
      return send({ ...JSON.parse(body), client_id: 'test-client' });
    }
    if (req.url === '/token') {
      const params = new URLSearchParams(body);
      if (params.get('grant_type') === 'authorization_code') {
        exchanges++;
        assert.equal(
          createHash('sha256').update(params.get('code_verifier')!).digest('base64url'),
          challenge,
        );
        assert.equal(params.get('resource'), base + '/mcp');
      } else {
        refreshes++;
        assert.equal(params.get('refresh_token'), 'refresh-secret');
      }
      return send({
        access_token: refreshes ? 'refreshed-secret' : 'access-secret',
        refresh_token: 'refresh-secret',
        token_type: 'Bearer',
        expires_in: 60,
      });
    }
    res.statusCode = 404;
    send({ error: 'not_found' });
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  t.after(async () => {
    await service.close();
    http.closeAllConnections();
    await new Promise<void>((r) => http.close(() => r()));
    rmSync(directory, { recursive: true, force: true });
  });
  const server: Settings['mcp'][number] = {
    id: 'oauth',
    name: 'OAuth',
    command: '',
    args: [],
    enabled: true,
    transport: 'http',
    url: base + '/mcp',
    oauth: { enabled: true },
  };
  let manager = new McpOAuth(directory, codec);
  const login = async () => {
    const result = await manager.start(server, 'http://127.0.0.1:12345/mcp/oauth/callback');
    const url = new URL(result.authorizationUrl);
    challenge = url.searchParams.get('code_challenge')!;
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    return new URLSearchParams({
      state: url.searchParams.get('state')!,
      code: 'fixture-code',
      iss: base,
    });
  };
  assert.throws(() => manager.forConnection(server), /Sign in/);
  await assert.rejects(
    manager.finish(new URLSearchParams({ state: 'forged', code: 'code' }), () => server),
  );
  const wrongIssuer = await login();
  wrongIssuer.set('iss', 'https://wrong.example');
  await assert.rejects(
    manager.finish(wrongIssuer, () => server),
    /issuer/,
  );
  assert.equal(exchanges, 0);
  const callback = await login();
  await manager.finish(callback, () => server);
  assert.equal(exchanges, 1);
  assert.ok(registrations >= 1);
  await assert.rejects(
    manager.finish(callback, () => server),
    /state/,
  );
  assert.equal(manager.status(server).signedIn, true);
  const disk = readdirSync(directory)
    .map((f) => readFileSync(join(directory, f), 'utf8'))
    .join('');
  assert.equal(disk.includes('access-secret'), false);
  manager = new McpOAuth(directory, codec);
  const hub = new McpHub();
  Object.defineProperty(hub, 'oauth', { value: manager });
  try {
    assert.equal((await hub.list(server, 'oauth-transport'))[0].name, 'protected_read');
    const protectedResult: any = await hub.call(
      server,
      'protected_read',
      {},
      new AbortController().signal,
      'oauth-transport',
    );
    assert.equal(protectedResult.content[0].text, 'protected');
  } finally {
    await hub.close();
  }
  assert.equal(refreshes, 1);
  assert.equal((await manager.forConnection(server)!.tokens())?.access_token, 'refreshed-secret');
  assert.equal(manager.status({ ...server, url: base + '/different' }).signedIn, false);
  const changed = await login();
  await assert.rejects(
    manager.finish(changed, () => ({ ...server, enabled: false })),
    /changed/,
  );
  manager.logout(server);
  assert.equal(manager.status(server).signedIn, false);
  assert.equal(new McpOAuth(directory, codec).status(server).signedIn, false);
});

test('resources, URI templates and prompt arguments use real stdio protocol; reset permits reconnect', async () => {
  const hub = new McpHub(),
    signal = new AbortController().signal;
  const server = {
    id: 'content',
    name: 'Content',
    command: process.execPath,
    args: ['--import', 'tsx', resolve('tests/fixtures/mcp-server.ts')],
    enabled: true,
  };
  try {
    assert.equal(
      ((await hub.catalog(server, 'resources', undefined, 'scope', signal)) as any).resources[0]
        .uri,
      'fixture://guide',
    );
    assert.equal(
      ((await hub.catalog(server, 'templates', undefined, 'scope', signal)) as any)
        .resourceTemplates[0].uriTemplate,
      'fixture://named/{name}',
    );
    const resource = (await hub.readResource(server, 'fixture://named/alice', 'scope', signal))
      .contents[0];
    assert.ok('text' in resource);
    assert.equal(resource.text, 'alice');
    assert.equal(
      ((await hub.catalog(server, 'prompts', undefined, 'scope', signal)) as any).prompts[0].name,
      'review',
    );
    const prompt = (await hub.getPrompt(server, 'review', { topic: 'fixtures' }, 'scope', signal))
      .messages[0].content;
    assert.equal(prompt.type, 'text');
    assert.ok('text' in prompt);
    assert.equal(prompt.text, 'Review fixtures');
    await assert.rejects(hub.getPrompt(server, 'review', {}, 'scope', signal));
    await hub.close(true);
    assert.ok((await hub.list(server, 'scope')).length);
  } finally {
    await hub.close();
  }
});

test('background MCP receipts remain scoped, notify once, cancel without replay and recover unknown', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mcp-jobs-')),
    store = new Store(join(directory, 'db.sqlite'));
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const run: any = { id: 'run', conversationId: 'chat', status: 'running', checkpoints: [] };
  store.put('conversation', { id: 'chat' });
  store.put('run', run);
  const jobs = new McpJobs(store),
    signal = new AbortController().signal;
  let count = 0,
    release!: (value: any) => void;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const job = jobs.start(
    run,
    'server',
    'tool',
    async () => {
      count++;
      return pending;
    },
    signal,
  );
  assert.equal(job.status, 'running');
  assert.throws(() => jobs.get('another', job.id));
  release({ content: [{ type: 'text', text: 'result' }] });
  assert.equal((await jobs.wait('chat', job.id, 2, signal)).status, 'completed');
  assert.equal(count, 1);
  assert.equal(store.unknownEffects('chat').length, 0);
  assert.ok(store.maybe('runtime-inbox', job.id));
  const cancelled = jobs.start(
    run,
    'server',
    'slow',
    async (sig) =>
      new Promise((_resolve, reject) =>
        sig.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
      ),
    signal,
  );
  await new Promise((r) => setImmediate(r));
  await jobs.cancel('chat', cancelled.id);
  assert.equal((await jobs.wait('chat', cancelled.id, 2, signal)).status, 'unknown');
  assert.equal(store.unknownEffects('chat').length, 1);
  store.put('mcp-job', { ...cancelled, id: 'orphan', status: 'running' });
  const restarted = new McpJobs(store);
  assert.equal(restarted.get('chat', 'orphan').status, 'unknown');
  await jobs.close();
});

test('all eight examples are valid data-only configurations and remain disabled', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mcp-examples-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = new Configuration(join(directory, 'settings.json'));
  const servers = mcpExamples.map((e, i) => ({
    ...e.config,
    id: String(i),
    name: e.name,
    enabled: false,
  }));
  config.save({ ...config.get(), mcp: servers });
  assert.equal(config.get().mcp.length, 8);
  assert.ok(config.get().mcp.every((s) => !s.enabled));
});

test('task-capable MCP tools submit once, retain remote identity and consume the final result', async () => {
  const hub = new McpHub();
  let submissions = 0;
  hub.connect = async () =>
    ({
      listTools: async () => ({
        tools: [
          {
            name: 'remote_job',
            inputSchema: { type: 'object' },
            execution: { taskSupport: 'required' },
          },
        ],
      }),
      experimental: {
        tasks: {
          callToolStream: async function* () {
            submissions++;
            yield { type: 'taskCreated', task: { taskId: 'remote-1', status: 'working' } };
            yield { type: 'taskStatus', task: { taskId: 'remote-1', status: 'completed' } };
            yield { type: 'result', result: { content: [{ type: 'text', text: 'done' }] } };
          },
        },
      },
    }) as any;
  const updates: unknown[] = [];
  const output: any = await hub.call(
    { id: 'task', name: 'Task', command: '', args: [], enabled: true },
    'remote_job',
    {},
    new AbortController().signal,
    'scope',
    (task) => updates.push(task),
  );
  assert.equal(submissions, 1);
  assert.equal(output.content[0].text, 'done');
  assert.deepEqual(updates, [
    { taskId: 'remote-1', status: 'working' },
    { taskId: 'remote-1', status: 'completed' },
  ]);
  await hub.close();
});

test('real HTTP task protocol polls the same task and cancels without a second submission', async (t) => {
  let submissions = 0,
    cancellations = 0;
  const task = () => ({
    taskId: 'remote-task',
    status: 'working',
    createdAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
    ttl: 60000,
    pollInterval: 1,
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
    let result: unknown;
    if (message.method === 'initialize')
      result = {
        protocolVersion: '2025-11-25',
        serverInfo: { name: 'task-fixture', version: '1' },
        capabilities: {
          tools: {},
          tasks: { requests: { tools: { call: {} } }, cancel: {}, list: {} },
        },
      };
    else if (message.method === 'tools/list')
      result = {
        tools: [
          {
            name: 'remote_job',
            inputSchema: { type: 'object' },
            execution: { taskSupport: 'required' },
          },
        ],
      };
    else if (message.method === 'tools/call') {
      submissions++;
      assert.ok(message.params.task);
      result = { task: task() };
    } else if (message.method === 'tasks/get') {
      assert.equal(message.params.taskId, 'remote-task');
      result = { ...task(), status: 'completed' };
    } else if (message.method === 'tasks/result')
      result = { content: [{ type: 'text', text: 'remote-result' }] };
    else if (message.method === 'tasks/cancel') {
      cancellations++;
      result = { ...task(), status: 'cancelled' };
    } else throw new Error('Unexpected method: ' + message.method);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const hub = new McpHub();
  t.after(async () => {
    await hub.close();
    http.closeAllConnections();
    await new Promise<void>((r) => http.close(() => r()));
  });
  const server: Settings['mcp'][number] = {
    id: 'tasks',
    name: 'Tasks',
    command: '',
    args: [],
    enabled: true,
    transport: 'http',
    url: `http://127.0.0.1:${(http.address() as { port: number }).port}/mcp`,
  };
  const output: any = await hub.call(server, 'remote_job', {}, new AbortController().signal);
  assert.equal(output.content[0].text, 'remote-result');
  assert.equal(submissions, 1);
  const controller = new AbortController();
  await assert.rejects(
    hub.call(server, 'remote_job', {}, controller.signal, 'global', () => controller.abort()),
  );
  assert.equal(submissions, 2);
  assert.equal(cancellations, 1);
});
