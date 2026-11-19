import { scopedVectorView } from '../server/services/scoped-vector-view.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { Store } from '../server/storage/store.js';
import { Knowledge } from '../server/services/knowledge.js';
import { installKnowledgeTools } from '../server/tools/knowledge-tools.js';
import { revisionState } from '../server/http/state-response.js';
import { allocatePreviews } from '../server/core/attachment-preview.js';
import { ChatNotebookMaintenance } from '../server/services/chat-notebook-maintenance.js';
import { indexAdvice } from '../server/services/retrieval-status.js';

test('two empty tool queries in flight return their own persisted diagnostics and trace IDs', async (t) => {
  const store = new Store(':memory:');
  let enter!: () => void, resume!: () => void;
  const started = new Promise<void>((r) => (enter = r)),
    gate = new Promise<void>((r) => (resume = r));
  const kb = new Knowledge(store, {
    enabled: () => true,
    fingerprint: () => 'fixture',
    encode: async () => {
      enter();
      await gate;
      throw Error('fixture');
    },
  } as any);
  t.after(() => {
    kb.close();
    store.close();
  });
  const tools = new Map<string, any>();
  installKnowledgeTools({ add: (tool: any) => tools.set(tool.name, tool) } as any);
  const run = async (scope: string, mode: string) =>
    JSON.parse(
      (
        await tools
          .get('search_knowledge')
          .run(
            { query: 'missing', strategy: 'lookup', limit: 1, mode, documentIds: [] },
            { scopes: [scope], store, knowledge: kb },
          )
      ).content,
    );
  const pending = run('project:a', 'hybrid');
  await started;
  let b;
  try {
    b = await run('project:b', 'lexical');
  } finally {
    resume();
  }
  const a = await pending;
  assert.equal(a.retrievalDiagnostics.semanticStatus, 'query_embedding_failed');
  assert.equal(b.retrievalDiagnostics.semanticStatus, 'disabled_by_request');
  assert.notEqual(a.retrievalTraceId, b.retrievalTraceId);
  for (const [result, scope] of [
    [a, 'project:a'],
    [b, 'project:b'],
  ]) {
    const trace = store.get<any>('retrieval-trace', result.retrievalTraceId);
    assert.deepEqual(trace.scopes, [scope]);
    assert.deepEqual(trace.diagnostics, result.retrievalDiagnostics);
    assert.deepEqual(result.results, []);
  }
  assert.equal(indexAdvice(2001, [2]).builtinSelection, 'streamed-exact');
});

test('inbox delivery and scheduler reconciliation retain scope, order, and paused dispatched work', (t) => {
  const s = new Store(':memory:');
  t.after(() => s.close());
  s.transaction(() => {
    for (let n = 0; n < 1000; n++)
      s.put('user-inbox', { id: 'old' + n, conversationId: 'c', runId: 'r', state: 'delivered' });
  });
  for (const id of ['21', '3', '10'])
    s.put('user-inbox', { id, conversationId: 'c', runId: 'r', state: 'pending' });
  s.put('user-inbox', { id: '2', conversationId: 'other', runId: 'other', state: 'pending' });
  s.put('runtime-inbox', { id: 'feedback', runId: 'r', state: 'pending' });
  assert.deepEqual(
    s.pendingUserInbox('c').map((x) => x.id),
    ['3', '10', '21'],
  );
  assert.deepEqual(
    s.pendingRuntimeInbox('r').map((x) => x.id),
    ['feedback'],
  );
  assert(!s.hasPendingInbox('runtime-inbox', 'other'));
  assert(s.hasPendingInbox('user-inbox', 'r'));
  for (const [id, enabled, runId] of [
    ['paused', false, 'running'],
    ['done', false, null],
    ['new', true, null],
  ])
    s.put('scheduled-work', { id: String(id), enabled, runId });
  assert.deepEqual(
    s.unsettledSchedules<any>().map((x) => x.id),
    ['new', 'paused'],
  );
  const plan = s.db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT data FROM records WHERE kind='user-inbox' AND json_extract(data,'$.state')='pending' AND json_extract(data,'$.conversationId')=? ORDER BY CAST(id AS INTEGER),id",
    )
    .all('c');
  assert.match(JSON.stringify(plan), /inbox_pending_user_conversation/);
});

test('unchanged state returns 304 without reading it; changes, rollback, restart and views stay distinct', async (t) => {
  const s = new Store(':memory:'),
    app = Fastify();
  t.after(async () => {
    await app.close();
    s.close();
  });
  let reads = 0,
    config = 0,
    epoch = 'one';
  app.get('/shell', (req, reply) =>
    revisionState(req, reply, s.stateRevisions(epoch, config).shell, () => ({ reads: ++reads })),
  );
  const first = await app.inject('/shell');
  const tag = first.headers.etag!;
  const cached = () => app.inject({ url: '/shell', headers: { 'if-none-match': tag } });
  const old = s.stateRevisions(epoch, config);
  s.put('retrieval-trace', { id: 'trace' });
  assert.deepEqual(s.stateRevisions(epoch, config), old);
  s.put('memory', { id: 'm' });
  assert.notEqual(s.stateRevisions(epoch, config).full, old.full);
  assert.equal((await cached()).statusCode, 304);
  assert.equal(reads, 1);
  assert.throws(() =>
    s.transaction(() => {
      s.put('project', { id: 'p' });
      throw Error('rollback');
    }),
  );
  assert.equal((await cached()).statusCode, 304);
  s.put('project', { id: 'p' });
  assert.equal((await cached()).statusCode, 200);
  assert.equal(reads, 2);
  const next = s.stateRevisions(epoch, config);
  config++;
  assert.notEqual(s.stateRevisions(epoch, config).shell, next.shell);
  epoch = 'two';
  assert.notEqual(s.stateRevisions(epoch, 0).shell, next.shell);
});

test('preview budget shares space, preserves small inputs, and leaves a readable remainder', () => {
  assert.deepEqual(allocatePreviews([30000]), [15000]);
  assert.deepEqual(allocatePreviews([30000, 4, 30000]), [7498, 4, 7498]);
  assert.deepEqual(allocatePreviews([0, 1, 5, 10], 5), [0, 1, 2, 2]);
});

test('notebook sweep errors are visible without leaking message text; next healthy sweep clears streak', async (t) => {
  const s = new Store(':memory:');
  const worker = new ChatNotebookMaintenance(s, {} as any);
  t.after(async () => {
    await worker.close();
    s.close();
  });
  // A malformed legacy row fails outer discovery before any per-conversation job can record an error.
  s.db.prepare("INSERT INTO records VALUES('chat-connection','bad','not-json')").run();
  await worker.tick(10);
  assert.equal(worker.sweepHealth().consecutiveFailures, 1);
  assert.equal(worker.sweepHealth().lastFailureAt, 10);
  assert(!JSON.stringify(worker.sweepHealth()).includes('not-json'));
  s.remove('chat-connection', 'bad');
  await worker.tick(20);
  assert.equal(worker.sweepHealth().lastSuccessAt, 20);
  assert.equal(worker.sweepHealth().consecutiveFailures, 0);
});

test('scoped view detects changes in inputs while leaving unrelated writes and rollback invisible', (t) => {
  const s = new Store(':memory:');
  const kb = new Knowledge(s);
  t.after(() => {
    kb.close();
    s.close();
  });
  const doc = kb.import('general', 'A', 'public text'),
    other = kb.import('project:B', 'B', 'other');
  assert(doc && typeof doc === 'object' && 'id' in doc && typeof doc.id === 'string');
  assert(other && typeof other === 'object' && 'id' in other && typeof other.id === 'string');
  const docId = doc.id;
  const update = s.db.prepare('UPDATE chunks SET vector=? WHERE document_id=?');
  update.run('[1,0]', docId);
  const v = scopedVectorView(s, ['general'], [docId, other.id], Date.now());
  assert.deepEqual(v.eligible, [docId]);
  update.run('[0,1]', other.id);
  assert(!v.changed());
  assert.throws(() =>
    s.transaction(() => {
      update.run('[0,1]', docId);
      throw Error('rollback');
    }),
  );
  assert(!v.changed());
  s.db.prepare('UPDATE chunks SET text=? WHERE document_id=?').run('revised', docId);
  assert(v.changed());
  const next = scopedVectorView(s, ['general'], [], Date.now());
  const withdrawn = { ...doc, id: docId, validUntil: 1 };
  s.put('document', withdrawn);
  assert(next.changed());
});

test('reused member answers belong to the requested run; only active descendants consume capacity', async (t) => {
  const { DelegationManager } = await import('../server/core/delegation-manager.js'),
    { EventEmitter } = await import('node:events');
  const s = new Store(':memory:');
  t.after(() => s.close());
  for (const [id, parent, chat, status] of [
    ['root', null, 'main', 'running'],
    ['first', 'root', 'member', 'completed'],
    ['second', 'root', 'member', 'completed'],
    ['grandchild', 'first', 'member-sub', 'waiting_approval'],
    ['outsider', null, 'unrelated', 'running'],
  ])
    s.put('run', {
      id: id!,
      parentRunId: parent,
      conversationId: chat,
      status,
      createdAt: Date.now(),
    });
  assert.deepEqual(
    s.descendantStatusCounts('root').map((r) => [r.status, r.n]),
    [
      ['completed', 2],
      ['waiting_approval', 1],
    ],
  );
  s.event('member', 'first', 'assistant.message', { text: 'one', final: true });
  s.event('member', 'second', 'assistant.message', { text: 'two', final: true });
  s.event('member', 'first', 'assistant.message', { text: 'draft', final: false });
  s.event('member', 'first', 'assistant.message', {
    text: 'partial',
    final: true,
    incomplete: true,
  });
  const dm = new DelegationManager(s, {} as any, '', new EventEmitter(), { pump() {} } as any);
  const result = await dm.wait(
    s.runHeader('root'),
    ['first', 'second'],
    new AbortController().signal,
  );
  assert.deepEqual(
    result.map((r) => r.answer),
    ['one', 'two'],
  );
  await assert.rejects(
    dm.wait(s.runHeader('root'), ['outsider'], new AbortController().signal),
    /unrelated task/,
  );
});
