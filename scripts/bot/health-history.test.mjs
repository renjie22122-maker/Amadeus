import test from 'node:test';
import assert from 'node:assert/strict';
import { BotHealthHistory } from './health-history.mjs';
test('history retains transitions across restarts without repeated polling or credentials', () => {
  const h = new BotHealthHistory();
  assert.equal(h.observe('login', 'online', 1), true);
  assert.equal(h.observe('login', 'online', 2), false);
  h.observe('bridge', 'bridge-disconnected', 3);
  h.observe('login', 'login-required', 4);
  const restored = new BotHealthHistory(h.entries);
  assert.equal(restored.observe('login', 'login-required', 5), false);
  assert.equal(restored.observe('login', 'https://secret', 6), false);
  assert.equal(
    new BotHealthHistory([{ source: 'login', state: 'online', at: 1, token: 'secret' }]).entries
      .length,
    0,
  );
  for (let i = 0; i < 500; i++)
    restored.observe('login', i % 2 ? 'online' : 'login-required', i + 10);
  assert.equal(restored.entries.length, 256);
});
