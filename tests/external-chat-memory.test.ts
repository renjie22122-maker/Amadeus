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

test('shared chat settings require attributed support and remain separate from participant facts', async (t) => {
  const { store } = fixture(t);
  store.put('conversation', { id: 'group', projectId: null, remoteMemoryOnly: true });
  const source = (run: string, sender: string, text: string, extra: any = {}) => {
    const e = store.event('group', run, 'user.message', { content: text });
    store.event('group', run, 'chat.origin', {
      senderId: sender,
      peerType: 'group',
      memoryMessages: [text],
      ...extra,
    });
    return { conversationId: 'group', eventId: e.id, quote: text };
  };
  const a = source('a', '111', 'Let us use a playful style.'),
    b = source('b', '222', 'I agree to a playful style.');
  const life = new MemoryLifecycle(store);
  const m = life.create({
    id: 'style',
    scope: 'chat:group',
    source: 'chat:group#event:' + a.eventId,
    sourceConversationId: 'group',
    sourceEventId: a.eventId,
    chatSubject: 'assistant',
    basis: 'proposal',
    content: 'Use a playful style in casual chat, adapt for serious tasks.',
    conditions: 'Casual conversation only.',
    stability: 'evolving',
    active: true,
    revision: 1,
    createdAt: Date.now(),
    expiresAt: null,
    evidence: [a],
  } as any);
  assert.equal(m.active, false);
  assert.throws(() => life.update('style', { active: true }), /evidence/i);
  const fake = { ...b, quote: 'unsupported invented consensus' };
  assert.equal(life.evidenceValid({ ...m, basis: 'direct-request', evidence: [fake] }), false);
  const accepted = life.update(
    'style',
    { basis: 'direct-request', evidence: [a], active: true },
    m.revision,
  );
  assert.equal(accepted.active, true);
  const index = new MemoryIndex(store, { enabled: () => false, fingerprint: () => 'test' } as any);
  const recalled = await index.recall(
    'hello',
    null,
    new AbortController().signal,
    true,
    Date.now(),
    'group',
  );
  assert.deepEqual(
    recalled.memories.map((m) => m.id),
    ['style'],
  );
  assert.equal(recalled.memories[0].chatSubject, 'assistant');
  assert.equal(
    (await index.recall('hello', null, new AbortController().signal, true, Date.now(), 'other'))
      .memories.length,
    0,
  );
  // A single ordinary participant can establish an interaction preference.
  assert.equal(life.evidenceValid({ ...accepted, evidence: [a] }), true);
  assert.equal(life.evidenceValid({ ...accepted, scope: 'chat:other', evidence: [a] }), false);
  const privatePeer = source('private', '444', 'Use concise replies.', { peerType: 'private' });
  assert.equal(life.evidenceValid({ ...accepted, evidence: [privatePeer] }), true);
});
