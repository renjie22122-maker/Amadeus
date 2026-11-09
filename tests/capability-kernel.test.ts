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

test('proactive chat can inspect existing Office data but cannot edit, export or execute', () => {
  const proactive = {
    ...ctx,
    conversation: { permission: 'ask', remoteChatOnly: true },
    store: { maybe: (kind: string) => (kind === 'chat-proactive-run' ? {} : undefined) },
  } as any;
  for (const name of ['office_open', 'office_query', 'office_read'])
    assert.equal(capabilityDecision(proactive, name, 'read').allowed, true, name);
  for (const name of [
    'office_export',
    'office_edit',
    'office_create',
    'send_knowledge_file',
    'run_command',
  ])
    assert.equal(capabilityDecision(proactive, name, 'write').reason, 'proactive-read-only', name);
  const limited = {
    ...proactive,
    conversation: { ...proactive.conversation, allowedTools: ['read_attachment'] },
  };
  assert.equal(
    capabilityDecision(limited, 'office_query', 'read').reason,
    'tool-not-in-allowed-set',
  );
});
