import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { McpHub } from '../server/services/mcp.js';
import { execute } from '../server/services/process.js';
import { Configuration } from '../server/services/settings.js';
import { Store } from '../server/storage/store.js';
import { Embeddings } from '../server/services/embedding.js';
import { Knowledge } from '../server/services/knowledge.js';
import { extract } from '../server/services/documents.js';
test('real stdio MCP handshake, discovery, call and close', async () => {
  const hub = new McpHub(),
    server = {
      id: 'fixture',
      name: 'Fixture',
      enabled: true,
      command: process.execPath,
      args: ['--import', 'tsx', resolve('tests/fixtures/mcp-server.ts')],
    };
  try {
    const catalog = await hub.list(server);
    assert.equal(catalog[0].name, 'echo');
    const result = await hub.call(
      server,
      'echo',
      { text: 'bounded fixture' },
      new AbortController().signal,
    );
    assert.equal((result.content as any[])[0].text, 'bounded fixture');
    await assert.rejects(hub.call(server, 'unknown', {}, new AbortController().signal));
  } finally {
    await hub.close();
  }
});
test('host backend reports actual exit code and output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentdemo-command-')),
    config = new Configuration(join(dir, 'settings.json'));
  const result = await execute('echo approved-fixture', dir, new AbortController().signal, 5000, {
    ...config.get(),
    commandBackend: 'approval-host' as const,
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /approved-fixture/);
  assert.equal(result.timedOut, false);
});
test('command timeout terminates the owned process', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentdemo-timeout-')),
    config = new Configuration(join(dir, 'settings.json'));
  const command = '"' + process.execPath + '" -e "setInterval(function(){},1000)"';
  const start = Date.now();
  const result = await execute(command, dir, new AbortController().signal, 300, {
    ...config.get(),
    commandBackend: 'approval-host' as const,
  });
  assert.equal(result.timedOut, true);
  assert(Date.now() - start < 10000);
});
test('hybrid retrieval uses configured vectors but never another scope', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'agentdemo-hybrid-')),
    store = new Store(join(dir, 'db.sqlite'));
  const embeddings = new Embeddings(() => ({
    baseUrl: 'https://embedding.example',
    apiKey: 'test-only',
    model: 'fixture',
  }));
  t.mock.method(globalThis, 'fetch', async (_url: any, options: any) => {
    const { input } = JSON.parse(options.body);
    return Response.json({
      data: input.map((text: string, index: number) => ({
        index,
        embedding: text.includes('car') || text.includes('automobile') ? [1, 0] : [0, 1],
      })),
    });
  });
  const kb = new Knowledge(store, embeddings),
    a = kb.import('project:a', 'vehicle.txt', 'automobile propulsion uses an engine') as any,
    b = kb.import('project:b', 'private.txt', 'car secret belongs elsewhere') as any;
  await kb.index(a.id);
  await kb.index(b.id);
  const result = await kb.hybrid(['project:a'], 'car', 3);
  assert.equal(result[0].name, 'vehicle.txt');
  assert(result.every((r) => r.scope === 'project:a'));
  store.close();
});
test('CSV and XLSX extraction preserve cells', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentdemo-doc-'));
  const csv = join(dir, 'data.csv');
  await writeFile(csv, 'name,value\nalpha,17\n');
  assert((await extract(csv)).includes('alpha,17'));
  const { default: Excel } = await import('exceljs');
  const book = new Excel.Workbook();
  book.addWorksheet('Data').addRows([
    ['name', 'value'],
    ['beta', 42],
  ]);
  const xlsx = join(dir, 'data.xlsx');
  await book.xlsx.writeFile(xlsx);
  assert((await extract(xlsx)).includes('beta'));
  assert((await extract(xlsx)).includes('42'));
});
test('public configuration exposes key presence but never the key value', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentdemo-config-'));
  const config = new Configuration(join(dir, 'settings.json'));
  config.save({
    ...{ ...config.get(), commandBackend: 'approval-host' as const },
    profiles: [
      {
        id: 'p',
        name: 'p',
        transport: 'openai-chat',
        baseUrl: 'https://example.com',
        apiKey: 'never-return-this',
        model: 'm',
      },
    ],
    defaultProfileId: 'p',
  });
  assert(!JSON.stringify(config.public()).includes('never-return-this'));
  assert.equal(config.public().profiles[0].hasKey, true);
  assert.equal(
    (await readFile(join(dir, 'settings.json'), 'utf8')).includes('never-return-this'),
    process.platform !== 'win32',
  );
  assert.equal(
    new Configuration(join(dir, 'settings.json')).profile('p').apiKey,
    'never-return-this',
  );
});

test('host command chains preserve their tail and large output declares truncation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentdemo-output-'));
  const config = new Configuration(join(dir, 'settings.json'));
  const chain =
    process.platform === 'win32'
      ? 'echo FIRST & echo SECOND & echo FINAL'
      : 'echo FIRST; echo SECOND; echo FINAL';
  const result = await execute(chain, dir, new AbortController().signal, 5000, {
    ...config.get(),
    commandBackend: 'approval-host' as const,
  });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /FIRST[\s\S]*SECOND[\s\S]*FINAL/);
  assert.equal(result.truncated, false);
  await writeFile(join(dir, 'output.cjs'), "process.stdout.write('x'.repeat(1100000)+'TAIL')");
  const large = await execute(
    '"' + process.execPath + '" output.cjs',
    dir,
    new AbortController().signal,
    10000,
    { ...config.get(), commandBackend: 'approval-host' as const },
  );
  assert.equal(large.code, 0);
  assert.equal(large.truncated, true);
  assert.equal(large.stdout.length, 1000000);
});

test('credential reuse is origin-bound and diagnostic configuration omits persisted secrets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'config-scope-')),
    path = join(dir, 'settings.json'),
    config = new Configuration(path, { persistSecrets: false });
  const p = {
    id: 'p',
    name: 'p',
    transport: 'openai-chat',
    baseUrl: 'https://original.example',
    apiKey: 'fixture-secret',
    model: 'm',
  };
  config.save({
    ...{ ...config.get(), commandBackend: 'approval-host' as const },
    profiles: [p],
    defaultProfileId: 'p',
  });
  assert.equal(
    { ...config.get(), commandBackend: 'approval-host' as const }.profiles[0].apiKey,
    'fixture-secret',
  );
  assert.ok(!(await readFile(path, 'utf8')).includes('fixture-secret'));
  config.save({
    ...{ ...config.get(), commandBackend: 'approval-host' as const },
    profiles: [{ ...p, apiKey: undefined, baseUrl: 'https://other.example' }],
  });
  assert.equal(
    { ...config.get(), commandBackend: 'approval-host' as const }.profiles[0].apiKey,
    '',
  );
});

test(
  'an exited launcher with inherited output handles cannot hold a command forever',
  { timeout: 15000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentdemo-inherited-pipe-'));
    const config = new Configuration(join(dir, 'settings.json'));
    await writeFile(
      join(dir, 'launcher.cjs'),
      `
    const {spawn} = require('node:child_process');
    const fs = require('node:fs');
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},10000)'],
      {stdio:['ignore', process.stdout, process.stderr], windowsHide:true});
    fs.writeFileSync('child.pid', String(child.pid));
    child.unref();
    console.log('SERVER_READY_FIXTURE');
    process.exit(0);
  `,
    );
    let observed = '';
    const started = Date.now();
    try {
      try {
        const result = await execute(
          '"' + process.execPath + '" launcher.cjs',
          dir,
          new AbortController().signal,
          700,
          { ...config.get(), commandBackend: 'approval-host' as const },
          (_stream, chunk) => {
            observed += chunk;
          },
        );
        assert(result.timedOut || result.code === 0, JSON.stringify(result));
      } catch (error: any) {
        if (error.code === 'ERR_ASSERTION') throw error;
        assert.equal(error.code, 'EXECUTION_OUTCOME_UNKNOWN');
        assert.match(error.message, /SERVER_READY_FIXTURE/);
      }
      assert.match(observed, /SERVER_READY_FIXTURE/);
      assert(Date.now() - started < 5000, 'deadline must not depend on close');
    } finally {
      try {
        process.kill(Number(await readFile(join(dir, 'child.pid'), 'utf8')));
      } catch {}
    }
  },
);

test(
  'abort returns promptly and streamed output arrives before completion',
  { timeout: 10000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentdemo-cancel-output-'));
    const config = new Configuration(join(dir, 'settings.json'));
    const controller = new AbortController();
    let received = false;
    const started = Date.now();
    const result = await execute(
      '"' + process.execPath + '" -e "console.log(123);setInterval(()=>{},1000)"',
      dir,
      controller.signal,
      30000,
      { ...config.get(), commandBackend: 'approval-host' as const },
      () => {
        received = true;
        controller.abort();
      },
    );
    assert(received);
    assert(Date.now() - started < 5000);
    assert(result.code !== 0);
  },
);

test(
  'missing close after termination returns an unknown outcome within the grace period',
  { timeout: 8000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'agentdemo-no-close-'));
    const config = new Configuration(join(dir, 'settings.json'));
    const fake = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      pid: undefined,
      unref() {},
      kill() {
        return false;
      },
    });
    const mocked = t.mock.method(childProcess, 'spawn', () => fake as any);
    syncBuiltinESMExports();
    const started = Date.now();
    try {
      const pending = execute('fixture', dir, new AbortController().signal, 20, {
        ...config.get(),
        commandBackend: 'approval-host' as const,
      });
      fake.stdout.write('already changed external state');
      await assert.rejects(
        pending,
        (error: any) =>
          error.code === 'EXECUTION_OUTCOME_UNKNOWN' &&
          /already changed external state/.test(error.message),
      );
      assert(Date.now() - started < 4000);
      assert(fake.stdout.destroyed && fake.stderr.destroyed);
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
    }
  },
);

test('an error after spawn is unknown, not permission to replay', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'agentdemo-postspawn-'));
  const config = new Configuration(join(dir, 'settings.json'));
  const fake = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: undefined,
    unref() {},
    kill() {
      return false;
    },
  });
  const mocked = t.mock.method(childProcess, 'spawn', () => fake as any);
  syncBuiltinESMExports();
  try {
    const pending = execute('fixture', dir, new AbortController().signal, 5000, {
      ...config.get(),
      commandBackend: 'approval-host',
    });
    fake.emit('spawn');
    fake.emit('error', Object.assign(new Error('post-spawn failure'), { code: 'EPERM' }));
    await assert.rejects(pending, (error: any) => error.code === 'EXECUTION_OUTCOME_UNKNOWN');
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
    fake.stdout.destroy();
    fake.stderr.destroy();
  }
});
