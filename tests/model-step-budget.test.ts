import test from 'node:test';
import assert from 'node:assert/strict';
import { modelStepBudget } from '../server/services/model-step-budget.js';
test('budget guidance reserves final capacity without imposing a cap on unlimited runs', () => {
  assert.deepEqual(modelStepBudget(0, 100), []);
  assert.deepEqual(modelStepBudget(16, 11), []);
  assert.match(modelStepBudget(16, 13)[0].content, /including this request: 3/);
  assert.match(modelStepBudget(16, 15)[0].content, /including this request: 1/);
  assert.match(modelStepBudget(16, 15)[0].content, /do not guess/);
});

test('budget guidance reports acquisition failures without claiming semantic confidence', () => {
  const note = modelStepBudget(16, 12, {
    hashes: [],
    repeated: 4,
    attempts: 8,
    unusable: 6,
    novel: 2,
  })[0].content;
  assert.match(note, /including this request: 4/);
  assert.match(note, /unusable responses\/errors: 6/);
  assert.match(note, /not verified relevance/);
});
