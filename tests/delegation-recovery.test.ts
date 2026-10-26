import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/storage/store.js';
import {
  assertDelegationRecovery,
  delegationFingerprint,
} from '../server/core/delegation-recovery.js';
test('only repeated identical failures back off; success, changed tasks, other trees and elapsed cooldown proceed', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const fingerprint = delegationFingerprint('inspect');
  for (let i = 0; i < 3; i++) {
    store.put('delegation-attempt', { id: String(i), root: 'root', fingerprint, at: i });
    store.put('run', {
      id: String(i),
      status: 'interrupted',
      error: 'same failure',
      updatedAt: 1000 + i,
    });
  }
  assert.throws(
    () => assertDelegationRecovery(store, 'root', fingerprint, 2000),
    /identical delegations/,
  );
  assert.doesNotThrow(() => assertDelegationRecovery(store, 'other', fingerprint, 2000));
  assert.doesNotThrow(() =>
    assertDelegationRecovery(store, 'root', delegationFingerprint('inspect new evidence'), 2000),
  );
  assert.doesNotThrow(() => assertDelegationRecovery(store, 'root', fingerprint, 62000));
  store.put('run', { id: '2', status: 'completed', updatedAt: 1002 });
  assert.doesNotThrow(() => assertDelegationRecovery(store, 'root', fingerprint, 2000));
});
