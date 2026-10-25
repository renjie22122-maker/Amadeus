import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Configuration } from '../server/services/settings.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { McpHub } from '../server/services/mcp.js';
import { validMcpUrl } from '../shared/mcp.js';
import type { Settings } from '../shared/types.js';

test('MCP settings persist generic fields and reject invalid HTTP and credential references', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-settings-'));
  try {
    const path = join(dir, 'settings.json');
    const config = new Configuration(path);
    const server: Settings['mcp'][number] = {
      id: 'remote',
      name: 'Remote',
      command: '',
      args: [],
      enabled: false,
      transport: 'http',
      url: 'https://example.com/mcp',
      bearerTokenEnv: 'MCP_TOKEN',
      allowedTools: ['echo'],
    };
    config.save({ ...config.get(), mcp: [server] });
    assert.deepEqual(new Configuration(path).get().mcp, [server]);
    for (const patch of [
      { url: 'http://example.com/mcp' },
      { bearerTokenEnv: 'not a variable' },
      { builtin: 'browser' },
      { envFromHost: { TOKEN: 'secret-value!' } },
    ]) {
      assert.throws(() => config.save({ ...config.get(), mcp: [{ ...server, ...patch }] }));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('HTTP MCP handshake, credential reference, schema rejection and allowlist enforcement', async () => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
    enableJsonResponse: true,
  });
  const service = new McpServer({ name: 'generic-fixture', version: '1.0' });
  let calls = 0;
  service.registerTool('echo', { inputSchema: { text: z.string() } }, async ({ text }) => {
    calls++;
    return { content: [{ type: 'text', text }] };
  });
  await service.connect(transport);
  const authorizations: (string | undefined)[] = [];
  const http = createServer((req, res) => {
    authorizations.push(req.headers.authorization);
    void transport.handleRequest(req, res);
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const port = (http.address() as { port: number }).port;
  const hub = new McpHub();
  process.env.AMADEUS_MCP_TEST_TOKEN = 'fixture-secret';
  const config: Settings['mcp'][number] = {
    id: 'http',
    name: 'HTTP',
    command: '',
    args: [],
    enabled: true,
    transport: 'http',
    url: `http://127.0.0.1:${port}/mcp`,
    bearerTokenEnv: 'AMADEUS_MCP_TEST_TOKEN',
  };
  const signal = new AbortController().signal;
  try {
    assert.equal((await hub.list(config))[0].name, 'echo');
    await assert.rejects(hub.call(config, 'echo', { text: 42 }, signal), /schema/);
    assert.equal(calls, 0);
    const result = await hub.call(config, 'echo', { text: 'hello' }, signal);
    assert.equal((result.content as any[])[0].text, 'hello');
    assert.equal(calls, 1);
    await assert.rejects(
      hub.call({ ...config, allowedTools: [] }, 'echo', { text: 'blocked' }, signal),
      /allowlist/,
    );
    assert.equal(calls, 1);
    assert.ok(authorizations.length > 2);
    assert.ok(authorizations.every((v) => v === 'Bearer fixture-secret'));
    const aborted = AbortSignal.abort();
    await assert.rejects(hub.call(config, 'echo', { text: 'cancelled' }, aborted));
    assert.equal(calls, 1);
  } finally {
    delete process.env.AMADEUS_MCP_TEST_TOKEN;
    await hub.close();
    await service.close();
    http.closeAllConnections();
    await new Promise<void>((r) => http.close(() => r()));
  }
});

test('stdio compatibility, filtered discovery and missing credentials fail before launch', async () => {
  const hub = new McpHub();
  const config = {
    id: 'stdio',
    name: 'stdio',
    command: process.execPath,
    args: ['--import', 'tsx', resolve('tests/fixtures/mcp-server.ts')],
    enabled: true,
  };
  try {
    assert.equal((await hub.list(config))[0].name, 'echo');
    assert.deepEqual(await hub.list({ ...config, allowedTools: [] }), []);
    await assert.rejects(
      hub.list({
        ...config,
        command: 'must-not-launch',
        envFromHost: { TOKEN: 'AMADEUS_MCP_ABSENT_TEST' },
      }),
      /Missing host environment/,
    );
  } finally {
    await hub.close();
  }
});

test('HTTP endpoint policy excludes credential-bearing and insecure remote URLs', () => {
  for (const url of ['https://example.com/mcp', 'http://127.0.0.1:123/mcp', 'http://[::1]/mcp'])
    assert.equal(validMcpUrl(url), true);
  for (const url of [
    'http://example.com/mcp',
    'https://user:secret@example.com/mcp',
    'https://example.com/mcp?token=secret',
    'file:///mcp',
    'broken',
  ])
    assert.equal(validMcpUrl(url), false);
});

test('stdio forwards only explicit credential references and reconnects after rotation', async () => {
  const hub = new McpHub();
  process.env.AMADEUS_MCP_MAPPED_TEST = 'first';
  process.env.AMADEUS_MCP_UNRELATED_TEST = 'must-not-inherit';
  const config = {
    id: 'env',
    name: 'env',
    command: process.execPath,
    args: ['--import', 'tsx', resolve('tests/fixtures/mcp-server.ts')],
    enabled: true,
    envFromHost: { MCP_MAPPED_TEST: 'AMADEUS_MCP_MAPPED_TEST' },
  };
  try {
    for (const expected of ['first', 'rotated']) {
      process.env.AMADEUS_MCP_MAPPED_TEST = expected;
      const result = await hub.call(
        config,
        'environment_fixture',
        {},
        new AbortController().signal,
      );
      assert.deepEqual(JSON.parse((result.content as any[])[0].text), { mapped: expected });
    }
  } finally {
    delete process.env.AMADEUS_MCP_MAPPED_TEST;
    delete process.env.AMADEUS_MCP_UNRELATED_TEST;
    await hub.close();
  }
});

test('HTTP redirects do not forward credentials or initialize another endpoint', async () => {
  let followed = false;
  const http = createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(307, { Location: '/target' });
      res.end();
    } else {
      followed = true;
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const hub = new McpHub();
  try {
    await assert.rejects(
      hub.list({
        id: 'redirect',
        name: 'Redirect',
        command: '',
        args: [],
        enabled: true,
        transport: 'http',
        url: `http://127.0.0.1:${(http.address() as { port: number }).port}/redirect`,
      }),
    );
    assert.equal(followed, false);
  } finally {
    await hub.close();
    http.closeAllConnections();
    await new Promise<void>((r) => http.close(() => r()));
  }
});
