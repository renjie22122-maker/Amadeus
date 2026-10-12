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
