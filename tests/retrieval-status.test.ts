import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/storage/store.js';
import { Knowledge } from '../server/services/knowledge.js';
import { memoryStatus, indexAdvice } from '../server/services/retrieval-status.js';
import { tools } from '../server/tools/registry.js';
import { createHash } from 'node:crypto';

function fixture(t: any) {
  const store = new Store(':memory:');
  const embedding: any = { enabled: () => true, fingerprint: () => 'fixture' };
  const knowledge = new Knowledge(store, embedding);
  t.after(() => {
    knowledge.close();
    store.close();
  });
  return { store, knowledge };
}
test('statistics separate scope, temporal versions, corrupt vectors and incomplete indexing', (t) => {
  const { store, knowledge } = fixture(t);
  assert.equal(knowledge.statistics([]).state, 'disabled');
  assert.equal(knowledge.statistics(['general']).state, 'not_imported');
  const a: any = knowledge.import('general', 'public', 'hello world');
  knowledge.import('project:secret', 'secret', 'private source');
  assert.equal(knowledge.statistics(['general']).state, 'index_incomplete');
  const update = store.db.prepare('UPDATE chunks SET vector=? WHERE document_id=?');
  update.run('broken JSON', a.id);
  assert.equal(knowledge.statistics(['general']).vectors.invalid, 1);
  update.run(JSON.stringify({ model: 'old', values: [1, 0] }), a.id);
  assert.equal(knowledge.statistics(['general']).vectors.staleModel, 1);
  update.run(JSON.stringify({ model: 'fixture', values: [1, 0] }), a.id);
  const report = knowledge.statistics(['general']);
  assert.equal(report.state, 'ready');
  assert.equal(report.documents.current, 1);
  assert.equal(report.vectors.compatible, 1);
  assert.deepEqual(report.vectors.dimensions, { 2: 1 });
  assert.equal(report.indexAdvice.float32PayloadBytesEstimate, 8);
  assert.equal(knowledge.diagnostics(['general']).status, 'no_match');
  assert.ok(!JSON.stringify(report).includes('private source'));
  store.put('document', { ...a, validUntil: Date.now() - 1 });
  assert.equal(knowledge.statistics(['general']).chunks.current, 0);
  assert.equal(knowledge.statistics(['general']).documents.nonCurrentVersions, 1);
});
test('memory totals exclude other chats and projects and distinguish eligibility from storage', (t) => {
  const { store } = fixture(t);
  const m: any = {
    id: 'visible',
    scope: 'user',
    content: 'prefer concise',
    source: 'user',
    kind: 'preference',
    status: 'active',
    active: true,
    revision: 1,
    createdAt: 1,
    expiresAt: null,
  };
  store.put('memory', m);
  store.put('memory', {
    ...m,
    id: 'private',
    recallScope: 'conversation',
    sourceConversationId: 'other',
  });
  store.put('memory', { ...m, id: 'project', scope: 'project:secret' });
  store.put('memory', { ...m, id: 'pending', active: false, status: 'candidate' });
  store.put('memory', { ...m, id: 'expired', expiresAt: 2 });
  store.put('memory-vector', {
    id: m.id,
    model: 'fixture',
    values: [1, 0],
    hash: createHash('sha256')
      .update(JSON.stringify([m.content, m.revision, m.scope]))
      .digest('hex'),
  });
  const report = memoryStatus(store, ['user'], 'this', 'fixture', true);
  assert.equal(report.visibleRecords, 3);
  assert.equal(report.recallEligible, 1);
  assert.equal(report.expired, 1);
  assert.equal(report.vectors.eligibleCompatible, 1);
  assert.equal(memoryStatus(store, [], 'this', 'fixture', true).visibleRecords, 0);
});
test('index advice respects uncertainty, memory pressure and does not authorize mutation', () => {
  assert.equal(indexAdvice(20, [384]).recommendation, 'exact');
  assert.equal(indexAdvice(4000, [384]).recommendation, 'benchmark_hnsw');
  assert.equal(indexAdvice(10000, [1024], 1).recommendation, 'evaluate_compression');
  assert.equal(indexAdvice(4000, [384, 1024]).recommendation, 'repair_mixed_dimensions');
  assert.equal(indexAdvice(4000, [384]).automaticMutation, false);
});
test('unified read tool is initially discoverable and never exposes connection credentials', async (t) => {
  const { store, knowledge } = fixture(t);
  const ctx: any = {
    store,
    knowledge,
    scopes: ['general'],
    conversation: { id: 'chat', memory: false, permission: 'read-only' },
    run: { id: 'run', checkpoints: [] },
    config: {
      get: () => ({
        embedding: { backend: 'local', baseUrl: '', model: '', apiKey: 'SECRET' },
        retrieval: {
          vectors: {
            enabled: true,
            backend: 'qdrant',
            index: 'hnsw',
            apiKey: 'SECRET',
            baseUrl: 'https://private.invalid',
          },
        },
      }),
    },
  };
  const registry = tools();
  assert.ok(registry.modelSpecs(ctx).some((s) => s.name === 'inspect_retrieval_status'));
  const result = await registry.invoke('inspect_retrieval_status', {}, ctx);
  assert.ok(!result.content.includes('SECRET'));
  assert.ok(!result.content.includes('private.invalid'));
  const report = JSON.parse(result.content);
  assert.equal(report.memory.visibleRecords, 0);
  assert.equal(report.configured.serviceHealth, 'not_probed');
});

test('import health and vector dimensions do not collapse into no-match', (t) => {
  const { store, knowledge } = fixture(t);
  store.put('knowledge-watch', { id: 'general', status: 'processing' });
  assert.equal(knowledge.diagnostics(['general']).status, 'awaiting_import');
  store.put('knowledge-watch', { id: 'general', status: 'failed', error: 'private path' });
  assert.equal(knowledge.diagnostics(['general']).status, 'import_failed');
  assert.ok(!JSON.stringify(knowledge.diagnostics(['general'])).includes('private path'));
  const a: any = knowledge.import('general', 'one', 'some data');
  const b: any = knowledge.import('general', 'two', 'other data');
  const update = store.db.prepare('UPDATE chunks SET vector=? WHERE document_id=?');
  update.run(JSON.stringify({ model: 'fixture', values: [1, 0] }), a.id);
  update.run(JSON.stringify({ model: 'fixture', values: [1, 0, 0] }), b.id);
  assert.equal(knowledge.diagnostics(['general']).status, 'incompatible_dimensions');
  const lexical = new Knowledge(store);
  t.after(() => lexical.close());
  assert.equal(lexical.statistics(['general']).state, 'lexical_only');
});

test('scan health separates unchanged work from imports without exposing source paths', (t) => {
  const { store, knowledge } = fixture(t);
  store.put('knowledge-watch', {
    id: 'general',
    status: 'processing',
    progress: {
      startedAt: 100,
      updatedAt: 200,
      phase: 'scanning',
      completed: 3,
      total: 4,
      imported: 0,
      reused: 3,
      failed: 0,
      currentFile: 'SECRET_PATH',
    },
    scan: { files: 4, updated: 0, unchanged: 4 },
  });
  const result = knowledge.statistics(['general']);
  assert.equal(result.sources[0].currentCycle?.imported, 0);
  assert.equal(result.sources[0].currentCycle?.unchangedSkipped, 3);
  assert.equal(result.sources[0].currentCycle?.phase, 'scanning');
  assert.equal(result.sources[0].lastCompletedScan?.newOrChanged, 0);
  assert.ok(!JSON.stringify(result).includes('SECRET_PATH'));
});

test('large corpus inspection yields to other requests and retains identical statistics', async (t) => {
  const { knowledge } = fixture(t);
  for (let i = 0; i < 150; i++) knowledge.import('general', 'd' + i, 'hello world ' + i);
  const at = Date.now();
  let yielded = false;
  setImmediate(() => {
    yielded = true;
  });
  const actual = await knowledge.statisticsAsync(['general'], at);
  assert.ok(yielded);
  assert.deepEqual(actual, knowledge.statistics(['general'], at));
  assert.deepEqual(
    await knowledge.indexStatusesAsync('general'),
    knowledge.indexStatuses('general'),
  );
});
