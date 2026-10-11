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
