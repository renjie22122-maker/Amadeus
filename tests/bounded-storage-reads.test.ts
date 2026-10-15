import { Knowledge } from '../server/services/knowledge.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/storage/store.js';

test('typed event reads filter before decoding and tail limits preserve chronology/scope', () => {
  const s = new Store(':memory:');
  try {
    s.event('c', 'r', 'assistant.message', { text: 'first' });
    s.event('other', 'r2', 'assistant.message', { text: 'private' });
    s.event('c', 'r', 'tool.completed', { large: 'x'.repeat(1000000) });
    const last = s.event('c', 'r', 'assistant.message', { text: 'last' });
    s.event('c', 'r', 'user.message', { text: 'new input' });
    assert.deepEqual(
      s.selectedEvents('c', ['assistant.message'], 1).map((e) => e.id),
      [last.id],
    );
    assert.deepEqual(
      s.selectedEvents('c', ['assistant.message', 'user.message']).map((e) => e.data.text),
      ['first', 'last', 'new input'],
    );
    assert.deepEqual(s.selectedEvents('c', []), []);
    assert.throws(() => s.selectedEvents('c', ['assistant.message'], 0));
  } finally {
    s.close();
  }
});

test('status polling does not hydrate checkpoints and attachment metadata omits payload/private path', () => {
  const s = new Store(':memory:');
  try {
    s.put('run', {
      id: 'r',
      conversationId: 'c',
      status: 'running',
      checkpoints: [{ content: 'x'.repeat(1000000) }],
    } as any);
    s.put('attachment', {
      id: 'a',
      conversationId: 'c',
      name: 'book',
      text: 'x'.repeat(1000000),
      path: 'private',
      mime: 'text/plain',
    });
    s.put('attachment', { id: 'b', conversationId: 'other', text: 'secret' });
    s.get = (() => {
      throw Error('Full record read forbidden');
    }) as typeof s.get;
    assert.equal(s.maybeRunHeader('r')?.status, 'running');
    assert.deepEqual(s.maybeRunHeader('r')?.checkpoints, []);
    assert.equal(s.maybeRunHeader('missing'), undefined);
    assert.deepEqual(s.attachmentMetadata('c'), [
      { id: 'a', conversationId: 'c', name: 'book', mime: 'text/plain' },
    ]);
  } finally {
    s.close();
  }
});

test('reconciliation with no unknown effects does not load conversation history', () => {
  const s = new Store(':memory:');
  try {
    s.events = (() => {
      throw Error('Unfiltered history read forbidden');
    }) as typeof s.events;
    s.selectedEvents = (() => {
      throw Error('Unneeded history read forbidden');
    }) as typeof s.selectedEvents;
    assert.deepEqual(s.reconcileKnownEffects('c'), []);
  } finally {
    s.close();
  }
});

test('indexing reads only current chunk payloads and preserves reuse across batch boundaries', async () => {
  const s = new Store(':memory:');
  let calls = 0;
  const kb = new Knowledge(s, {
    enabled: () => true,
    fingerprint: () => 'm',
    encode: async (texts: string[]) => {
      calls += texts.length;
      return texts.map(() => [1, 0]);
    },
  } as any);
  try {
    for (let i = 0; i < 35; i++)
      s.db
        .prepare('INSERT INTO chunks VALUES(?,?,?,?,?,?,?,?)')
        .run(String(i), 'general', 'doc', 'doc', i, 'unique text ' + i, null, 'hash');
    const prepare = s.db.prepare.bind(s.db);
    s.db.prepare = ((sql: string) => {
      assert(
        !sql.includes('SELECT id,text,vector FROM chunks WHERE document_id=? ORDER BY'),
        'must not preload all payloads',
      );
      return prepare(sql);
    }) as typeof s.db.prepare;
    const progress: number[] = [];
    assert.equal(
      (
        await kb.index(
          'doc',
          () => true,
          (p) => progress.push(p.completed),
        )
      ).chunks,
      35,
    );
    assert.equal(calls, 35);
    assert(progress.includes(16) && progress.includes(32) && progress.at(-1) === 35);
    await kb.index('doc');
    assert.equal(calls, 35);
  } finally {
    kb.close();
    s.close();
  }
});
