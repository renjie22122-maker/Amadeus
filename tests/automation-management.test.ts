import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/storage/store.js';
import { ScheduledWorkService } from '../server/services/scheduled-work.js';
import { inheritedMemory } from '../server/services/memory-policy.js';
import { Knowledge } from '../server/services/knowledge.js';
import { KnowledgeMaintenance } from '../server/services/knowledge-maintenance.js';
import { evaluateRetrieval } from '../server/services/retrieval-evaluation.js';
function fixture(t: any) {
  const d = mkdtempSync(join(tmpdir(), 'automation-regression-'));
  const store = new Store(join(d, 'db.sqlite'));
  t.after(() => {
    store.close();
    rmSync(d, { recursive: true, force: true });
  });
  return { store, d };
}
test('scope defaults do not leak between general chats, projects or model destinations', (t) => {
  const { store } = fixture(t),
    profile = { id: 'model', baseUrl: 'https://example.test' };
  const config: any = { get: () => ({ profiles: [profile] }) };
  store.put('memory-policy', {
    id: 'user',
    enabled: true,
    targets: ['model|https://example.test'],
  });
  assert.equal(
    inheritedMemory(store, config, { projectId: null, profileId: 'model' }).memory,
    true,
  );
  assert.equal(
    inheritedMemory(store, config, { projectId: 'p', profileId: 'model' }).memory,
    false,
  );
  store.put('memory-policy', {
    id: 'project:p',
    enabled: true,
    targets: ['model|https://example.test'],
  });
  assert.equal(
    inheritedMemory(store, config, { projectId: 'other', profileId: 'model' }).memory,
    false,
  );
  profile.baseUrl = 'https://new.test';
  assert.equal(
    inheritedMemory(store, config, { projectId: 'p', profileId: 'model' }).memory,
    false,
  );
});
test('durable schedules dispatch once, await completion and refuse interrupted replay', (t) => {
  const { store } = fixture(t);
  store.put('conversation', { id: 'c', projectId: null, profileId: 'm' });
  let calls = 0;
  const runtime: any = {
    config: { profile: () => ({ id: 'm', baseUrl: 'local' }) },
    active: () => false,
    start: (c: string, _p: string, _n: number, o: any) => {
      calls++;
      store.put('run', { id: o.runId, conversationId: c, status: 'running' });
    },
  };
  store.put('scheduled-work', {
    id: 's',
    conversationId: 'c',
    prompt: 'check',
    enabled: true,
    dueAt: 0,
    status: 'waiting',
  });
  const scheduler = new ScheduledWorkService(store, runtime);
  scheduler.tick(1);
  scheduler.tick(2);
  new ScheduledWorkService(store, runtime).tick(3);
  assert.equal(calls, 1);
  const runId = store.get<any>('scheduled-work', 's').runId;
  store.put('run', { id: runId, status: 'interrupted' });
  scheduler.tick(4);
  scheduler.tick(5);
  assert.equal(calls, 1);
  assert.equal(store.get<any>('scheduled-work', 's').status, 'needs_attention');
});
test('scheduled command completion is scoped and does not run before the trigger', (t) => {
  const { store } = fixture(t);
  store.put('conversation', { id: 'c', projectId: null, profileId: 'm' });
  let calls = 0;
  const runtime: any = {
    config: { profile: () => ({ id: 'm', baseUrl: 'local' }) },
    active: () => false,
    start: () => {
      calls++;
    },
  };
  store.put('command-job', { id: 'j', conversationId: 'other', status: 'completed' });
  store.put('scheduled-work', {
    id: 's',
    conversationId: 'c',
    prompt: 'check',
    enabled: true,
    dueAt: 0,
    jobId: 'j',
  });
  const scheduler = new ScheduledWorkService(store, runtime);
  scheduler.tick(1);
  assert.equal(calls, 0);
  store.put('command-job', { id: 'j', conversationId: 'c', status: 'running' });
  store.put('scheduled-work', {
    id: 's',
    conversationId: 'c',
    prompt: 'check',
    enabled: true,
    dueAt: 0,
    jobId: 'j',
  });
  scheduler.tick(2);
  assert.equal(calls, 0);
  store.put('command-job', { id: 'j', conversationId: 'c', status: 'completed' });
  scheduler.tick(3);
  assert.equal(calls, 1);
});
test('transient indexing failures back off and recover after three failures', async (t) => {
  const { store, d } = fixture(t);
  let count = 0;
  const embedding: any = {
    enabled: () => true,
    fingerprint: () => 'fixture',
    encode: async (text: string[]) => {
      if (++count <= 4) throw Error('fetch failed');
      return text.map(() => [1, 0]);
    },
  };
  const knowledge = new Knowledge(store, embedding),
    manager = new KnowledgeMaintenance(store, knowledge, embedding, d);
  t.after(async () => {
    await manager.close();
    knowledge.close();
  });
  store.put('conversation', { id: 'c' });
  knowledge.import('session:c', 'doc', 'retention policy seven days');
  store.put('knowledge-watch', {
    id: 'session:c',
    enabled: true,
    paths: [],
    target: 'fixture',
    revision: 1,
  });
  await manager.tick();
  await manager.tick();
  assert.equal(count, 1);
  for (let i = 0; i < 4; i++) {
    store.put('knowledge-watch', {
      ...store.get<any>('knowledge-watch', 'session:c'),
      nextRetryAt: 0,
    });
    await manager.tick();
  }
  assert.equal(count, 5);
  assert.equal(store.get<any>('knowledge-watch', 'session:c').status, 'synced');
});
test('retrieval selection requires user labels and held-out improvement', async (t) => {
  const { store } = fixture(t);
  const realKnowledge = new Knowledge(store);
  t.after(() => realKnowledge.close());
  store.put('document', { id: 'doc', scope: 'project:p' });
  for (let i = 0; i < 15; i++)
    store.put('retrieval-case', {
      id: String(i).padStart(2, '0'),
      scope: 'project:p',
      source: 'user',
      documentId: 'doc',
      query: 'q' + i,
    });
  store.put('retrieval-case', {
    id: 'fake',
    scope: 'project:p',
    source: 'agent',
    documentId: 'doc',
    query: 'fake',
  });
  const knowledge: any = { search: () => [], hybrid: async () => [{ documentId: 'doc' }] };
  const result = await evaluateRetrieval(store, knowledge, 'project:p');
  assert.equal(result.cases, 15);
  assert.equal(result.promoted, true);
  assert.equal(result.heldOut, 5);
  assert.equal(store.get<any>('retrieval-policy', 'project:p').mode, 'hybrid');
  assert.equal((await evaluateRetrieval(store, knowledge, 'project:other')).promoted, false);
});

test('graph extraction rejects invented quotes and never reuses entities from another scope', async (t) => {
  const { GraphLearning } = await import('../server/services/graph-learning.js');
  const { KnowledgeGraph } = await import('../server/services/knowledge-graph.js');
  const { store } = fixture(t);
  const knowledge = new Knowledge(store);
  t.after(() => knowledge.close());
  const doc = knowledge.import('project:p', 'source', 'Alpha owns Beta. Twin owns Other.');
  for (const id of ['twin1', 'twin2'])
    store.put('memory-entity', {
      id,
      scope: 'project:p',
      name: 'Twin',
      aliases: [],
      confirmed: true,
    });
  store.put('memory-entity', {
    id: 'foreign',
    scope: 'project:other',
    name: 'Alpha',
    aliases: [],
    confirmed: true,
  });
  const config: any = { profile: () => ({ id: 'm', baseUrl: 'https://fixture.test' }) };
  const learning = new GraphLearning(
    store,
    config,
    () =>
      ({
        complete: async () => ({
          message: {
            role: 'assistant',
            content: JSON.stringify({
              relations: [
                { from: 'Alpha', to: 'Beta', relation: 'owns', quote: 'Alpha owns Beta.' },
                { from: 'Alpha', to: 'Gamma', relation: 'owns', quote: 'Alpha owns Gamma.' },
                { from: 'Twin', to: 'Other', relation: 'owns', quote: 'Twin owns Other.' },
              ],
            }),
          },
          usage: { input: 1, output: 1, cached: 0, measured: true },
        }),
      }) as any,
  );
  await learning.document(doc, 'm', 'm|https://fixture.test', () => true);
  const edges = new KnowledgeGraph(store).list('project:p');
  assert.equal(edges.length, 1);
  assert.equal(store.list<any>('graph-learning')[0].deferred.length, 1);
  assert.notEqual(edges[0].from, 'foreign');
  assert.equal(store.list<any>('memory-entity').filter((e) => e.name === 'Gamma').length, 0);
});
test('ambiguous disputed memory is not activated merely because no structured conflict was found', async (t) => {
  const { reconsiderMemoryConflicts } = await import('../server/services/memory-automatic.js');
  const { store } = fixture(t);
  store.put('conversation', { id: 'c', projectId: null });
  const event = store.event('c', null, 'user.message', { content: 'An ambiguous preference' });
  store.put('memory', {
    id: 'm',
    scope: 'user',
    automatic: true,
    status: 'disputed',
    active: false,
    conflictsWith: [],
    sourceConversationId: 'c',
    sourceEventId: event.id,
    content: 'An ambiguous preference',
    revision: 1,
  });
  reconsiderMemoryConflicts(store, 'user');
  assert.equal(store.get<any>('memory', 'm').active, false);
});

test('failure diagnosis never retries permission, credentials or uncertain effects as network errors', async () => {
  const { diagnoseFailure } = await import('../server/services/failure-diagnosis.js');
  for (const message of [
    'HTTP 401',
    'HTTP 403',
    'Project is unavailable.',
    'SANDBOX_PREFLIGHT_FAILED: network denial not confirmed',
    'unknown effect after timeout',
  ]) {
    assert.equal(diagnoseFailure(message).automatic, false, message);
  }
  assert.equal(diagnoseFailure('Embedding endpoint returned HTTP 503').automatic, true);
  assert.equal(diagnoseFailure('ModuleNotFoundError: numpy').kind, 'dependency');
});
test('corrected credentials resume authorized indexing but changed destination never does', async (t) => {
  const { store, d } = fixture(t);
  let calls = 0,
    key = 'bad',
    target = 'original';
  const embedding: any = {
    enabled: () => true,
    fingerprint: () => target,
    recoveryRevision: () => key,
    encode: async (text: string[]) => {
      calls++;
      if (key === 'bad') throw Error('HTTP 401');
      return text.map(() => [1, 0]);
    },
  };
  const knowledge = new Knowledge(store, embedding),
    manager = new KnowledgeMaintenance(store, knowledge, embedding, d);
  t.after(async () => {
    await manager.close();
    knowledge.close();
  });
  store.put('conversation', { id: 'c' });
  knowledge.import('session:c', 'doc', 'source text');
  store.put('knowledge-watch', { id: 'session:c', enabled: true, paths: [], target, revision: 1 });
  for (let i = 0; i < 4; i++) await manager.tick();
  assert.equal(calls, 3);
  key = 'fixed';
  await manager.tick();
  assert.equal(calls, 4);
  assert.equal(store.get<any>('knowledge-watch', 'session:c').status, 'synced');
  target = 'new endpoint';
  key = 'other';
  await manager.tick();
  assert.equal(calls, 4);
  assert.throws(() => manager.recheck('session:c'), /destination/);
});
test('repair requests are idempotent and instruct inspection before replay', async () => {
  const { createApp } = await import('../server/http/app.js');
  const d = mkdtempSync(join(tmpdir(), 'repair-api-'));
  const { app, store, runtime } = await createApp({ directory: d });
  try {
    store.put('conversation', { id: 'c', archived: false, projectId: null });
    store.put('skill-environment', {
      id: 'e',
      conversationId: 'c',
      skillId: 's',
      status: 'needs_attention',
      updatedAt: 123,
      manager: 'pip',
      packages: ['numpy'],
      path: '.skill-env/x',
    });
    let calls = 0;
    runtime.start = ((c: string, prompt: string, _n: number, options: any) => {
      calls++;
      assert.match(prompt, /Do not blindly replay/);
      return store.put('run', { id: options.runId, conversationId: c, status: 'completed' });
    }) as any;
    const b = await app.inject({ url: '/api/bootstrap', headers: { host: 'localhost' } });
    const headers = {
      host: 'localhost',
      cookie: String(b.headers['set-cookie']).split(';')[0],
      'x-csrf-token': b.json().csrf,
    };
    const first = await app.inject({
      method: 'POST',
      url: '/api/background/repair-skill',
      headers,
      payload: { id: 'e' },
    });
    assert.equal(first.statusCode, 200, first.body);
    const second = await app.inject({
      method: 'POST',
      url: '/api/background/repair-skill',
      headers,
      payload: { id: 'e' },
    });
    assert.equal(second.statusCode, 200);
    assert.equal(calls, 1);
    assert.equal(first.json().runId, second.json().runId);
  } finally {
    await app.close();
    rmSync(d, { recursive: true, force: true });
  }
});
