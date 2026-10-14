import { Knowledge } from '../server/services/knowledge.js';
import { deliveryEvidence } from '../server/services/delivery-evidence.js';
import { installKnowledgeTools } from '../server/tools/knowledge-tools.js';
import { relatedToolNames } from '../server/tools/discovery.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/storage/store.js';
import { ResearchCases, researchReferenceCurrent } from '../server/services/research-case.js';
function setup() {
  const store = new Store(':memory:');
  const run: any = {
    id: 'lead',
    conversationId: 'chat',
    parentRunId: null,
    status: 'running',
    checkpoints: [],
  };
  store.put('run', run);
  store.put('conversation', { id: 'chat', permission: 'ask', memory: false });
  store.put('document', { id: 'd', scope: 'general', name: 'Source', version: 1, createdAt: 0 });
  const insert = store.db.prepare('INSERT INTO chunks VALUES(?,?,?,?,?,?,?,?)');
  for (let i = 0; i < 45; i++)
    insert.run('c' + i, 'general', 'd', 'Source', i, 'Passage ' + i, null, 'hash');
  const service = new ResearchCases(store, run, ['general']);
  const c = service.create('Which explanation fits the observations?');
  const hypotheses = [
    {
      id: 'a',
      explanation: 'Mechanism A',
      supports: [] as string[],
      counters: [] as string[],
      missing: ['Observation X'],
      discriminator: 'X differs from B',
    },
    {
      id: 'b',
      explanation: 'Mechanism B',
      supports: [] as string[],
      counters: [] as string[],
      missing: ['Observation X'],
      discriminator: 'X differs from A',
    },
  ];
  return { store, run, service, c, hypotheses };
}
test('long reading provides ordered navigation and adjacent context without embeddings', () => {
  const f = setup();
  try {
    const overview = f.service.outline('d', 0);
    assert.equal(overview.entries.length, 40);
    assert.equal(overview.nextOffset, 40);
    const context = f.service.readContext('d', 20, 2, f.c.id);
    assert.deepEqual(
      context.passages.map((r) => r.ordinal),
      [18, 19, 20, 21, 22],
    );
    assert.equal(f.service.get(f.c.id).evidence.length, 5);
    f.store.db.prepare('UPDATE chunks SET text=? WHERE id=?').run('x'.repeat(8000), 'c20');
    const other = f.service.create('Long passage');
    const partial = f.service.readContext('d', 20, 0, other.id);
    assert.equal(partial.passages[0].truncated, true);
    assert.equal(f.service.get(other.id).evidence.length, 0);
  } finally {
    f.store.close();
  }
});
test('comparison binds notes to observed unchanged sources; duplicate content is not corroboration', () => {
  const f = setup();
  try {
    assert.throws(
      () =>
        f.service.update(
          f.c.id,
          1,
          [{ ...f.hypotheses[0], supports: ['c1'] }, f.hypotheses[1]],
          [],
          'open',
          '',
        ),
      /read\/retrieved/,
    );
    f.store.db.prepare('UPDATE chunks SET text=? WHERE id=?').run('Passage 1', 'c2');
    f.service.readContext('d', 1, 1, f.c.id);
    const current = f.service.get(f.c.id);
    assert.equal(f.service.inspect(f.c.id).distinctPassageHashes, 2);
    const h = [
      { ...f.hypotheses[0], supports: ['c1'] },
      { ...f.hypotheses[1], counters: ['c1'] },
    ];
    const updated = f.service.update(
      f.c.id,
      current.revision,
      h,
      [
        {
          text: 'Tentative relation',
          evidenceIds: ['c1'],
          nature: 'inference',
          limitation: 'Alternative remains',
        },
      ],
      'open',
      '',
    );
    assert(researchReferenceCurrent(f.store, f.c.id, updated.revision));
    f.store.db.prepare('UPDATE chunks SET text=? WHERE id=?').run('Changed', 'c1');
    assert(!researchReferenceCurrent(f.store, f.c.id, updated.revision));
    assert.deepEqual(f.service.inspect(f.c.id).staleEvidenceIds, ['c1']);
    assert.throws(
      () => f.service.update(f.c.id, updated.revision, h, [], 'concluded', 'A is plausible'),
      /unchanged evidence/,
    );
    assert.throws(() => f.service.addEvidence(f.c.id, ['c1']), /silently rebind/);
  } finally {
    f.store.close();
  }
});
test('one specific investigation at a time; repeats and no-gain loops stop', () => {
  const f = setup();
  try {
    f.service.update(f.c.id, 1, f.hypotheses, [], 'open', '');
    assert.throws(
      () => f.service.reserve(f.c.id, 'query', 'gap', ['a', 'missing']),
      /recorded alternatives/,
    );
    const n = f.service.reserve(f.c.id, 'Query!', 'Observe X', ['a', 'b']);
    assert.throws(() => f.service.reserve(f.c.id, 'Other', 'Observe X', ['a', 'b']), /pending/);
    assert.throws(
      () =>
        f.service.update(
          f.c.id,
          f.service.get(f.c.id).revision,
          f.hypotheses,
          [],
          'inconclusive',
          'Stop',
        ),
      /pending/,
    );
    f.service.finish(f.c.id, n, { results: [], investigationId: 'i' });
    assert.throws(
      () => f.service.reserve(f.c.id, 'query', 'Observe X', ['a', 'b']),
      /already attempted/,
    );
    const m = f.service.reserve(f.c.id, 'Different', 'Observe Y', ['a', 'b']);
    f.service.finish(f.c.id, m, undefined, true);
    assert.equal(f.service.get(f.c.id).noGain, 1);
    const third = f.service.reserve(f.c.id, 'Third', 'Observe Z', ['a', 'b']);
    f.service.finish(f.c.id, third, { results: [], investigationId: 'third' });
    assert.throws(
      () => f.service.reserve(f.c.id, 'Fourth', 'Observe Z', ['a', 'b']),
      /two successful/,
    );
    assert.equal(f.service.get(f.c.id).attempts[1].status, 'failed');
  } finally {
    f.store.close();
  }
});
test('total budget stops even if every query adds evidence; conclusions remain assessments', () => {
  const f = setup();
  try {
    f.service.update(f.c.id, 1, f.hypotheses, [], 'open', '');
    for (let i = 0; i < 6; i++) {
      const n = f.service.reserve(f.c.id, 'query' + i, 'gap' + i, ['a', 'b']);
      f.service.finish(f.c.id, n, { results: [{ id: 'c' + i }], investigationId: 'i' + i });
    }
    assert.throws(
      () => f.service.reserve(f.c.id, 'seventh', 'gap', ['a', 'b']),
      /budget exhausted/,
    );
    const c = f.service.get(f.c.id);
    const result = f.service.update(
      c.id,
      c.revision,
      [{ ...f.hypotheses[0], supports: ['c0'] }, f.hypotheses[1]],
      [],
      'inconclusive',
      'Both explanations remain compatible; no more retrieval justified.',
    );
    assert.equal(result.status, 'inconclusive');
    assert.equal(f.store.events('chat').at(-1)?.type, 'research.assessed');
  } finally {
    f.store.close();
  }
});
test('shared task-tree research does not cross conversation trees or knowledge permissions', () => {
  const f = setup();
  try {
    const child = { ...f.run, id: 'child', conversationId: 'childchat', parentRunId: 'lead' };
    f.store.put('run', child);
    assert.equal(new ResearchCases(f.store, child, ['general']).get(f.c.id).id, f.c.id);
    assert.throws(() => new ResearchCases(f.store, child, []).get(f.c.id), /scope/);
    const stranger = { ...f.run, id: 'stranger', conversationId: 'other' };
    f.store.put('run', stranger);
    assert.throws(
      () => new ResearchCases(f.store, stranger, ['general']).get(f.c.id),
      /another conversation/,
    );
    f.store.put('document', { id: 'private', scope: 'project:other', name: 'private', version: 1 });
    assert.throws(() => f.service.outline('private', 0), /accessible version/);
  } finally {
    f.store.close();
  }
});

test('tool chain registers read evidence, enforces budgets before retrieval and exposes related capabilities', async () => {
  const f = setup();
  try {
    const defs = new Map<string, any>();
    installKnowledgeTools({ add: (d: any) => defs.set(d.name, d) } as any);
    let calls = 0;
    const ctx: any = {
      store: f.store,
      run: f.run,
      scopes: ['general'],
      signal: new AbortController().signal,
      knowledge: {
        investigate: async () => {
          calls++;
          return {
            results: [],
            investigationId: 'empty',
            budget: { stopReason: 'query-budget-exhausted' },
          };
        },
      },
    };
    const call = async (name: string, args: any) => {
      const d = defs.get(name);
      return JSON.parse((await d.run(d.schema.parse(args), ctx)).content);
    };
    const read = await call('read_knowledge_document', {
      documentId: 'd',
      limit: 1,
      caseId: f.c.id,
    });
    assert.equal(read.caseRevision, 2);
    await call('update_research_case', { id: f.c.id, revision: 2, hypotheses: f.hypotheses });
    for (const query of ['first', 'second'])
      await call('investigate_research_gap', {
        id: f.c.id,
        query,
        gap: 'distinguish timing',
        distinguishes: ['a', 'b'],
      });
    await assert.rejects(
      call('investigate_research_gap', {
        id: f.c.id,
        query: 'third',
        gap: 'timing',
        distinguishes: ['a', 'b'],
      }),
      /Stop:/,
    );
    assert.equal(calls, 2);
    assert(relatedToolNames(['create_research_case']).includes('read_knowledge_context'));
  } finally {
    f.store.close();
  }
});

test('continued new passages cannot cause unbounded reading or reset the same case', () => {
  const f = setup();
  try {
    for (let i = 0; i < 16; i++) f.service.readContext('d', i, 0, f.c.id);
    assert.throws(() => f.service.readContext('d', 16, 0, f.c.id), /reading budget/);
    assert.equal(f.service.inspect(f.c.id).budget.readsUsed, 16);
    assert.equal(f.service.create('Which explanation fits the observations?').id, f.c.id);
    const other = f.service.create('Different question');
    f.service.recordRead(other.id, 'large', 160000, []);
    assert.throws(() => f.service.recordRead(other.id, 'extra', 1, []), /reading budget/);
    assert.throws(() => f.service.recordRead(other.id, 'large', 1, []), /already returned/);
  } finally {
    f.store.close();
  }
});

test('discarding stale citations requires a revision; ordinary re-reading cannot silently refresh them', () => {
  const f = setup();
  try {
    f.service.readContext('d', 0, 0, f.c.id);
    const revision = f.service.get(f.c.id).revision;
    f.service.addEvidence(f.c.id, ['c0']);
    assert.equal(f.service.get(f.c.id).revision, revision);
    f.store.db.prepare('UPDATE chunks SET text=? WHERE id=?').run('Revised', 'c0');
    f.service.update(
      f.c.id,
      revision,
      f.hypotheses,
      [],
      'open',
      'Discard obsolete observations before re-reading',
    );
    assert.equal(f.service.get(f.c.id).evidence.length, 0);
    f.service.addEvidence(f.c.id, ['c0']);
    assert.equal(f.service.inspect(f.c.id).staleEvidenceIds.length, 0);
  } finally {
    f.store.close();
  }
});

test('slow services get a bounded longer retry and never count as missing evidence', () => {
  const f = setup();
  try {
    f.service.update(f.c.id, 1, f.hypotheses, [], 'open', '');
    let n = f.service.reserve(f.c.id, 'slow query', 'Observe X', ['a', 'b']);
    assert.equal(f.service.get(f.c.id).attempts[n].timeLimitMs, 180000);
    f.service.finish(f.c.id, n, undefined, true, 'timeout');
    assert.equal(f.service.get(f.c.id).noGain, 0);
    n = f.service.reserve(f.c.id, 'slow query', 'Observe X', ['a', 'b']);
    assert.equal(f.service.get(f.c.id).attempts[n].timeLimitMs, 300000);
    f.service.finish(f.c.id, n, undefined, true, 'timeout');
    assert.throws(
      () => f.service.reserve(f.c.id, 'third query', 'Observe X', ['a', 'b']),
      /service failures/,
    );
    assert(f.service.inspect(f.c.id).budget.stopReasons.includes('service-failures'));
  } finally {
    f.store.close();
  }
});

test('cumulative retrieval time stops despite fresh evidence and pending interrupted work is not replayed', () => {
  const f = setup();
  try {
    f.service.update(f.c.id, 1, f.hypotheses, [], 'open', '');
    const n = f.service.reserve(f.c.id, 'query', 'Observe X', ['a', 'b']);
    f.store.put('run', { ...f.run, status: 'interrupted' });
    const recovered = f.service.recover(f.c.id);
    assert.equal(recovered.attempts[n].failureReason, 'interrupted');
    assert.equal(recovered.attempts[n].elapsedEstimated, true);
    assert.equal(recovered.noGain, 0);
    recovered.attempts[n].elapsedMs = 720000;
    f.store.put('research-case', recovered);
    assert.throws(() => f.service.reserve(f.c.id, 'new', 'Observe Y', ['a', 'b']), /time budget/);
    assert(f.service.inspect(f.c.id).budget.stopReasons.includes('retrieval-time-budget'));
  } finally {
    f.store.close();
  }
});

test('investigation propagates its selected deadline and times out without claiming absent evidence', async () => {
  const f = setup();
  try {
    const harness: any = {
      store: f.store,
      hybrid: async (_s: any, _q: any, _l: any, signal: AbortSignal) =>
        new Promise((resolve, reject) => {
          const watchdog = setTimeout(() => resolve([]), 2000);
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(watchdog);
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    };
    const result = await Knowledge.prototype.investigate.call(
      harness,
      ['general'],
      ['slow'],
      6,
      undefined,
      Date.now(),
      [],
      1000,
    );
    assert.equal(result.budget.maxDurationMs, 1000);
    assert.equal(result.budget.stopReason, 'time-budget');
    assert.equal(result.results.length, 0);
    assert.equal(result.coverage.exhaustive, false);
  } finally {
    f.store.close();
  }
});

test('unfinished research warns at delivery without forcing further searching', () => {
  const f = setup();
  try {
    const report = deliveryEvidence(f.store, f.run);
    assert.equal(report.verdict, 'yellow');
    assert(report.entries.some((e) => e.kind === 'research' && !e.blocking));
  } finally {
    f.store.close();
  }
});

test('infer and compare words do not silently multiply retrieval calls', async () => {
  const f = setup();
  try {
    const defs = new Map<string, any>();
    installKnowledgeTools({ add: (d: any) => defs.set(d.name, d) } as any);
    let queries: string[] = [];
    const ctx: any = {
      store: f.store,
      run: f.run,
      scopes: ['general'],
      signal: new AbortController().signal,
      knowledge: {
        hybrid: async (_s: any, q: string) => {
          queries.push(q);
          return [{ id: 'c0' }];
        },
        investigate: async (_s: any, q: string[]) => {
          queries.push(...q);
          return { results: [] };
        },
      },
    };
    const d = defs.get('search_knowledge');
    await d.run(d.schema.parse({ query: 'infer compare contradictory explanations' }), ctx);
    assert.equal(queries.length, 1);
    queries = [];
    await d.run(d.schema.parse({ query: 'infer compare', strategy: 'research' }), ctx);
    assert.deepEqual(queries, ['infer compare']);
  } finally {
    f.store.close();
  }
});
