import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createLoginRecovery, safeLoginReason } from './login-recovery.mjs';
import { patchLoginRecovery } from './patch-login-recovery.mjs';
function fixture(restart = async () => false) {
  const timers = new Map(),
    events = [];
  let id = 0,
    online = false,
    recovered = 0;
  const recover = createLoginRecovery({
    isOnline: () => online,
    onOffline: () => {},
    onRecovered: () => recovered++,
    restart,
    report: (e) => events.push(e),
    schedule: (f, delay) => {
      timers.set(++id, { f, delay });
      return id;
    },
    cancel: (i) => timers.delete(i),
  });
  return {
    recover,
    timers,
    events,
    setOnline: (v) => (online = v),
    recovered: () => recovered,
    tick: async () => {
      const [key, job] = timers.entries().next().value;
      timers.delete(key);
      await job.f();
    },
  };
}
test('forced recovery also cancels restart when connection recovered during delay', async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    return true;
  });
  f.recover('expired', false);
  f.setOnline(true);
  await f.tick();
  assert.equal(calls, 0);
  assert.equal(f.recovered(), 1);
  f.setOnline(false);
  f.recover('next outage', false);
  assert.equal(f.timers.size, 1);
});
test('failed and accepted-but-ineffective restarts stop after five; duplicates cannot bypass bound', async () => {
  for (const accepted of [false, true]) {
    let calls = 0;
    const f = fixture(async () => {
      calls++;
      return accepted;
    });
    f.recover('expired', false);
    for (let i = 0; i < 5; i++) {
      f.recover('duplicate', false);
      await f.tick();
    }
    assert.equal(calls, 5);
    assert.equal(f.timers.size, 0);
    f.recover('duplicate', false);
    assert.equal(f.timers.size, 0);
    assert.equal(f.events.at(-1).state, 'recovery-exhausted');
  }
});
test('forced invalidation advances transient timer without concurrent restarts', async () => {
  let finish,
    calls = 0;
  const f = fixture(() => {
    calls++;
    return new Promise((r) => (finish = r));
  });
  f.recover('network', true);
  assert.equal([...f.timers.values()][0].delay, 60000);
  f.recover('invalidated', false);
  assert.equal(f.timers.size, 1);
  assert.equal([...f.timers.values()][0].delay, 3500);
  const running = f.tick();
  f.recover('duplicate', false);
  assert.equal(f.timers.size, 0);
  finish(false);
  await running;
  assert.equal(calls, 1);
  assert.equal(f.timers.size, 1);
});
test('reason diagnostics exclude credentials, strings, nested payloads and unknown fields', () => {
  assert.deepEqual(
    safeLoginReason({
      errCode: 3,
      reason: 'secret',
      token: 'secret',
      uid: 42,
      isRecoverable: false,
      type: {},
      code: NaN,
    }),
    { errCode: 3, isRecoverable: false },
  );
});
test('patch refuses unknown layout, preserves arbitrary bytes and is idempotent', () => {
  assert.throws(() => patchLoginRecovery(Buffer.from('unknown')), /Unsupported/);
  const prefix = Buffer.from([255, 254, 128]);
  const source = Buffer.from(
    '\nfunction UAe({kickedDelayMs: i = 3500, selfOfflineDelayMs: o = 6e4}) { r(c).then(() => {}); }\nclass LAe {}\nconst i = `[KickedOffLine] [${r.tipsTitle}] ${r.tipsDesc}`;',
  );
  const patched = patchLoginRecovery(Buffer.concat([prefix, source]));
  assert.deepEqual(patched.subarray(0, 3), prefix);
  assert.deepEqual(patchLoginRecovery(patched), patched);
  new vm.Script(patched.subarray(3).toString('latin1'));
  assert.ok(patched.includes(Buffer.from('[AmadeusLoginDiagnostic]')));
});
