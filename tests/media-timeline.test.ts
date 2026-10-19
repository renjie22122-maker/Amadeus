import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaTimeline } from '../src/media-timeline.js';
import type { AgentEvent } from '../shared/types.js';
test('media stays at creation event across followups while progress updates in place', () => {
  const events = [
    { id: 1, type: 'user.message', data: { text: 'draw' } },
    { id: 2, type: 'media.updated', data: { job: { id: 'a', status: 'queued' } } },
    { id: 3, type: 'user.message', data: { text: 'next task' } },
    {
      id: 4,
      type: 'media.updated',
      data: { job: { id: 'a', status: 'completed', outputs: [{ id: 'image' }] } },
    },
    { id: 5, type: 'media.updated', data: { job: { id: 'b', status: 'running' } } },
  ].map((e) => ({ ...e, conversationId: 'chat', runId: 'run', createdAt: e.id })) as AgentEvent[];
  const index = mediaTimeline(events);
  assert.deepEqual([...index.keys()], [2, 5]);
  assert.equal(index.get(2)?.status, 'completed');
  assert.equal(index.has(4), false);
  assert.equal(mediaTimeline([]).size, 0);
});

test('read-aloud receipts stay out of the chat gallery while generated speech remains', () => {
  const events = [
    { id: 1, type: 'media.updated', data: { job: { id: 'read', kind: 'speech' } } },
    {
      id: 2,
      type: 'media.updated',
      data: { job: { id: 'read', kind: 'speech', purpose: 'read-aloud' } },
    },
    {
      id: 3,
      type: 'media.updated',
      data: { job: { id: 'generated', kind: 'speech', purpose: 'generation' } },
    },
  ].map((e) => ({ ...e, conversationId: 'chat', runId: null, createdAt: e.id })) as AgentEvent[];
  assert.deepEqual([...mediaTimeline(events).keys()], [3]);
});
