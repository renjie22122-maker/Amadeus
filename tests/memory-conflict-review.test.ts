import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/storage/store.js';
import { MemoryLifecycle } from '../server/services/memory-lifecycle.js';
import { reviewMemoryConflicts } from '../server/services/memory-conflict-review.js';
const profile = { id: 'p', baseUrl: 'https://model.example', model: 'test' } as any;
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'relation-review-')),
    store = new Store(join(dir, 'db.sqlite'));
  const c = { id: 'a', projectId: null } as any;
  store.put('conversation', c);
  const event = store.event('a', null, 'user.message', {
    content: 'Use an atmospheric style. Include detailed materials.',
  });
  const base = {
    scope: 'user',
    automatic: true,
    revision: 1,
    createdAt: 1,
    validFrom: 1,
    expiresAt: null,
    kind: 'preference',
    entityId: 'user',
    attribute: 'style',
    source: 'chat:a#event:' + event.id,
    sourceConversationId: 'a',
    sourceEventId: event.id,
  };
  store.put('memory', {
    ...base,
    id: 'old',
    content: 'Atmospheric style',
    value: 'atmospheric',
    status: 'active',
    active: true,
  });
  store.put('memory', {
    ...base,
    id: 'new',
    content: 'Detailed materials',
    value: 'detailed',
    status: 'disputed',
    active: false,
    conflictsWith: ['old'],
    conflictReviewRequired: true,
    candidateReview: {
      status: 'needs_review',
      reason: 'Conflict references repaired; human review required.',
    },
  });
  return {
    store,
    c,
    close: async () => {
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
const provider = (relation = 'complementary', quote = 'Include detailed materials.') =>
  ({
    complete: async () => ({
      message: {
        role: 'assistant',
        content: JSON.stringify({
          relations: [
            {
              id: 'old',
              relation,
              quote,
              otherQuote: 'Use an atmospheric style.',
              reason: 'Mood and material detail can coexist.',
            },
          ],
        }),
      },
      usage: { input: 1, output: 1, cached: 0, measured: true },
    }),
  }) as any;
test('unknown cardinality is not exclusive; sourced complementary records automatically coexist', async () => {
  const f = await fixture();
  try {
    const life = new MemoryLifecycle(f.store);
    assert.deepEqual(life.conflicts(f.store.get('memory', 'new')), []);
    await reviewMemoryConflicts(
      f.store,
      f.c,
      profile,
      provider(),
      new AbortController().signal,
      () => true,
      () => false,
    );
    assert.equal(f.store.get<any>('memory', 'new').active, true);
    assert.equal(f.store.get<any>('memory', 'old').active, true);
    assert.equal(f.store.list('memory-history').length, 1);
    assert.equal(f.store.get<any>('memory-relation-review', 'new').outcome, 'coexisting');
  } finally {
    await f.close();
  }
});
test('uncertain decisions and fabricated quotations never enable recall', async () => {
  for (const [relation, quote] of [
    ['uncertain', 'Include detailed materials.'],
    ['compatible', 'fabricated'],
  ]) {
    const f = await fixture();
    try {
      await reviewMemoryConflicts(
        f.store,
        f.c,
        profile,
        provider(relation, quote),
        new AbortController().signal,
        () => true,
        () => false,
      );
      assert.equal(f.store.get<any>('memory', 'new').active, false);
    } finally {
      await f.close();
    }
  }
});
test('source mutation during review and unauthorized counterparts remain quarantined', async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const p = {
      complete: async () => {
        calls++;
        f.store.put('memory', { ...f.store.get<any>('memory', 'old'), revision: 2 });
        return provider().complete();
      },
    } as any;
    await reviewMemoryConflicts(
      f.store,
      f.c,
      profile,
      p,
      new AbortController().signal,
      () => false,
      () => false,
    );
    assert.equal(calls, 0);
    await reviewMemoryConflicts(
      f.store,
      f.c,
      profile,
      p,
      new AbortController().signal,
      () => true,
      () => false,
    );
    assert.equal(f.store.get<any>('memory', 'new').active, false);
  } finally {
    await f.close();
  }
});
test('explicit exclusive values cannot be bypassed by a compatibility response', async () => {
  const f = await fixture();
  try {
    for (const id of ['new', 'old'])
      f.store.put('memory', { ...f.store.get<any>('memory', id), factCardinality: 'single' });
    await reviewMemoryConflicts(
      f.store,
      f.c,
      profile,
      provider(),
      new AbortController().signal,
      () => true,
      () => false,
    );
    assert.equal(f.store.get<any>('memory', 'new').active, false);
  } finally {
    await f.close();
  }
});

test('false conflict can be cleared without overriding a historical deactivation', async () => {
  const f = await fixture();
  try {
    f.store.put('memory-history', {
      id: 'disabled',
      memoryId: 'new',
      reason: 'edited',
      before: { active: true },
      after: { active: false, status: 'candidate' },
    });
    await reviewMemoryConflicts(
      f.store,
      f.c,
      profile,
      provider(),
      new AbortController().signal,
      () => true,
      () => false,
    );
    const m = f.store.get<any>('memory', 'new');
    assert.equal(m.active, false);
    assert.deepEqual(m.conflictsWith, []);
    assert.equal(m.status, 'candidate');
    assert.equal(m.conflictReviewRequired, true);
    assert.equal(f.store.get<any>('memory-relation-review', 'new').outcome, 'coexisting_held');
  } finally {
    await f.close();
  }
});
