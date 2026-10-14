import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { Store } from '../server/storage/store.js';
import { Runtime } from '../server/core/runtime.js';
import { conversationViewRoutes } from '../server/http/conversation-view.js';
import { mergeConversationEvents } from '../src/conversation-events.js';

test('active checks and latest run never decode historical checkpoints', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-query-'));
  const store = new Store(join(dir, 'test.sqlite'));
  try {
    store.put('run', {
      id: 'old',
      conversationId: 'chat',
      createdAt: 1,
      status: 'completed',
      checkpoints: [],
    } as any);
    store.put('run', {
      id: 'new',
      conversationId: 'chat',
      createdAt: 2,
      status: 'running',
      checkpoints: [{ content: 'current' }],
    } as any);
    store.db.prepare('UPDATE run_checkpoints SET data=? WHERE id=?').run('{broken', 'old');
    assert.equal(Runtime.prototype.active.call({ store } as Runtime, 'chat')?.id, 'new');
    assert.equal(store.latestRun('chat')?.checkpoints.length, 1);
    assert.equal(store.latestRun('missing'), undefined);
    assert.throws(
      () => store.get('run', 'old'),
      (e: any) => e.code === 'RECORD_CORRUPT',
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('conversation projection scopes records and serves incremental history with authoritative delivery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-view-'));
  const store = new Store(join(dir, 'test.sqlite'));
  const app = Fastify();
  try {
    store.put('conversation', { id: 'a' });
    store.put('conversation', { id: 'b' });
    const old = store.event('a', null, 'user.message', { text: 'old' });
    store.put('user-inbox', { id: String(old.id), conversationId: 'a', state: 'delivered' });
    store.put('attachment', {
      id: 'private',
      conversationId: 'b',
      path: 'secret',
      text: 'private',
    });
    store.put('input', { id: 'private', conversationId: 'b' });
    const next = store.event('a', null, 'assistant.message', { text: 'next' });
    store.event('b', null, 'assistant.message', { text: 'private' });
    conversationViewRoutes(app, { store, streams: new Map() } as any);
    const full = (await app.inject('/api/conversations/a')).json();
    const delta = (await app.inject('/api/conversations/a?after=' + old.id)).json();
    assert.equal(full.events.length, 2);
    assert.deepEqual(
      delta.events.map((e: any) => e.id),
      [next.id],
    );
    assert.equal(delta.deliveries[old.id], 'delivered');
    assert.deepEqual(delta.attachments, []);
    assert.deepEqual(delta.inputs, []);
    assert.equal((await app.inject('/api/conversations/a?after=-1')).statusCode, 400);
  } finally {
    await app.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('snapshot merge fills SSE gaps, deduplicates events and updates old message delivery', () => {
  const event = (id: number, type = 'assistant.message', data: any = {}) => ({
    id,
    conversationId: 'a',
    runId: null,
    type,
    data,
    createdAt: id,
  });
  const result = mergeConversationEvents(
    [event(1, 'user.message', { delivery: 'pending' }), event(4)],
    [event(2), event(3), event(4)],
    { '1': 'delivered' },
  );
  assert.deepEqual(
    result.map((e) => e.id),
    [1, 2, 3, 4],
  );
  assert.equal(result[0].data.delivery, 'delivered');
});

test('bounded history pages cover every event exactly once and never cross conversations', async () => {
  const store = new Store(':memory:');
  const app = Fastify();
  try {
    store.put('conversation', { id: 'a' });
    const ids = [];
    for (let i = 0; i < 17; i++) {
      ids.push(store.event('a', null, 'user.message', { text: String(i) }).id);
      store.event('b', null, 'user.message', { text: 'private' });
    }
    conversationViewRoutes(app, { store, streams: new Map() } as any);
    let before = Number.MAX_SAFE_INTEGER;
    const loaded: number[] = [];
    for (;;) {
      const response = await app.inject('/api/conversations/a?limit=5&before=' + before);
      assert.equal(response.statusCode, 200);
      const page = response.json();
      assert(page.events.length <= 5);
      assert(page.events.every((e: any) => e.conversationId === 'a'));
      loaded.unshift(...page.events.map((e: any) => e.id));
      if (!page.hasOlderEvents) break;
      before = page.events[0].id;
    }
    assert.deepEqual(loaded, ids);
    assert.equal((await app.inject('/api/conversations/a?limit=0')).statusCode, 400);
    assert.equal((await app.inject('/api/conversations/a?limit=1001')).statusCode, 400);
    assert.equal((await app.inject('/api/conversations/a?after=1&before=2')).statusCode, 400);
    const next = store.event('a', null, 'assistant.message', { text: 'new' });
    assert.deepEqual(
      (await app.inject('/api/conversations/a?after=' + ids.at(-1)))
        .json()
        .events.map((e: any) => e.id),
      [next.id],
    );
  } finally {
    await app.close();
    store.close();
  }
});

test('run event projection filters before decoding unrelated payloads', () => {
  const store = new Store(':memory:');
  try {
    store.event('a', 'old', 'assistant.message', { text: 'large unrelated history' });
    const selected = store.event('a', 'current', 'tool.completed', { callId: 'ok' });
    store.event('a', 'current', 'assistant.message', { text: 'not needed for recovery' });
    store.db.prepare("UPDATE events SET data='invalid' WHERE type='assistant.message'").run();
    assert.deepEqual(
      store.eventsForRun('current', ['tool.started', 'tool.completed']).map((e) => e.id),
      [selected.id],
    );
  } finally {
    store.close();
  }
});
