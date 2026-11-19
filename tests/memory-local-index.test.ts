import test from 'node:test';
import assert from 'node:assert/strict';
import { localMemoryEmbedding } from '../server/services/memory-local-index.js';
test('automatic memory embedding accepts configured loopback, not remote or misleading hosts', () => {
  const s = (baseUrl: string) => ({ backend: 'openai', baseUrl, model: 'embedding' }) as any;
  assert.equal(localMemoryEmbedding({ backend: 'local' } as any), true);
  for (const url of ['http://127.0.0.1:8811/v1', 'http://localhost/v1', 'https://[::1]/v1'])
    assert.equal(localMemoryEmbedding(s(url)), true);
  for (const url of [
    'https://remote.example/v1',
    'http://localhost.evil/v1',
    'http://127.0.0.1@evil/v1',
    'http://user@localhost/v1',
    'http://localhost/v1?x=1',
    'broken',
  ])
    assert.equal(localMemoryEmbedding(s(url)), false);
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/storage/store.js';
import { MemoryIndex } from '../server/services/memory-index.js';
test('bounded memory backfill resumes missing vectors without re-encoding completed entries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'memory-backfill-')),
    store = new Store(join(dir, 'db.sqlite'));
  try {
    for (const id of ['a', 'b', 'c'])
      store.put('memory', {
        id,
        scope: 'user',
        content: id,
        source: 'User',
        active: true,
        status: 'active',
        revision: 1,
        createdAt: 1,
      });
    store.put('memory', {
      id: 'held',
      scope: 'user',
      content: 'held',
      source: 'User',
      active: false,
      status: 'disputed',
      revision: 1,
      createdAt: 1,
    });
    const calls: string[] = [];
    const index = new MemoryIndex(store, {
      fingerprint: () => 'test',
      encode: async (texts: string[]) => {
        calls.push(...texts);
        return texts.map(() => [1, 2]);
      },
    } as any);
    assert.equal((await index.index('user', () => true, undefined, 1)).indexed, 1);
    assert.equal((await index.index('user', () => true, undefined, 1)).indexed, 1);
    assert.equal((await index.index('user', () => true, undefined, 1)).indexed, 1);
    assert.equal((await index.index('user', () => true, undefined, 1)).indexed, 0);
    assert.deepEqual(calls, ['a', 'b', 'c']);
    assert.equal(store.list('memory-vector').length, 3);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('scoped recall and backfill skip unrelated histories and recheck scope after embedding', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const convo = { id: 'owner', projectId: 'alpha' };
  store.put('conversation', convo);
  const mem = {
    id: 'alpha',
    scope: 'project:alpha',
    content: 'alignment workflow',
    source: 'User',
    active: true,
    status: 'active',
    revision: 1,
    createdAt: 1,
  };
  store.put('memory', mem);
  store.put('memory', { ...mem, id: 'elsewhere', scope: 'project:other' });
  const encodeCalls: string[] = [];
  const index = new MemoryIndex(store, {
    enabled: () => true,
    fingerprint: () => 'fixture',
    encode: async (texts: string[], _signal?: AbortSignal, purpose?: string) => {
      encodeCalls.push(...texts);
      if (purpose === 'query') store.put('conversation', { ...convo, remoteMemoryOnly: true });
      return texts.map(() => [1, 2]);
    },
  } as any);
  assert.deepEqual(store.memoriesInScopes([]), []);
  assert.deepEqual(
    store.memoriesInScopes(['project:alpha']).map((m) => m.id),
    ['alpha'],
  );
  assert.deepEqual((await index.index('project:alpha')).indexed, 1);
  assert.deepEqual(encodeCalls, ['alignment workflow']);
  const result = await index.recall(
    'workflow',
    'alpha',
    new AbortController().signal,
    false,
    Date.now(),
    'owner',
  );
  assert.deepEqual(result.memories, []);
  assert.match(result.fallback || '', /scope changed/);
  assert.deepEqual(encodeCalls, ['alignment workflow', 'workflow']);
});
