import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { validMcpUrl, validMcpHeader } from '../../shared/mcp.js';
import type { Settings } from '../../shared/types.js';
import { assert } from '../core/errors.js';
import { McpOAuth } from './mcp-oauth.js';
import { setTimeout as delay } from 'node:timers/promises';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpJobs, MCP_SUSPEND, type Recovery, type Job, type TaskUpdate } from './mcp-jobs.js';
import type { Store } from '../storage/store.js';
export class McpHub {
  readonly oauth?: McpOAuth;
  readonly jobs?: McpJobs;
  constructor(
    private stateDirectory?: string,
    store?: Store,
  ) {
    if (stateDirectory) this.oauth = new McpOAuth(join(stateDirectory, 'oauth'));
    if (store) this.jobs = new McpJobs(store);
  }
  private clients = new Map<
    string,
    { client: Client; transport: Transport; fingerprint: string }
  >();
  private closing = false;
  private resumeSessions = new Map<string, Recovery>();
  recoveryBinding(server: Settings['mcp'][number]) {
    return createHash('sha256')
      .update(
        JSON.stringify([
          server,
          this.credentials(server),
          server.oauth?.enabled ? this.oauth?.recoveryIdentity(server) : null,
        ]),
      )
      .digest('hex');
  }
  async followTask(
    server: Settings['mcp'][number],
    job: Job,
    signal: AbortSignal,
    update: (task: TaskUpdate) => void,
    validate: () => void = () => {},
  ) {
    validate();
    const recovery = job.recovery!;
    assert(
      recovery.protocol === '2025-11-25' && recovery.binding === this.recoveryBinding(server),
      'MCP_RECOVERY_CHANGED',
      'Server or login identity changed; restore original settings before resuming.',
    );
    assert(
      server.enabled &&
        (server.allowedTools === undefined || server.allowedTools.includes(job.tool)),
      'MCP_RECOVERY_DENIED',
      'Task server or tool is disabled.',
    );
    const scope = 'recovery:' + job.conversationId + ':' + job.id;
    const key = JSON.stringify([server.id, scope]);
    this.resumeSessions.set(key, recovery);
    let client: Client | undefined;
    let cancellationSent = false;
    try {
      client = await this.connect(server, scope);
      validate();
      const taskId = job.remoteTask!.taskId;
      if (signal.aborted && signal.reason !== MCP_SUSPEND) {
        cancellationSent = true;
        await client.experimental.tasks.cancelTask(taskId, { timeout: 5000 });
        return;
      }
      const options = { signal, timeout: (server.toolTimeoutSeconds ?? 120) * 1000 };
      for (;;) {
        signal.throwIfAborted();
        validate();
        let task;
        for (let attempt = 0; ; attempt++) {
          try {
            validate();
            task = await client.experimental.tasks.getTask(taskId, options);
            break;
          } catch (error) {
            if (
              signal.aborted ||
              attempt >= 3 ||
              (error as any)?.code === -32602 ||
              (error as any)?.code === 'MCP_RECOVERY_DENIED'
            )
              throw error;
            await delay(1000 * 2 ** attempt, undefined, { signal });
          }
        }
        assert(task.taskId === taskId, 'MCP_TASK_ID', 'Task identity mismatch.');
        validate();
        update({ taskId, status: task.status });
        if (['completed', 'failed', 'cancelled'].includes(task.status))
          return await client.experimental.tasks.getTaskResult(
            taskId,
            CallToolResultSchema,
            options,
          );
        assert(
          task.status !== 'input_required',
          'MCP_TASK_INPUT',
          'Remote task needs input; automatic following paused.',
        );
        await delay(Math.max(1000, Math.min(task.pollInterval ?? 5000, 2147483647)), undefined, {
          signal,
        });
      }
    } catch (error) {
      if (client && !cancellationSent && signal.aborted && signal.reason !== MCP_SUSPEND)
        await client.experimental.tasks
          .cancelTask(job.remoteTask!.taskId, { timeout: 5000 })
          .catch(() => {});
      throw error;
    } finally {
      this.resumeSessions.delete(key);
      await client?.close().catch(() => {});
    }
  }
  private connecting = new Map<string, { fingerprint: string; promise: Promise<Client> }>();
  private credentials(server: Settings['mcp'][number]) {
    const read = (name: string) => {
      assert(
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(name),
        'MCP_ENV',
        'Invalid MCP environment variable name.',
      );
      const value = process.env[name];
      assert(value, 'MCP_ENV', `Missing host environment variable: ${name}`);
      return value;
    };
    const headers: Record<string, string> = {};
    if (server.transport === 'http') {
      for (const [name, variable] of Object.entries(server.headersFromHost || {})) {
        assert(validMcpHeader(name), 'MCP_HEADER', 'Reserved or invalid MCP header.');
        assert(!(name.toLowerCase() in headers), 'MCP_HEADER', 'Duplicate MCP header.');
        const value = read(variable);
        assert(!/[\r\n]/.test(value), 'MCP_HEADER', 'MCP header values must be single-line.');
        headers[name.toLowerCase()] = value;
      }
      assert(
        !(server.bearerTokenEnv && headers.authorization),
        'MCP_HEADER',
        'Choose either bearerTokenEnv or an Authorization header reference.',
      );
    }
    return server.transport === 'http'
      ? { token: server.bearerTokenEnv ? read(server.bearerTokenEnv) : undefined, env: {}, headers }
      : {
          token: undefined,
          headers,
          env: Object.fromEntries(
            Object.entries(server.envFromHost || {}).map(([key, name]) => [key, read(name)]),
          ),
        };
  }
  async connect(server: Settings['mcp'][number], scope = 'global'): Promise<Client> {
    assert(!this.closing, 'MCP_CLOSING', 'MCP service is shutting down.');
    const credentials = this.credentials(server);
    const key = JSON.stringify([server.id, scope]),
      fingerprint = createHash('sha256')
        .update(JSON.stringify([server, credentials]))
        .digest('hex');
    const pending = this.connecting.get(key);
    if (pending) {
      if (pending.fingerprint === fingerprint) return pending.promise;
      await pending.promise.catch(() => {});
      return this.connect(server, scope);
    }
    const work = this.open(server, key, fingerprint, credentials);
    this.connecting.set(key, { fingerprint, promise: work });
    try {
      return await work;
    } finally {
      this.connecting.delete(key);
    }
  }
  private async open(
    server: Settings['mcp'][number],
    key: string,
    fingerprint: string,
    credentials: ReturnType<McpHub['credentials']>,
  ) {
    assert(server.enabled, 'MCP_DISABLED', 'MCP server is not enabled.');
    assert(
      !server.oauth?.enabled || this.oauth,
      'MCP_OAUTH_UNAVAILABLE',
      'OAuth credential storage is unavailable.',
    );
    const old = this.clients.get(key);
    if (old?.fingerprint === fingerprint) return old.client;
    if (old) {
      await old.client.close();
      this.clients.delete(key);
    }
    const env: Record<string, string> = {};
    for (const key of [
      'PATH',
      'Path',
      'SystemRoot',
      'WINDIR',
      'TEMP',
      'TMP',
      'HOME',
      'USERPROFILE',
      'APPDATA',
      'LOCALAPPDATA',
    ])
      if (process.env[key]) env[key] = process.env[key]!;
    Object.assign(env, credentials.env);
    if (server.builtin === 'browser') {
      env.AGENTDEMO_BROWSER_HOSTS = JSON.stringify(server.browser?.allowedHosts || []);
      if (server.browser?.persistSession) {
        assert(
          this.stateDirectory,
          'BROWSER_STORAGE',
          'Persistent browser storage is unavailable.',
        );
        const folder = join(
          this.stateDirectory,
          createHash('sha256').update(JSON.parse(key)[1]).digest('hex'),
        );
        mkdirSync(folder, { recursive: true });
        env.AGENTDEMO_BROWSER_STATE = join(
          folder,
          createHash('sha256').update(server.id).digest('hex') + '.json',
        );
      }
    }
    if (server.transport === 'http')
      assert(
        !server.builtin && !!server.url && validMcpUrl(server.url),
        'MCP_URL',
        'Invalid MCP HTTP endpoint.',
      );
    const transport =
      server.transport === 'http'
        ? new StreamableHTTPClientTransport(new URL(server.url!), {
            sessionId: this.resumeSessions.get(key)?.sessionId,
            authProvider: this.oauth?.forConnection(server),
            fetch: server.oauth?.enabled
              ? (input, init) => {
                  const url = input instanceof Request ? input.url : String(input);
                  // OAuth metadata/token requests are short; MCP response streams may run much longer.
                  return url === server.url
                    ? fetch(input, { ...init, redirect: 'error' })
                    : this.oauth!.fetch(input, init);
                }
              : undefined,
            requestInit: {
              redirect: 'error',
              headers: {
                ...credentials.headers,
                ...(credentials.token ? { Authorization: `Bearer ${credentials.token}` } : {}),
              },
            },
            reconnectionOptions: {
              maxRetries: 0,
              initialReconnectionDelay: 1000,
              maxReconnectionDelay: 1000,
              reconnectionDelayGrowFactor: 1,
            },
          })
        : new StdioClientTransport({
            command: server.builtin ? process.execPath : server.command,
            args: server.builtin
              ? [
                  ...(import.meta.url.endsWith('.ts') ? ['--import', 'tsx'] : []),
                  fileURLToPath(
                    new URL(
                      import.meta.url.endsWith('.ts')
                        ? '../interactive-mcp.ts'
                        : '../interactive-mcp.js',
                      import.meta.url,
                    ),
                  ),
                  server.builtin,
                ]
              : server.args,
            env,
            cwd: server.cwd,
            stderr: 'pipe',
          });
    const resumed = this.resumeSessions.get(key);
    if (resumed && transport instanceof StreamableHTTPClientTransport)
      transport.setProtocolVersion(resumed.protocol);
    // Remote server stderr may contain credentials. Do not mirror it into chat or logs.
    if (transport instanceof StdioClientTransport) transport.stderr?.on('data', () => {});
    const client = new Client({ name: 'Amadeus', version: '0.1.0' });
    try {
      await client.connect(transport, { timeout: (server.startupTimeoutSeconds ?? 20) * 1000 });
    } catch (error) {
      await transport.close().catch(() => {});
      throw error;
    }
    this.clients.set(key, { client, transport, fingerprint });
    client.onclose = () => {
      if (this.clients.get(key)?.client === client) this.clients.delete(key);
    };
    return client;
  }
  async list(server: Settings['mcp'][number], scope = 'global', signal?: AbortSignal) {
    signal?.throwIfAborted();
    const client = await this.connect(server, scope);
    const tools: Awaited<ReturnType<Client['listTools']>>['tools'] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    const names = new Set<string>();
    do {
      signal?.throwIfAborted();
      const page = await client.listTools(cursor ? { cursor } : {}, {
        timeout: (server.startupTimeoutSeconds ?? 20) * 1000,
        signal,
      });
      for (const tool of page.tools) {
        assert(!names.has(tool.name), 'MCP_CATALOG', 'MCP server advertised duplicate tool names.');
        names.add(tool.name);
      }
      assert(names.size <= 10000, 'MCP_CATALOG', 'MCP catalog exceeds 10000 tools.');
      tools.push(...page.tools);
      cursor = page.nextCursor;
      if (cursor) {
        assert(
          !seen.has(cursor) && seen.size < 100,
          'MCP_PAGINATION',
          'MCP catalog pagination exceeded its bound.',
        );
        seen.add(cursor);
      }
    } while (cursor);
    return server.allowedTools === undefined
      ? tools
      : tools.filter((t) => server.allowedTools!.includes(t.name));
  }
  async call(
    server: Settings['mcp'][number],
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    scope = 'global',
    onTask?: (task: TaskUpdate) => void,
  ) {
    signal.throwIfAborted();
    const binding = onTask ? this.recoveryBinding(server) : undefined;
    assert(
      server.allowedTools === undefined || server.allowedTools.includes(name),
      'MCP_TOOL_DENIED',
      'MCP tool is outside the configured allowlist.',
    );
    const client = await this.connect(server, scope);
    const catalog = await this.list(server, scope, signal);
    assert(
      catalog.some((t) => t.name === name),
      'MCP_TOOL_UNKNOWN',
      'Unknown MCP tool.',
    );
    signal.throwIfAborted();
    const tool = catalog.find((t) => t.name === name)!;
    // A fresh validator keeps schema IDs from different servers from sharing a cache.
    const validation = new AjvJsonSchemaValidator().getValidator(tool.inputSchema)(args);
    assert(
      validation.valid,
      'MCP_ARGUMENTS',
      'MCP arguments do not match the advertised input schema.',
    );
    const timeout = (server.toolTimeoutSeconds ?? 120) * 1000;
    const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(timeout)]);
    if (tool.execution?.taskSupport === 'required' || tool.execution?.taskSupport === 'optional') {
      let taskId: string | undefined;
      try {
        for await (const message of client.experimental.tasks.callToolStream(
          { name, arguments: args },
          undefined,
          { signal: boundedSignal, timeout, task: {} },
        )) {
          if (message.type === 'taskCreated' || message.type === 'taskStatus') {
            taskId = message.task.taskId;
            const connection = this.clients.get(JSON.stringify([server.id, scope]));
            onTask?.({
              taskId,
              status: message.task.status,
              ...(connection
                ? {
                    recovery: {
                      binding: binding!,
                      sessionId:
                        connection.transport instanceof StreamableHTTPClientTransport
                          ? connection.transport.sessionId
                          : undefined,
                      protocol: '2025-11-25',
                    },
                  }
                : {}),
            });
          } else if (message.type === 'result') return message.result;
          else if (message.type === 'error') throw message.error;
        }
        throw new Error('MCP task ended without a result.');
      } catch (error) {
        if (taskId && boundedSignal.aborted && signal.reason !== MCP_SUSPEND)
          await client.experimental.tasks.cancelTask(taskId, { timeout: 5000 }).catch(() => {});
        throw error;
      }
    }
    return client.callTool({ name, arguments: args }, undefined, { timeout, signal });
  }
  async closeScope(scope: string) {
    await this.jobs?.closeScope(scope);
    for (const [key, pending] of this.connecting)
      if (JSON.parse(key)[1] === scope) await pending.promise.catch(() => {});
    for (const [key, connection] of this.clients)
      if (JSON.parse(key)[1] === scope) {
        await connection.client.close();
        this.clients.delete(key);
      }
  }
  async closeServer(id: string) {
    for (const [key, pending] of this.connecting)
      if (JSON.parse(key)[0] === id) await pending.promise.catch(() => {});
    for (const [key, connection] of this.clients)
      if (JSON.parse(key)[0] === id) {
        await connection.client.close();
        this.clients.delete(key);
      }
  }
  async close(reopen = false) {
    this.closing = true;
    await this.jobs?.close();
    await Promise.allSettled([...this.connecting.values()].map((x) => x.promise));
    await Promise.allSettled([...this.clients.values()].map((c) => c.client.close()));
    this.clients.clear();
    this.closing = !reopen;
    if (reopen) this.jobs?.reopen();
  }
  async catalog(
    server: Settings['mcp'][number],
    kind: 'resources' | 'templates' | 'prompts',
    cursor: string | undefined,
    scope: string,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const client = await this.connect(server, scope),
      options = { signal, timeout: (server.startupTimeoutSeconds ?? 20) * 1000 };
    if (kind === 'resources') return client.listResources({ cursor }, options);
    if (kind === 'templates') return client.listResourceTemplates({ cursor }, options);
    return client.listPrompts({ cursor }, options);
  }
  async readResource(
    server: Settings['mcp'][number],
    uri: string,
    scope: string,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    return (await this.connect(server, scope)).readResource(
      { uri },
      { signal, timeout: (server.toolTimeoutSeconds ?? 120) * 1000 },
    );
  }
  async getPrompt(
    server: Settings['mcp'][number],
    name: string,
    args: Record<string, string>,
    scope: string,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    return (await this.connect(server, scope)).getPrompt(
      { name, arguments: args },
      { signal, timeout: (server.toolTimeoutSeconds ?? 120) * 1000 },
    );
  }
}
