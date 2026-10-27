import { memoryReachReason } from '../shared/memory-scope.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/storage/store.js';
import {
  browseHistory,
  historyConversations,
  maintainHistory,
  saveHistoryDigest,
  searchHistory,
  readHistoryDigest,
  readHistorySource,
  historyOverview,
} from '../server/services/conversation-history.js';
import { sourceKey } from '../server/services/memory-lifecycle.js';

function setup(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'history-test-'));
  const store = new Store(join(dir, 'test.db'));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  store.put('project', { id: 'p' });
  store.put('project', { id: 'q' });
  for (const [id, projectId, remote] of [
    ['local', null, false],
    ['local2', null, false],
    ['project', 'p', false],
    ['project2', 'p', false],
    ['other', 'q', false],
    ['bot', null, true],
    ['bot2', null, true],
  ] as const)
    store.put('conversation', {
      id,
      projectId,
      remoteMemoryOnly: remote,
      memory: true,
      generateMemory: true,
      archived: false,
    });
  return store;
}
test('history domains isolate local, projects and each external chat in both directions', (t) => {
  const store = setup(t);
  for (const c of store.conversations())
    store.event(c.id, null, c.remoteMemoryOnly ? 'chat.memory-source' : 'user.message', {
      text: 'coffee ' + c.id,
      senderId: 'same-human',
    });
  for (const [cid, expected] of [
    ['local', ['local', 'local2']],
    ['project', ['project', 'project2']],
    ['bot', ['bot']],
    ['bot2', ['bot2']],
  ] as const) {
    assert.deepEqual(
      searchHistory(store, cid, 'coffee')
        .results.map((x) => x.conversationId)
        .sort(),
      [...expected].sort(),
    );
  }
  assert.deepEqual(readHistorySource(store, 'bot', 'local', 1), { unavailable: true });
  store.put('conversation', { ...store.get<any>('conversation', 'local2'), generateMemory: false });
  assert.equal(historyConversations(store, 'local').length, 1);
});
test('layered summaries retain citations and reject fabricated evidence; forgetting and edits invalidate reads', (t) => {
  const store = setup(t),
    c = store.get<any>('conversation', 'bot');
  const e = store.event('bot', null, 'chat.memory-source', {
    text: 'coffee preference: no sugar',
    senderId: 'alice',
  });
  const batch = [{ id: e.id, at: e.createdAt, text: e.data.text, sender: 'alice' }];
  saveHistoryDigest(store, c, batch, [
    {
      title: 'coffee',
      summary: 'Alice prefers no sugar',
      evidence: [{ eventId: e.id, quote: 'no sugar' }],
    },
  ]);
  const topic = historyOverview(store, 'bot', 'coffee')[0];
  assert.ok(topic);
  assert.equal((readHistoryDigest(store, 'bot', topic.digestId) as any).method, 'model');
  assert.equal((readHistorySource(store, 'bot', 'bot', e.id) as any).speaker, 'alice');
  assert.deepEqual(readHistoryDigest(store, 'bot2', topic.digestId), { unavailable: true });
  store.put('memory-source-forgotten', { id: sourceKey('chat:bot', 'bot', e.id) });
  assert.equal(historyOverview(store, 'bot', 'coffee').length, 0);
  assert.equal(searchHistory(store, 'bot', 'coffee').results.length, 0);
  store.remove('memory-source-forgotten', sourceKey('chat:bot', 'bot', e.id));
  store.db
    .prepare('UPDATE events SET data=? WHERE id=?')
    .run(JSON.stringify({ ...e.data, text: 'tea instead' }), e.id);
  assert.deepEqual(readHistoryDigest(store, 'bot', topic.digestId), { unavailable: true });
});
test('incremental fallback does not repeat completed batches or accept prompt wrappers and secrets', (t) => {
  const store = setup(t),
    c = store.get<any>('conversation', 'bot');
  store.event('bot', null, 'user.message', { text: 'coffee wrapper should not appear' });
  const e = store.event('bot', null, 'chat.memory-source', {
    text: 'coffee original',
    senderId: 'alice',
  });
  store.event('bot', null, 'chat.memory-source', {
    text: 'coffee password=abcdefgh',
    senderId: 'alice',
  });
  const batch = [{ id: e.id, at: e.createdAt, text: e.data.text }];
  maintainHistory(store, c, batch);
  maintainHistory(store, c, batch);
  assert.equal(store.list('history-digest').length, 1);
  saveHistoryDigest(store, c, batch, [
    {
      title: 'invented',
      summary: 'unsupported',
      evidence: [{ eventId: e.id, quote: 'not present' }],
    },
  ]);
  assert.equal(
    (readHistoryDigest(store, 'bot', historyOverview(store, 'bot', 'coffee')[0].digestId) as any)
      .method,
    'extractive',
  );
  assert.equal(searchHistory(store, 'bot', 'coffee').results.length, 1);
  store.put('conversation', { ...c, archived: true });
  assert.equal(searchHistory(store, 'bot', 'coffee').results.length, 0);
});
test('bounded historical pagination finds older sources and paginates long originals', (t) => {
  const store = setup(t);
  const old = store.event('local', null, 'user.message', { text: 'needle ' + 'x'.repeat(10000) });
  for (let i = 0; i < 210; i++) store.event('local', null, 'user.message', { text: 'recent ' + i });
  const first = searchHistory(store, 'local', 'needle');
  assert.equal(first.results.length, 0);
  assert.ok(first.nextBefore);
  const second = searchHistory(store, 'local', 'needle', first.nextBefore!);
  assert.equal(second.results[0].eventId, old.id);
  const read = readHistorySource(store, 'local', 'local', old.id) as any;
  assert.equal(read.text.length, 8000);
  assert.equal(read.nextOffset, 8000);
  const rest = readHistorySource(store, 'local', 'local', old.id, read.nextOffset) as any;
  assert.equal(rest.nextOffset, null);
  store.remove('conversation', 'local');
  assert.deepEqual(readHistorySource(store, 'local2', 'local', old.id), { unavailable: true });
});

test('legacy bot origins preserve authorship but source author edits invalidate summaries', (t) => {
  const store = setup(t),
    c = store.get<any>('conversation', 'bot');
  const e = store.event('bot', 'legacy', 'user.message', { text: 'untrusted wrapper' });
  const o = store.event('bot', 'legacy', 'chat.origin', {
    senderId: 'alice',
    memoryMessages: ['coffee original'],
  });
  saveHistoryDigest(store, c, [{ id: e.id, at: e.createdAt, text: 'coffee original' }], []);
  const topic = historyOverview(store, 'bot', 'coffee')[0];
  assert.ok(topic);
  assert.equal((readHistorySource(store, 'bot', 'bot', e.id) as any).speaker, 'alice');
  store.db
    .prepare('UPDATE events SET data=? WHERE id=?')
    .run(JSON.stringify({ ...o.data, senderId: 'bob' }), o.id);
  assert.deepEqual(readHistoryDigest(store, 'bot', topic.digestId), { unavailable: true });
  const reply = store.event('bot', null, 'assistant.message', { text: 'coffee answer' });
  assert.equal((readHistorySource(store, 'bot', 'bot', reply.id) as any).speaker, 'assistant');
});

test('chronological history reaches old messages with attribution, cursors and domain isolation', (t) => {
  const store = setup(t);
  const first = store.event('bot', null, 'chat.memory-source', {
    senderId: 'alice',
    text: 'I own an old controller.',
  });
  for (let i = 0; i < 45; i++)
    store.event('bot', null, 'chat.memory-source', { senderId: 'bob', text: 'later ' + i });
  store.event('bot2', null, 'chat.memory-source', { senderId: 'alice', text: 'OTHER CHAT' });
  const old = browseHistory(store, 'bot', { order: 'oldest', limit: 1 });
  assert.equal(old.results[0].eventId, first.id);
  assert.equal(old.results[0].speaker, 'alice');
  assert.ok(old.nextCursor);
  const next = browseHistory(store, 'bot', { order: 'oldest', cursor: old.nextCursor!, limit: 1 });
  assert.equal(next.results[0].speaker, 'bob');
  assert.notEqual(next.results[0].eventId, first.id);
  assert.equal(browseHistory(store, 'bot', { conversationId: 'bot2' }).unavailable, true);
  store.put('memory-source-forgotten', { id: sourceKey('chat:bot', 'bot', first.id) });
  assert.notEqual(browseHistory(store, 'bot', { order: 'oldest' }).results[0].eventId, first.id);
  assert.equal(browseHistory(store, 'bot', { since: Date.now() + 99999 }).results.length, 0);
});
test('empty filtered chronological pages expose a continuation instead of claiming no history', (t) => {
  const store = setup(t);
  for (let i = 0; i < 201; i++)
    store.event('bot', null, 'user.message', { content: 'unattributed prompt wrapper' });
  const last = store.event('bot', null, 'chat.memory-source', {
    senderId: 'member',
    text: 'attributed original',
  });
  const page = browseHistory(store, 'bot', { order: 'oldest' });
  assert.equal(page.results.length, 0);
  assert.ok(page.nextCursor);
  const next = browseHistory(store, 'bot', { order: 'oldest', cursor: page.nextCursor! });
  assert.equal(next.results[0].eventId, last.id);
});

test('remote isolation is not mislabeled as a manual reach selection', () => {
  assert.equal(
    memoryReachReason({ scope: 'chat:bot', recallScope: 'conversation' } as any),
    'isolated-chat',
  );
  assert.equal(memoryReachReason({ scope: 'user', recallScope: 'conversation' } as any), 'manual');
});
