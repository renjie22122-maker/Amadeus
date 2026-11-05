import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenHeatScale } from '../shared/token-heat.js';
test('extreme peak does not compress ordinary days into indistinguishable shades', () => {
  const normal = tokenHeatScale([1000, 1500, 2000, 3000]);
  const peak = tokenHeatScale([1000, 1500, 2000, 1e12]);
  assert.equal(normal(1500), peak(1500));
  assert.equal(normal(2000), peak(2000));
  assert.ok(peak(2000) - peak(1000) > 0.6);
  assert.equal(peak(1e12), 1);
  assert.ok(peak(1250) > peak(1000) && peak(1250) < peak(1500));
});
test('ties and sparse histories keep consistent colors without zero-day dilution', () => {
  const scale = tokenHeatScale([0, 0, 100, 100, 200, 300, NaN, Infinity, -1]);
  assert.equal(scale(100), 0);
  assert.equal(scale(200), 0.6);
  assert.equal(scale(300), 1);
  assert.equal(tokenHeatScale([42, 42, 42])(42), 0.5);
  assert.equal(tokenHeatScale([42])(42), 0.5);
  assert.equal(tokenHeatScale([])(42), 0);
  assert.equal(scale(0), 0);
  assert.equal(scale(NaN), 0);
});
