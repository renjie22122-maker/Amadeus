import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/storage/store.js';
import { MemoryLifecycle } from '../server/services/memory-lifecycle.js';
import { reviewMemoryCandidates } from '../server/services/memory-candidate-review.js';
import type { Conversation, Memory, Profile } from '../shared/types.js';
const profile = {
  id: 'p',
  baseUrl: 'https://model.example',
  model: 'test',
  transport: 'openai-chat',
} as Profile;
async function fixture() {
  const store = new Store(join(await mkdtemp(join(tmpdir(), 'candidate-review-')), 'db.sqlite'));
  const c = { id: 'chat', projectId: null } as Conversation;
  store.put('conversation', c);
  store.event(c.id, null, 'user.message', { content: 'I prefer concise technical answers.' });
  const event = store.events(c.id, 0, 'user.message')[0];
  const life = new MemoryLifecycle(store);
  const add = (id: string, patch: Partial<Memory> = {}) =>
    life.create({
      id,
      scope: 'user',
      kind: 'preference',
      content: 'Prefers concise technical answers.',
      source: 'chat:chat#event:' + event.id,
      sourceConversationId: c.id,
      sourceEventId: event.id,
      active: false,
      expiresAt: null,
      revision: 1,
      createdAt: Date.now(),
      ...patch,
    });
  return { store, c, life, add };
}
const reply = (items: any[]) => ({
  message: { role: 'assistant' as const, content: JSON.stringify({ items }) },
  usage: { input: 10, output: 10, cached: 0, measured: true },
});
test('old candidates enable with exact human support, excluded states never enter review', async () => {
  const f = await fixture();
  f.add('candidate');
  f.add('disabled');
  f.life.update('disabled', { active: false }, 1);
  f.add('expired', { expiresAt: 1 });
  f.add('other', { sourceConversationId: 'elsewhere' });
  let calls = 0;
  const provider = {
    complete: async (req: any) => {
      calls++;
      const data = JSON.parse(req.messages[1].content);
      assert.deepEqual(
        data.items.map((x: any) => x.id),
        ['candidate'],
      );
      return reply([
        {
          id: 'candidate',
          approve: true,
          quote: 'I prefer concise technical answers.',
          kind: 'preference',
        },
      ]);
    },
  };
  try {
    await reviewMemoryCandidates(
      f.store,
      f.c,
      profile,
      provider,
      new AbortController().signal,
      () => true,
      () => false,
    );
    assert.equal(f.store.get<Memory>('memory', 'candidate').active, true);
    assert.equal(f.store.get<Memory>('memory', 'disabled').status, 'inactive');
    await reviewMemoryCandidates(
      f.store,
      f.c,
      profile,
      provider,
      new AbortController().signal,
      () => true,
      () => false,
    );
    assert.equal(calls, 1);
  } finally {
    f.store.close();
  }
});
test('unsupported quote, source edits, permission withdrawal and failed review do not activate', async () => {
  for (const mode of ['quote', 'edit', 'permission', 'failure']) {
    const f = await fixture();
    f.add('candidate');
    let allowed = true,
      calls = 0;
    const provider = {
      complete: async () => {
        calls++;
        if (mode === 'failure') throw Error('timeout');
        if (mode === 'permission') allowed = false;
        if (mode === 'edit') f.life.update('candidate', { content: 'Edited meanwhile' }, 1);
        return reply([
          {
            id: 'candidate',
            approve: true,
            quote: mode === 'quote' ? 'not in source' : 'I prefer concise technical answers.',
            kind: 'preference',
          },
        ]);
      },
    };
    try {
      await reviewMemoryCandidates(
        f.store,
        f.c,
        profile,
        provider,
        new AbortController().signal,
        () => allowed,
        () => false,
      );
      assert.equal(f.store.get<Memory>('memory', 'candidate').active, false);
      if (mode === 'failure') {
        await reviewMemoryCandidates(
          f.store,
          f.c,
          profile,
          provider,
          new AbortController().signal,
          () => true,
          () => false,
        );
        assert.equal(calls, 1);
      }
    } finally {
      f.store.close();
    }
  }
});
test('one batch can activate several records and cannot downgrade unsupported experience', async () => {
  const f = await fixture();
  f.add('a');
  f.add('b', { content: 'Prefers concise replies in technical discussions.' });
  f.add('experience', { kind: 'experience' });
  try {
    await reviewMemoryCandidates(
      f.store,
      f.c,
      profile,
      {
        complete: async () =>
          reply(
            ['a', 'b', 'experience'].map((id) => ({
              id,
              approve: true,
              quote: 'I prefer concise technical answers.',
              kind: 'preference',
            })),
          ),
      },
      new AbortController().signal,
      () => true,
      () => false,
    );
    assert.equal(f.store.get<Memory>('memory', 'a').active, true);
    assert.equal(f.store.get<Memory>('memory', 'b').active, true);
    assert.equal(f.store.get<Memory>('memory', 'experience').active, false);
  } finally {
    f.store.close();
  }
});

test('old automatic false conflicts can coexist after source review without replacing either memory', async () => {
  const f = await fixture();
  try {
    f.add('first', { active: true, automatic: true, content: 'First independent record' });
    f.add('second', {
      automatic: true,
      content: 'Second independent record',
      conflictsWith: ['first'],
    });
    assert.equal(f.store.get<Memory>('memory', 'second').status, 'disputed');
    await reviewMemoryCandidates(
      f.store,
      f.c,
      profile,
      {
        complete: async () =>
          reply([
            {
              id: 'second',
              approve: true,
              quote: 'I prefer concise technical answers.',
              kind: 'episode',
              coexistsWith: ['first'],
              factCardinality: 'multiple',
            },
          ]),
      },
      new AbortController().signal,
      () => true,
      () => false,
    );
    assert.equal(f.store.get<Memory>('memory', 'first').active, true);
    assert.equal(f.store.get<Memory>('memory', 'second').active, true);
    assert.deepEqual(f.store.get<Memory>('memory', 'second').conflictsWith, []);
  } finally {
    f.store.close();
  }
});
