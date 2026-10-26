import test from 'node:test';
import assert from 'node:assert/strict';
import { runDescendants } from '../src/run-descendants.js';
test('descendant accounting keeps source order, isolates roots and terminates on cycles', () => {
  const runs = [
    { id: 'leaf', parentRunId: 'child' },
    { id: 'other', parentRunId: null },
    { id: 'root', parentRunId: 'leaf' },
    { id: 'child', parentRunId: 'root' },
    { id: 'orphan', parentRunId: 'missing' },
  ];
  assert.deepEqual(
    runDescendants(runs, 'root').map((r) => r.id),
    ['leaf', 'root', 'child'],
  );
  assert.deepEqual(
    runDescendants(runs, 'other').map((r) => r.id),
    ['other'],
  );
});
test('long delegation chains need no recursive stack or per-parent array scan', () => {
  const runs = Array.from({ length: 20000 }, (_, i) => ({
    id: String(i),
    parentRunId: i ? String(i - 1) : null,
  }));
  assert.equal(runDescendants(runs, '0').length, 20000);
});
