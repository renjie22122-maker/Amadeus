import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/storage/store.js';
import { Knowledge } from '../server/services/knowledge.js';

function fixture() {
  const store = new Store(':memory:');
  let calls = 0,
    model = 'fixture-v1';
  const kb = new Knowledge(store, {
    enabled: () => true,
    fingerprint: () => model,
    encode: async (texts: string[]) => {
      calls++;
      return texts.map(() => [1, 0]);
    },
  } as any);
  return {
    store,
    kb,
    calls: () => calls,
    model: (value: string) => {
      model = value;
    },
    close: () => {
      kb.close();
      store.close();
    },
  };
}
test('selected snapshot reuses exact vectors without encoding and remains isolated and independently removable', async () => {
  const f = fixture();
  try {
    const a: any = f.kb.import('general', 'engines', '# propulsion\nrocket engine '.repeat(90));
    const hidden: any = f.kb.import('general', 'other', 'private unselected secret');
    await f.kb.index(a.id);
    const before = f.calls();
    const copy = f.kb.reuse(a.id, 'general', 'project:a');
    assert.ok(copy.reusedVectors! > 1);
    assert.equal(copy.pendingVectors, 0);
    await f.kb.index(copy.document.id);
    assert.equal(f.calls(), before);
    const sourceRows = f.store.db
      .prepare('SELECT ordinal,text,vector FROM chunks WHERE document_id=? ORDER BY ordinal')
      .all(a.id);
    const copiedRows = f.store.db
      .prepare('SELECT ordinal,text,vector FROM chunks WHERE document_id=? ORDER BY ordinal')
      .all(copy.document.id);
    assert.deepEqual(copiedRows, sourceRows);
    assert.equal(copy.document.reusedFrom.documentId, a.id);
    assert.equal(f.kb.reuse(a.id, 'general', 'project:a').document.id, copy.document.id);
    assert.equal(f.store.list<any>('document').length, 3);
    assert.ok(f.kb.search(['project:a'], 'rocket').length);
    assert.ok(
      f.kb.search(['project:a'], 'rocket').every((r: any) => r.documentId === copy.document.id),
    );
    assert.deepEqual(f.kb.search(['project:a'], 'secret'), []);
    assert.deepEqual(f.kb.search(['project:b'], 'rocket'), []);
    assert.throws(() => f.kb.reuse(hidden.id, 'project:a', 'project:b'));
    f.kb.remove(a.id);
    assert.ok(f.kb.search(['project:a'], 'rocket').length);
    f.kb.remove(copy.document.id);
    assert.ok(f.store.maybe('document', hidden.id));
  } finally {
    f.close();
  }
});
test('incompatible, corrupt or mismatched-content vectors are not reused; missing chunks alone are indexed', async () => {
  const f = fixture();
  try {
    const a: any = f.kb.import('general', 'source', 'rocket propulsion');
    await f.kb.index(a.id);
    f.model('fixture-v2');
    const copy = f.kb.reuse(a.id, 'general', 'project:new-model');
    assert.equal(copy.reusedVectors, 0);
    assert.equal(copy.pendingVectors, 1);
    const before = f.calls();
    await f.kb.index(copy.document.id);
    assert.equal(f.calls(), before + 1);
    f.model('fixture-v1');
    f.store.db.prepare('UPDATE chunks SET vector=? WHERE document_id=?').run('{broken', a.id);
    assert.equal(f.kb.reuse(a.id, 'general', 'project:corrupt').reusedVectors, 0);
    f.store.db
      .prepare('UPDATE chunks SET vector=?,source_hash=? WHERE document_id=?')
      .run(JSON.stringify({ model: 'fixture-v1', values: [1, 0] }), 'wrong-hash', a.id);
    assert.equal(f.kb.reuse(a.id, 'general', 'project:mismatch').reusedVectors, 0);
    f.store.put('document', { ...a, validUntil: Date.now() - 1 });
    assert.throws(() => f.kb.reuse(a.id, 'general', 'project:expired'));
    assert.throws(() => f.kb.reuse(copy.document.id, 'project:new-model', 'project:new-model'));
  } finally {
    f.close();
  }
});

test('reuse API requires local authentication and rejects invalid or removed target scopes', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createApp } = await import('../server/http/app.js');
  const dir = await mkdtemp(join(tmpdir(), 'knowledge-reuse-api-'));
  const { app, store, runtime } = await createApp({ directory: dir });
  try {
    store.put('project', { id: 'active', name: 'Active' });
    store.put('project', { id: 'removed', name: 'Removed', removedAt: Date.now() });
    const doc: any = runtime.knowledge.import('general', 'source', 'rocket propulsion');
    const payload = { sourceId: doc.id, sourceScope: 'general', targetScope: 'project:active' };
    const denied = await app.inject({
      method: 'POST',
      url: '/api/knowledge/reuse',
      headers: { host: 'localhost' },
      payload,
    });
    assert.equal(denied.statusCode, 401);
    const boot = await app.inject({ url: '/api/bootstrap', headers: { host: 'localhost' } });
    const headers = {
      host: 'localhost',
      cookie: String(boot.headers['set-cookie']).split(';')[0],
      'x-csrf-token': boot.json().csrf,
    };
    for (const targetScope of ['project:removed', 'project:missing', 'general']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/knowledge/reuse',
        headers,
        payload: { ...payload, targetScope },
      });
      assert.ok(response.statusCode >= 400, response.body);
    }
    const response = await app.inject({
      method: 'POST',
      url: '/api/knowledge/reuse',
      headers,
      payload,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().document.scope, 'project:active');
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
