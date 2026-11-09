import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localLoginStatus } from '../server/services/chat-login-status.js';
test('login display requires fresh account and endpoint evidence; paused routes stay paused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'login-state-'));
  try {
    mkdirSync(join(dir, 'bot'));
    const statusFile = join(dir, 'status');
    writeFileSync(join(dir, 'bot', 'config.json'), JSON.stringify({ offline: { statusFile } }));
    const c: any = {
      enabled: true,
      transport: 'onebot11',
      accountId: '123',
      endpoint: 'ws://127.0.0.1:3011/',
    };
    writeFileSync(
      statusFile + '.login.json',
      JSON.stringify({
        state: 'login-required',
        accountId: '123',
        endpoint: c.endpoint,
        at: 100000,
      }),
    );
    assert.equal(localLoginStatus(dir, c, 110000)?.status, 'login-required');
    assert.equal(localLoginStatus(dir, { ...c, enabled: false }, 110000), undefined);
    assert.equal(localLoginStatus(dir, { ...c, accountId: '456' }, 110000), undefined);
    assert.equal(
      localLoginStatus(dir, { ...c, endpoint: 'ws://localhost:9999' }, 110000),
      undefined,
    );
    assert.equal(localLoginStatus(dir, c, 200000), undefined);
    writeFileSync(statusFile + '.login.json', 'invalid');
    assert.equal(localLoginStatus(dir, c, 110000), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
