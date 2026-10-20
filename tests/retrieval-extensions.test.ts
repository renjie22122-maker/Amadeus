import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { retrievalTarget } from '../shared/retrieval.js';
import {
  rerankCandidates,
  externalVectorSearch,
  retrievalPost,
} from '../server/services/retrieval-extensions.js';
import { Store } from '../server/storage/store.js';
import { Knowledge } from '../server/services/knowledge.js';
async function service(t: any, reply: (path: string, body: any) => any) {
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const b of req) raw += b;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(reply(req.url!, JSON.parse(raw))));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  return 'http://127.0.0.1:' + (server.address() as any).port;
}
test('reranking changes order, preserves fusion, supports no-match and validates every index', async (t) => {
  let bad = false;
  const baseUrl = await service(t, () =>
    bad
      ? [{ index: 99, score: 1 }]
      : [
          { index: 1, score: 0.9 },
          { index: 0, score: 0.1 },
        ],
  );
  const c: any = { enabled: true, baseUrl, model: 'test', minScore: 0.5, candidates: 2 };
  c.authorizedTarget = retrievalTarget('rerank', c);
  const rows = [
    { text: 'noise', fusionScore: 0.02 },
    { text: 'answer', fusionScore: 0.01 },
  ];
  const result = await rerankCandidates(c, 'question', rows);
  assert.equal(result.length, 1);
  assert.equal(result[0].text, 'answer');
  assert.equal(result[0].fusionScore, 0.01);
  assert.deepEqual(await rerankCandidates({ ...c, minScore: 0.95 }, 'q', rows), []);
  bad = true;
  await assert.rejects(() => rerankCandidates(c, 'q', rows));
  await assert.rejects(() =>
    retrievalPost('rerank', { ...c, baseUrl: baseUrl + '/changed' }, '/rerank', {}),
  );
});
test('external vector results cannot introduce foreign IDs or unsupported Qdrant IVF', async (t) => {
  const baseUrl = await service(t, () => ({ result: [{ id: 'foreign', score: 1 }] }));
  const c: any = { enabled: true, baseUrl, backend: 'faiss', index: 'flat' };
  c.authorizedTarget = retrievalTarget('vectors', c);
  await assert.rejects(() => externalVectorSearch(c, [{ id: 'allowed', values: [1, 0] }], [1, 0]));
  await assert.rejects(() =>
    externalVectorSearch({ ...c, backend: 'qdrant', index: 'ivf-pq' }, [], []),
  );
});
test('LightRAG sync submits once, polls completion, and imported text must match current scoped chunks', async (t) => {
  const store = new Store(':memory:');
  let submissions = 0;
  let source = '';
  let content = '';
  const baseUrl = await service(t, (path, body) => {
    if (path === '/documents/texts') {
      submissions++;
      source = body.file_sources[0];
      content = body.texts[0];
      return { jobId: 'job', status: 'processing' };
    }
    if (path === '/documents/status') return { status: 'completed' };
    return {
      data: {
        chunks: [
          { file_path: source, content },
          { file_path: 'amadeus-foreign-secret', content: 'secret' },
        ],
      },
    };
  });
  const light: any = { enabled: true, baseUrl, scope: 'general', mode: 'mix' };
  light.authorizedTarget = retrievalTarget('lightRag', light);
  const kb = new Knowledge(store, undefined, () => ({ lightRag: light }));
  t.after(() => {
    kb.close();
    store.close();
  });
  const doc: any = kb.import('general', 'facts', 'The capital is Paris.');
  await kb.syncLightRag();
  await kb.syncLightRag();
  await kb.syncLightRag();
  assert.equal(submissions, 1);
  const result = await kb.hybrid(['general'], 'capital');
  assert.ok(result.some((r: any) => r.documentId === doc.id));
  assert.ok(!JSON.stringify(result).includes('secret'));
  store.put('document', { ...doc, validUntil: 1 });
  assert.deepEqual(await kb.hybrid(['general'], 'capital'), []);
});
test('LightRAG unknown submission is recorded before network and is not replayed', async (t) => {
  let requests = 0;
  const baseUrl = await service(t, () => {
    requests++;
    return { invalid: true };
  });
  const light: any = { enabled: true, baseUrl, scope: 'general', mode: 'mix' };
  light.authorizedTarget = retrievalTarget('lightRag', light);
  const store = new Store(':memory:');
  const kb = new Knowledge(store, undefined, () => ({ lightRag: light }));
  t.after(() => {
    kb.close();
    store.close();
  });
  kb.import('general', 'test', 'a useful document');
  await assert.rejects(() => kb.syncLightRag());
  assert.equal((await kb.syncLightRag()).status, 'unknown');
  assert.equal(requests, 1);
});

test('vector snapshots use bounded float32 payloads and preserve scoped identifiers', async (t) => {
  const baseUrl = await service(t, (_path, body) => {
    assert.equal(body.rows, undefined);
    assert.deepEqual(body.ids, ['one']);
    assert.equal(body.dimensions, 2);
    const packed = Buffer.from(body.vectorsBase64, 'base64');
    assert.equal(packed.length, 8);
    assert.equal(packed.readFloatLE(0), 1);
    return { result: [{ id: 'one', score: 1 }], effectiveIndex: 'flat' };
  });
  const config: any = { enabled: true, baseUrl, backend: 'faiss', index: 'flat' };
  config.authorizedTarget = retrievalTarget('vectors', config);
  assert.equal(
    (await externalVectorSearch(config, [{ id: 'one', values: [1, 0] }], [1, 0])).result[0].id,
    'one',
  );
  await assert.rejects(() => externalVectorSearch(config, [{ id: 'one', values: [1] }], [1, 0]));
  await assert.rejects(() =>
    externalVectorSearch(config, [{ id: 'one', values: [NaN, 0] }], [1, 0]),
  );
});

test('corpora above 80 MiB search bounded shards, merge top hits and reuse snapshots', async (t) => {
  let uploads = 0,
    probes = 0;
  const cached = new Map<string, string[]>();
  const baseUrl = await service(t, (_path, body) => {
    if (body.cachedOnly) probes++;
    else {
      uploads++;
      assert(Buffer.from(body.vectorsBase64, 'base64').length <= 16 * 1024 * 1024);
      cached.set(body.generation, body.ids);
    }
    const ids = cached.get(body.generation);
    if (!ids) return { cacheMiss: true };
    return {
      result: [{ id: ids.at(-1), score: Number(ids.at(-1)) / 22000 }],
      effectiveIndex: 'flat',
      snapshotCached: true,
    };
  });
  const config: any = { enabled: true, baseUrl, backend: 'faiss', index: 'flat' };
  config.authorizedTarget = retrievalTarget('vectors', config);
  const values = Array(1024).fill(0);
  values[0] = 1;
  const rows = Array.from({ length: 22000 }, (_, i) => ({ id: String(i), values }));
  const result = await externalVectorSearch(config, rows, values);
  assert.equal(result.result[0].id, '21999');
  assert.equal(uploads, 6);
  await externalVectorSearch(config, rows, values);
  assert.equal(uploads, 6);
  assert.equal(probes, 6);
  cached.clear();
  await externalVectorSearch(config, rows, values);
  assert.equal(uploads, 12);
});

test('vector outage preserves lexical evidence and explicit lexical mode never embeds', async (t) => {
  const baseUrl = await service(t, () => ({ result: [{ id: 'foreign', score: 1 }] }));
  const config: any = { enabled: true, baseUrl, backend: 'faiss', index: 'flat' };
  config.authorizedTarget = retrievalTarget('vectors', config);
  const store = new Store(':memory:');
  let calls = 0;
  const embedding: any = {
    enabled: () => true,
    fingerprint: () => 'test',
    encode: async () => {
      calls++;
      return [[1, 0]];
    },
  };
  const kb = new Knowledge(store, embedding, () => ({ vectors: config }));
  t.after(() => {
    kb.close();
    store.close();
  });
  const doc: any = kb.import('general', 'evidence', 'target lexical evidence');
  store.db
    .prepare('UPDATE chunks SET vector=? WHERE document_id=?')
    .run(JSON.stringify({ model: 'test', values: [1, 0] }), doc.id);
  const hits = await kb.hybrid(['general'], 'target');
  assert.equal(hits[0].documentId, doc.id);
  assert.equal((hits[0] as any).retrievalDiagnostics.degraded, true);
  const before = calls;
  const lexical = await kb.hybrid(
    ['general'],
    'target',
    6,
    undefined,
    Date.now(),
    false,
    [],
    'lexical',
  );
  assert.equal(calls, before);
  assert.equal(lexical[0].documentId, doc.id);
  assert.deepEqual(
    await kb.hybrid(['project:private'], 'target', 6, undefined, Date.now(), false, [], 'lexical'),
    [],
  );
});

test('optional LightRAG failure preserves scoped base results and reports degradation', async (t) => {
  const baseUrl = await service(t, () => ({ error: 'unavailable' }));
  const light: any = { enabled: true, baseUrl, scope: 'general', mode: 'mix' };
  light.authorizedTarget = retrievalTarget('lightRag', light);
  const store = new Store(':memory:');
  const kb = new Knowledge(store, undefined, () => ({ lightRag: light }));
  t.after(() => {
    kb.close();
    store.close();
  });
  const doc: any = kb.import('general', 'facts', 'The capital is Paris.');
  const result = await kb.hybrid(['general'], 'capital');
  assert.ok(result.some((r: any) => r.documentId === doc.id));
  assert.equal(kb.lastRetrieval.lightRagStatus, 'unavailable');
  assert.equal(kb.lastRetrieval.degraded, true);
  assert.ok((kb.lastRetrieval.timingsMs as any).lightRag >= 0);
});

test('unknown LightRAG jobs reconcile exact scoped batch without a second submission', async (t) => {
  let original: any;
  let submissions = 0,
    checks = 0;
  const baseUrl = await service(t, (path, body) => {
    if (path === '/documents/texts') {
      original = structuredClone(body);
      submissions++;
      return { jobId: 'original', status: 'processing' };
    }
    checks++;
    if (body.reconcile) {
      assert.equal(body.reconcile.scope, 'general');
      assert.deepEqual(body.reconcile, original);
      return { status: 'completed' };
    }
    return { status: 'unknown' };
  });
  const light: any = { enabled: true, baseUrl, scope: 'general', mode: 'mix' };
  light.authorizedTarget = retrievalTarget('lightRag', light);
  const store = new Store(':memory:');
  const kb = new Knowledge(store, undefined, () => ({ lightRag: light }));
  t.after(() => {
    kb.close();
    store.close();
  });
  kb.import('general', 'source', 'original content');
  await kb.syncLightRag();
  assert.equal((await kb.syncLightRag()).status, 'synced');
  assert.equal(submissions, 1);
  assert.equal(checks, 2);
});
