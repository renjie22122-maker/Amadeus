import test from 'node:test';
import assert from 'node:assert/strict';
import { previewHeight } from '../src/preview-height';
test('preview height ignores rounding jitter but follows real growth and shrink', () => {
  let height = 440;
  for (let i = 0; i < 100; i++) height = previewHeight(height, i % 2 ? 441 : 439.2);
  assert.equal(height, 440);
  assert.equal(previewHeight(height, 650.2), 651);
  assert.equal(previewHeight(651, 220), 220);
  for (const value of [NaN, Infinity, -1, 0, '600', null])
    assert.equal(previewHeight(440, value), 440);
  assert.equal(previewHeight(440, 99999), 2400);
  assert.equal(previewHeight(440, 10), 160);
});
