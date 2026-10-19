import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localVoiceStatus } from '../server/services/local-voice.js';

test('voice telemetry reports device/fallback and hides stale idle state and secrets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'voice-status-'));
  const original = globalThis.fetch;
  try {
    mkdirSync(join(root, 'voice-service'));
    writeFileSync(
      join(root, 'voice-service/config.json'),
      JSON.stringify({ token: 's'.repeat(40) }),
    );
    for (const device of ['cuda', 'cpu']) {
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            state: { busy: true, device, reason: 'selection reason' },
            devicePolicy: 'auto',
            token: 'secret',
          }),
        )) as typeof fetch;
      assert.deepEqual(await localVoiceStatus(root), {
        available: true,
        busy: true,
        device,
        reason: 'selection reason',
        policy: 'auto',
      });
    }
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          state: { busy: false, device: 'cuda', reason: 'previous request' },
          devicePolicy: 'auto',
        }),
      )) as typeof fetch;
    assert.equal((await localVoiceStatus(root)).device, null);
    assert.equal((await localVoiceStatus(root)).reason, null);
    globalThis.fetch = (async () => {
      throw new Error('private diagnostic');
    }) as typeof fetch;
    assert.deepEqual(await localVoiceStatus(root), {
      available: false,
      busy: false,
      device: null,
      reason: null,
      policy: null,
    });
  } finally {
    globalThis.fetch = original;
    rmSync(root, { recursive: true, force: true });
  }
});
