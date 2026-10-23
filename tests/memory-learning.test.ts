import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/storage/store.js';
import { Configuration } from '../server/services/settings.js';
import {
  MemoryLearning,
  memoryTarget,
  memoryKey,
  sensitive,
} from '../server/services/memory-learning.js';
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'memory-learning-'));
  const store = new Store(join(dir, 'db.sqlite')),
    config = new Configuration(join(dir, 'settings.json'));
  config.save({
    ...config.get(),
    profiles: [
      {
        id: 'test',
        name: 'Test',
        transport: 'openai-chat',
        baseUrl: 'https://model.example',
        model: 'test',
      },
    ],
    defaultProfileId: 'test',
  });
  const c = {
    id: 'chat',
    profileId: 'test',
    projectId: null,
    parentId: null,
    archived: false,
    generateMemory: true,
    memoryGenerationTarget: memoryTarget(config.profile()),
    updatedAt: Date.now() - 300000,
  };
  store.put('conversation', c);
  store.put('run', {
    id: 'run',
    conversationId: 'chat',
    status: 'completed',
    createdAt: Date.now() - 300000,
    updatedAt: Date.now() - 300000,
    checkpoints: [],
  });
  store.event('chat', 'run', 'user.message', { content: 'Please remember my writing style.' });
  store.event('chat', 'run', 'user.message', { content: 'I prefer concise answers.' });
  const eid = store.events('chat', 0, 'user.message').at(-1)!.id;
  const item = {
    content: 'Prefers concise answers.',
    topic: 'writing-style',
    eventId: eid,
    quote: 'I prefer concise answers.',
    kind: 'preference',
    conflictsWith: [],
  };
  return { store, config, c, eid, item };
}
const response = (items: any[]) => ({
  message: { role: 'assistant' as const, content: JSON.stringify({ items }) },
  usage: { input: 10, output: 10, cached: 0, measured: true },
});
test('idle opted-in chats extract with provenance, consolidate duplicates and do not send tool output', async () => {
  const f = await fixture();
  let calls = 0;
  f.store.event('chat', 'run', 'tool.completed', { content: 'PRIVATE TOOL OUTPUT' });
  const learning = new MemoryLearning(f.store, f.config, () => ({
    complete: async (req) => {
      calls++;
      assert.equal(req.tools.length, 0);
      assert.ok(!req.messages[1].content.includes('PRIVATE TOOL OUTPUT'));
      return response([f.item, f.item]);
    },
  }));
  try {
    await learning.tick();
    await learning.tick();
    assert.equal(calls, 1);
    const memories = f.store.list<any>('memory');
    assert.equal(memories.length, 1);
    assert.equal(memories[0].active, true);
    assert.equal(memories[0].applicability, 'uncertain');
    assert.equal(memories[0].sourceEventId, f.eid);
    assert.equal(f.store.list<any>('memory-learning')[0].status, 'completed');
  } finally {
    await learning.close();
    f.store.close();
  }
});
test('opt-out, changed destination, active and short chats do not generate', async () => {
  for (const mode of ['off', 'endpoint', 'active', 'short']) {
    const f = await fixture();
    let calls = 0;
    if (mode === 'off') f.store.put('conversation', { ...f.c, generateMemory: false });
    if (mode === 'endpoint')
      f.store.put('conversation', { ...f.c, memoryGenerationTarget: 'old-endpoint' });
    if (mode === 'active')
      f.store.put('run', { id: 'run', conversationId: 'chat', status: 'running', checkpoints: [] });
    if (mode === 'short') f.store.put('conversation', { ...f.c, updatedAt: Date.now() });
    const learning = new MemoryLearning(f.store, f.config, () => ({
      complete: async () => {
        calls++;
        return response([f.item]);
      },
    }));
    try {
      await learning.tick();
      assert.equal(calls, 0);
    } finally {
      await learning.close();
      f.store.close();
    }
  }
});
test('project evidence is isolated; conflicts and decisions remain candidates', async () => {
  const f = await fixture();
  f.store.put('conversation', { ...f.c, projectId: 'p' });
  f.store.put('memory', {
    id: 'user',
    scope: 'user',
    content: 'UNRELATED USER SECRET',
    revision: 1,
    active: true,
  });
  f.store.put('memory', {
    id: 'existing',
    scope: 'project:p',
    content: 'Prefers long answers.',
    topic: 'writing-style',
    revision: 1,
    active: true,
  });
  const learning = new MemoryLearning(f.store, f.config, () => ({
    complete: async (req) => {
      assert.ok(!req.messages[1].content.includes('UNRELATED USER SECRET'));
      return response([
        { ...f.item, conflictsWith: ['existing'] },
        { ...f.item, content: 'Writing decision: concise.', topic: 'decision', kind: 'decision' },
      ]);
    },
  }));
  try {
    await learning.tick();
    const added = f.store.list<any>('memory').filter((m) => m.automatic);
    assert.equal(added.length, 2);
    assert.ok(added.every((m) => m.scope === 'project:p' && !m.active));
  } finally {
    await learning.close();
    f.store.close();
  }
});
test('source changes and opt-out during extraction discard results', async () => {
  for (const change of ['message', 'off']) {
    const f = await fixture();
    const learning = new MemoryLearning(f.store, f.config, () => ({
      complete: async () => {
        if (change === 'message')
          f.store.event('chat', 'run', 'user.message', { content: 'Actually, change that.' });
        else f.store.put('conversation', { ...f.c, generateMemory: false });
        return response([f.item]);
      },
    }));
    try {
      await learning.tick();
      assert.equal(f.store.list('memory').length, 0);
      assert.equal(f.store.list<any>('memory-learning')[0].status, 'failed');
    } finally {
      await learning.close();
      f.store.close();
    }
  }
});
test('forgotten content, unsupported quotes and secret-shaped content never activate', async () => {
  const f = await fixture();
  f.store.put('memory-forgotten', { id: memoryKey('user', f.item.content) });
  const learning = new MemoryLearning(f.store, f.config, () => ({
    complete: async () =>
      response([
        f.item,
        { ...f.item, content: 'Unsupported', quote: 'Not in any message' },
        { ...f.item, content: 'api_key=abc1234567890123' },
      ]),
  }));
  try {
    await learning.tick();
    assert.equal(f.store.list('memory').length, 0);
    assert.equal(sensitive('password=supersecret'), true);
  } finally {
    await learning.close();
    f.store.close();
  }
});
test('malformed output is recorded once and not retried in an idle loop', async () => {
  const f = await fixture();
  let calls = 0;
  const learning = new MemoryLearning(f.store, f.config, () => ({
    complete: async () => {
      calls++;
      return { ...response([]), message: { role: 'assistant', content: 'bad' } };
    },
  }));
  try {
    await learning.tick();
    await learning.tick();
    assert.equal(calls, 1);
    assert.equal(f.store.list<any>('memory-learning')[0].status, 'failed');
  } finally {
    await learning.close();
    f.store.close();
  }
});

test('automatic mode activates sourced decisions and creates scoped graph once', async () => {
  const f = await fixture();
  f.store.put('conversation', { ...f.c, automaticMemory: true });
  const learning = new MemoryLearning(
    f.store,
    f.config,
    () =>
      ({
        complete: async () => response([{ ...f.item, kind: 'decision' }]),
      }) as any,
  );
  await learning.tick();
  const memories = f.store.list<any>('memory');
  assert.equal(memories.length, 1);
  assert.equal(memories[0].active, true);
  assert.equal(f.store.list<any>('knowledge-edge').length, 1);
  assert.equal(f.store.list<any>('knowledge-edge')[0].scope, 'user');
  await learning.tick();
  assert.equal(f.store.list<any>('knowledge-edge').length, 1);
  await learning.close();
});
test('automatic mode quarantines ambiguous conflicts without activating competing facts', async () => {
  const f = await fixture();
  f.store.put('conversation', { ...f.c, automaticMemory: true });
  f.store.put('memory', {
    id: 'old',
    scope: 'user',
    content: 'Long responses',
    topic: f.item.topic,
    active: true,
    revision: 1,
    createdAt: 1,
    source: 'manual',
  });
  const learning = new MemoryLearning(
    f.store,
    f.config,
    () =>
      ({
        complete: async () =>
          response([{ ...f.item, applicability: 'scope', conflictsWith: ['old'] }]),
      }) as any,
  );
  await learning.tick();
  assert.equal(f.store.list<any>('memory').filter((m) => m.active).length, 1);
  assert.equal(f.store.list<any>('memory').find((m) => m.id !== 'old').status, 'disputed');
  assert.equal(f.store.list<any>('knowledge-edge').length, 0);
  await learning.close();
});

test('memory extraction advances through long chats and does not replay processed messages', async () => {
  const f = await fixture();
  const seen: number[][] = [];
  for (let i = 0; i < 64; i++)
    f.store.event('chat', 'run', 'user.message', { content: 'Message ' + i });
  const learning = new MemoryLearning(f.store, f.config, () => ({
    complete: async (req) => {
      seen.push(JSON.parse(req.messages[1].content).messages.map((e: any) => e.id));
      return response([]);
    },
  }));
  try {
    await learning.tick();
    await learning.tick();
    await learning.tick();
    await learning.tick();
    assert.deepEqual(
      seen.map((x) => x.length),
      [30, 30, 6],
    );
    assert.equal(new Set(seen.flat()).size, 66);
    f.store.event('chat', 'run', 'user.message', { content: 'A new durable preference.' });
    await learning.tick();
    assert.equal(seen.at(-1)!.length, 1);
  } finally {
    await learning.close();
    f.store.close();
  }
});

test('automatic learning retains reusable evolving facts with source time and conditions', async () => {
  const f = await fixture();
  f.store.put('conversation', { ...f.c, automaticMemory: true });
  let event = f.store.event('chat', 'run', 'user.message', {
    content: 'The workshop currently has three available machines for planning.',
  });
  const learning = new MemoryLearning(f.store, f.config, () => ({
    complete: async () =>
      response([
        {
          content: 'Workshop currently has three available machines.',
          topic: 'workshop-capacity',
          eventId: event.id,
          quote: 'The workshop currently has three available machines for planning.',
          kind: 'fact',
          applicability: 'scope',
          stability: 'evolving',
          conditions: 'workshop planning',
          attribute: 'available_machines',
          value: '3',
          conflictsWith: [],
        },
      ]),
  }));
  try {
    await learning.tick();
    const m = f.store.list<any>('memory')[0];
    assert.equal(m.kind, 'fact');
    assert.equal(m.active, true);
    assert.equal(m.applicability, 'scope');
    assert.equal(m.stability, 'evolving');
    assert.equal(m.conditions, 'workshop planning');
    assert.equal(m.observedAt, event.createdAt);
    assert.equal(
      m.evidence[0].quote,
      'The workshop currently has three available machines for planning.',
    );
    event = f.store.event('chat', 'run', 'user.message', {
      content: 'The workshop currently has three available machines for planning.',
    });
    await learning.tick();
    const reports = f.store.list<any>('memory');
    assert.equal(reports.length, 2);
    assert.equal(reports.filter((x) => x.active).length, 2);
    assert.ok(
      reports.some((x) => x.sourceEventId === event.id && x.observedAt === event.createdAt),
    );
  } finally {
    await learning.close();
    f.store.close();
  }
});
