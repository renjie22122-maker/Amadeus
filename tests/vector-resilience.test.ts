import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/storage/store.js';
import { Knowledge } from '../server/services/knowledge.js';
import { vectorRecord, validVector } from '../server/services/vector-record.js';
import { chartDocument } from '../src/chart-spec.js';

test('vector records reject malformed JSON, shapes, zero norms and nonfinite values', () => {
  for (const raw of [
    'broken',
    'null',
    '{}',
    '[]',
    JSON.stringify({ model: 'm', values: [] }),
    JSON.stringify({ model: 'm', values: [0, 0] }),
    JSON.stringify({ model: 'm', values: ['1', 2] }),
    '{"model":"m","values":[1e999,1]}',
  ])
    assert.equal(vectorRecord(raw), undefined);
  assert.equal(validVector([1e308, 1e308]), false);
  assert.equal(validVector([1, 2], 3), false);
  assert(vectorRecord('{"model":"m","values":[1,0]}', 'm', 2));
});

test('one corrupt vector does not discard healthy semantic or lexical results and repair replaces it', async () => {
  const store = new Store(':memory:');
  let calls = 0;
  const embedding: any = {
    enabled: () => true,
    fingerprint: () => 'm',
    encode: async (text: string[]) => {
      calls++;
      return text.map(() => [1, 0]);
    },
  };
  const kb = new Knowledge(store, embedding);
  try {
    const good: any = kb.import('general', 'good', 'target healthy evidence');
    const bad: any = kb.import('general', 'bad', 'target damaged derived vector');
    const wrong: any = kb.import('general', 'wrong', 'target other dimensional vector');
    const secret: any = kb.import('project:secret', 'secret', 'target private corpus');
    const update = store.db.prepare('UPDATE chunks SET vector=? WHERE document_id=?');
    update.run(JSON.stringify({ model: 'm', values: [1, 0] }), good.id);
    update.run('{broken', bad.id);
    update.run(JSON.stringify({ model: 'm', values: [1, 0, 0] }), wrong.id);
    update.run('{broken', secret.id);
    const hits = await kb.hybrid(['general'], 'target');
    assert(hits.some((h) => h.documentId === good.id));
    assert(hits.some((h) => h.documentId === bad.id));
    assert(!hits.some((h) => h.documentId === secret.id));
    const trace = store.get<any>('retrieval-trace', hits[0].retrievalTraceId);
    assert.deepEqual(trace.diagnostics.vectorHealth, {
      scanned: 3,
      usable: 1,
      invalid: 1,
      incompatible: 1,
    });
    assert.equal(kb.indexStatus(bad.id).invalid, 1);
    await kb.index(bad.id);
    assert.equal(kb.indexStatus(bad.id).status, 'indexed');
    assert.equal(calls, 2);
    update.run(JSON.stringify({ model: 'm', values: 'bad' }), bad.id);
    await kb.index(bad.id);
    assert.equal(calls, 3);
  } finally {
    kb.close();
    store.close();
  }
});

test('query embedding failure falls back visibly but cancellation and database failure propagate', async () => {
  const store = new Store(':memory:');
  const error = new Error('unavailable');
  const embedding: any = {
    enabled: () => true,
    fingerprint: () => 'm',
    encode: async () => {
      throw error;
    },
  };
  const kb = new Knowledge(store, embedding);
  kb.import('general', 'a', 'target evidence');
  try {
    const hits = await kb.hybrid(['general'], 'target');
    assert(hits.length);
    assert.equal(hits[0].retrievalDiagnostics.reason, 'query_embedding_unavailable');
    const c = new AbortController();
    c.abort();
    await assert.rejects(kb.hybrid(['general'], 'target', 6, c.signal));
    store.close();
    await assert.rejects(kb.hybrid(['general'], 'target'));
  } finally {
    kb.close();
  }
});

test('declarative charts escape content and validate data without executing model code', () => {
  for (const type of ['bar', 'line']) {
    const html = chartDocument(
      JSON.stringify({
        type,
        title: '<script>alert(1)</script>',
        data: [
          { label: '<img src=x onerror=alert(1)>', value: -2 },
          { label: 'two', value: 3 },
        ],
      }),
    );
    assert(!html.includes('<script>'));
    assert(!html.includes('<img src=x'));
    assert(html.includes('&lt;script&gt;'));
    assert(!html.includes('NaN'));
  }
  assert(
    chartDocument(
      JSON.stringify({
        type: 'flow',
        steps: [{ title: 'Observe', detail: 'Collect evidence' }, { title: 'Verify' }],
      }),
    ).includes('class="flow"'),
  );
  assert(
    chartDocument(
      JSON.stringify({ type: 'table', columns: ['A', 'B'], rows: [[1, 'x']] }),
    ).includes('<table>'),
  );
  assert.throws(() => chartDocument('{unfinished'));
  assert.throws(() =>
    chartDocument(JSON.stringify({ type: 'table', columns: ['A'], rows: [[1, 2]] })),
  );
  assert.throws(() =>
    chartDocument(JSON.stringify({ type: 'bar', data: [{ label: 'x', value: '1' }] })),
  );
});

test('memory vector corruption preserves other memories and is repaired during normal indexing', async () => {
  const { MemoryIndex } = await import('../server/services/memory-index.js');
  const store = new Store(':memory:');
  const embedding: any = {
    enabled: () => true,
    fingerprint: () => 'm',
    encode: async (text: string[]) => text.map(() => [1, 0]),
  };
  const index = new MemoryIndex(store, embedding);
  try {
    for (const id of ['good', 'bad'])
      store.put('memory', {
        id,
        scope: 'user',
        active: true,
        content: 'TypeScript preference ' + id,
        revision: 1,
        createdAt: Date.now(),
        source: 'fixture',
        expiresAt: null,
      });
    await index.index();
    store.db
      .prepare("UPDATE records SET data=? WHERE kind='memory-vector' AND id=?")
      .run('{broken', 'bad');
    const result = await index.recall('TypeScript', null, new AbortController().signal);
    assert.equal(result.invalidVectors, 1);
    assert(result.memories.some((m) => m.id === 'good'));
    await index.index();
    assert(validVector(store.get<any>('memory-vector', 'bad').values));
  } finally {
    store.close();
  }
});

test('simultaneous retrieval traces retain their own corruption diagnostics', async () => {
  const store = new Store(':memory:');
  const embedding: any = {
    enabled: () => true,
    fingerprint: () => 'm',
    encode: async () => [[1, 0]],
  };
  const kb = new Knowledge(store, embedding);
  try {
    for (const scope of ['general', 'project:a']) {
      const doc: any = kb.import(scope, 'test', 'target ' + scope);
      store.db
        .prepare('UPDATE chunks SET vector=? WHERE document_id=?')
        .run(
          scope === 'general' ? '{broken' : JSON.stringify({ model: 'm', values: [1, 0] }),
          doc.id,
        );
    }
    const [bad, good] = await Promise.all([
      kb.hybrid(['general'], 'target'),
      kb.hybrid(['project:a'], 'target'),
    ]);
    assert.equal((bad[0].retrievalDiagnostics.vectorHealth as any).invalid, 1);
    assert.equal((good[0].retrievalDiagnostics.vectorHealth as any).invalid, 0);
  } finally {
    kb.close();
    store.close();
  }
});
