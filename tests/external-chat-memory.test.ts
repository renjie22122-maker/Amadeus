import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/storage/store.js';
import { MemoryIndex } from '../server/services/memory-index.js';
import { MemoryLifecycle } from '../server/services/memory-lifecycle.js';
import { MemoryLearning, memoryTarget } from '../server/services/memory-learning.js';
import { Configuration } from '../server/services/settings.js';
import { ChatConnections } from '../server/services/chat-connections.js';
import { inheritedMemory } from '../server/services/memory-policy.js';
function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'external-memory-'));
  const store = new Store(join(dir, 'test.db'));
  const config = new Configuration(join(dir, 'settings.json'));
  config.save({
    ...config.get(),
    profiles: [
      {
        id: 'model',
        name: 'Test',
        transport: 'openai-chat',
        baseUrl: 'https://example.invalid',
        model: 'test',
      },
    ],
    defaultProfileId: 'model',
  });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, config, dir };
}
test('external memory recall is isolated in both directions including legacy shared records', async (t) => {
  const { store } = fixture(t);
  for (const id of ['local', 'private-a', 'private-b', 'group'])
    store.put('conversation', { id, projectId: null, remoteMemoryOnly: id !== 'local' });
  const life = new MemoryLifecycle(store);
  for (const [id, scope, source] of [
    ['local', 'user', 'local'],
    ['a', 'chat:private-a', 'private-a'],
    ['b', 'chat:private-b', 'private-b'],
    ['group', 'chat:group', 'group'],
  ]) {
    life.create({
      id,
      scope,
      sourceConversationId: source,
      source: 'fixture',
      active: true,
      recallScope: 'scope',
      applicability: 'scope',
      content: 'coffee preference ' + id,
      createdAt: Date.now(),
      revision: 1,
      expiresAt: null,
    } as any);
  }
  store.put('memory', {
    id: 'legacy',
    scope: 'user',
    sourceConversationId: 'private-a',
    source: 'fixture',
    active: true,
    content: 'coffee legacy leak',
    createdAt: Date.now(),
    revision: 1,
    expiresAt: null,
  });
  const index = new MemoryIndex(store, { enabled: () => false, fingerprint: () => 'test' } as any);
  for (const [cid, expected] of [
    ['local', 'local'],
    ['private-a', 'a'],
    ['private-b', 'b'],
    ['group', 'group'],
  ]) {
    const result = await index.recall(
      'coffee',
      null,
      new AbortController().signal,
      true,
      Date.now(),
      cid,
    );
    assert.deepEqual(
      result.memories.map((m) => m.id),
      [expected],
    );
  }
  const updated = life.update('a', { recallScope: 'scope', applicability: 'scope' });
  assert.equal(updated.recallScope, 'conversation');
  assert.equal(updated.applicability, 'conversation');
  assert.throws(() => life.update('legacy', { active: true }), /evidence/i);
});
test('external extraction excludes injected group context and preserves each platform speaker', async (t) => {
  const { store, config } = fixture(t);
  store.put('conversation', {
    id: 'group',
    projectId: null,
    profileId: 'model',
    remoteMemoryOnly: true,
    memory: true,
    automaticMemory: true,
    generateMemory: true,
    memoryGenerationTarget: memoryTarget(config.profile()),
    updatedAt: Date.now() - 300000,
  });
  const items: any[] = [];
  for (const [run, sender] of [
    ['r1', '111'],
    ['r2', '222'],
  ]) {
    store.put('run', {
      id: run,
      conversationId: 'group',
      status: 'completed',
      createdAt: Date.now() - 300000,
      updatedAt: Date.now() - 300000,
      checkpoints: [],
    });
    const e = store.event('group', run, 'user.message', {
      content: 'OTHER PERSON SECRET. I prefer coffee.',
    });
    store.event('group', run, 'chat.origin', {
      senderId: sender,
      memoryMessages: ['I prefer coffee.'],
    });
    items.push({
      content: 'Prefers coffee.',
      topic: 'drink',
      kind: 'preference',
      eventId: e.id,
      quote: 'I prefer coffee.',
      applicability: 'scope',
      attribute: 'drink',
      value: 'coffee',
      conflictsWith: [],
    });
  }
  const learning = new MemoryLearning(store, config, () => ({
    complete: async (req) => {
      assert.ok(!req.messages[1].content.includes('OTHER PERSON SECRET'));
      assert.ok(req.messages[1].content.includes('111'));
      return {
        message: { role: 'assistant', content: JSON.stringify({ items }) },
        usage: { input: 1, output: 1, cached: 0, measured: true },
      };
    },
  }));
  try {
    await learning.tick();
    const rows = store.list<any>('memory');
    assert.equal(rows.length, 2, JSON.stringify(store.list('memory-learning')));
    assert.equal(new Set(rows.map((m) => m.entityId)).size, 2);
    assert.ok(
      rows.every((m) => m.scope === 'chat:group' && m.active && m.recallScope === 'conversation'),
    );
    assert.ok(rows.some((m) => m.content.startsWith('[Platform sender 111]')));
  } finally {
    await learning.close();
  }
});
test('existing connection migration preserves grants, paused state and model destination; local defaults do not leak', (t) => {
  const { store, config, dir } = fixture(t);
  store.put('conversation', {
    id: 'bot',
    projectId: null,
    profileId: 'model',
    memory: false,
    remoteChatOnly: true,
  });
  const runtime: any = { config };
  const first = new ChatConnections(store, runtime, dir);
  store.put('chat-connection', {
    id: 'connection',
    conversationId: 'bot',
    authorizedTarget: first.target('bot'),
    enabled: false,
    revision: 3,
  });
  new ChatConnections(store, runtime, dir);
  const c = store.get<any>('conversation', 'bot');
  assert.equal(c.remoteMemoryOnly, true);
  assert.equal(c.memory, true);
  assert.equal(c.automaticMemory, true);
  assert.equal(c.memoryGenerationTarget, memoryTarget(config.profile()));
  const binding = store.get<any>('chat-connection', 'connection');
  assert.equal(binding.enabled, false);
  assert.equal(binding.revision, 3);
  assert.equal(binding.authorizedTarget, first.target('bot'));
  store.put('memory-policy', {
    id: 'user',
    enabled: true,
    targets: [memoryTarget(config.profile())],
  });
  assert.equal(inheritedMemory(store, config, { ...c, automaticMemory: false }).memory, false);
  store.put('conversation', { ...c, memory: false, automaticMemory: false });
  new ChatConnections(store, runtime, dir);
  assert.equal(store.get<any>('conversation', 'bot').automaticMemory, false);
});
