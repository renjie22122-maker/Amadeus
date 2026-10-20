import { createServer } from 'node:http';
import { retrievalTarget } from '../shared/retrieval.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/storage/store.js';
import { Knowledge } from '../server/services/knowledge.js';
import { streamedVectors } from '../server/services/streamed-vectors.js';
import { selectEvidence } from '../server/services/research-evidence.js';

test('streaming traverses all batches and enforces scope, document version and dimensional compatibility', async () => {
  const store = new Store(':memory:');
  const kb = new Knowledge(store);
  try {
    const a: any = kb.import('general', 'active', 'target evidence');
    const old: any = kb.import('general', 'old', 'old evidence');
    store.put('document', { ...old, validUntil: 1 });
    const secret: any = kb.import('project:secret', 'secret', 'private evidence');
    const insert = store.db.prepare(
      'INSERT INTO chunks(id,scope,document_id,name,ordinal,text,vector,source_hash) VALUES(?,?,?,?,?,?,?,?)',
    );
    store.transaction(() => {
      for (let i = 0; i < 4200; i++)
        insert.run(
          'v' + String(i).padStart(5, '0'),
          'general',
          a.id,
          'active',
          i + 1,
          'target ' + i,
          JSON.stringify({ model: 'm', values: i === 4199 ? [1, 0] : [0, 1] }),
          'hash' + i,
        );
    });
    store.db
      .prepare('UPDATE chunks SET vector=? WHERE document_id IN (?,?)')
      .run(JSON.stringify({ model: 'm', values: [1, 0] }), old.id, secret.id);
    const result = await streamedVectors(
      store,
      ['general'],
      [],
      Date.now(),
      'm',
      [1, 0],
      undefined,
    );
    assert.equal(result.diagnostics.batches, 2);
    assert.equal(result.rows[0].id, 'v04199');
    assert(result.rows.every((r) => r.document_id === a.id));
    assert(result.rows.every((r) => !('vector' in r)));
    assert.equal(
      (await streamedVectors(store, ['general'], [secret.id], Date.now(), 'm', [1, 0], undefined))
        .rows.length,
      0,
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      streamedVectors(
        store,
        ['general'],
        [],
        Date.now(),
        'm',
        [1, 0],
        undefined,
        controller.signal,
      ),
    );
  } finally {
    kb.close();
    store.close();
  }
});

test('research selection groups duplicate passages, diversifies chapters and records bounded coverage', async () => {
  const hits = [
    { id: 'a', documentId: 'd', ordinal: 0, text: 'same text' },
    { id: 'b', documentId: 'd', ordinal: 1, text: 'nearby' },
    { id: 'c', documentId: 'e', ordinal: 0, text: 'same  text' },
    { id: 'd', documentId: 'd', ordinal: 40, text: 'different chapter' },
  ];
  const chosen = selectEvidence(hits, 2);
  assert.deepEqual(
    chosen.map((r) => r.id),
    ['a', 'd'],
  );
  assert.equal(chosen[0].samePassageSources[0].chunkId, 'c');
  const store = new Store(':memory:');
  const kb = new Knowledge(store);
  try {
    const doc: any = kb.import('general', 'source', 'target evidence');
    kb.import('project:private', 'secret', 'target secret');
    const result = await kb.investigate(
      ['general'],
      ['target', 'target evidence', 'target source', 'target missing'],
      6,
      undefined,
      Date.now(),
      [doc.id],
    );
    assert.equal(result.coverage.eligibleDocuments, 1);
    assert.equal(result.coverage.exhaustive, false);
    assert(result.results.every((r) => r.documentId === doc.id));
    assert(store.get('knowledge-investigation', result.investigationId));
    assert(result.rounds.length <= 4);
  } finally {
    kb.close();
    store.close();
  }
});

test('persistent manifests query without vector payload, invalidate on deletion, and recover evicted cache', async (t) => {
  const snapshots = new Map<string, string[]>();
  let batchSupported = false;
  let uploads = 0,
    probes = 0;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (req.url === '/vectors/search-batch') {
      if (!batchSupported) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          results: body.generations.map((generation: string) => ({
            generation,
            result: (snapshots.get(generation) || []).slice(0, 60).map((id) => ({ id, score: 1 })),
          })),
        }),
      );
      return;
    }
    if (body.cachedOnly) probes++;
    else {
      uploads++;
      snapshots.set(body.generation, body.ids);
    }
    const ids = snapshots.get(body.generation);
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify(
        ids
          ? {
              result: ids.slice(0, 60).map((id) => ({ id, score: 1 })),
              snapshotCached: true,
              effectiveIndex: 'flat',
            }
          : { cacheMiss: true },
      ),
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const external: any = {
    enabled: true,
    backend: 'faiss',
    index: 'flat',
    baseUrl: 'http://127.0.0.1:' + (server.address() as any).port,
  };
  external.authorizedTarget = retrievalTarget('vectors', external);
  const store = new Store(':memory:');
  const kb = new Knowledge(store);
  try {
    const doc: any = kb.import('general', 'source', 'target evidence');
    store.db
      .prepare('UPDATE chunks SET vector=? WHERE document_id=?')
      .run(JSON.stringify({ model: 'm', values: [1, 0] }), doc.id);
    const run = () => streamedVectors(store, ['general'], [], Date.now(), 'm', [1, 0], external);
    await run();
    assert.equal(uploads, 1);
    const hit = await run();
    assert.equal(hit.diagnostics.backend, 'persistent-external');
    assert.equal(uploads, 1);
    assert.equal(probes, 1);
    batchSupported = true;
    const batched = await run();
    assert.equal(batched.diagnostics.batchedCacheSearch, true);
    assert.deepEqual(batched.rows, hit.rows);
    assert.equal(probes, 1);
    batchSupported = false;
    snapshots.clear();
    assert.equal((await run()).rows.length, 1);
    assert.equal(uploads, 2);
    const insert = store.db.prepare(
      'INSERT INTO chunks(id,scope,document_id,name,ordinal,text,vector,source_hash) VALUES(?,?,?,?,?,?,?,?)',
    );
    store.transaction(() => {
      for (let i = 0; i < 2000; i++)
        insert.run(
          'padding-' + i,
          'general',
          doc.id,
          'source',
          i + 1,
          'different wording ' + i,
          JSON.stringify({ model: 'm', values: [1, 0] }),
          'h' + i,
        );
    });
    const hybrid = new Knowledge(
      store,
      { enabled: () => true, fingerprint: () => 'm', encode: async () => [[1, 0]] } as any,
      () => ({ vectors: external, graph: false }),
    );
    try {
      const first: any[] = await hybrid.hybrid(['general'], 'absent-query');
      assert(first.length > 0);
      assert(first.every((h) => h.scope === 'general' && h.retrievalChannels.semantic));
      const uploadCount = uploads;
      const cached: any[] = await hybrid.hybrid(['general'], 'absent-query');
      assert(cached.length > 0);
      assert(cached.every((h) => h.scope === 'general' && h.ranking.embeddingDimension === 2));
      assert.equal(cached[0].retrievalDiagnostics.backend, 'persistent-external');
      assert.equal(uploads, uploadCount);
    } finally {
      hybrid.close();
    }
    store.put('document', { ...doc, validUntil: 1 });
    assert.equal((await run()).rows.length, 0);
  } finally {
    kb.close();
    store.close();
  }
});
