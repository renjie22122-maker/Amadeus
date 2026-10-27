import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryContext, memoryProse, reinforcement } from '../server/services/memory-context.js';
import { memoryDecay } from '../shared/memory-decay.js';
import { experienceOutcome } from '../server/services/memory-experience.js';
test('window reserves older evidence, excludes future and forgotten material', () => {
  const sources = Array.from({ length: 50 }, (_, i) => ({
    id: i + 1,
    at: i,
    text: 'x'.repeat(4000),
  }));
  const result = memoryContext(
    sources,
    [sources[48]],
    [{ evidence: [{ eventId: 1 }] } as any],
    (s) => s.id !== 48,
  );
  assert.ok(result.some((s) => s.id === 1));
  assert.ok(!result.some((s) => s.id >= 48));
  assert.ok(result.reduce((n, s) => n + s.text.length, 0) <= 32000);
  assert.equal(
    memoryProse('[Assistant interaction context] [Assistant interaction context] Plain'),
    'Plain',
  );
});
test('reinforcement cannot revive a hold or count replay, and strength is bounded', () => {
  const m: any = {
    active: true,
    automatic: true,
    sourceConversationId: 'a',
    sourceEventId: 1,
    createdAt: 1,
    observedAt: 1,
    kind: 'episode',
    evidence: [{ conversationId: 'a', eventId: 2 }],
  };
  assert.deepEqual(reinforcement(m, { id: 2, at: 20, text: 'same' }, 'a'), {});
  assert.deepEqual(reinforcement(m, { id: 3, at: 20, text: 'same' }, 'b'), {});
  assert.deepEqual(
    reinforcement({ ...m, active: false }, { id: 3, at: 20, text: 'same' }, 'a'),
    {},
  );
  const boost = reinforcement(m, { id: 3, at: 20, text: 'same' }, 'a');
  assert.equal(boost.reinforcementCount, 1);
  assert.equal(boost.reinforcedEventId, 3);
  assert.ok(
    memoryDecay({ ...m, ...boost }, 86400000 * 30).factor > memoryDecay(m, 86400000 * 30).factor,
  );
  assert.equal(memoryDecay({ ...m, reinforcementCount: 1e6 }, 86400000 * 3000).factor, 0.05);
  assert.equal(
    experienceOutcome({ verification: { passed: false }, outcome: { status: 'denied' } }),
    undefined,
  );
  assert.equal(
    experienceOutcome({ verification: { passed: false }, output: '{"timedOut":true}' }),
    undefined,
  );
  assert.equal(experienceOutcome({ verification: { passed: true } }), 'success');
});

test('old source quotation beyond its first window is restored for a later revision', () => {
  const text = 'x'.repeat(6000) + 'Original tested procedure';
  const result = memoryContext(
    [
      { id: 1, at: 1, text },
      { id: 9, at: 9, text: 'update' },
    ],
    [{ id: 9, at: 9, text: 'update' }],
    [{ evidence: [{ eventId: 1, quote: 'Original tested procedure' }] } as any],
    () => true,
  );
  assert.ok(result[0].text.includes('Original tested procedure'));
});

test('dialogue context stays in the original conversation and skips excluded turns', async () => {
  const { Store } = await import('../server/storage/store.js');
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { memoryDialogueContext } = await import('../server/services/memory-context.js');
  const store = new Store(join(await mkdtemp(join(tmpdir(), 'dialogue-context-')), 'db.sqlite'));
  try {
    const before = store.event('a', null, 'user.message', { content: 'Old topic' });
    const response = store.event('a', null, 'assistant.message', {
      content: 'Clarification'.repeat(2000),
    });
    store.event('b', null, 'assistant.message', { content: 'Other conversation secret' });
    const next = store.event('a', null, 'user.message', { content: 'That one' });
    const sources = [
      { id: before.id, at: 1, text: 'Old topic' },
      { id: next.id, at: 2, text: 'That one' },
    ];
    const result = memoryDialogueContext(store, 'a', sources, [sources[1]], () => true);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, response.id);
    assert.ok(result[0].text.length <= 2000);
    assert.deepEqual(
      memoryDialogueContext(store, 'a', sources, [sources[1]], (s) => s.id !== before.id),
      [],
    );
  } finally {
    store.close();
  }
});
