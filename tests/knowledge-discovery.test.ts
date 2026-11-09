import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/storage/store.js';
import {
  knowledgeDiscovery,
  listKnowledgeDocuments,
} from '../server/services/knowledge-discovery.js';

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

test('inventory finds directory-only identifiers, normalizes separators and retains scope/version boundaries', () => {
  const store = new Store(':memory:');
  try {
    for (let i = 0; i < 35; i++)
      store.put('document', {
        id: 'd' + i,
        scope: 'general',
        name: 'Lecture ' + i + '.pdf',
        source: 'D:\\Courses\\T2_ABC0123_Visual_Computing\\Lecture' + i + '.pdf',
        createdAt: 1,
      });
    store.put('document', {
      id: 'private',
      scope: 'project:private',
      name: 'ABC0123.pdf',
      source: 'secret',
      createdAt: 1,
    });
    store.put('document', {
      id: 'expired',
      scope: 'general',
      name: 'ABC0123.pdf',
      createdAt: 1,
      validUntil: 50,
    });
    store.put('document', { id: 'future', scope: 'general', name: 'ABC0123.pdf', validFrom: 200 });
    store.put('knowledge-watch', {
      id: 'general',
      status: 'partial',
      progress: { phase: 'checking', startedAt: 100, completed: 3, total: 40 },
      scan: { files: 35, completedAt: 50 },
      issues: [
        {
          path: 'D:/Courses/T2_ABC0123_Visual_Computing/empty.docx',
          stage: 'parse',
          error: 'Empty file',
        },
      ],
      currentIssues: [],
    });
    store.put('knowledge-watch', {
      id: 'project:private',
      issues: [{ path: 'ABC0123 secret', error: 'private error' }],
    });
    const first = listKnowledgeDocuments(store, ['general'], 'abc0123', 0, 30, 100);
    assert.equal(first.total, 35);
    assert.equal(first.availableDocuments, 35);
    assert.equal(first.documents.length, 30);
    assert.equal(first.nextOffset, 30);
    assert.equal(
      listKnowledgeDocuments(store, ['general'], 'Visual Computing', 30, 30, 100).documents.length,
      5,
    );
    assert.equal(first.maintenance.length, 1);
    assert.equal(first.maintenance[0].matchingCurrentIssues, 0);
    assert.equal(first.maintenance[0].matchingRecordedIssues, 1);
    assert.ok(first.documents.every((d) => d.source.includes('ABC0123')));
    assert.equal(knowledgeDiscovery(store, ['general'], 'ABC0123', 100).candidates.length, 6);
    const miss = listKnowledgeDocuments(store, ['general'], 'unrelated', 0, 30, 100);
    assert.equal(miss.total, 0);
    assert.equal(miss.availableDocuments, 35);
    assert.match(miss.notice, /do not establish missing import/);
    assert.equal(listKnowledgeDocuments(store, [], 'ABC0123', 0, 30, 100).maintenance.length, 0);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM chunks').get()!.n, 0);
  } finally {
    store.close();
  }
});
