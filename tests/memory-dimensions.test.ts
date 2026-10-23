import test from 'node:test';
import assert from 'node:assert/strict';
import type { Memory } from '../shared/types.js';
import { memoryReach } from '../shared/memory-scope.js';
import { memoryDecayPolicy, memoryDecay } from '../shared/memory-decay.js';
import { recallMemories } from '../server/services/memory-retrieval.js';
const day = 86400000;
const base: Memory = {
  id: 'fact',
  scope: 'user',
  kind: 'fact',
  applicability: 'scope',
  stability: 'evolving',
  content: 'Workshop capacity three machines',
  conditions: 'workshop planning',
  source: 'chat:a#event:1',
  sourceConversationId: 'a',
  active: true,
  status: 'active',
  createdAt: 60 * day,
  observedAt: day,
  expiresAt: null,
  revision: 1,
};
test('reusable facts and goals are independent of permanence and local type defaults', () => {
  for (const kind of ['fact', 'goal', 'decision', 'episode'] as const) {
    const m = { ...base, kind };
    assert.equal(memoryReach(m), 'scope');
    assert.equal(memoryDecayPolicy(m), 'time');
    assert.equal(memoryReach({ ...m, applicability: 'conversation' }), 'conversation');
  }
  assert.equal(memoryDecayPolicy({ ...base, stability: 'stable' }), 'stable');
  assert.equal(memoryDecayPolicy({ ...base, stability: 'temporary' }), 'time-and-turns');
  assert.ok(memoryDecay(base, 60 * day).factor < 0.3);
});
test('cross-chat recall is relevant, dated and still bounded by project access', () => {
  const result = recallMemories([base], 'workshop', null, 60 * day, undefined, 'b');
  assert.equal(result.length, 1);
  assert.equal(result[0].observedAt, day);
  assert.equal(result[0].freshness, 'dated-report-not-guaranteed-current');
  assert.equal(result[0].applicability, 'check-conditions-before-use');
  assert.equal(recallMemories([base], 'gardening', null, 60 * day, undefined, 'b').length, 0);
  assert.equal(
    recallMemories([{ ...base, scope: 'project:p' }], 'workshop', 'q', 60 * day, undefined, 'b')
      .length,
    0,
  );
  assert.equal(
    recallMemories(
      [{ ...base, applicability: 'conversation' }],
      'workshop',
      null,
      60 * day,
      undefined,
      'b',
    ).length,
    0,
  );
  assert.equal(
    recallMemories(
      [{ ...base, conflictReviewRequired: true }],
      'workshop',
      null,
      60 * day,
      undefined,
      'b',
    ).length,
    0,
  );
});
test('more specific automatically-local facts shadow broad facts without mutating them', () => {
  const shared = { ...base, entityId: 'workshop', attribute: 'capacity', value: '3' };
  const local = {
    ...shared,
    id: 'local',
    applicability: 'conversation' as const,
    value: '2',
    content: 'Workshop capacity two machines',
  };
  const result = recallMemories([shared, local], 'workshop', null, 60 * day, undefined, 'a');
  assert.deepEqual(
    result.map((m) => m.id),
    ['local'],
  );
  assert.equal(shared.value, '3');
});
