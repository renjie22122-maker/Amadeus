import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/storage/store.js';
import { Knowledge } from '../server/services/knowledge.js';

test('RRF retains both channel contributions and distinguishes identical sources from other candidates', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ranking-')),
    store = new Store(join(dir, 'db.sqlite'));
  const embedding: any = {
    enabled: () => true,
    fingerprint: () => 'fixture',
    encode: async (texts: string[]) => texts.map(() => [1, 0]),
  };
  const kb = new Knowledge(store, embedding);
  try {
    const a: any = kb.import('project:a', 'a.txt', 'rocket engine propulsion');
    const b: any = kb.import('project:a', 'b.txt', 'rocket engine propulsion');
    const c: any = kb.import('project:a', 'c.txt', 'rocket unrelated discussion');
    const secret: any = kb.import('project:b', 'secret.txt', 'rocket engine propulsion');
    for (const doc of [a, b, c, secret]) await kb.index(doc.id);
    const rows = await kb.hybrid(['project:a'], 'rocket', 10);
    const hit = rows.find((r: any) => r.documentId === a.id)!;
    const channels = hit.retrievalChannels;
    const expected = 1 / (60 + channels.lexical.rank) + 1 / (60 + channels.semantic.rank);
    assert.equal(hit.fusionScore, expected);
    assert.equal(hit.baseScore, expected);
    assert.equal(hit.score, expected);
    assert.equal(hit.ranking.semanticReranker, 'none');
    assert.equal(hit.ranking.embeddingDimension, 2);
    assert.equal(hit.ranking.relevanceCalibrated, false);
    assert.deepEqual(
      hit.alternativeSources.map((r: any) => r.documentId),
      [b.id],
    );
    assert.ok(!JSON.stringify(rows).includes(secret.id));
    assert.deepEqual(await kb.hybrid(['project:a'], '  '), []);
  } finally {
    kb.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
