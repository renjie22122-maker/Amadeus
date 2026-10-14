import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/storage/store.js';
import { Knowledge } from '../server/services/knowledge.js';

for (const size of [1, 2001]) {
  test(`query diagnostics distinguish lexical-only hits from semantic execution (${size} vectors)`, async () => {
    const store = new Store(':memory:');
    const embeddings: any = {
      enabled: () => true,
      fingerprint: () => 'test-model',
      encode: async () => [[1, 0]],
    };
    const kb = new Knowledge(store, embeddings);
    try {
      const lexical: any = kb.import('general', 'literal', 'needle literal evidence');
      const semantic: any = kb.import('general', 'meaning', 'different wording');
      store.db
        .prepare('UPDATE chunks SET vector=? WHERE document_id=?')
        .run(JSON.stringify({ model: 'test-model', values: [1, 0] }), semantic.id);
      const insert = store.db.prepare(
        'INSERT INTO chunks(id,scope,document_id,name,ordinal,text,vector,source_hash) VALUES(?,?,?,?,?,?,?,?)',
      );
      store.transaction(() => {
        for (let i = 1; i < size; i++)
          insert.run(
            'padding-' + i,
            'general',
            semantic.id,
            'meaning',
            i,
            'unrelated filler ' + i,
            JSON.stringify({ model: 'test-model', values: [0, 1] }),
            'h' + i,
          );
      });
      const hits: any[] = await kb.hybrid(['general'], 'needle', 6);
      const literal = hits.find((h) => h.documentId === lexical.id);
      const meaning = hits.find(
        (h) => h.documentId === semantic.id && h.retrievalChannels?.semantic?.rawScore === 1,
      );
      assert(literal);
      assert(
        meaning,
        JSON.stringify(
          hits.map((h) => ({
            text: h.text,
            channels: h.retrievalChannels,
            score: h.score,
            diag: h.retrievalDiagnostics,
          })),
        ),
      );
      assert(!literal.retrievalChannels.semantic);
      assert.equal(literal.ranking.embeddingModel, null);
      assert.equal(literal.retrievalDiagnostics.semanticStatus, 'searched');
      assert.equal(literal.retrievalDiagnostics.embeddingModel, 'test-model');
      assert.equal(literal.retrievalDiagnostics.embeddingDimension, 2);
      assert(literal.retrievalDiagnostics.semanticCandidates > 0);
      assert(literal.retrievalDiagnostics.returnedChannels.semantic > 0);
      assert.equal(meaning.ranking.embeddingDimension, 2);
      assert.equal(meaning.fusionScore, 1 / 61);
      const trace = store.get<any>('retrieval-trace', literal.retrievalTraceId);
      assert.equal(trace.diagnostics.semanticStatus, 'searched');
      const lexicalOnly: any[] = await kb.hybrid(
        ['general'],
        'needle',
        6,
        undefined,
        Date.now(),
        false,
        [],
        'lexical',
      );
      assert.equal(lexicalOnly[0].retrievalDiagnostics.semanticStatus, 'disabled_by_request');
      assert.equal(lexicalOnly[0].retrievalDiagnostics.embeddingDimension, null);
      store.db
        .prepare('UPDATE chunks SET vector=? WHERE vector IS NOT NULL')
        .run(JSON.stringify({ model: 'different-model', values: [1, 0] }));
      const incompatible: any[] = await kb.hybrid(['general'], 'needle');
      assert.equal(incompatible[0].retrievalDiagnostics.semanticStatus, 'no_compatible_candidates');
      assert.equal(incompatible[0].retrievalDiagnostics.semanticCandidates, 0);
    } finally {
      kb.close();
      store.close();
    }
  });
}
