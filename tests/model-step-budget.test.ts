import test from 'node:test';
import assert from 'node:assert/strict';
import { modelStepBudget } from '../server/services/model-step-budget.js';
test('budget guidance reserves final capacity without imposing a cap on unlimited runs', () => {
  assert.deepEqual(modelStepBudget(0, 100), []);
  assert.deepEqual(modelStepBudget(16, 12), []);
  assert.match(modelStepBudget(16, 13)[0].content, /including this request: 3/);
  assert.match(modelStepBudget(16, 15)[0].content, /including this request: 1/);
  assert.match(modelStepBudget(16, 15)[0].content, /do not guess/);
});
