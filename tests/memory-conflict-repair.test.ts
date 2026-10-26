import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/storage/store.js';
import { MemoryLifecycle, memoryValid } from '../server/services/memory-lifecycle.js';
import {
  reconsiderMemoryConflicts,
  manageAutomaticMemory,
} from '../server/services/memory-automatic.js';
import { reviewMemoryCandidates } from '../server/services/memory-candidate-review.js';
import type { Memory } from '../shared/types.js';
const memory = (id: string, extra: Partial<Memory> = {}): Memory => ({
  id,
  scope: 'user',
  content: id,
  source: 'User',
  active: false,
  status: 'candidate',
  revision: 1,
  createdAt: 1,
  validFrom: 1,
  expiresAt: null,
  kind: 'preference',
  entityId: 'user',
  attribute: 'theme',
  factCardinality: 'single',
  value: id,
  ...extra,
});
test('update persists detected conflicts, removes self/cross-scope references and blocks activation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'memory-repair-'));
  const store = new Store(join(dir, 'db.sqlite'));
  const life = new MemoryLifecycle(store);
  try {
    life.create(memory('old', { active: true }));
    const next = life.create(memory('new', { attribute: 'other' }));
    const saved = life.update(next.id, { attribute: 'theme' }, next.revision);
    assert.equal(saved.status, 'disputed');
    assert.deepEqual(saved.conflictsWith, ['old']);
    assert.throws(
      () => life.update(next.id, { active: true }, saved.revision),
      /Resolve conflicting/,
    );
    store.put(
      'memory',
      memory('foreign', { scope: 'project:other', active: true, status: 'active' }),
    );
    const cleaned = life.update('new', {
      conflictsWith: ['new', 'foreign', 'missing', 'old', 'old'],
    });
    assert.deepEqual(cleaned.conflictsWith, ['old']);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('legacy reconciliation repairs links or quarantines orphans, is idempotent and never calls a model', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'memory-audit-'));
  const store = new Store(join(dir, 'db.sqlite'));
  const life = new MemoryLifecycle(store);
  try {
    store.put('memory', memory('active', { active: true, status: 'active' }));
    store.put(
      'memory',
      memory('linked', { status: 'disputed', conflictsWith: [], automatic: true }),
    );
    store.put(
      'memory',
      memory('orphan', {
        status: 'disputed',
        attribute: 'other',
        conflictsWith: ['missing'],
        automatic: true,
      }),
    );
    store.put('memory', memory('expired', { status: 'disputed', expiresAt: 2 }));
    store.put('memory', memory('disabled', { status: 'inactive' }));
    assert.deepEqual(life.reconcileConflicts(), { checked: 2, linked: 1, needsReview: 1 });
    const linked = store.get<Memory>('memory', 'linked'),
      orphan = store.get<Memory>('memory', 'orphan');
    assert.deepEqual(linked.conflictsWith, ['active']);
    assert.equal(linked.status, 'disputed');
    assert.equal(orphan.status, 'candidate');
    assert.deepEqual(orphan.conflictsWith, []);
    for (const m of [linked, orphan]) {
      assert.equal(m.active, false);
      assert.equal(m.conflictReviewRequired, true);
      assert.equal(memoryValid(m), false);
      manageAutomaticMemory(store, m);
    }
    assert.deepEqual(life.reconcileConflicts(), { checked: 1, linked: 0, needsReview: 0 });
    assert.equal(store.list('memory-history').length, 2);
    reconsiderMemoryConflicts(store, 'user');
    assert.equal(store.get<Memory>('memory', 'linked').active, false);
    // Even valid original source and enabled automatic review cannot override the repair hold.
    store.put('conversation', { id: 'chat', projectId: null });
    store.event('chat', null, 'user.message', { content: 'orphan' });
    const event = store.events('chat')[0];
    store.put('memory', { ...orphan, sourceConversationId: 'chat', sourceEventId: event.id });
    let calls = 0;
    await reviewMemoryCandidates(
      store,
      { id: 'chat', projectId: null } as any,
      { id: 'p', baseUrl: 'https://example.com', model: 'fixture' } as any,
      {
        complete: async () => {
          calls++;
          throw Error('unexpected model call');
        },
      } as any,
      new AbortController().signal,
      () => true,
      () => false,
    );
    assert.equal(calls, 0);
    assert.equal(store.get<Memory>('memory', 'orphan').active, false);
    const confirmed = life.update('orphan', { active: true, automatic: false }, orphan.revision);
    assert.equal(confirmed.conflictReviewRequired, false);
    assert.equal(memoryValid(confirmed), true);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('mutually disputed references remain visible without activating either side', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'memory-pair-'));
  const store = new Store(join(dir, 'db.sqlite'));
  const life = new MemoryLifecycle(store);
  try {
    store.put('memory', memory('a', { status: 'disputed', conflictsWith: ['b'] }));
    store.put('memory', memory('b', { status: 'disputed', conflictsWith: ['a'] }));
    assert.deepEqual(life.reconcileConflicts(), { checked: 2, linked: 0, needsReview: 0 });
    assert.deepEqual(life.update('a', { topic: 'edit' }).conflictsWith, ['b']);
    assert.throws(() => life.update('a', { active: true }), /Resolve conflicting/);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('automatic replacement needs sourced update intent, not simply a newer timestamp', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'memory-update-'));
  const store = new Store(join(dir, 'db.sqlite'));
  try {
    store.put('conversation', { id: 'chat', projectId: null });
    const a = store.event('chat', null, 'user.message', { content: 'Use light theme.' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const b = store.event('chat', null, 'user.message', { content: 'Switch my theme to dark.' });
    const life = new MemoryLifecycle(store);
    life.create(
      memory('light', {
        active: true,
        automatic: true,
        source: 'chat:chat#event:' + a.id,
        sourceConversationId: 'chat',
        sourceEventId: a.id,
        evidence: [{ conversationId: 'chat', eventId: a.id, quote: 'Use light theme.' }],
      }),
    );
    const next = life.create(
      memory('dark', {
        automatic: true,
        source: 'chat:chat#event:' + b.id,
        sourceConversationId: 'chat',
        sourceEventId: b.id,
        evidence: [{ conversationId: 'chat', eventId: b.id, quote: 'Switch my theme to dark.' }],
        conflictsWith: ['light'],
      }),
    );
    manageAutomaticMemory(store, next);
    assert.equal(store.get<Memory>('memory', 'dark').active, false);
    const assessed = life.update('dark', { revisionIntent: 'replace' });
    manageAutomaticMemory(store, assessed);
    assert.equal(store.get<Memory>('memory', 'dark').active, true);
    assert.equal(store.get<Memory>('memory', 'light').status, 'superseded');
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
