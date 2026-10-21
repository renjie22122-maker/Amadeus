import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeHealth } from './bridge-health.mjs';
const sample = { accountId: 'bot', online: true, friends: 0 };
function monitor(saved) {
  const m = new BridgeHealth('bot', saved);
  m.started = 0;
  return m;
}
test('silence, new accounts and unknown probe results do not authorize restarting', () => {
  const m = monitor();
  for (let i = 0; i < 10; i++) assert.equal(m.observe(sample, 10000000 + i * 60000).restart, false);
  assert.equal(m.observe({ ...sample, friends: 2 }, 11000000).state, 'platform-responsive');
  assert.equal(m.observe({ ...sample, friends: undefined }, 11060000).restart, false);
  assert.equal(m.observe({ ...sample, accountId: 'other' }, 11120000).state, 'login-required');
  assert.equal(m.observe({ ...sample, online: false }, 11180000).restart, false);
});
test('three consecutive empty results after a healthy baseline permit bounded recovery', () => {
  const m = monitor({ baseline: true });
  assert.equal(m.observe(sample, 10000000).restart, false);
  assert.equal(m.observe(sample, 10060000).restart, false);
  assert.equal(m.observe(sample, 10120000).restart, true);
  m.markRestart(10120000);
  assert.equal(m.observe(sample, 10180000).restart, false);
  m.observe(sample, 10720000);
  m.observe(sample, 10780000);
  assert.equal(m.observe(sample, 10840000).restart, true);
  m.markRestart(10840000);
  const restored = monitor(m.snapshot());
  for (let i = 0; i < 10; i++)
    assert.equal(restored.observe(sample, 12000000 + i * 60000).restart, false);
});
test('received messages and successful probes reset suspicious streaks', () => {
  const m = monitor({ baseline: true });
  m.observe(sample, 10000000);
  m.observe(sample, 10060000);
  m.lastMessage = 10110000;
  assert.equal(m.observe(sample, 10120000).restart, false);
  m.observe(sample, 10300000);
  m.observe({ ...sample, friends: 1 }, 10360000);
  assert.equal(m.observe(sample, 10420000).restart, false);
});
