import test from 'node:test';
import assert from 'node:assert/strict';
import { capabilityDecision } from '../server/services/capability-kernel.js';
const ctx: any = {
  run: { depth: 0 },
  conversation: { permission: 'ask', projectId: 'p' },
  config: { get: () => ({ commandBackend: 'approval-host', web: { enabled: true } }) },
};
test('capability admission retains readonly, child, network and allowed tool boundaries', () => {
  assert.equal(capabilityDecision(ctx, 'run_command', 'execute').allowed, true);
  assert.equal(
    capabilityDecision(
      { ...ctx, conversation: { ...ctx.conversation, permission: 'read-only' } },
      'write_file',
      'write',
    ).reason,
    'read-only',
  );
  assert.equal(
    capabilityDecision({ ...ctx, run: { depth: 1 } }, 'run_command', 'execute').allowed,
    false,
  );
  assert.equal(
    capabilityDecision(
      { ...ctx, conversation: { ...ctx.conversation, allowedTools: ['read_file'] } },
      'run_command',
      'execute',
    ).allowed,
    false,
  );
  assert.equal(
    capabilityDecision(
      { ...ctx, config: { get: () => ({ web: { enabled: false } }) } },
      'web_fetch',
      'network',
    ).allowed,
    false,
  );
  assert.equal(
    capabilityDecision({ ...ctx, run: { depth: 0, recoveryOnly: true } }, 'write_file', 'write')
      .allowed,
    false,
  );
});

test('isolated analysis tools are never advertised on a host backend', () => {
  for (const name of ['run_python', 'extract_media_frames', 'extract_media_audio']) {
    assert.equal(capabilityDecision(ctx, name, 'execute').reason, 'isolated-compute-required');
    assert.equal(
      capabilityDecision(
        { ...ctx, config: { get: () => ({ commandBackend: 'docker' }) } },
        name,
        'execute',
      ).allowed,
      true,
    );
  }
});
