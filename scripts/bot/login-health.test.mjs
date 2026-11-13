import test from 'node:test';
import assert from 'node:assert/strict';
import { loginState, LoginPrompt } from './login-health.mjs';
test('only explicit login evidence opens a page, once per outage including watcher restart', () => {
  assert.equal(loginState({ isLogin: true }), 'online');
  assert.equal(loginState({ isLogin: false, loginPhase: 'waiting_qrcode' }), 'login-required');
  assert.equal(loginState({ isLogin: false, loginPhase: 'reconnecting' }), 'reconnecting');
  assert.equal(loginState({ qrLoginAccepted: true }), 'login-confirming');
  assert.equal(loginState({}), 'unknown');
  const p = new LoginPrompt();
  for (const s of ['unknown', 'probe-unavailable', 'reconnecting', 'login-confirming'])
    assert.equal(p.observe(s, 1000), false);
  assert.equal(p.observe('login-required', 1000), false);
  assert.equal(p.observe('login-required', 16000), true);
  assert.equal(p.observe('login-required', 60000), false);
  const restarted = new LoginPrompt({ prompted: p.prompted });
  assert.equal(restarted.observe('login-required', 70000), false);
  assert.equal(restarted.observe('login-required', 90000), false);
  restarted.observe('online', 100000);
  restarted.observe('login-required', 110000);
  assert.equal(restarted.observe('login-required', 126000), true);
});

test('stuck reconnect/confirmation opens login once without a restart loop', () => {
  for (const state of ['reconnecting', 'login-confirming']) {
    const p = new LoginPrompt();
    assert.equal(p.observe(state, 1000), false);
    assert.equal(p.observe(state, 120999), false);
    assert.equal(p.observe(state, 121000), true);
    assert.equal(p.observe(state, 200000), false);
    p.observe('online', 210000);
    assert.equal(p.observe('login-required', 211000), false);
    assert.equal(p.observe('login-required', 226000), true);
  }
});
