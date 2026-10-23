import test from 'node:test';
import assert from 'node:assert/strict';
import { collapsibleProcess } from '../src/conversation-process.js';
import type { AgentEvent } from '../shared/types.js';
const event = (id: number, type: string, data: any = {}): AgentEvent => ({
  id,
  type,
  data,
  runId: 'r',
  conversationId: 'c',
  createdAt: id,
});
test('fold only successful delivered process; preserve user steering, questions and files; fold historical tool errors', () => {
  const events = [
    event(1, 'user.message'),
    event(2, 'assistant.message', { final: false }),
    event(3, 'tool.started'),
    event(4, 'user.message', { steering: true }),
    event(5, 'input.requested'),
    event(6, 'file.attached'),
    event(7, 'tool.completed', { outcome: { status: 'failed' } }),
    event(8, 'assistant.message', { final: true }),
    event(9, 'run.status'),
  ];
  assert.deepEqual([...collapsibleProcess(events, [{ id: 'r', status: 'completed' }])], [2, 3, 7]);
  for (const status of ['running', 'failed', 'interrupted'])
    assert.equal(collapsibleProcess(events, [{ id: 'r', status }]).size, 0);
  assert.equal(
    collapsibleProcess(
      events.filter((e) => e.id !== 8),
      [{ id: 'r', status: 'completed' }],
    ).size,
    0,
  );
});
test('incomplete output and latest final remain visible', () => {
  const events = [
    event(1, 'assistant.message', { incomplete: true }),
    event(2, 'assistant.message', { final: true }),
    event(3, 'assistant.message', { final: true }),
  ];
  assert.deepEqual([...collapsibleProcess(events, [{ id: 'r', status: 'completed' }])], [2]);
});

test('completed run folds approval cards including pending ones, preserving questions and user chronology', () => {
  const events = [
    event(1, 'user.message'),
    event(2, 'input.requested', { id: 'a', kind: 'approval', status: 'pending' }),
    event(3, 'user.message', { steering: true }),
    event(4, 'input.requested', { id: 'b' }),
    event(5, 'input.requested', { id: 'q', kind: 'question' }),
    event(6, 'assistant.message', { final: true }),
  ];
  const before = JSON.stringify(events);
  const inputs = [
    { id: 'a', kind: 'approval', status: 'answered' },
    { id: 'b', kind: 'approval', status: 'pending' },
  ];
  assert.deepEqual(
    [...collapsibleProcess(events, [{ id: 'r', status: 'completed' }], inputs)],
    [2, 4],
  );
  assert.equal(
    collapsibleProcess(events, [{ id: 'r', status: 'waiting_approval' }], inputs).size,
    0,
  );
  assert.equal(JSON.stringify(events), before);
});
