import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/storage/store.js';
import { MemoryLifecycle } from '../server/services/memory-lifecycle.js';
import { memoryAccessible, memoryReach } from '../shared/memory-scope.js';
import type { Memory } from '../shared/types.js';
const memory = (id: string, extra: Partial<Memory> = {}): Memory => ({
  id,
  scope: 'user',
  content: 'Preference ' + id,
  source: 'chat:a#event:1',
  sourceConversationId: 'a',
  active: false,
  status: 'candidate',
  kind: 'preference',
  revision: 1,
  createdAt: 1,
  expiresAt: null,
  ...extra,
});
test('automatic reach follows kind, explicit overrides can be reset', () => {
  const m = memory('a', { kind: 'episode', recallScope: 'scope' });
  assert.equal(memoryAccessible(m, 'other'), true);
  assert.equal(memoryReach({ ...m, recallScope: 'auto' }), 'conversation');
  assert.equal(memoryAccessible({ ...m, recallScope: 'auto' }, 'other'), false);
  assert.equal(memoryAccessible({ ...m, recallScope: 'auto' }, 'a'), true);
  assert.equal(
    memoryReach({ ...m, recallScope: 'auto', kind: 'decision', scope: 'project:p' }),
    'scope',
  );
});
test('batch reach preserves source and disabled status; enforces revision and storage scope', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'memory-reach-'));
  const s = new Store(join(dir, 'db.sqlite'));
  try {
    const life = new MemoryLifecycle(s);
    for (const m of [
      memory('a'),
      memory('b', { status: 'inactive', sourceConversationId: 'b' }),
      memory('foreign', { scope: 'project:p' }),
      memory('manual', { source: 'User', sourceConversationId: undefined }),
    ])
      s.put('memory', m);
    const result = life.batch(
      'user',
      'local',
      ['a', 'b', 'foreign', 'manual'].map((id) => ({ id, revision: 1 })),
    );
    assert.equal(result.changed, 2);
    assert.equal(result.failed, 2);
    const a = s.get<Memory>('memory', 'a'),
      b = s.get<Memory>('memory', 'b');
    assert.equal(a.status, 'candidate');
    assert.equal(b.status, 'inactive');
    assert.equal(a.active, false);
    assert.equal(b.active, false);
    assert.equal(a.source, 'chat:a#event:1');
    assert.equal(b.sourceConversationId, 'b');
    assert.equal(memoryAccessible(b, 'a'), false);
    assert.equal(life.batch('user', 'share', [{ id: 'a', revision: 1 }]).failed, 1);
    assert.equal(life.batch('user', 'share', [{ id: 'a', revision: 2 }]).changed, 1);
    assert.equal(s.get<Memory>('memory', 'a').active, false);
    assert.equal(s.get<Memory>('memory', 'a').sourceConversationId, 'a');
  } finally {
    s.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('sharing an active local memory cannot bypass a conflicting shared fact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'memory-reach-'));
  const s = new Store(join(dir, 'db.sqlite'));
  try {
    const life = new MemoryLifecycle(s);
    s.put(
      'memory',
      memory('shared', {
        active: true,
        status: 'active',
        recallScope: 'scope',
        entityId: 'user',
        attribute: 'language',
        value: 'en',
      }),
    );
    s.put(
      'memory',
      memory('local', {
        active: true,
        status: 'active',
        recallScope: 'conversation',
        entityId: 'user',
        attribute: 'language',
        value: 'zh',
      }),
    );
    const r = life.batch('user', 'share', [{ id: 'local', revision: 1 }]);
    assert.equal(r.failed, 1);
    assert.equal(s.get<Memory>('memory', 'local').recallScope, 'conversation');
    assert.equal(s.get<Memory>('memory', 'local').revision, 1);
  } finally {
    s.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('applicability narrows automatic preferences without overriding explicit user reach', () => {
  const local = memory('temporary', { applicability: 'conversation' });
  assert.equal(memoryReach(local), 'conversation');
  assert.equal(memoryAccessible(local, 'other'), false);
  assert.equal(memoryReach({ ...local, applicability: 'uncertain' }), 'conversation');
  assert.equal(memoryReach({ ...local, applicability: 'scope' }), 'scope');
  assert.equal(memoryReach({ ...local, recallScope: 'scope' }), 'scope');
  assert.equal(
    memoryReach({ ...local, applicability: 'scope', recallScope: 'conversation' }),
    'conversation',
  );
  assert.equal(memoryReach(memory('legacy')), 'scope');
});
