import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/storage/store.js';
import { MemoryLifecycle } from '../server/services/memory-lifecycle.js';
import { chatMemorySource, chatMemorySources } from '../server/services/chat-memory-source.js';
import { sharedChatMemorySupported } from '../server/services/chat-memory-support.js';

test('experience evidence uses scoped point reads and rejects missing, foreign or unverified receipts', () => {
  const store = new Store(':memory:');
  try {
    store.put('conversation', { id: 'a', projectId: 'p' });
    store.put('conversation', { id: 'b', projectId: 'other' });
    const event = store.event('a', 'r', 'tool.completed', {
      verification: { passed: true },
      output: 'verified',
    });
    const wrong = store.event('b', 's', 'tool.completed', { verification: { passed: true } });
    const unverified = store.event('a', 'r', 'tool.completed', { output: 'looks fine' });
    // Malformed unrelated history must never be decoded by a point evidence check.
    store.db
      .prepare('INSERT INTO events(conversation_id,run_id,type,data,created_at) VALUES(?,?,?,?,?)')
      .run('a', 'r', 'assistant.message', '{corrupt', Date.now());
    store.events = (() => {
      throw Error('Full-history scan forbidden');
    }) as any;
    const life = new MemoryLifecycle(store);
    const memory: any = {
      id: 'm',
      scope: 'project:p',
      kind: 'experience',
      source: 'manual',
      conditions: 'when applicable',
      content: 'verified method',
      evidence: [{ conversationId: 'a', eventId: event.id, quote: 'verified' }],
    };
    assert.equal(life.evidenceValid(memory), true);
    assert.equal(store.eventById('b', event.id), undefined);
    for (const eventId of [wrong.id, unverified.id, 999999, NaN])
      assert.equal(
        life.evidenceValid({ ...memory, evidence: [{ conversationId: 'a', eventId }] }),
        false,
      );
    assert.equal(
      life.evidenceValid({
        ...memory,
        evidence: [{ conversationId: 'a', eventId: event.id, quote: 'not present' }],
      }),
      false,
    );
    store.db.prepare('DELETE FROM events WHERE id=?').run(event.id);
    assert.equal(life.evidenceValid(memory), false);
  } finally {
    store.close();
  }
});
test('point chat receipts preserve full-reader attribution and shared-setting evidence rules', () => {
  const store = new Store(':memory:');
  try {
    const raw = store.event('a', null, 'chat.memory-source', {
      senderId: 'one',
      text: 'use a concise style',
      receivedAt: 123,
      peerType: 'group',
    });
    store.event('a', 'legacy', 'chat.origin', {
      senderId: 'two',
      memoryMessages: ['legacy preference'],
      peerType: 'group',
    });
    const old = store.event('a', 'legacy', 'user.message', { content: 'untrusted wrapper' });
    store.event('a', 'modern', 'chat.origin', {
      senderId: 'two',
      memoryMessages: ['ignore'],
      sourceEventIds: [raw.id],
    });
    const modern = store.event('a', 'modern', 'user.message', { content: 'wrapper' });
    const scheduled = store.event('a', 'legacy', 'user.message', {
      content: 'timer',
      scheduledTrigger: true,
    });
    for (const source of chatMemorySources(store, 'a'))
      assert.deepEqual(chatMemorySource(store, 'a', source.id), source);
    for (const eventId of [modern.id, scheduled.id])
      assert.equal(chatMemorySource(store, 'a', eventId), undefined);
    assert.equal(chatMemorySource(store, 'b', old.id), undefined);
    store.events = (() => {
      throw Error('Full-history scan forbidden');
    }) as any;
    const m: any = {
      scope: 'chat:a',
      chatSubject: 'assistant',
      basis: 'explicit',
      evidence: [{ conversationId: 'a', eventId: raw.id, quote: 'concise' }],
    };
    assert.equal(sharedChatMemorySupported(store, m), true);
    assert.equal(sharedChatMemorySupported(store, { ...m, basis: 'proposal' }), false);
    assert.equal(
      sharedChatMemorySupported(store, {
        ...m,
        evidence: [{ conversationId: 'b', eventId: raw.id, quote: 'concise' }],
      }),
      false,
    );
  } finally {
    store.close();
  }
});
test('pending inputs exclude historical payloads before JavaScript decoding', () => {
  const store = new Store(':memory:');
  try {
    store.put('input', { id: 'pending', status: 'pending', question: 'now' });
    store.put('input', {
      id: 'answered',
      status: 'answered',
      question: 'historical'.repeat(50000),
    });
    assert.deepEqual(
      store.pendingInputs().map((x) => x.id),
      ['pending'],
    );
    store.put('input', { id: 'pending', status: 'answered' });
    assert.deepEqual(store.pendingInputs(), []);
  } finally {
    store.close();
  }
});
