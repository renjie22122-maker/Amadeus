import { assertSourceRetention } from '../server/core/source-ledger.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/storage/store.js';
import { Configuration } from '../server/services/settings.js';
import { tools } from '../server/tools/registry.js';
import { workflowGuidance, refreshWorkflowGuidance } from '../server/core/workflow-guidance.js';
import { RunEnvironment } from '../server/core/run-environment.js';
import { ContextManager } from '../server/core/context-manager.js';
import { ModelPool } from '../server/core/pool.js';
import { TEAM_PROTOCOL, TEAM_ENTRY } from '../server/core/prompts.js';
import { latestContextSnapshots } from '../server/core/context-snapshots.js';
import type { ModelMessage } from '../shared/types.js';

function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'context-guidance-'));
  const store = new Store(join(dir, 'db'));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const config = new Configuration(join(dir, 'config.json'));
  const run: any = { id: 'r', conversationId: 'c', depth: 0, checkpoints: [], parentRunId: null };
  const conversation: any = {
    id: 'c',
    permission: 'ask',
    teamStrategy: 'auto',
    teamMode: 'auto',
    skillIds: [],
    memory: false,
  };
  store.put('run', run);
  store.put('conversation', conversation);
  const ctx: any = {
    store,
    config,
    run,
    conversation,
    scopes: [],
    signal: new AbortController().signal,
  };
  return { store, config, run, conversation, ctx, dir };
}

test('auto stays concise; discovery loads procedures before team setup without repeated injection', async (t) => {
  const { ctx, store, run } = fixture(t);
  const registry = tools();
  assert.equal(workflowGuidance(ctx, registry.modelSpecs(ctx)), undefined);
  await registry.invoke('search_tools', { query: 'configure_team' }, ctx);
  refreshWorkflowGuidance(ctx, registry.modelSpecs(ctx));
  assert.equal(run.checkpoints[0].content, TEAM_PROTOCOL);
  refreshWorkflowGuidance(ctx, registry.modelSpecs(ctx));
  assert.equal(run.checkpoints.length, 1);
  assert.equal(store.events('c').filter((e) => e.type === 'context.guidance_loaded').length, 1);
  ctx.conversation.teamStrategy = 'off';
  assert.equal(workflowGuidance(ctx, registry.modelSpecs(ctx)), undefined);
});

test('active or explicitly selected teams load procedure; availability still bounds guidance', (t) => {
  const { ctx, store, conversation } = fixture(t);
  const registry = tools();
  conversation.teamMode = 'creative';
  assert.equal(workflowGuidance(ctx, registry.modelSpecs(ctx))?.content, TEAM_PROTOCOL);
  conversation.teamMode = 'auto';
  store.put('team-space', { id: 'r', mode: 'host' });
  assert.equal(workflowGuidance(ctx, registry.modelSpecs(ctx))?.content, TEAM_PROTOCOL);
  assert.equal(workflowGuidance(ctx, []), undefined);
});

test('initial environment keeps workflow entry and omits disabled memory management', async (t) => {
  const { ctx, store, config, run, dir } = fixture(t);
  const environment = new RunEnvironment(store, config, dir, {
    recall: async () => {
      throw new Error('Disabled memory must not be queried');
    },
  } as any);
  const system = await environment.system(
    run,
    ctx,
    { model: 'test', transport: 'openai-chat' } as any,
    [],
  );
  assert.ok(system.includes(TEAM_ENTRY));
  assert.ok(!system.includes(TEAM_PROTOCOL));
  assert.ok(system.includes('"memoryPolicy":{"enabled":false}'));
  assert.ok(!system.includes('"memoryCheckGuidance"'));
  assert.ok(!system.includes('"historyGuidance"'));
  assert.ok(TEAM_PROTOCOL.length - TEAM_ENTRY.length > 3000);
});

test('latest state selection preserves independent kinds and prefers refreshed task state', () => {
  const messages: ModelMessage[] = [
    { role: 'user', content: 'User requirement' },
    { role: 'user', contextKind: 'task-snapshot', content: 'old task' },
    { role: 'system', contextKind: 'workflow-guidance', content: 'workflow' },
    { role: 'user', contextKind: 'runtime-snapshot', content: 'old scope' },
    { role: 'user', contextKind: 'runtime-snapshot', content: 'new scope' },
  ];
  const current: ModelMessage = {
    role: 'user',
    contextKind: 'task-snapshot',
    content: 'current task',
  };
  assert.deepEqual(
    latestContextSnapshots(messages, current).map((m) => m.content),
    ['workflow', 'new scope', 'current task'],
  );
  assert.equal(messages.length, 5);
  assert.equal(latestContextSnapshots(messages)[0].content, 'old task');
});

test('compaction excludes superseded state from summary and places current state after retained tool groups', async (t) => {
  const { store, run } = fixture(t);
  const profile: any = {
    contextWindow: 16000,
    maxOutputTokens: 1000,
    efforts: ['none'],
    prices: {},
  };
  run.checkpoints = [
    { role: 'system', content: 'Instructions' },
    { role: 'user', content: 'Preserve original user requirement' },
    { role: 'user', contextKind: 'task-snapshot', content: 'OBSOLETE_TASK' },
    ...Array.from({ length: 8 }, () => ({
      role: 'assistant',
      content: 'investigation '.repeat(3000),
    })),
    { role: 'system', contextKind: 'workflow-guidance', content: 'Retain procedure verbatim' },
    { role: 'user', contextKind: 'runtime-snapshot', content: 'Current scope' },
    {
      role: 'assistant',
      content: '',
      calls: [{ id: 'read', name: 'read_file', arguments: { path: 'a' } }],
    },
    { role: 'tool', callId: 'read', content: 'Current observed contents' },
    { role: 'user', contextKind: 'task-snapshot', content: 'STALE_TAIL_TASK' },
  ];
  const current: ModelMessage = {
    role: 'user',
    contextKind: 'task-snapshot',
    content: 'Fresh blocked state',
  };
  let summaries = 0;
  const earlier: ModelMessage = { ...current, content: 'State before summary' };
  const manager = new ContextManager(
    store,
    () => 0.75,
    new ModelPool(() => 1),
    async (_run, request) => {
      summaries++;
      const input = JSON.stringify(request.messages);
      assert.ok(!input.includes('OBSOLETE_TASK'));
      assert.ok(!input.includes('STALE_TAIL_TASK'));
      return {
        message: { role: 'assistant', content: 'Investigation summary' },
        usage: { input: 1, output: 1, cached: 0, measured: false },
      };
    },
    undefined,
    () => (summaries ? current : earlier),
  );
  await manager.compact(run, profile, new AbortController().signal, []);
  assert.ok(summaries > 0);
  assert.deepEqual(
    run.checkpoints.filter((m: ModelMessage) => m.contextKind === 'task-snapshot'),
    [current],
  );
  assert.equal(run.checkpoints.at(-1).content, 'Fresh blocked state');
  assert.ok(
    run.checkpoints.some((m: ModelMessage) => m.content === 'Preserve original user requirement'),
  );
  assert.ok(run.checkpoints.some((m: ModelMessage) => m.content === 'Retain procedure verbatim'));
  const resultIndex = run.checkpoints.findIndex((m: ModelMessage) => m.callId === 'read');
  assert.equal(run.checkpoints[resultIndex - 1].calls[0].id, 'read');
});

test('snapshot-only compaction needs no summary call and retains the original request', async (t) => {
  const { store, run } = fixture(t);
  run.checkpoints = [
    { role: 'system', content: 'Instructions' },
    { role: 'user', content: 'Original task' },
    ...Array.from({ length: 10 }, () => ({
      role: 'user',
      contextKind: 'task-snapshot',
      content: 'obsolete '.repeat(2000),
    })),
    { role: 'user', contextKind: 'task-snapshot', content: 'Latest state' },
  ];
  const manager = new ContextManager(
    store,
    () => 0.75,
    new ModelPool(() => 1),
    async () => {
      throw new Error('Replacing snapshots requires no model summary');
    },
  );
  await manager.compact(
    run,
    { contextWindow: 16000, maxOutputTokens: 1000, efforts: ['none'] } as any,
    new AbortController().signal,
    [],
  );
  assert.equal(run.checkpoints.length, 3);
  assert.equal(run.checkpoints[1].content, 'Original task');
  assert.equal(run.checkpoints[2].content, 'Latest state');
  assert.equal(
    store.events('c').some((e) => e.type === 'context.degraded'),
    false,
  );
});

test('oversized legacy remote requests compact into a scoped verified archive without losing the latest request', async (t) => {
  const { store, run } = fixture(t);
  run.checkpoints = [
    { role: 'system', content: 'Instructions' },
    ...Array.from({ length: 12 }, (_, i) => ({
      role: 'user',
      content:
        `Legacy sender ${i}: preserve my constraint. ` +
        'Repeated host style and group history. '.repeat(1200),
    })),
    ...Array.from({ length: 7 }, () => ({ role: 'assistant', content: 'Old reply' })),
    { role: 'user', content: 'Current request: do not delete any source.' },
  ];
  const before = structuredClone(run.checkpoints);
  let summaries = 0;
  const manager = new ContextManager(
    store,
    () => 0.75,
    new ModelPool(() => 1),
    async () => {
      summaries++;
      return {
        message: {
          role: 'assistant',
          content: 'Earlier participant constraints preserved; consult archive for exact text.',
        },
        usage: { input: 1, output: 1, cached: 0, measured: false },
      };
    },
  );
  const result = await manager.compact(
    run,
    { contextWindow: 16000, maxOutputTokens: 1000, efforts: ['none'] } as any,
    new AbortController().signal,
    [],
  );
  assert.ok(summaries > 0);
  assert.ok(result.tokens < result.threshold);
  assert.ok(
    run.checkpoints.some((m: any) => m.content === 'Current request: do not delete any source.'),
  );
  assert.ok(
    run.checkpoints.some(
      (m: any) => m.contextKind === 'source-ledger' && m.content.includes('read_spill'),
    ),
  );
  assertSourceRetention(before, run.checkpoints, (key) => {
    const spill = store.get<any>('spill', key);
    assert.equal(spill.conversationId, 'c');
    return spill.text;
  });
});

test('summary failure archives old user sources while preserving current request and a readable recovery path', async (t) => {
  const { store, run } = fixture(t);
  run.checkpoints = [
    { role: 'system', content: 'instructions' },
    ...Array.from({ length: 8 }, (_, i) => ({
      role: 'user',
      content: 'historical-' + i + ' retain source '.repeat(3000),
    })),
    ...Array.from({ length: 7 }, () => ({ role: 'assistant', content: 'old response' })),
    { role: 'user', content: 'latest requirement' },
  ];
  const before = structuredClone(run.checkpoints);
  const manager = new ContextManager(
    store,
    () => 0.75,
    new ModelPool(() => 1),
    async () => {
      throw Error('summary unavailable');
    },
  );
  await manager.compact(
    run,
    { contextWindow: 16000, maxOutputTokens: 1000, efforts: ['none'] } as any,
    new AbortController().signal,
    [],
  );
  assertSourceRetention(before, run.checkpoints, (key) => store.get<any>('spill', key).text);
  assert.ok(run.checkpoints.some((m: any) => m.content.includes('Summary unavailable')));
  assert.ok(run.checkpoints.some((m: any) => m.content === 'latest requirement'));
});

test('ordinary requests prune obsolete host snapshots below compaction threshold without dropping sources', async (t) => {
  const { store, run } = fixture(t);
  run.checkpoints = [
    { role: 'system', content: 'instructions' },
    { role: 'user', content: 'original' },
    { role: 'user', contextKind: 'runtime-snapshot', content: 'old'.repeat(1000) },
    {
      role: 'assistant',
      content: '',
      calls: [{ id: 'a', name: 'read_file', arguments: { path: 'a' } }],
    },
    { role: 'tool', callId: 'a', content: 'result' },
    { role: 'user', contextKind: 'runtime-snapshot', content: 'current' },
    { role: 'user', content: 'latest' },
  ];
  const before = [...run.checkpoints];
  const manager = new ContextManager(
    store,
    () => 0.85,
    new ModelPool(() => 1),
    async () => {
      throw Error('no summary needed');
    },
  );
  await manager.compact(
    run,
    { contextWindow: 100000, maxOutputTokens: 1000 } as any,
    new AbortController().signal,
    [],
  );
  assert.deepEqual(
    run.checkpoints,
    before.filter((m) => m.content !== 'old'.repeat(1000)),
  );
  assertSourceRetention(before, run.checkpoints);
});
