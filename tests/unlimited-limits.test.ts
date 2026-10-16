import { Store } from '../server/storage/store.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelPool } from '../server/core/pool.js';
import { RunPump } from '../server/core/run-pump.js';
import { DelegationManager } from '../server/core/delegation-manager.js';
import { Configuration } from '../server/services/settings.js';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('zero model capacity starts more than the previous cap concurrently and still cancels', async () => {
  const pool = new ModelPool(() => 0);
  let started = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const work = Array.from({ length: 40 }, () =>
    pool.run(
      new AbortController().signal,
      async () => {
        started++;
        await gate;
      },
      'one-chat',
    ),
  );
  await new Promise((r) => setImmediate(r));
  try {
    assert.equal(started, 40);
  } finally {
    release();
    await Promise.all(work);
  }
  const aborter = new AbortController();
  aborter.abort();
  await assert.rejects(
    pool.run(aborter.signal, async () => {
      throw Error('must not execute');
    }),
  );
});

test('zero run-pump limit dispatches all queued work instead of blocking', async () => {
  let started = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const pump = new RunPump({
    scope: () => 'one-chat',
    status: () => 'running',
    limit: () => 0,
    execute: async () => {
      started++;
      await gate;
    },
    finished: () => {},
  });
  for (let i = 0; i < 40; i++) pump.enqueue(String(i));
  pump.pump();
  await new Promise((r) => setImmediate(r));
  try {
    assert.equal(started, 40);
  } finally {
    release();
    await pump.drained();
  }
  assert.deepEqual(pump.keys(), []);
});

test('zero child limit passes the real spawn gate above 32, finite limits still reject', async (t) => {
  const root: any = { id: 'root', depth: 0, conversationId: 'chat' };
  const runs = [
    root,
    ...Array.from({ length: 40 }, (_, i) => ({ id: String(i), parentRunId: 'root' })),
  ];
  let maxChildren = 0;
  const directory = await mkdtemp(join(tmpdir(), 'child-gate-'));
  const store = new Store(join(directory, 'state.sqlite'));
  t.after(() => store.close());
  for (const run of runs) store.put('run', run);
  store.put('conversation', { id: 'chat', teamStrategy: 'auto' });
  const config: any = { get: () => ({ maxAgentDepth: 3, maxChildren }) };
  const host: any = {
    context: async () => {
      throw Error('PASSED_CHILD_GATE');
    },
  };
  const manager = new DelegationManager(store, config, 'unused', new EventEmitter(), host);
  await assert.rejects(manager.spawn(root, 'task', 'result'), /PASSED_CHILD_GATE/);
  maxChildren = 8;
  await assert.rejects(manager.spawn(root, 'task', 'result'), (e: any) => e.code === 'CHILD_LIMIT');
  maxChildren = 0;
  root.depth = 3;
  await assert.rejects(manager.spawn(root, 'task', 'result'), (e: any) => e.code === 'DEPTH_LIMIT');
});

test('zero configuration roundtrips; defaults remain finite and negatives are invalid', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentdemo-unlimited-'));
  const file = join(root, 'settings.json');
  const config = new Configuration(file);
  assert.equal(config.get().maxParallelRuns, 3);
  assert.equal(config.get().maxChildren, 8);
  config.save({ ...config.get(), maxParallelRuns: 0, maxChildren: 0 });
  const saved = new Configuration(file).get();
  assert.equal(saved.maxParallelRuns, 0);
  assert.equal(saved.maxChildren, 0);
  assert.throws(() => config.save({ ...saved, maxChildren: -1 }));
  assert.throws(() => config.save({ ...saved, maxParallelRuns: 0.5 }));
});
