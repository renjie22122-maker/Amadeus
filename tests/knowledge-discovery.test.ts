import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/storage/store.js';
import { knowledgeDiscovery } from '../server/services/knowledge-discovery.js';

test('knowledge discovery is bounded, scope/version isolated and never claims absent contents from title misses', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'knowledge-discovery-')),
    store = new Store(join(dir, 'db.sqlite'));
  try {
    for (let i = 0; i < 12; i++)
      store.put('document', {
        id: String(i),
        name: '数据库事务学习资料 ' + i,
        scope: 'general',
        createdAt: 1,
      });
    store.put('document', {
      id: 'secret',
      name: '数据库私密资料',
      scope: 'project:private',
      createdAt: 1,
    });
    store.put('document', {
      id: 'old',
      name: '数据库旧版',
      scope: 'general',
      createdAt: 1,
      validUntil: 50,
    });
    store.put('document', { id: 'future', name: '数据库新版', scope: 'general', validFrom: 200 });
    const result = knowledgeDiscovery(store, ['general'], '怎么学习数据库事务？', 100);
    assert.equal(result.documents, 12);
    assert.equal(result.candidates.length, 6);
    assert.ok(result.candidates.every((x: any) => !['secret', 'old', 'future'].includes(x.id)));
    const miss = knowledgeDiscovery(store, ['general'], 'unrelated astronomy', 100);
    assert.equal(miss.status, 'available');
    assert.equal(miss.candidates.length, 0);
    assert.match(miss.notice!, /do not mean missing content/);
    assert.equal(knowledgeDiscovery(store, [], '数据库', 100).status, 'disabled');
    assert.equal(
      knowledgeDiscovery(store, ['project:empty'], '数据库', 100).status,
      'not_imported',
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
