import test from 'node:test';
import assert from 'node:assert/strict';
import { processStartedAt, isReusedOwner } from '../supervisor-lock.mjs';
test('lock identity distinguishes recycled PID, legacy locks and unavailable process details', () => {
  assert.equal(isReusedOwner({ startedAt: 1000 }, 3000, 1000), false);
  assert.equal(isReusedOwner({ startedAt: 1000 }, 3000, 2000), true);
  assert.equal(isReusedOwner({}, 3000, 5000), true);
  assert.equal(isReusedOwner({}, 3000, 1000), false);
  assert.equal(isReusedOwner({}, 3000, undefined), false);
  assert.equal(isReusedOwner({ startedAt: 1000 }, 3000, undefined), false);
});
test(
  'Windows birth time is stable for live process and absent for nonexistent PID',
  { skip: process.platform !== 'win32' },
  () => {
    const first = processStartedAt(process.pid);
    assert.ok(Number.isFinite(first));
    assert.ok(first <= Date.now());
    assert.equal(processStartedAt(process.pid), first);
    assert.equal(processStartedAt(2147483647), undefined);
  },
);
