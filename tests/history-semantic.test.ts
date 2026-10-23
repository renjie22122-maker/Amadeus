import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/storage/store.js';
import { HistorySemantic, historyPassages } from '../server/services/history-semantic.js';
import { sourceKey } from '../server/services/memory-lifecycle.js';
function setup(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'history-vectors-'));
  const store = new Store(join(dir, 'test.db'));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  store.put('project', { id: 'p' });
  for (const [id, projectId, remote] of [
    ['a', null, false],
    ['b', null, true],
    ['c', null, true],
    ['p', 'p', false],
  ] as const)
    store.put('conversation', {
      id,
      projectId,
      remoteMemoryOnly: remote,
      memory: true,
      generateMemory: true,
    });
  return store;
}
const signal = () => new AbortController().signal;
function embedding() {
  let passages = 0,
    model = 'one';
  return {
    enabled: () => true,
    fingerprint: () => model,
    setModel: (x: string) => (model = x),
    count: () => passages,
    encode: async (texts: string[], _s?: AbortSignal, purpose?: string) => {
      if (purpose === 'passage') passages += texts.length;
      return texts.map((s) => (/疲惫|exhausted|tired|dinner/.test(s) ? [1, 0] : [0, 1]));
    },
  };
}
test('paraphrases use semantic recall, scoped domains never mix, persisted unchanged passages reuse', async (t) => {
  const store = setup(t),
    e = embedding();
  for (const c of store.conversations())
    store.event(c.id, null, c.remoteMemoryOnly ? 'chat.memory-source' : 'user.message', {
      text: '下班后很疲惫，不愿做饭',
      senderId: 'same-person',
    });
  for (const cid of ['a', 'b', 'c', 'p']) {
    const r = await new HistorySemantic(store, e).search(
      cid,
      'too exhausted to prepare dinner',
      signal(),
    );
    assert.equal(r.method, 'hybrid');
    assert.deepEqual(
      r.results.map((x) => x.conversationId),
      [cid],
    );
  }
  assert.equal(e.count(), 4);
  const r = await new HistorySemantic(store, e).search('b', 'tired', signal());
  assert.equal(e.count(), 4);
  assert.equal(r.semantic.indexed, 0);
});
test('source edits, forgotten markers and model changes cannot reuse stale vectors', async (t) => {
  const store = setup(t),
    e = embedding(),
    index = new HistorySemantic(store, e);
  const event = store.event('b', null, 'chat.memory-source', { text: '疲惫', senderId: 'one' });
  await index.search('b', 'tired', signal());
  store.db
    .prepare('UPDATE events SET data=? WHERE id=?')
    .run(JSON.stringify({ text: '疲惫 changed', senderId: 'two' }), event.id);
  const changed = await index.search('b', 'tired', signal());
  assert.equal(e.count(), 2);
  assert.equal(changed.results[0].speaker, 'two');
  e.setModel('two');
  await index.search('b', 'tired', signal());
  assert.equal(e.count(), 3);
  store.put('memory-source-forgotten', { id: sourceKey('chat:b', 'b', event.id) });
  assert.equal((await index.search('b', 'tired', signal())).results.length, 0);
});
test('revoked access during passage or query embedding never persists or returns unauthorized data', async (t) => {
  const store = setup(t),
    e = embedding();
  store.event('b', null, 'chat.memory-source', { text: '疲惫', senderId: 'one' });
  const original = e.encode;
  e.encode = async (...args) => {
    store.put('conversation', { ...store.get<any>('conversation', 'b'), memory: false });
    return original(...args);
  };
  assert.equal(
    (await new HistorySemantic(store, e).search('b', 'tired', signal())).results.length,
    0,
  );
  assert.equal(store.list('history-vector').length, 0);
  store.put('conversation', { ...store.get<any>('conversation', 'b'), memory: true });
  e.encode = original;
  await new HistorySemantic(store, e).search('b', 'tired', signal());
  e.encode = async (...args) => {
    if (args[2] === 'query')
      store.put('conversation', {
        ...store.get<any>('conversation', 'b'),
        remoteMemoryOnly: false,
        projectId: 'p',
      });
    return original(...args);
  };
  assert.equal(
    (await new HistorySemantic(store, e).search('b', 'tired', signal())).results.length,
    0,
  );
});
test('bounded incremental indexing, overlapping chunks deduplicate, concurrent requests do not duplicate work', async (t) => {
  const store = setup(t),
    e = embedding();
  for (let i = 0; i < 10; i++)
    store.event('b', null, 'chat.memory-source', { text: '疲惫 ' + i, senderId: 'one' });
  const a = new HistorySemantic(store, e),
    b = new HistorySemantic(store, e);
  const results = await Promise.all([
    a.search('b', 'tired', signal()),
    b.search('b', 'tired', signal()),
  ]);
  assert.equal(e.count(), 8);
  assert.ok(results.some((r) => r.semantic.status === 'index_busy'));
  await a.search('b', 'tired', signal());
  assert.equal(e.count(), 10);
  store.event('c', null, 'chat.memory-source', { text: '疲惫 '.repeat(1000), senderId: 'one' });
  assert.equal((await a.search('c', 'tired', signal())).results.length, 1);
});
test('unavailable embedding and malformed vectors fall back; caller cancellation propagates', async (t) => {
  const store = setup(t);
  store.event('a', null, 'user.message', { text: 'coffee' });
  const e = embedding();
  e.encode = async () => {
    throw Error('service unavailable');
  };
  const r = await new HistorySemantic(store, e).search('a', 'coffee', signal());
  assert.equal(r.method, 'lexical');
  assert.equal(r.results.length, 1);
  assert.equal(store.list('history-vector').length, 0);
  e.encode = async () => [[0, 0]];
  assert.equal(
    (await new HistorySemantic(store, e).search('a', 'coffee', signal())).method,
    'lexical',
  );
  assert.equal(store.list('history-vector').length, 0);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(new HistorySemantic(store, e).search('a', 'coffee', abort.signal));
});

test('unchanged passage content survives source revisions and dimension drift recovers', async (t) => {
  const store = setup(t),
    e = embedding(),
    index = new HistorySemantic(store, e);
  const event = store.event('b', null, 'chat.memory-source', {
    text: '疲惫 ' + 'a'.repeat(2200),
    senderId: 'one',
  });
  await index.search('b', 'tired', signal());
  const first = e.count();
  store.db
    .prepare('UPDATE events SET data=? WHERE id=?')
    .run(
      JSON.stringify({ ...event.data, text: event.data.text.replace('疲惫', '疲倦') }),
      event.id,
    );
  await index.search('b', 'tired', signal());
  assert.equal(e.count(), first + 1);
  const original = e.encode;
  e.encode = async (...args) => (await original(...args)).map((v) => [...v, 1]);
  const drift = await index.search('b', 'tired', signal());
  assert.equal(drift.semantic.status, 'dimension_changed');
  await index.search('b', 'tired', signal());
  assert.ok(store.list<any>('history-vector').every((v) => v.vector.length === 3));
});

test('uncooperative encoder cannot hold a cancelled caller or write late vectors', async (t) => {
  const store = setup(t),
    e = embedding();
  store.event('b', null, 'chat.memory-source', { text: '疲惫', senderId: 'one' });
  let finish!: (v: number[][]) => void;
  e.encode = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const abort = new AbortController(),
    pending = new HistorySemantic(store, e).search('b', 'tired', abort.signal);
  abort.abort();
  await assert.rejects(pending);
  finish([[1, 0]]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.list('history-vector').length, 0);
});

test('multilingual passage windows preserve coverage without splitting Unicode pairs', () => {
  const text = '中文🙂abc'.repeat(300),
    parts = historyPassages(text);
  let end = 0;
  for (const p of parts) {
    assert.ok(p.offset <= end);
    assert.ok(Buffer.byteLength(p.text, 'utf8') <= 400);
    assert.equal(text.slice(p.offset, p.offset + p.text.length), p.text);
    assert.ok(!/^[\uDC00-\uDFFF]/.test(p.text));
    end = p.offset + p.text.length;
  }
  assert.equal(end, text.length);
});
