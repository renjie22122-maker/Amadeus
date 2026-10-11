import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptiveCutoff, candidatePassages } from '../server/services/retrieval-extensions.js';
import { structuredChunks } from '../server/services/knowledge-versions.js';
import { Knowledge } from '../server/services/knowledge.js';
import { Store } from '../server/storage/store.js';
import { groupObservations } from '../server/services/evidence-diversity.js';

test('automatic cutoff retains ambiguous lists and complementary leaders, defers separated tail', () => {
  const rows = [0.99, 0.98, 0.4, 0.39, 0.38].map((score, id) => ({ score, id }));
  assert.deepEqual(
    adaptiveCutoff(rows).kept.map((r) => r.id),
    [0, 1],
  );
  assert.equal(adaptiveCutoff([0.9, 0.88, 0.85, 0.8].map((score) => ({ score }))).kept.length, 4);
  assert.equal(adaptiveCutoff([10, 9, 1, 0].map((score) => ({ score }))).kept.length, 4);
});
test('legacy passage selection reaches the tail and preserves source offsets', () => {
  const text = 'irrelevant '.repeat(250) + 'target requirement appears in this final sentence';
  const passages = candidatePassages(text, 'target requirement');
  assert.ok(passages.some((p) => p.text.includes('target requirement')));
  for (const p of passages) assert.equal(text.slice(p.start, p.end), p.text);
  assert.ok(structuredChunks('中'.repeat(2300)).every((c) => c.text.length <= 600));
});
test('document constrained retrieval applies before ranking and audit preserves hashes', async () => {
  const store = new Store(':memory:'),
    kb = new Knowledge(store);
  try {
    const a: any = kb.import('general', 'a.txt', 'shared term specific clause');
    kb.import('general', 'b.txt', 'shared term '.repeat(80));
    const hidden: any = kb.import('project:private', 'secret.txt', 'shared term specific clause');
    const hits = await kb.hybrid(['general'], 'shared term', 6, undefined, Date.now(), false, [
      a.id,
      hidden.id,
    ]);
    assert.ok(hits.length);
    assert.ok(hits.every((h) => h.documentId === a.id));
    const trace: any = store.get('retrieval-trace', hits[0].retrievalTraceId);
    assert.equal(trace.conclusion, 'unassessed');
    assert.ok(trace.hits[0].contentHash);
    const run = await kb.investigate(['general'], ['shared term', 'shared term', 'unknown words']);
    assert.ok(run.rounds.length <= 2);
    assert.equal(run.budget.maxQueries, 4);
  } finally {
    kb.close();
    store.close();
  }
});
test('copied evidence and repeated checks do not become independent support', () => {
  const a = { eventId: 1, runId: 'a', source: { tool: 'read', path: 'x' }, result: 'same' };
  const report = groupObservations([a, a, { ...a, eventId: 2, runId: 'b' }]);
  assert.equal(report.uniqueEvents, 2);
  assert.equal(report.sourceGroups, 1);
  assert.equal(report.independentSources, 'not-established');
  assert.equal(report.groups[0].executors.length, 2);
  assert.equal(
    groupObservations([a, { ...a, eventId: 3, result: 'different' }]).groups[0].observationsDiffer,
    true,
  );
});
