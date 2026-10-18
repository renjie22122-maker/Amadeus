import { AppError } from '../server/core/errors.js';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Runtime } from '../server/core/runtime.js';
import { createApp } from '../server/http/app.js';
import type { ModelProvider } from '../server/providers/protocol.js';
import { Configuration } from '../server/services/settings.js';
import { Store } from '../server/storage/store.js';
async function setup(provider: ModelProvider) {
  const dir = await mkdtemp(join(tmpdir(), 'agentdemo-runtime-'));
  const store = new Store(join(dir, 'db.sqlite')),
    config = new Configuration(join(dir, 'config.json'));
  config.save({
    ...{ ...config.get(), commandBackend: 'approval-host' as const },
    profiles: [
      {
        id: 'test',
        name: 'Test',
        transport: 'openai-chat',
        baseUrl: 'https://example.com',
        model: 'test',
      },
    ],
    defaultProfileId: 'test',
  });
  store.put('conversation', {
    id: 'chat',
    title: 'Runtime test',
    projectId: null,
    profileId: 'test',
    reasoning: 'auto',
    permission: 'ask',
    createdAt: 1,
    updatedAt: 1,
    pinned: false,
    archived: false,
    parentId: null,
    forkEvent: null,
    skillIds: [],
    knowledge: true,
    memory: true,
  });
  return { dir, store, config, runtime: new Runtime(store, config, dir, () => provider) };
}
const result = (content: string, calls?: any[]) => ({
  message: { role: 'assistant' as const, content, calls },
  usage: { input: 10, output: 2, cached: 0, measured: true },
});
async function until(fn: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('Timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}
test('plain answer finishes in one model call without compulsory finish or review', async () => {
  const f = await setup({
    complete: async (r) => {
      r.onText('Hello');
      return result('Hello');
    },
  });
  const r = f.runtime.start('chat', 'Hi');
  await until(() => f.store.get<any>('run', r.id).status === 'completed');
  const done = f.store.get<any>('run', r.id);
  assert.equal(done.modelCalls, 1);
  assert.equal(done.inputTokens, 10);
  assert.equal(done.estimatedUsd, null);
  assert.equal(f.store.events('chat').filter((e) => e.type === 'tool.started').length, 0);
  await f.runtime.shutdown();
  f.store.close();
});
test('question waits for user and resumes same run', async () => {
  let n = 0;
  const f = await setup({
    complete: async () =>
      ++n === 1
        ? result('', [
            {
              id: 'q',
              name: 'ask_user',
              arguments: { question: 'Which format?', options: ['CSV', 'JSON'] },
            },
          ])
        : result('Selected JSON'),
  });
  const r = f.runtime.start('chat', 'Prepare output');
  await until(() => f.store.get<any>('run', r.id).status === 'waiting_user');
  assert.equal(n, 1);
  const q = f.store.list<any>('input')[0];
  f.runtime.inputs.answer(q.id, 'JSON', true);
  await until(() => f.store.get<any>('run', r.id).status === 'completed');
  assert.equal(n, 2);
  assert(
    f.store
      .get<any>('run', r.id)
      .checkpoints.some((m: any) => m.role === 'tool' && m.content === 'JSON'),
  );
  await f.runtime.shutdown();
  f.store.close();
});
test('approval denial does not execute command and model sees denial', async () => {
  let n = 0;
  const f = await setup({
    complete: async () =>
      ++n === 1
        ? result('', [
            {
              id: 'cmd',
              name: 'run_command',
              arguments: { command: 'echo forbidden', reason: 'Testing authorization' },
            },
          ])
        : result('Command was denied'),
  });
  const work = await mkdtemp(join(tmpdir(), 'agentdemo-approved-project-'));
  f.store.put('project', { id: 'p', name: 'p', folders: [work], createdAt: 1 });
  f.store.put('conversation', { ...f.store.get<any>('conversation', 'chat'), projectId: 'p' });
  const r = f.runtime.start('chat', 'Try command');
  await until(() => f.store.get<any>('run', r.id).status === 'waiting_approval');
  f.runtime.inputs.answer(f.store.list<any>('input')[0].id, 'Do not execute', false);
  await until(() => f.store.get<any>('run', r.id).status === 'completed');
  assert(
    f.store
      .get<any>('run', r.id)
      .checkpoints.some((m: any) => m.role === 'tool' && m.content.includes('APPROVAL_DENIED')),
  );
  assert.equal(f.store.unknownEffects('chat').length, 0);
  await f.runtime.shutdown();
  f.store.close();
});
test('steering arrives at a model boundary and is not lost at completion', async () => {
  let release: () => void = () => {},
    count = 0;
  const gate = new Promise<void>((r) => (release = r));
  const f = await setup({
    complete: async (r) => {
      count++;
      if (count === 1) await gate;
      else assert(r.messages.some((m) => m.content.includes('Use blue')));
      return result(count === 1 ? 'Initial' : 'Blue');
    },
  });
  const r = f.runtime.start('chat', 'Design');
  await until(() => count === 1);
  f.runtime.steer('chat', 'Use blue');
  release();
  await until(() => f.store.get<any>('run', r.id).status === 'completed');
  assert.equal(count, 2);
  await f.runtime.shutdown();
  f.store.close();
});
test('child receives parent session knowledge, minimal context and no write tools', async () => {
  let parentCalls = 0;
  const f = await setup({
    complete: async (r) => {
      const facts = r.messages.findLast((m) => m.contextKind === 'runtime-snapshot')!.content;
      const isChild = facts.includes('"depth":1');
      if (isChild) {
        assert(!r.tools.some((t) => t.name === 'write_file' || t.name === 'run_command'));
        assert(facts.includes('session:chat'));
        return result('Child inspected evidence');
      }
      parentCalls++;
      if (parentCalls === 1)
        return result('', [
          {
            id: 'spawn',
            name: 'spawn_agent',
            arguments: {
              task: 'Independently inspect the provided knowledge for a bounded answer.',
              deliverable: 'Return one sourced finding.',
            },
          },
        ]);
      return result('Parent incorporates child');
    },
  });
  f.runtime.knowledge.import('session:chat', 'notes', 'cobalt = blue');
  const r = f.runtime.start('chat', 'Delegate this evidence check');
  await until(() => f.store.get<any>('run', r.id).status === 'completed', 5000);
  const children = f.store.runs().filter((x) => x.parentRunId === r.id);
  assert.equal(children.length, 1);
  assert.equal(children[0].status, 'completed');
  await f.runtime.shutdown();
  f.store.close();
});
test('service recovery marks live tasks interrupted and does not replay', async () => {
  const f = await setup({ complete: async () => result('unused') });
  f.store.put('run', {
    id: 'dead',
    conversationId: 'chat',
    status: 'running',
    createdAt: 1,
    updatedAt: 1,
  });
  f.store.beginEffect('dead', 'run_command', { command: 'unknown' });
  f.store.recover();
  assert.equal(f.store.get<any>('run', 'dead').status, 'interrupted');
  const resumed = f.runtime.start('chat', 'Explain the interrupted operation');
  assert.equal(resumed.recoveryOnly, true);
  await until(() => f.store.get<any>('run', resumed.id).status === 'interrupted');
  assert.equal(f.store.unknownEffects('chat').length, 1);
  f.store.close();
});
test('HTTP requires local host, cookie and CSRF for state changes', async () => {
  const f = await setup({ complete: async () => result('test') });
  const { app } = await createApp({ directory: f.dir, runtime: f.runtime });
  const denied = await app.inject({
    method: 'GET',
    url: '/api/state',
    headers: { host: '127.0.0.1:8810' },
  });
  assert.equal(denied.statusCode, 401);
  assert.equal(
    (await app.inject({ url: '/api/bootstrap', headers: { host: 'evil.test' } })).statusCode,
    403,
  );
  const boot = await app.inject({ url: '/api/bootstrap', headers: { host: '127.0.0.1:8810' } });
  const cookie = String(boot.headers['set-cookie']).split(';')[0],
    csrf = boot.json().csrf;
  f.store.put('memory', { id: 'state-memory', content: 'library only' });
  const shell = (
    await app.inject({ url: '/api/state?view=shell', headers: { host: '127.0.0.1:8810', cookie } })
  ).json();
  assert.equal(shell.memories, undefined);
  assert.equal(shell.documents, undefined);
  assert(Array.isArray(shell.conversations));
  const full = (
    await app.inject({ url: '/api/state', headers: { host: '127.0.0.1:8810', cookie } })
  ).json();
  assert(full.memories.some((m: any) => m.id === 'state-memory'));

  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/conversations',
        headers: { host: '127.0.0.1:8810', cookie },
        payload: {},
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/conversations',
        headers: { host: '127.0.0.1:8810', cookie, 'x-csrf-token': csrf },
        payload: {},
      })
    ).statusCode,
    200,
  );
  await app.close();
});

test('failed stream retains partial text and measured usage without claiming completion', async () => {
  const f = await setup({
    complete: async (r) => {
      r.onText('Partial answer');
      throw Object.assign(new Error('truncated'), {
        usage: { input: 70, output: 30, cached: 0, measured: true },
      });
    },
  });
  const run = f.runtime.start('chat', 'Test interruption');
  await until(() => f.store.get<any>('run', run.id).status === 'failed');
  const r = f.store.get<any>('run', run.id);
  assert.equal(r.modelCalls, 1);
  assert.equal(r.inputTokens, 70);
  assert.equal(r.outputTokens, 30);
  assert(
    f.store
      .events('chat')
      .some(
        (e) =>
          e.type === 'assistant.message' && e.data.incomplete && e.data.text === 'Partial answer',
      ),
  );
  await f.runtime.shutdown();
  f.store.close();
});
test('missing provider usage is marked incomplete, not known zero', async () => {
  const f = await setup({
    complete: async () => {
      throw new Error('network failure');
    },
  });
  const run = f.runtime.start('chat', 'Test network failure');
  await until(() => f.store.get<any>('run', run.id).status === 'failed');
  assert.equal(f.store.get<any>('run', run.id).usageComplete, false);
  assert.equal(f.store.get<any>('run', run.id).estimatedUsd, null);
  await f.runtime.shutdown();
  f.store.close();
});

test('recursive children finish under one shared model pool', async () => {
  const f = await setup({
    complete: async (request) => {
      const facts = request.messages.findLast((m) => m.contextKind === 'runtime-snapshot')!.content;
      if (facts.includes('"depth":2')) return result('Grandchild result');
      const spawned = request.messages.some(
        (m) => m.role === 'tool' && m.content.includes('runId'),
      );
      if (!spawned)
        return result('', [
          {
            id: 'delegate-' + (facts.includes('"depth":1') ? 'child' : 'root'),
            name: 'spawn_agent',
            arguments: {
              task: 'Inspect one independent detail and return a compact observation.',
              deliverable: 'Return exactly one useful finding.',
            },
          },
        ]);
      return result('Incorporated delegated result');
    },
  });
  const r = f.runtime.start('chat', 'Delegate a bounded tree check');
  await until(() => f.store.get<any>('run', r.id).status === 'completed', 5000);
  const runs = f.store.runs();
  assert.equal(runs.length, 3);
  assert(runs.every((r) => r.status === 'completed'));
  assert.equal(Math.max(...runs.map((r) => r.depth)), 2);
  await f.runtime.shutdown();
  f.store.close();
});

test('isolated worker tools, project preservation and delegation off are enforced by host', async () => {
  const { writeFile, readFile } = await import('node:fs/promises');
  const f = await setup({
    complete: async (r) => {
      const child = r.messages
        .findLast((m) => m.contextKind === 'runtime-snapshot')!
        .content.includes('"depth":1');
      if (child) {
        assert.ok(r.tools.some((t) => t.name === 'write_file'));
        assert.ok(
          !r.tools.some((t) => t.name === 'run_command'),
          'Host backend must never be exposed to child',
        );
        if (!r.messages.some((m) => m.role === 'tool'))
          return result('', [
            {
              id: 'child-write',
              name: 'write_file',
              arguments: { path: 'child.txt', content: 'isolated' },
            },
          ]);
        return result('child complete');
      }
      if (!r.messages.some((m) => m.role === 'tool'))
        return result('', [
          {
            id: 'spawn',
            name: 'spawn_agent',
            arguments: {
              task: 'Write a bounded child file in your isolated copy.',
              deliverable: 'Create child.txt and report.',
              mode: 'isolated',
            },
          },
        ]);
      return result('parent complete');
    },
  });
  const project = await mkdtemp(join(tmpdir(), 'agentdemo-project-'));
  await writeFile(join(project, 'base.txt'), 'parent');
  f.store.put('project', { id: 'p', name: 'p', folders: [project], createdAt: 1 });
  f.store.put('conversation', { ...f.store.get<any>('conversation', 'chat'), projectId: 'p' });
  const run = f.runtime.start('chat', 'delegate');
  await until(() => f.store.get<any>('run', run.id).status === 'completed', 5000);
  const child = f.store.runs().find((r) => r.parentRunId === run.id)!;
  assert.equal(child.status, 'completed');
  await assert.rejects(readFile(join(project, 'child.txt')));
  const review: any = await f.runtime.inspectChanges(run, child.id);
  assert.equal(review.changes[0].path, '@0/child.txt');
  f.store.put('conversation', { ...f.store.get<any>('conversation', 'chat'), teamStrategy: 'off' });
  const context = await f.runtime.context(run);
  assert.ok(!f.runtime.registry.specs(context).some((t) => t.name === 'spawn_agent'));
  await assert.rejects(
    f.runtime.spawn(run, 'Another independent task here', 'Return a real result'),
    /disabled/,
  );
  await f.runtime.shutdown();
  f.store.close();
});

test('inspection shows request usage separately from totals and enforces file/run scope', async () => {
  const f = await setup({ complete: async () => result('A direct answer') });
  const first = f.runtime.start('chat', 'First question');
  await until(() => f.store.get<any>('run', first.id).status === 'completed');
  const second = f.runtime.start('chat', 'Second question');
  await until(() => f.store.get<any>('run', second.id).status === 'completed');
  const { app } = await createApp({ directory: f.dir, runtime: f.runtime });
  try {
    const boot = await app.inject({ url: '/api/bootstrap', headers: { host: '127.0.0.1:8810' } });
    const headers = {
      host: '127.0.0.1:8810',
      cookie: String(boot.headers['set-cookie']).split(';')[0],
    };
    const saved = f.store.get<any>('run', second.id);
    const { sampleContext } = await import('../server/core/context-budget.js');
    const selectedProfile = {
      ...f.runtime.config.profile(saved.profileId),
      reasoning: 'max' as const,
    };
    saved.reasoning = 'max';
    saved.contextSample = sampleContext(saved.checkpoints, [], selectedProfile, 10);
    f.store.put('run', saved);
    let contextBuilds = 0;
    const originalContext = f.runtime.context.bind(f.runtime);
    f.runtime.context = async (...args: Parameters<typeof originalContext>) => {
      contextBuilds++;
      return originalContext(...args);
    };
    const originalRuns = f.store.runs.bind(f.store);
    f.store.runs = () => {
      throw Error('Context inspection must not scan all full runs');
    };
    f.store.event('chat', first.id, 'context.compacted', { beforeTokens: 100, afterTokens: 20 });
    const response = await app.inject({ url: '/api/conversations/chat/context', headers });
    assert.equal(response.statusCode, 200);
    const view = response.json();
    assert.equal(view.compactionCount, 1);
    assert.equal(view.compactions.length, 0);
    assert.equal(view.measuredInput, 10);
    assert.notEqual(view.budget.method, 'estimated');
    assert.ok(view.messages.some((m: any) => m.role === 'system'));
    assert.ok(view.characters > 0);
    assert.equal(view.capacity, 65536);
    assert.ok(view.lastCompactionCheck.checkedAt > 0);
    assert.equal(view.lastCompactionCheck.required, false);
    const summary = await app.inject({ url: '/api/conversations/chat/context?summary=1', headers });
    assert.equal(summary.json().messages.length, 0);
    assert.equal(summary.json().total, view.total);
    const page = await app.inject({ url: '/api/conversations/chat/context?offset=10', headers });
    assert.equal(page.statusCode, 200);
    assert.equal(contextBuilds, 1);
    const changed = f.store.get<any>('run', second.id);
    changed.checkpoints.push({ role: 'user', content: 'new checkpoint marker' });
    f.store.put('run', changed);
    const fresh = await app.inject({ url: '/api/conversations/chat/context?summary=1', headers });
    assert.equal(fresh.json().total, view.total + 1);
    assert.equal(contextBuilds, 2);
    f.store.runs = originalRuns;

    f.store.put('run', {
      ...f.store.get<any>('run', first.id),
      id: 'foreign',
      conversationId: 'other',
    });
    assert.equal(
      (await app.inject({ url: '/api/conversations/chat/context?runId=foreign', headers }))
        .statusCode,
      403,
    );
    const scope = await f.runtime.filesForConversation(f.store.get<any>('conversation', 'chat'));
    await scope.write('preview.html', '<button>Preview</button>');
    assert.equal(
      (
        await app.inject({
          url: '/api/conversations/chat/files?view=text&path=preview.html',
          headers,
        })
      ).json().text,
      '<button>Preview</button>',
    );
    assert.equal(
      (
        await app.inject({
          url: '/api/conversations/chat/files?view=text&path=..%2F..%2Fsettings.json',
          headers,
        })
      ).statusCode,
      403,
    );
    assert.notEqual(
      (
        await app.inject({
          url: '/api/conversations/chat/files?view=asset&path=preview.html',
          headers,
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          url: '/api/conversations/chat/files',
          headers: { host: '127.0.0.1:8810' },
        })
      ).statusCode,
      401,
    );
  } finally {
    await app.close();
  }
});

test('proven pre-execution rejection does not leave an unknown effect', async () => {
  const { NotStartedError } = await import('../server/core/errors.js');
  let count = 0;
  const f = await setup({
    complete: async () =>
      ++count === 1
        ? result('', [{ id: 'blocked', name: 'preflight_test', arguments: {} }])
        : result('Not executed.'),
  });
  const { z } = await import('zod');
  f.runtime.registry.add({
    name: 'preflight_test',
    description: 'test',
    effect: 'write',
    schema: z.object({}),
    run: async () => {
      throw new NotStartedError('NOT_STARTED', 'preflight refused before launch');
    },
  });
  const c = f.store.get<any>('conversation', 'chat');
  f.store.put('conversation', { ...c, permission: 'trusted' });
  const run = f.runtime.start('chat', 'test');
  await until(() => f.store.get<any>('run', run.id).status === 'completed');
  assert.equal(f.store.unknownEffects('chat').length, 0);
  assert.equal(
    (f.store.db.prepare('SELECT state FROM effects WHERE run_id=?').get(run.id) as any).state,
    'not_started',
  );
  f.store.close();
});

test('compaction retains current request and complete tool groups; failed summaries retain history', async () => {
  const { COMPACT } = await import('../server/core/prompts.js');
  let fail = false;
  const f = await setup({
    complete: async (req) => {
      assert.equal(req.messages[0].content, COMPACT);
      return result(fail ? '' : 'Original requirement: Cedar-73, retention 17 days.');
    },
  });
  const profile = { ...f.config.profile(), contextWindow: 32768, maxOutputTokens: 2048 };
  const messages: any[] = [
    { role: 'system', content: 'System' },
    {
      role: 'user',
      content: 'Earlier constraint: do not delete the source dataset; preserve 17 days of logs.',
    },
    { role: 'user', content: 'Current requirement must remain verbatim.' },
    {
      role: 'user',
      contextKind: 'runtime-snapshot',
      content: 'Current scope must remain verbatim.',
    },
  ];
  for (let i = 0; i < 12; i++)
    messages.push(
      {
        role: 'assistant',
        content: 'old '.repeat(1500),
        calls: [{ id: 'c' + i, name: 'read_file', arguments: {} }],
      },
      { role: 'tool', callId: 'c' + i, content: 'data '.repeat(1500) },
    );
  const run: any = {
    id: 'compact-fixture',
    conversationId: 'chat',
    status: 'running',
    checkpoints: messages,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    modelCalls: 0,
    estimatedUsd: null,
  };
  f.store.put('task-board', {
    id: run.id,
    revision: 7,
    tasks: [{ id: 'remaining', status: 'blocked', kind: 'verify', dependsOn: [], owner: null }],
  });
  await (f.runtime as any).contextManager.compact(run, profile, new AbortController().signal, []);
  assert.ok(
    run.checkpoints.some(
      (m: any) =>
        m.contextKind === 'task-snapshot' &&
        m.content.includes('"revision":7') &&
        m.content.includes('"status":"blocked"'),
    ),
  );

  assert.ok(
    run.checkpoints.some((m: any) => m.content === 'Current requirement must remain verbatim.'),
  );
  assert.ok(run.checkpoints.some((m: any) => m.content === 'Current scope must remain verbatim.'));
  const calls = new Set(run.checkpoints.flatMap((m: any) => (m.calls || []).map((c: any) => c.id)));
  for (const m of run.checkpoints) if (m.role === 'tool') assert.ok(calls.has(m.callId));
  assert.ok(
    run.checkpoints.some(
      (m: any) =>
        m.contextKind === 'source-ledger' && m.content.includes('do not delete the source dataset'),
    ),
  );
  for (let i = 0; i < 12; i++)
    run.checkpoints.push({ role: 'assistant', content: 'more investigation '.repeat(4000) });
  await (f.runtime as any).contextManager.compact(run, profile, new AbortController().signal, []);
  assert.ok(
    run.checkpoints.some(
      (m: any) =>
        m.contextKind === 'source-ledger' && m.content.includes('do not delete the source dataset'),
    ),
  );
  run.checkpoints = structuredClone(messages);
  const before = JSON.stringify(run.checkpoints);
  fail = true;
  await (f.runtime as any).contextManager.compact(run, profile, new AbortController().signal, []);
  assert.notEqual(JSON.stringify(run.checkpoints), before);
  assert.ok(run.checkpoints.some((m: any) => m.content.includes('archived verbatim')));
  assert.ok(
    f.store
      .list<any>('spill')
      .some((s: any) => s.conversationId === 'chat' && s.text.includes('data data')),
  );
  f.store.close();
});

test('unavailable execution backend suppresses later commands in the same batch without repeat approval', async () => {
  let count = 0;
  const f = await setup({
    complete: async (req) => {
      if (++count === 1)
        return result(
          '',
          [1, 2, 3].map((i) => ({
            id: 'cmd' + i,
            name: 'run_command',
            arguments: { command: 'echo never', reason: 'readiness test' },
          })),
        );
      assert.ok(!req.tools.some((t) => t.name === 'run_command'));
      return result('Backend unavailable; no commands executed.');
    },
  });
  const work = await mkdtemp(join(tmpdir(), 'agentdemo-blocked-'));
  f.store.put('project', { id: 'p', name: 'p', folders: [work], createdAt: 1 });
  f.store.put('conversation', { ...f.store.get<any>('conversation', 'chat'), projectId: 'p' });
  // Deliberately load old invalid configuration: runtime must handle it, even if new saves reject it.
  const original = f.config.get.bind(f.config);
  f.config.get = () => ({ ...original(), commandBackend: 'native-windows', nativePython: '' });
  const run = f.runtime.start('chat', 'Probe the command backend');
  await until(() => f.store.get<any>('run', run.id).status === 'waiting_approval');
  f.runtime.inputs.answer(f.store.list<any>('input')[0].id, 'Approved', true);
  await until(() => f.store.get<any>('run', run.id).status === 'completed');
  assert.equal(f.store.list<any>('input').length, 1);
  assert.equal(f.store.unknownEffects('chat').length, 0);
  assert.ok(f.store.get<any>('run', run.id).executionBlock);
  f.store.close();
});

test('edit preconditions and invalid arguments do not create uncertain writes', async () => {
  let count = 0;
  const f = await setup({
    complete: async () =>
      ++count === 1
        ? result('', [
            {
              id: 'missing',
              name: 'edit_file',
              arguments: { path: 'file.txt', oldText: 'absent', newText: 'changed' },
            },
            { id: 'invalid', name: 'write_file', arguments: { path: 'file.txt' } },
          ])
        : result('No edits applied.'),
  });
  const { writeFile, readFile } = await import('node:fs/promises');
  const run: any = { id: 'placeholder', conversationId: 'chat' };
  const ctx = await f.runtime.context(run);
  await writeFile(join(ctx.files.roots[0], 'file.txt'), 'original');
  const r = f.runtime.start('chat', 'Try invalid edits');
  await until(() => f.store.get<any>('run', r.id).status === 'completed');
  assert.equal(f.store.unknownEffects('chat').length, 0);
  assert.equal(await readFile(join(ctx.files.roots[0], 'file.txt'), 'utf8'), 'original');
  f.store.close();
});

test('waiting for command approval has no started effect and cancellation needs no inspection', async () => {
  const f = await setup({
    complete: async () =>
      result('', [
        {
          id: 'pending',
          name: 'run_command',
          arguments: { command: 'echo never', reason: 'Approval journal test' },
        },
      ]),
  });
  const work = await mkdtemp(join(tmpdir(), 'agentdemo-awaiting-'));
  f.store.put('project', { id: 'p', name: 'p', folders: [work], createdAt: 1 });
  f.store.put('conversation', { ...f.store.get<any>('conversation', 'chat'), projectId: 'p' });
  const r = f.runtime.start('chat', 'Wait for approval');
  await until(() => f.store.get<any>('run', r.id).status === 'waiting_approval');
  assert.equal(f.store.unknownEffects('chat').length, 0);
  f.runtime.stop(r.id);
  await until(() => f.store.get<any>('run', r.id).status === 'interrupted');
  assert.equal(f.store.unknownEffects('chat').length, 0);
  f.store.close();
});

test('recovery reconciles exact file contents but leaves arbitrary commands uncertain', async () => {
  const { inspectEffects } = await import('../server/services/recovery.js');
  const f = await setup({
    complete: async (req) => {
      assert.ok(
        req.tools.every(
          (t) =>
            ['read', 'network'].includes(t.effect) ||
            ['ask_user', 'resolve_effect'].includes(t.name),
        ),
      );
      return result('Inspection only.');
    },
  });
  f.store.put('run', {
    id: 'old',
    conversationId: 'chat',
    status: 'interrupted',
    createdAt: 1,
    updatedAt: 1,
  });
  const write = f.store.beginEffect('old', 'write_file', { path: 'done.txt', content: 'expected' });
  f.store.beginEffect('old', 'run_command', { command: 'unknown side effect' });
  const ctx = await f.runtime.context({ id: 'old', conversationId: 'chat' } as any);
  await ctx.files.write('done.txt', 'expected');
  const checked = await inspectEffects(f.store, ctx.files, 'chat');
  assert.deepEqual(checked.resolved, [write]);
  assert.equal(checked.unresolved.length, 1);
  const run = f.runtime.start('chat', 'Inspect results');
  await until(() => f.store.get<any>('run', run.id).status === 'interrupted');
  assert.equal(f.store.unknownEffects('chat').length, 1);
  f.store.close();
});

test('retry authorization records uncertainty without replaying the operation', async () => {
  const f = await setup({
    complete: async () => {
      throw new Error('must not run');
    },
  });
  f.store.put('run', {
    id: 'uncertain',
    conversationId: 'chat',
    status: 'interrupted',
    createdAt: 1,
    updatedAt: 1,
  });
  const effect = f.store.beginEffect('uncertain', 'run_command', { command: 'unknown' });
  const { app } = await createApp({ directory: f.dir, runtime: f.runtime });
  const boot = await app.inject({ url: '/api/bootstrap', headers: { host: '127.0.0.1:8810' } });
  const headers = {
    host: '127.0.0.1:8810',
    cookie: String(boot.headers['set-cookie']).split(';')[0],
    'x-csrf-token': boot.json().csrf,
  };
  const res = await app.inject({
    method: 'POST',
    url: '/api/effects/' + effect + '/allow-retry',
    headers,
    payload: {},
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().executed, false);
  const row = f.store.db.prepare('SELECT state,result FROM effects WHERE id=?').get(effect) as any;
  assert.equal(row.state, 'retry_authorized');
  assert.match(row.result, /remains unknown/);
  assert.equal(f.store.runs().length, 1);
  await app.close();
});

test('protocol repair corrects once and accounts both calls without executing tools', async () => {
  let calls = 0;
  const f = await setup({
    complete: async () => {
      if (++calls === 1) throw new AppError('INVALID_ARGUMENTS', 'bad JSON', 502);
      return result('Corrected answer');
    },
  });
  try {
    const r = f.runtime.start('chat', 'Hello');
    await until(() => f.store.get<any>('run', r.id).status === 'completed');
    assert.equal(calls, 2);
    assert.equal(
      f.store.events('chat').filter((e) => e.type === 'model.protocol-repair').length,
      1,
    );
    assert.equal(f.store.events('chat').filter((e) => e.type === 'tool.started').length, 0);
    assert.equal(f.store.get<any>('run', r.id).modelCalls, 2);
  } finally {
    await f.runtime.shutdown();
    f.store.close();
  }
});
test('malformed responses are not retried indefinitely', async () => {
  let calls = 0;
  const f = await setup({
    complete: async () => {
      calls++;
      throw new AppError('INVALID_ARGUMENTS', 'bad JSON', 502);
    },
  });
  try {
    const r = f.runtime.start('chat', 'Hello');
    await until(() => f.store.get<any>('run', r.id).status === 'interrupted');
    assert.equal(calls, 3);
  } finally {
    await f.runtime.shutdown();
    f.store.close();
  }
});

test('idle worker waits without model polling, wakes on assignment and releases listeners on abort', async () => {
  const f = await setup({
    complete: async () => {
      throw new Error('No model call expected');
    },
  });
  try {
    const lead = {
      id: 'lead-wait',
      conversationId: 'chat',
      parentRunId: null,
      status: 'running',
      createdAt: 1,
      depth: 0,
    } as any;
    const worker = { ...lead, id: 'worker-wait', parentRunId: lead.id, depth: 1 };
    f.store.put('run', lead);
    f.store.put('run', worker);
    const { TaskBoard } = await import('../server/services/task-board.js');
    const board = new TaskBoard(f.store);
    board.create(
      lead,
      [
        { id: 'read', title: 'read', acceptance: 'read', dependsOn: [] },
        { id: 'next', title: 'next', acceptance: 'next', dependsOn: [] },
      ],
      0,
    );
    const before = f.runtime.bus.listenerCount('event'),
      control = new AbortController();
    const wait = f.runtime.awaitAssignment(worker, control.signal);
    assert.equal(f.store.get<any>('run', worker.id).status, 'waiting_children');
    board.update(worker, 'read', 1, 'running', [], 'assigned');
    f.store.event('chat', worker.id, 'team.assigned', {});
    const result: any = await wait;
    assert.equal(result.status, 'assigned');
    assert.equal(f.runtime.bus.listenerCount('event'), before);
    assert.equal(f.store.maybe('team-worker-ready', worker.id), undefined);
    const evidence = f.store.event('chat', worker.id, 'tool.completed', {
      name: 'read_file',
      output: 'read',
    });
    board.update(worker, 'read', 2, 'done', [evidence.id], 'done');
    const cancel = new AbortController(),
      pending = f.runtime.awaitAssignment(worker, cancel.signal);
    cancel.abort();
    await assert.rejects(pending);
    assert.equal(f.runtime.bus.listenerCount('event'), before);
  } finally {
    await f.runtime.shutdown();
    f.store.close();
  }
});

test('peer message wait is event driven and member stop does not cancel peers', async () => {
  const f = await setup({
    complete: async () => {
      throw new Error('No model polling');
    },
  });
  try {
    const { Teams } = await import('../server/services/team-space.js');
    const lead = {
      id: 'discussion-root',
      conversationId: 'chat',
      parentRunId: null,
      status: 'running',
      createdAt: 1,
      depth: 0,
    } as any;
    const peer = {
      ...lead,
      id: 'discussion-peer',
      conversationId: 'peer-chat',
      parentRunId: lead.id,
      depth: 1,
    };
    f.store.put('conversation', {
      ...f.store.get<any>('conversation', 'chat'),
      teamMode: 'creative',
      teamStrategy: 'auto',
    });
    f.store.put('conversation', { ...f.store.get<any>('conversation', 'chat'), id: 'peer-chat' });
    f.store.put('run', lead);
    f.store.put('run', peer);
    const teams = new Teams(f.store);
    teams.configure(lead, 'creative', [lead.id, peer.id], 3);
    const control = new AbortController(),
      before = f.runtime.bus.listenerCount('event');
    const pending = f.runtime.awaitDiscussion(peer, control.signal, undefined, 1);
    const m = teams.post(lead, 'fictional clue', [peer.id]);
    const response: any = await pending;
    assert.equal(response.messages[0].id, m.id);
    assert.equal(f.runtime.bus.listenerCount('event'), before);
    const next = f.runtime.awaitDiscussion(peer, control.signal, m.id, 1);
    control.abort();
    await assert.rejects(next);
    assert.equal(f.runtime.bus.listenerCount('event'), before);
    f.runtime.stop(lead.id, false);
    assert.equal(f.store.get<any>('run', lead.id).status, 'interrupted');
    assert.equal(f.store.get<any>('run', peer.id).status, 'waiting_children');
    f.runtime.stopTeam(lead.id);
    assert.equal(f.store.get<any>('run', peer.id).status, 'interrupted');
  } finally {
    await f.runtime.shutdown();
    f.store.close();
  }
});

test('newly requested operation after recovery is not deduplicated by matching arguments', async () => {
  const f = await setup({ complete: async () => result('unused') });
  try {
    const old = {
      id: 'previous-write',
      conversationId: 'chat',
      parentRunId: null,
      status: 'interrupted',
      createdAt: 1,
      depth: 0,
    } as any;
    const next = { ...old, id: 'resumed-write', recoveredFrom: old.id, status: 'running' };
    f.store.put('run', old);
    f.store.put('run', next);
    const args = { path: 'already.txt', content: 'old result' };
    const effect = f.store.beginEffect(old.id, 'write_file', args);
    f.store.endEffect(effect, 'Saved already.txt');
    const context = await f.runtime.context(next);
    await context.files.write('already.txt', 'newer user edit');
    const output = await f.runtime.registry.invoke('write_file', args, context);
    assert.doesNotMatch(output.content, /NOT executed again/);
    assert.equal(await context.files.read('already.txt'), 'old result');
  } finally {
    await f.runtime.shutdown();
    f.store.close();
  }
});

test('output truncation retries once, records both costs and preserves completed checkpoints', async () => {
  let n = 0;
  const f = await setup({
    complete: async (req) => {
      n++;
      if (n === 1)
        throw Object.assign(new AppError('MODEL_INCOMPLETE', 'length', 502), {
          finishReason: 'length',
          usage: { input: 10, output: 8192, cached: 0, measured: true },
        });
      assert.match(req.messages.at(-1)!.content, /None of its tool calls executed/);
      return result('Recovered answer');
    },
  });
  try {
    const run = f.runtime.start('chat', 'Hello');
    await until(() => ['completed', 'failed'].includes(f.store.get<any>('run', run.id).status));
    const done = f.store.get<any>('run', run.id);
    assert.equal(done.status, 'completed');
    assert.equal(done.modelCalls, 2);
    assert.equal(done.outputTokens, 8194);
    assert.equal(f.store.events('chat').filter((e) => e.type === 'tool.started').length, 0);
  } finally {
    await f.runtime.shutdown();
    f.store.close();
  }
});
test('length failures stop after two corrections; disconnect recovery is bounded to five retries', async () => {
  for (const finishReason of ['length', '']) {
    let n = 0;
    const f = await setup({
      complete: async () => {
        n++;
        throw Object.assign(new AppError('MODEL_INCOMPLETE', 'truncated', 502), { finishReason });
      },
    });
    try {
      const run = f.runtime.start('chat', 'Hello');
      await until(() => f.store.get<any>('run', run.id).status === 'interrupted', 75000);
      assert.equal(n, finishReason === 'length' ? 3 : 6);
      assert.equal(
        f.store.events('chat').filter((e) => e.type === 'model.reconnecting').length,
        finishReason === 'length' ? 0 : 5,
      );
      assert.equal(f.store.events('chat').filter((e) => e.type === 'tool.started').length, 0);
    } finally {
      await f.runtime.shutdown();
      f.store.close();
    }
  }
});

test('attachments bind once to user messages, including steering', async () => {
  const f = await setup({ complete: async () => result('ok') });
  f.store.put('attachment', {
    id: 'a',
    conversationId: 'chat',
    name: 'note.txt',
    mime: 'text/plain',
    size: 1,
    path: 'unused',
    text: 'unique source',
    createdAt: 1,
  });
  const run = f.runtime.start('chat', 'first');
  await until(() => f.store.get<any>('run', run.id).status === 'completed');
  const event = f.store.events('chat').find((e) => e.type === 'user.message')!;
  assert.equal(event.data.attachments[0].id, 'a');
  assert.equal(f.store.get<any>('attachment', 'a').messageEventId, event.id);
  const second = f.runtime.start('chat', 'second');
  await until(() => f.store.get<any>('run', second.id).status === 'completed');
  const events = f.store.events('chat').filter((e) => e.type === 'user.message');
  assert.equal(events[1].data.attachments.length, 0);
  const messages = f.store
    .get<any>('run', second.id)
    .checkpoints.filter((m: any) => m.role === 'user');
  assert.equal(messages.filter((m: any) => m.content.includes('unique source')).length, 1);
  await f.runtime.shutdown();
  f.store.close();
});

test('steering arriving during failed model call is durably delivered on continuation', async () => {
  let unblock!: () => void,
    entered!: () => void,
    calls = 0;
  const ready = new Promise<void>((r) => (entered = r)),
    gate = new Promise<void>((_, reject) => (unblock = () => reject(Error('injected failure'))));
  const f = await setup({
    complete: async (req) => {
      if (++calls === 1) {
        entered();
        await gate;
      }
      assert.ok(JSON.stringify(req.messages).includes('late-message-marker'));
      return result('ok');
    },
  });
  try {
    const first = f.runtime.start('chat', 'begin');
    await ready;
    f.runtime.steer('chat', 'late-message-marker');
    unblock();
    await until(() => f.store.get<any>('run', first.id).status === 'failed');
    const second = f.runtime.start('chat', 'continue');
    await until(() => f.store.get<any>('run', second.id).status === 'completed');
    assert.equal(f.store.list<any>('user-inbox').filter((m) => m.state === 'pending').length, 0);
  } finally {
    await f.runtime.shutdown();
    f.store.close();
  }
});

test('a saturated conversation tree cannot block another conversation or leak its input', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen: string[] = [];
  const f = await setup({
    complete: async (request) => {
      const text = request.messages
        .filter((m) => m.role === 'user')
        .map((m) => m.content)
        .join(' ');
      seen.push(text);
      if (text.includes('hold-root')) await gate;
      return result('done');
    },
  });
  f.config.save({
    ...{ ...f.config.get(), commandBackend: 'approval-host' as const },
    maxParallelRuns: 1,
  });
  for (const id of ['child', 'grandchild', 'other'])
    f.store.put('conversation', { ...f.store.get<any>('conversation', 'chat'), id });
  try {
    const root = f.runtime.start('chat', 'hold-root');
    await until(() => seen.length === 1);
    const child = f.runtime.start('child', 'child-only', 0, {
      parentRunId: root.id,
      depth: 1,
      fresh: true,
    });
    const grandchild = f.runtime.start('grandchild', 'grandchild-only', 0, {
      parentRunId: child.id,
      depth: 2,
      fresh: true,
    });
    const other = f.runtime.start('other', 'independent-only');
    await until(() => f.store.get<any>('run', other.id).status === 'completed');
    assert.equal(f.store.get<any>('run', child.id).status, 'queued');
    assert.equal(f.store.get<any>('run', grandchild.id).status, 'queued');
    assert.equal(seen.length, 2);
    assert(seen[1].includes('independent-only'));
    assert(!seen[1].includes('hold-root'));
    release();
    await until(() => f.store.get<any>('run', grandchild.id).status === 'completed');
    // Child completion can legitimately wake the parent for a final summary.
    const childIndex = seen.findIndex((text) => text.includes('child-only'));
    const grandchildIndex = seen.findIndex((text) => text.includes('grandchild-only'));
    assert(childIndex >= 2);
    assert(grandchildIndex > childIndex);
  } finally {
    release();
    await f.runtime.shutdown();
    f.store.close();
  }
});

test(
  'background command permits independent tools, wakes on steering, and finishes without polling',
  { timeout: 15000 },
  async () => {
    let calls = 0,
      jobId = '',
      workedWhileRunning = false;
    const f = await setup({
      complete: async (req) => {
        calls++;
        if (calls === 1)
          return result('', [
            {
              id: 'start-bg',
              name: 'run_command',
              arguments: {
                command:
                  '"' +
                  process.execPath +
                  '" -e "console.log(123);setTimeout(()=>console.log(456),2500)"',
                folder: 0,
                background: true,
                timeoutSeconds: 10,
                reason: 'bounded background test',
              },
            },
          ]);
        if (calls === 2) {
          jobId = JSON.parse(
            req.messages.find((m) => m.role === 'tool' && m.callId === 'start-bg')!.content,
          ).id;
          workedWhileRunning = f.runtime.background.get('chat', jobId).status === 'running';
          return result('', [
            {
              id: 'independent',
              name: 'write_file',
              arguments: { path: 'independent.txt', content: 'done while command waits' },
            },
          ]);
        }
        if (calls === 3)
          return result('', [
            { id: 'wait-bg', name: 'wait_background_command', arguments: { id: jobId } },
          ]);
        if (calls === 4) {
          assert(req.messages.some((m) => m.role === 'user' && m.content === 'status please'));
          assert.equal(f.runtime.background.get('chat', jobId).status, 'running');
          // Release only after steering was delivered: wall-clock sleeps race slow CI hosts.
          await writeFile(
            join(f.store.get<any>('project', 'p').folders[0], 'release-command'),
            'go',
          );
          return result('', [
            { id: 'wait-again', name: 'wait_background_command', arguments: { id: jobId } },
          ]);
        }
        return result('Background and independent work finished.');
      },
    });
    f.store.put('project', {
      id: 'p',
      name: 'Fixture',
      folders: [await mkdtemp(join(tmpdir(), 'background-work-'))],
      createdAt: 1,
    });
    f.store.put('conversation', {
      ...f.store.get<any>('conversation', 'chat'),
      projectId: 'p',
      permission: 'trusted',
    });
    try {
      const run = f.runtime.start('chat', 'Prepare two independent outputs');
      await until(() =>
        f.store
          .events('chat')
          .some((e) => e.type === 'tool.started' && e.data.callId === 'wait-bg'),
      );
      await new Promise((r) => setTimeout(r, 100));
      const before = calls;
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(calls, before);
      f.runtime.steer('chat', 'status please');
      await until(() => calls >= 4);
      await until(() => f.store.get<any>('run', run.id).status === 'completed', 7000);
      assert(workedWhileRunning);
      assert.equal(f.runtime.background.get('chat', jobId).status, 'completed');
      assert.equal(f.store.unknownEffects('chat').length, 0);
      assert(calls <= 6, 'waiting must not poll the model');
      assert.equal(
        f.store.events('chat').filter((e) => e.type === 'user.message').length,
        2,
        'host completion must not impersonate user input',
      );
    } finally {
      await f.runtime.shutdown();
      f.store.close();
    }
  },
);

test('background jobs are scoped, cancelled and recovered as unknown without replay', async () => {
  const f = await setup({ complete: async () => result('done') });
  try {
    const run = f.runtime.start('chat', 'fixture');
    await until(() => f.store.get<any>('run', run.id).status === 'completed');
    const job = f.runtime.background.start(
      run,
      '"' + process.execPath + '" -e "console.log(123);setInterval(()=>{},1000)"',
      f.dir,
      10,
      { ...f.config.get(), commandBackend: 'approval-host' as const },
      new AbortController().signal,
      '123',
    );
    const ready = await f.runtime.background.wait(
      'chat',
      job.id,
      new AbortController().signal,
      3,
      true,
    );
    assert(ready.readyObserved);
    assert.equal(ready.status, 'running');
    assert.throws(() => f.runtime.background.get('foreign', job.id), /another conversation/);
    const cancelled = await f.runtime.background.cancel('chat', job.id);
    assert.equal(cancelled.status, 'cancelled');
    const effectId = f.store.beginEffect(run.id, 'background_command', {
      command: 'do not replay',
    });
    f.store.put('command-job', { ...job, id: 'interrupted-job', status: 'running', effectId });
    const { BackgroundCommands } = await import('../server/services/background-commands.js');
    const recovered = new BackgroundCommands(f.store);
    assert.equal(recovered.get('chat', 'interrupted-job').status, 'unknown');
    assert(f.store.unknownEffects('chat').some((e) => e.id === effectId));
    assert.equal((await recovered.cancel('chat', 'interrupted-job')).status, 'unknown');
    await recovered.shutdown();
  } finally {
    await f.runtime.shutdown();
    f.store.close();
  }
});

for (const decision of ['approve', 'deny', 'cancel', 'changed'] as const)
  test(
    'deferred approval permits independent work and respects ' + decision,
    { timeout: 15000 },
    async () => {
      let calls = 0,
        jobId = '';
      const f = await setup({
        complete: async (req) => {
          if (++calls === 1)
            return result('', [
              {
                id: 'defer',
                name: 'run_command',
                arguments: {
                  command: 'echo approved > command-marker.txt',
                  background: true,
                  timeoutSeconds: 5,
                  reason: 'test approval boundary',
                },
              },
            ]);
          if (calls === 2) {
            jobId = JSON.parse(
              req.messages.find((m) => m.role === 'tool' && m.callId === 'defer')!.content,
            ).id;
            return result('', [
              {
                id: 'other',
                name: 'write_file',
                arguments: { path: 'independent.txt', content: 'unrelated work' },
              },
            ]);
          }
          return result('Independent work ready; report remaining approval status.');
        },
      });
      const work = await mkdtemp(join(tmpdir(), 'deferred-approval-'));
      f.store.put('project', { id: 'p', name: 'Fixture', folders: [work], createdAt: 1 });
      f.store.put('conversation', {
        ...f.store.get<any>('conversation', 'chat'),
        projectId: 'p',
        permission: 'ask',
      });
      const { access, readFile } = await import('node:fs/promises');
      try {
        const run = f.runtime.start('chat', 'Do independent work during command approval');
        await until(() =>
          f.store
            .events('chat')
            .some((e) => e.type === 'tool.completed' && e.data.callId === 'other'),
        );
        const input = f.store.list<any>('input').find((i) => i.status === 'pending');
        assert(input);
        assert(jobId);
        assert.equal(f.runtime.background.get('chat', jobId).approvalId, input.id);
        assert.equal(f.runtime.background.get('chat', jobId).status, 'waiting_approval');
        assert.equal(
          f.store.unknownEffects('chat').length,
          0,
          'approval is not an executed effect',
        );
        assert.equal(await readFile(join(work, 'independent.txt'), 'utf8'), 'unrelated work');
        await assert.rejects(access(join(work, 'command-marker.txt')));
        assert.notEqual(f.store.get<any>('run', run.id).status, 'completed');
        const n = calls;
        await new Promise((r) => setTimeout(r, 150));
        assert.equal(calls, n, 'no model polling while awaiting decision');
        if (decision === 'cancel') {
          await f.runtime.background.cancel('chat', jobId);
          assert.equal(f.store.get<any>('input', input.id).status, 'cancelled');
          assert.throws(
            () => f.runtime.inputs.answer(input.id, 'late approval', true),
            /no longer waiting/,
          );
        } else {
          if (decision === 'changed')
            f.config.save({
              ...{ ...f.config.get(), commandBackend: 'approval-host' as const },
              commandBackend: 'docker',
            });
          f.runtime.inputs.answer(
            input.id,
            decision,
            decision === 'approve' || decision === 'changed',
          );
        }
        await until(() => f.store.get<any>('run', run.id).status === 'completed');
        const job = f.runtime.background.get('chat', jobId);
        assert.equal(
          job.status,
          decision === 'approve'
            ? 'completed'
            : decision === 'deny'
              ? 'denied'
              : decision === 'changed'
                ? 'failed'
                : 'cancelled',
        );
        if (decision === 'approve')
          assert.match(await readFile(join(work, 'command-marker.txt'), 'utf8'), /approved/);
        else await assert.rejects(access(join(work, 'command-marker.txt')));
      } finally {
        await f.runtime.shutdown();
        f.store.close();
      }
    },
  );

test('conversation accepts more than thirty preferred skills and deduplicates them', async () => {
  const f = await setup({ complete: async () => result('done') });
  const { app } = await createApp({
    directory: f.dir,
    runtime: f.runtime,
  });
  try {
    for (let i = 0; i < 45; i++)
      f.store.put('skill', {
        id: 's' + i,
        name: 'Skill ' + i,
        description: 'fixture',
        enabled: true,
        content: 'fixture',
        source: 'fixture',
      });
    const boot = await app.inject({ method: 'GET', url: '/api/bootstrap' });
    const csrf = boot.json().csrf;
    const cookie = String(boot.headers['set-cookie']).split(';')[0];
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/conversations/chat',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { skillIds: [...Array.from({ length: 45 }, (_, i) => 's' + i), 's0'] },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().skillIds.length, 45);
  } finally {
    await app.close();
  }
});

test('project folders can be edited, removed and restored without deleting history or files', async () => {
  const { writeFile, readFile } = await import('node:fs/promises');
  const f = await setup({ complete: async () => result('unused') });
  const a = await mkdtemp(join(tmpdir(), 'workspace-a-'));
  const b = await mkdtemp(join(tmpdir(), 'workspace-b-'));
  await writeFile(join(a, 'keep.txt'), 'preserve me');
  const { app } = await createApp({ directory: f.dir, runtime: f.runtime });
  try {
    const boot = await app.inject({ url: '/api/bootstrap', headers: { host: '127.0.0.1:8810' } });
    const headers = {
      host: '127.0.0.1:8810',
      cookie: String(boot.headers['set-cookie']).split(';')[0],
      'x-csrf-token': boot.json().csrf,
    };
    const call = (method: any, url: string, payload: any = {}) =>
      app.inject({ method, url, headers, payload });
    const made = await call('POST', '/api/projects', { name: 'Workspace', folders: [a] });
    assert.equal(made.statusCode, 200);
    const project = made.json(),
      url = '/api/projects/' + project.id;
    const chat = f.store.get<any>('conversation', 'chat');
    f.store.put('conversation', { ...chat, projectId: project.id });
    f.store.put('memory', {
      id: 'project-memory',
      scope: 'project:' + project.id,
      content: 'kept',
      active: true,
    });
    const edited = await call('PATCH', url, { name: 'Renamed', folders: [a, b] });
    assert.equal(edited.statusCode, 200);
    assert.equal(edited.json().folders.length, 2);
    assert.equal(
      (await call('PATCH', url, { name: 'Bad', folders: [a, a] })).statusCode >= 400,
      true,
    );
    f.store.put('run', {
      id: 'busy',
      conversationId: 'chat',
      status: 'waiting_approval',
      createdAt: 1,
      updatedAt: 1,
    });
    assert.equal((await call('DELETE', url)).statusCode >= 400, true);
    assert.equal((await call('PATCH', url, { name: 'No', folders: [b] })).statusCode >= 400, true);
    f.store.put('run', {
      id: 'busy',
      conversationId: 'chat',
      status: 'interrupted',
      createdAt: 1,
      updatedAt: 1,
    });
    const removed = await call('DELETE', url);
    assert.equal(removed.statusCode, 200);
    assert.ok(removed.json().removedAt);
    assert.equal(f.store.get<any>('conversation', 'chat').projectId, project.id);
    assert.equal(f.store.get<any>('memory', 'project-memory').scope, 'project:' + project.id);
    assert.equal(await readFile(join(a, 'keep.txt'), 'utf8'), 'preserve me');
    assert.throws(() => f.runtime.start('chat', 'Hello'), /Restore this project/);
    await assert.rejects(
      f.runtime.filesForConversation(f.store.get('conversation', 'chat')),
      /Restore this project/,
    );
    assert.equal(
      (await call('POST', '/api/conversations', { projectId: project.id })).statusCode >= 400,
      true,
    );
    assert.equal((await call('DELETE', url)).json().removedAt, removed.json().removedAt);
    assert.equal(
      (await call('PATCH', url, { name: 'Restored', folders: [a, b] })).json().removedAt,
      null,
    );
    assert.equal(
      (await f.runtime.filesForConversation(f.store.get('conversation', 'chat'))).roots.length,
      2,
    );
  } finally {
    await app.close();
  }
});

test('general library is shared by general chats but excluded from projects and disabled knowledge', async () => {
  const f = await setup({ complete: async () => result('done') });
  try {
    const r = f.runtime.start('chat', 'hi');
    await until(() => f.store.get<any>('run', r.id).status === 'completed');
    const run = f.store.get<any>('run', r.id),
      original = f.store.get<any>('conversation', 'chat');
    const general = await f.runtime.context(run);
    assert(general.scopes.includes('general'));
    f.runtime.knowledge.import('general', 'shared', 'unique_shared_guide');
    assert.equal(general.knowledge.search(general.scopes, 'unique_shared_guide').length, 1);
    const projectDir = await mkdtemp(join(tmpdir(), 'scope-project-'));
    f.store.put('project', { id: 'project', folders: [projectDir] });
    f.store.put('conversation', { ...original, projectId: 'project' });
    const project = await f.runtime.context(run);
    assert(!project.scopes.includes('general'));
    assert.equal(project.knowledge.search(project.scopes, 'unique_shared_guide').length, 0);
    f.store.put('conversation', { ...original, knowledge: false });
    assert.deepEqual((await f.runtime.context(run)).scopes, []);
  } finally {
    await f.runtime.shutdown();
    f.store.close();
  }
});

test('persistent members retain private context across parent turns without spawning a replacement', async () => {
  const f = await setup({
    complete: async (req) => {
      const txt = JSON.stringify(req.messages);
      return result(txt.includes('remember-token') ? 'member remembers remember-token' : 'done');
    },
  });
  try {
    const p1 = f.runtime.start('chat', 'first parent turn');
    await until(() => f.store.get<any>('run', p1.id).status === 'completed');
    const key = await f.runtime.spawn(
      p1,
      'Read-only collaborator remember-token; respond briefly.',
      'Confirm the assigned token.',
    );
    await until(() => f.store.get<any>('run', key).status === 'completed');
    const old = f.store.get<any>('run', key),
      member = old.conversationId;
    const p2 = f.runtime.start('chat', 'second parent turn');
    await until(() => f.store.get<any>('run', p2.id).status === 'completed');
    assert.throws(() => f.runtime.message(p2, key, 'hello'), /unrelated/);
    const next: any = await f.runtime.continueMember(
      p2,
      member,
      'What was your earlier assigned token?',
    );
    assert.equal(next.agentId, member);
    assert.notEqual(next.runId, key);
    await until(() => f.store.get<any>('run', next.runId).status === 'completed');
    assert.equal(f.store.get<any>('run', next.runId).parentRunId, p2.id);
    assert(
      f.store
        .events(member)
        .some(
          (e) =>
            e.runId === next.runId &&
            e.type === 'assistant.message' &&
            e.data.text.includes('remember-token'),
        ),
    );
    assert.equal((f.runtime.members(p2) as any[]).length, 1);
    assert.equal(f.store.runs(member).length, 2);
    const other = { ...p2, conversationId: 'someone-else' };
    await assert.rejects(
      f.runtime.continueMember(other, member, 'hi'),
      /owned by this conversation/,
    );
    f.runtime.closeMember(p2, member);
    await assert.rejects(f.runtime.continueMember(p2, member, 'hi'), /closed/);
  } finally {
    await f.runtime.shutdown();
    f.store.close();
  }
});
test('continuation refuses unknown effects, changed scope and disabled delegation', async () => {
  const f = await setup({ complete: async () => result('done') });
  try {
    const p = f.runtime.start('chat', 'parent');
    await until(() => f.store.get<any>('run', p.id).status === 'completed');
    const key = await f.runtime.spawn(
      p,
      'Read-only collaborator for testing lifecycle.',
      'Confirm the lifecycle probe.',
    );
    await until(() => f.store.get<any>('run', key).status === 'completed');
    const child = f.store.get<any>('run', key),
      c = f.store.get<any>('conversation', 'chat');
    const effect = f.store.beginEffect(key, 'run_command', { command: 'unknown' });
    await assert.rejects(f.runtime.continueMember(p, key, 'continue'), /unresolved/);
    f.store.endEffect(effect, 'inspected', 'completed');
    f.store.put('conversation', { ...c, teamStrategy: 'off' });
    await assert.rejects(f.runtime.continueMember(p, key, 'continue'), /disabled/);
    f.store.put('conversation', c);
    f.store.put('agent-binding', {
      id: child.conversationId,
      owner: 'chat',
      roots: ['changed'],
      mode: 'read-only',
    });
    await assert.rejects(f.runtime.continueMember(p, key, 'continue'), /roots changed/);
  } finally {
    await f.runtime.shutdown();
    f.store.close();
  }
});

test('writable continuation retains unmerged copy then renews merged copy, concurrent activation is single', async () => {
  const f = await setup({ complete: async () => result('done') });
  const { writeFile, readFile } = await import('node:fs/promises');
  const project = await mkdtemp(join(tmpdir(), 'persistent-write-'));
  try {
    await writeFile(join(project, 'a.txt'), 'base');
    f.store.put('project', { id: 'p', folders: [project] });
    f.store.put('conversation', { ...f.store.get<any>('conversation', 'chat'), projectId: 'p' });
    const p1 = f.runtime.start('chat', 'first');
    await until(() => f.store.get<any>('run', p1.id).status === 'completed');
    const key = await f.runtime.spawn(
      p1,
      'Independent collaborator for isolated file changes.',
      'Return the file change summary.',
      'isolated',
    );
    await until(() => f.store.get<any>('run', key).status === 'completed');
    const child = f.store.get<any>('run', key),
      ctx = await f.runtime.context(child);
    await writeFile(await ctx.files.resolve('a.txt'), 'changed');
    const p2 = f.runtime.start('chat', 'followup');
    await until(() => f.store.get<any>('run', p2.id).status === 'completed');
    const results = await Promise.allSettled([
      f.runtime.continueMember(p2, key, 'Check your earlier work'),
      f.runtime.continueMember(p2, key, 'Concurrent followup'),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const next: any = (results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>)
      .value;
    await until(() => f.store.get<any>('run', next.runId).status === 'completed');
    assert.equal(
      f.store.get<any>('conversation', child.conversationId).isolationId,
      ctx.conversation.isolationId,
    );
    await assert.rejects(f.runtime.inspectChanges!(p1, key), /Not owned/);
    const review = await f.runtime.inspectChanges!(p2, next.runId);
    assert('version' in review);
    await f.runtime.mergeChanges!(p2, next.runId, review.version);
    assert.equal(await readFile(join(project, 'a.txt'), 'utf8'), 'changed');
    const again: any = await f.runtime.continueMember(
      p2,
      next.runId,
      'Work on the current merged revision',
    );
    await until(() => f.store.get<any>('run', again.runId).status === 'completed');
    assert.notEqual(
      f.store.get<any>('conversation', child.conversationId).isolationId,
      ctx.conversation.isolationId,
    );
  } finally {
    await f.runtime.shutdown();
    f.store.close();
  }
});

test('cognitive control warns in the real loop and allows a changed approach to finish', async () => {
  let calls = 0;
  const f = await setup({
    complete: async (req) => {
      calls++;
      if (calls <= 4)
        return result('', [
          { id: 'read-cycle-' + calls, name: 'list_files', arguments: { path: '.' } },
        ]);
      assert.ok(
        req.messages.some(
          (m) => m.contextKind === 'runtime-advice' && m.content.includes('Repeated calls'),
        ),
      );
      return result('The repeated reads gave no new evidence; report the empty directory.');
    },
  });
  try {
    const run = f.runtime.start('chat', 'Inspect the directory without modifying files.');
    await until(() => ['completed', 'failed'].includes(f.store.get<any>('run', run.id).status));
    assert.equal(f.store.get<any>('run', run.id).status, 'completed');
    const interventions = f.store.events('chat').filter((e) => e.type === 'cognitive.intervention');
    assert.equal(interventions.length, 1);
    assert.equal(interventions[0].data.action, 'change-strategy');
    assert.equal(f.store.get<any>('cognitive-state', run.id).signals.repeated, true);
    assert.equal(f.store.unknownEffects('chat').length, 0);
  } finally {
    await f.runtime.shutdown();
    f.store.close();
  }
});

test('optional file-write approval prevents a denied mutation without unresolved effects', async () => {
  let n = 0;
  const f = await setup({
    complete: async () =>
      ++n === 1
        ? result('', [
            {
              id: 'write',
              name: 'write_file',
              arguments: { path: 'approval.txt', content: 'must not exist' },
            },
          ])
        : result('Write denied.'),
  });
  try {
    f.config.save({ ...f.config.get(), approveFileWrites: true });
    const run = f.runtime.start('chat', 'Create a file');
    await until(() => f.store.get<any>('run', run.id).status === 'waiting_approval');
    const ctx = await f.runtime.context(run);
    await assert.rejects(ctx.files.read('approval.txt'));
    assert.equal(f.store.unknownEffects('chat').length, 0);
    f.runtime.inputs.answer(f.store.list<any>('input')[0].id, 'No', false);
    await until(() => f.store.get<any>('run', run.id).status === 'completed');
    await assert.rejects(ctx.files.read('approval.txt'));
    assert.equal(f.store.unknownEffects('chat').length, 0);
    assert.ok(
      f.store
        .events('chat')
        .some((e: any) => e.type === 'tool.completed' && e.data.outcome.status === 'denied'),
    );
  } finally {
    await f.runtime.shutdown();
    f.store.close();
  }
});

test('unresolved effect resolution asks the user and never retries the command', async () => {
  let effect = '';
  let n = 0;
  const f = await setup({
    complete: async () =>
      ++n === 1
        ? result('', [
            {
              id: 'resolve',
              name: 'resolve_effect',
              arguments: {
                effectId: effect,
                evidence: 'Inspected current output and confirmed the exact saved result.',
              },
            },
          ])
        : result('Inspection recorded.'),
  });
  try {
    f.store.put('run', {
      id: 'old-effect',
      conversationId: 'chat',
      status: 'interrupted',
      createdAt: 1,
      updatedAt: 1,
    });
    effect = f.store.beginEffect('old-effect', 'run_command', { command: 'never replay this' });
    const run = f.runtime.start('chat', 'Record verified outcome');
    await until(() => f.store.get<any>('run', run.id).status === 'waiting_approval');
    assert.equal(f.store.unknownEffects('chat').length, 1);
    f.runtime.inputs.answer(f.store.list<any>('input')[0].id, 'Confirmed from inspection', true);
    await until(() =>
      ['completed', 'interrupted'].includes(f.store.get<any>('run', run.id).status),
    );
    assert.equal(f.store.unknownEffects('chat').length, 0);
    assert.equal(
      f.store
        .events('chat')
        .filter((e: any) => e.type === 'tool.started' && e.data.name === 'run_command').length,
      0,
    );
  } finally {
    await f.runtime.shutdown();
    f.store.close();
  }
});

test('historical collaboration endpoint selects the original round and rejects unrelated run IDs', async () => {
  const f = await setup({ complete: async () => result('done') });
  const { app } = await createApp({ directory: f.dir, runtime: f.runtime });
  try {
    const first = f.runtime.start('chat', 'first round');
    await until(() => f.store.get<any>('run', first.id).status === 'completed');
    f.store.put('task-board', { id: first.id, revision: 7, tasks: [] });
    const second = f.runtime.start('chat', 'second round');
    await until(() => f.store.get<any>('run', second.id).status === 'completed');
    const boot = await app.inject({ url: '/api/bootstrap', headers: { host: '127.0.0.1:8810' } });
    const headers = {
      host: '127.0.0.1:8810',
      cookie: String(boot.headers['set-cookie']).split(';')[0],
    };
    const current = await app.inject({ url: '/api/conversations/chat', headers });
    const history = await app.inject({ url: '/api/conversations/chat?runId=' + first.id, headers });
    assert.equal(current.statusCode, 200);
    assert.equal(history.statusCode, 200);
    assert.equal(current.json().taskBoard.id, second.id);
    assert.equal(history.json().taskBoard.id, first.id);
    assert.equal(history.json().taskBoard.revision, 7);
    const other = { ...second, id: 'foreign-round', conversationId: 'other-chat' };
    f.store.put('run', other);
    const rejected = await app.inject({
      url: '/api/conversations/chat?runId=foreign-round',
      headers,
    });
    assert.notEqual(rejected.statusCode, 200);
    assert.match(rejected.body, /Run does not belong/);
  } finally {
    await app.close();
  }
});

test('connection reset after partial output reconnects without executing partial tools', async () => {
  let calls = 0;
  const f = await setup({
    complete: async (req) => {
      if (++calls === 1) {
        req.onText('unfinished output');
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
        });
      }
      return result('Connected again');
    },
  });
  try {
    const r = f.runtime.start('chat', 'hello');
    await until(() => f.store.get<any>('run', r.id).status === 'completed', 6000);
    assert.equal(calls, 2);
    const events = f.store.events('chat');
    assert.equal(events.filter((e) => e.type === 'model.reconnecting').length, 1);
    assert.equal(events.filter((e) => e.type === 'tool.started').length, 0);
    assert(events.some((e) => e.type === 'assistant.message' && e.data.incomplete));
  } finally {
    await f.runtime.shutdown();
    f.store.close();
  }
});

test('a fresh successful model step resets the malformed response repair allowance', async () => {
  let calls = 0;
  const f = await setup({
    complete: async () => {
      calls++;
      if ([1, 2, 4, 5].includes(calls)) throw new AppError('INVALID_ARGUMENTS', 'bad JSON', 502);
      if (calls === 3)
        return result('', [{ id: 'read-once', name: 'list_files', arguments: { path: '.' } }]);
      return result('done');
    },
  });
  try {
    const r = f.runtime.start('chat', 'inspect');
    await until(() => f.store.get<any>('run', r.id).status === 'completed', 6000);
    assert.equal(calls, 6);
    assert.equal(f.store.events('chat').filter((e) => e.type === 'tool.started').length, 1);
    assert.equal(
      f.store.events('chat').filter((e) => e.type === 'model.protocol-repair').length,
      4,
    );
  } finally {
    await f.runtime.shutdown();
    f.store.close();
  }
});

test('stop cancels model reconnection waiting without another request', async () => {
  let calls = 0;
  const f = await setup({
    complete: async () => {
      calls++;
      throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    },
  });
  try {
    const r = f.runtime.start('chat', 'hello');
    await until(() => f.store.events('chat').some((e) => e.type === 'model.reconnecting'));
    await f.runtime.shutdown();
    assert.equal(calls, 1);
    assert.equal(f.store.get<any>('run', r.id).status, 'interrupted');
  } finally {
    f.store.close();
  }
});

test(
  'foreground command auto-yields once, continues independent work and receives steering',
  { timeout: 15000 },
  async () => {
    let calls = 0,
      jobId = '',
      workedWhileRunning = false;
    const f = await setup({
      complete: async (req) => {
        calls++;
        if (calls === 1)
          return result('', [
            {
              id: 'start-bg',
              name: 'run_command',
              arguments: {
                command:
                  '"' +
                  process.execPath +
                  "\" -e \"const fs=require('fs');console.log(123);const timer=setInterval(()=>{if(fs.existsSync('release-command')){clearInterval(timer);console.log(456)}},25)\"",
                folder: 0,
                yieldAfterSeconds: 0.15,
                timeoutSeconds: 10,
                reason: 'bounded background test',
              },
            },
          ]);
        if (calls === 2) {
          jobId = JSON.parse(
            req.messages.find((m) => m.role === 'tool' && m.callId === 'start-bg')!.content,
          ).id;
          workedWhileRunning = f.runtime.background.get('chat', jobId).status === 'running';
          return result('', [
            {
              id: 'independent',
              name: 'write_file',
              arguments: { path: 'independent.txt', content: 'done while command waits' },
            },
          ]);
        }
        if (calls === 3)
          return result('', [
            { id: 'wait-bg', name: 'wait_background_command', arguments: { id: jobId } },
          ]);
        if (calls === 4) {
          assert(req.messages.some((m) => m.role === 'user' && m.content === 'status please'));
          assert.equal(f.runtime.background.get('chat', jobId).status, 'running');
          // Release only after steering was delivered: wall-clock sleeps race slow CI hosts.
          await writeFile(
            join(f.store.get<any>('project', 'p').folders[0], 'release-command'),
            'go',
          );
          return result('', [
            { id: 'wait-again', name: 'wait_background_command', arguments: { id: jobId } },
          ]);
        }
        return result('Background and independent work finished.');
      },
    });
    f.store.put('project', {
      id: 'p',
      name: 'Fixture',
      folders: [await mkdtemp(join(tmpdir(), 'background-work-'))],
      createdAt: 1,
    });
    f.store.put('conversation', {
      ...f.store.get<any>('conversation', 'chat'),
      projectId: 'p',
      permission: 'trusted',
    });
    try {
      const run = f.runtime.start('chat', 'Prepare two independent outputs');
      await until(() =>
        f.store
          .events('chat')
          .some((e) => e.type === 'tool.started' && e.data.callId === 'wait-bg'),
      );
      await new Promise((r) => setTimeout(r, 100));
      const before = calls;
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(calls, before);
      f.runtime.steer('chat', 'status please');
      await until(() => calls >= 4);
      await until(() => f.store.get<any>('run', run.id).status === 'completed', 7000);
      assert(workedWhileRunning);
      assert.equal(f.store.events('chat').filter((e) => e.type === 'command.yielded').length, 1);
      assert.equal(f.runtime.background.list('chat').length, 1);
      assert.equal(f.runtime.background.get('chat', jobId).timeoutSeconds, 10);
      assert.equal(
        f.runtime.background.get('chat', jobId).result?.stdout.replaceAll('\r', '').trim(),
        '123\n456',
      );
      assert.equal(f.runtime.background.get('chat', jobId).status, 'completed');
      assert.equal(f.store.unknownEffects('chat').length, 0);
      assert(calls <= 6, 'waiting must not poll the model');
      assert.equal(
        f.store.events('chat').filter((e) => e.type === 'user.message').length,
        2,
        'host completion must not impersonate user input',
      );
    } finally {
      await f.runtime.shutdown();
      f.store.close();
    }
  },
);

test(
  'auto-yield preserves command timeout and never treats scheduling as a passed test',
  { timeout: 15000 },
  async () => {
    let calls = 0,
      jobId = '';
    const f = await setup({
      complete: async (req) => {
        calls++;
        if (calls === 1)
          return result('', [
            {
              id: 'timeout-test',
              name: 'run_command',
              arguments: {
                command: '"' + process.execPath + '" -e "setTimeout(()=>console.log(999),10000)"',
                timeoutSeconds: 1,
                yieldAfterSeconds: 0.1,
                reason: 'Timeout behavior test',
              },
            },
          ]);
        if (calls === 2) {
          const output = JSON.parse(
            req.messages.find((m) => m.role === 'tool' && m.callId === 'timeout-test')!.content,
          );
          jobId = output.id;
          assert.equal(output.status, 'running');
          assert.equal(output.autoBackground, true);
          const event = f.store
            .events('chat')
            .find((e) => e.type === 'tool.completed' && e.data.callId === 'timeout-test')!;
          const { resultSucceeded } = await import('../server/core/tool-outcome.js');
          assert.equal(resultSucceeded(event.data), false);
          return result('', [
            { id: 'wait-timeout', name: 'wait_background_command', arguments: { id: jobId } },
          ]);
        }
        assert.equal(f.runtime.background.get('chat', jobId).result?.timedOut, true);
        return result('Observed actual timeout.');
      },
    });
    f.store.put('project', {
      id: 'p',
      name: 'Fixture',
      folders: [await mkdtemp(join(tmpdir(), 'auto-timeout-'))],
      createdAt: 1,
    });
    f.store.put('conversation', {
      ...f.store.get<any>('conversation', 'chat'),
      projectId: 'p',
      permission: 'trusted',
    });
    try {
      const run = f.runtime.start('chat', 'Check timeout');
      await until(() => f.store.get<any>('run', run.id).status === 'completed', 10000);
      assert.equal(f.runtime.background.list('chat').length, 1);
      assert.equal(f.runtime.background.get('chat', jobId).result?.stdout.includes('999'), false);
    } finally {
      await f.runtime.shutdown();
      f.store.close();
    }
  },
);

test('empty deliveries recover with measured usage and no invented tool requirement', async () => {
  let calls = 0;
  const f = await setup({
    complete: async (req) => {
      if (++calls === 1) return result('   ');
      assert.match(req.messages.at(-1)!.content, /nonempty answer if no tool is needed/);
      return result('Recovered answer');
    },
  });
  try {
    const r = f.runtime.start('chat', 'Hello');
    await until(() => f.store.get<any>('run', r.id).status === 'completed');
    const run = f.store.get<any>('run', r.id);
    assert.equal(calls, 2);
    assert.equal(run.inputTokens, 20);
    assert.equal(run.outputTokens, 4);
    assert.equal(run.modelCalls, 2);
    assert.equal(f.store.events('chat').filter((e) => e.type === 'tool.started').length, 0);
  } finally {
    await f.runtime.shutdown();
    f.store.close();
  }
});

test('persistent empty delivery is interrupted after bounded repair, never completed', async () => {
  let calls = 0;
  const f = await setup({
    complete: async () => {
      calls++;
      return result('');
    },
  });
  try {
    const r = f.runtime.start('chat', 'Hello');
    await until(() => f.store.get<any>('run', r.id).status === 'interrupted');
    assert.equal(calls, 3);
    assert.equal(f.store.get<any>('run', r.id).termination.code, 'EMPTY_RESPONSE');
    assert.equal(f.store.get<any>('run', r.id).inputTokens, 30);
  } finally {
    await f.runtime.shutdown();
    f.store.close();
  }
});

test('length repairs retain output settings and never replay completed operations', async () => {
  let calls = 0;
  let allowance: number | undefined;
  const f = await setup({
    complete: async (req) => {
      calls++;
      allowance ??= req.profile.maxOutputTokens;
      assert.equal(req.profile.maxOutputTokens, allowance);
      if (calls === 1)
        return result('', [{ id: 'once', name: 'list_files', arguments: { path: '.' } }]);
      if (calls <= 3) {
        req.onText('incomplete');
        throw Object.assign(new AppError('MODEL_INCOMPLETE', 'limit'), { finishReason: 'length' });
      }
      return result('Done');
    },
  });
  try {
    const r = f.runtime.start('chat', 'Inspect');
    await until(() => f.store.get<any>('run', r.id).status === 'completed');
    assert.equal(calls, 4);
    const events = f.store.events('chat');
    assert.equal(events.filter((e) => e.type === 'tool.started').length, 1);
    assert.deepEqual(
      events.filter((e) => e.type === 'model.protocol-repair').map((e) => e.data.attempt),
      [1, 2],
    );
  } finally {
    await f.runtime.shutdown();
    f.store.close();
  }
});

test('unrecoverable output length remains bounded', async () => {
  let calls = 0;
  const f = await setup({
    complete: async () => {
      calls++;
      throw Object.assign(new AppError('MODEL_INCOMPLETE', 'limit'), { finishReason: 'length' });
    },
  });
  try {
    const r = f.runtime.start('chat', 'Hello');
    await until(() => f.store.get<any>('run', r.id).status === 'interrupted');
    assert.equal(calls, 3);
    assert.equal(f.store.events('chat').filter((e) => e.type === 'tool.started').length, 0);
  } finally {
    await f.runtime.shutdown();
    f.store.close();
  }
});

test('strict final format repairs representation without rerunning the completed tool', async () => {
  let n = 0;
  const f = await setup({
    complete: async () => {
      n++;
      if (n === 1)
        return result('', [
          {
            id: 'contract',
            name: 'set_response_contract',
            arguments: { format: 'number', userRequirement: 'Return just the number' },
          },
        ]);
      return result(n === 2 ? '<answer>42</answer>' : '42');
    },
  });
  try {
    const run = f.runtime.start('chat', 'Return just the number 42.');
    await until(() => f.store.get<any>('run', run.id).status === 'completed', 10000);
    assert.equal(n, 3);
    const events = f.store.events('chat');
    assert.equal(events.filter((e) => e.type === 'tool.started').length, 1);
    assert.equal(events.filter((e) => e.type === 'delivery.format-rejected').length, 1);
    assert(
      events.some(
        (e) =>
          e.type === 'assistant.message' && (e.data as any).text === '42' && (e.data as any).final,
      ),
    );
  } finally {
    await f.runtime.shutdown();
    f.store.close();
  }
});

test('plain reply and provider failure never hydrate unrelated historical runs at finalization', async () => {
  for (const fail of [false, true]) {
    const f = await setup({
      complete: async () => {
        if (fail) throw new AppError('TEST_FAILURE', 'non-retryable test failure');
        return result('Hello');
      },
    });
    let bulkReads = 0;
    f.store.runs = (() => {
      bulkReads++;
      throw Error('Historical checkpoint bulk load forbidden');
    }) as typeof f.store.runs;
    try {
      const r = f.runtime.start('chat', 'Hi');
      await until(() =>
        ['completed', 'failed', 'interrupted'].includes(f.store.runHeader(r.id).status),
      );
      assert.equal(f.store.runHeader(r.id).status, fail ? 'failed' : 'completed');
      assert.equal(bulkReads, 0);
    } finally {
      await f.runtime.shutdown();
      f.store.close();
    }
  }
});

test(
  'explicit foreground wait yields to steering without restarting the process',
  { timeout: 15000 },
  async () => {
    let calls = 0,
      jobId = '',
      received = false;
    const f = await setup({
      complete: async (req) => {
        calls++;
        if (calls === 1)
          return result('', [
            {
              id: 'long',
              name: 'run_command',
              arguments: {
                command:
                  '"' +
                  process.execPath +
                  '" -e "console.log(123);setTimeout(()=>console.log(456),2500)"',
                folder: 0,
                yieldAfterSeconds: 0,
                timeoutSeconds: 10,
                reason: 'steering regression',
              },
            },
          ]);
        if (calls === 2) {
          received = req.messages.some(
            (m) => m.role === 'user' && m.content === 'keep current work; change next step',
          );
          jobId = JSON.parse(
            req.messages.find((m) => m.role === 'tool' && m.callId === 'long')!.content,
          ).id;
          assert.equal(f.runtime.background.get('chat', jobId).status, 'running');
          return result('', [
            { id: 'wait', name: 'wait_background_command', arguments: { id: jobId } },
          ]);
        }
        return result('Done');
      },
    });
    f.store.put('project', {
      id: 'p',
      name: 'fixture',
      folders: [await mkdtemp(join(tmpdir(), 'explicit-wait-'))],
      createdAt: 1,
    });
    f.store.put('conversation', {
      ...f.store.get<any>('conversation', 'chat'),
      projectId: 'p',
      permission: 'trusted',
    });
    try {
      const r = f.runtime.start('chat', 'Run bounded work');
      await until(() => f.runtime.background.list('chat').some((j) => j.status === 'running'));
      f.runtime.steer('chat', 'keep current work; change next step');
      await until(() => received, 2000);
      await until(() => f.store.get<any>('run', r.id).status === 'completed', 7000);
      assert.equal(f.runtime.background.list('chat').length, 1);
      assert.equal(
        f.runtime.background.get('chat', jobId).result?.stdout.replaceAll('\r', '').trim(),
        '123\n456',
      );
    } finally {
      await f.runtime.shutdown();
      f.store.close();
    }
  },
);

test('subagent model defaults and explicit allowlists apply to spawn and continuation', async () => {
  const f = await setup({ complete: async () => result('Done') });
  f.config.save({
    ...f.config.get(),
    profiles: [
      ...f.config.get().profiles,
      { ...f.config.profile('test'), id: 'second', name: 'Second', model: 'second' },
      { ...f.config.profile('test'), id: 'third', name: 'Third', model: 'third' },
    ],
  });
  try {
    const parent = f.runtime.start('chat', 'Parent task');
    await until(() => f.store.runHeader(parent.id).status === 'completed');
    await assert.rejects(
      f.runtime.spawn(
        parent,
        'Independent investigation task',
        'Return verified observations',
        'read-only',
        undefined,
        undefined,
        'second',
      ),
      /not allowed/,
    );
    assert.equal(f.store.runMetadata().length, 1);
    f.store.put('conversation', {
      ...f.store.get<any>('conversation', 'chat'),
      subagentModels: { defaultProfileId: 'second', allowedProfileIds: ['third'] },
    });
    const id = await f.runtime.spawn(
      parent,
      'Independent investigation task',
      'Return verified observations',
    );
    await until(() => f.store.runHeader(id).status === 'completed');
    assert.equal(f.store.runHeader(id).profileId, 'second');
    assert.equal(
      f.store.get<any>('conversation', f.store.runHeader(id).conversationId).permission,
      'read-only',
    );
    const next: any = await f.runtime.continueMember(
      parent,
      id,
      'Review the result',
      undefined,
      'third',
    );
    await until(() => f.store.runHeader(next.runId).status === 'completed');
    assert.equal(f.store.runHeader(next.runId).profileId, 'third');
    assert.equal(next.agentId, f.store.runHeader(id).conversationId);
    f.store.put('conversation', {
      ...f.store.get<any>('conversation', 'chat'),
      subagentModels: null,
    });
    await assert.rejects(
      f.runtime.continueMember(parent, id, 'Try a removed choice', undefined, 'third'),
      /not allowed/,
    );
    const inherited: any = await f.runtime.continueMember(parent, id, 'Follow parent model');
    await until(() => f.store.runHeader(inherited.runId).status === 'completed');
    assert.equal(f.store.runHeader(inherited.runId).profileId, 'test');
  } finally {
    await f.runtime.shutdown();
    f.store.close();
  }
});

test('conversation model settings validate connections and remain locked during active runs', async () => {
  const f = await setup({
    complete: async () =>
      result('', [
        { id: 'q', name: 'ask_user', arguments: { question: 'Wait here', options: ['Yes', 'No'] } },
      ]),
  });
  f.config.save({
    ...f.config.get(),
    profiles: [
      ...f.config.get().profiles,
      { ...f.config.profile('test'), id: 'second', model: 'second' },
    ],
  });
  const { app } = await createApp({ directory: f.dir, runtime: f.runtime });
  try {
    const boot = await app.inject({ url: '/api/bootstrap', headers: { host: '127.0.0.1:8810' } });
    const headers = {
      host: '127.0.0.1:8810',
      cookie: String(boot.headers['set-cookie']).split(';')[0],
      'x-csrf-token': boot.json().csrf,
    };
    const patch = (payload: any) =>
      app.inject({ method: 'PATCH', url: '/api/conversations/chat', headers, payload });
    assert.equal(
      (await patch({ subagentModels: { defaultProfileId: 'missing', allowedProfileIds: [] } }))
        .statusCode,
      409,
    );
    const saved = await patch({
      profileId: 'second',
      subagentModels: { defaultProfileId: null, allowedProfileIds: ['test', 'test'] },
    });
    assert.equal(saved.statusCode, 200);
    assert.deepEqual(saved.json().subagentModels.allowedProfileIds, ['test']);
    assert.equal(saved.json().reasoning, 'auto');
    const run = f.runtime.start('chat', 'Wait');
    await until(() => f.store.runHeader(run.id).status === 'waiting_user');
    assert.equal((await patch({ profileId: 'test' })).statusCode, 409);
    assert.equal((await patch({ subagentModels: null })).statusCode, 409);
    assert.equal(f.store.runHeader(run.id).profileId, 'second');
  } finally {
    await app.close();
  }
});

test('scheduled wake-up is labelled and never consumes unsent user attachments', async () => {
  let modelInput = '';
  const f = await setup({
    complete: async (request) => {
      modelInput = JSON.stringify(request);
      return result('Checked');
    },
  });
  try {
    f.store.put('attachment', {
      id: 'draft',
      conversationId: 'chat',
      name: 'private-draft.txt',
      text: 'UNSENT_PRIVATE_DRAFT_SENTINEL',
      mime: 'text/plain',
      size: 1,
    });
    const run = f.runtime.start('chat', 'Check progress', 0, {
      scheduledTrigger: { id: 'schedule', name: 'Progress' },
    });
    await until(() => f.store.get<any>('run', run.id).status === 'completed');
    const event = f.store.events('chat', 0, 'user.message')[0];
    assert.deepEqual(event.data.scheduledTrigger, { id: 'schedule', name: 'Progress' });
    assert.deepEqual(event.data.attachments, []);
    assert.equal(f.store.get<any>('attachment', 'draft').messageEventId, undefined);
    assert.equal(modelInput.includes('UNSENT_PRIVATE_DRAFT_SENTINEL'), false);
  } finally {
    await f.runtime.shutdown();
    f.store.close();
  }
});
