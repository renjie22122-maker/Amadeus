import { learnMemoryGraph } from '../server/services/memory-graph-learning.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/storage/store.js';
import { MemoryLifecycle } from '../server/services/memory-lifecycle.js';
import { manageAutomaticMemory } from '../server/services/memory-automatic.js';
import { KnowledgeGraph } from '../server/services/knowledge-graph.js';

test('legacy source nodes are readable, searchable, paginated and lifecycle-filtered without migration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'graph-discovery-'));
  const store = new Store(join(dir, 'db.sqlite'));
  try {
    const life = new MemoryLifecycle(store),
      graph = new KnowledgeGraph(store);
    const make = (id: string, content: string, extra = {}) => {
      const m = life.create({
        id,
        content,
        scope: 'user',
        source: 'User',
        active: true,
        revision: 1,
        createdAt: 1,
        expiresAt: null,
        ...extra,
      });
      manageAutomaticMemory(store, m);
      return m;
    };
    make('a', '用户偏好中英双语技术文档');
    make('b', 'Amadeus project uses SQLite');
    make('private', '私密场景唯一线索', { kind: 'episode', sourceConversationId: 'other' });
    const catalog = graph.catalog(['user'], { limit: 1, conversationId: 'current' });
    assert.equal(catalog.total, 2);
    assert.equal(catalog.nextOffset, 1);
    assert.equal(catalog.statistics.provenanceRelations, 2);
    assert.equal(catalog.statistics.semanticEntities, 0);
    assert.ok(
      ['用户偏好中英双语技术文档', 'Amadeus project uses SQLite'].includes(
        catalog.entities[0].displayName,
      ),
    );
    assert.equal(graph.catalog(['user'], { offset: 1 }).entities.length, 1);
    const found = graph.search(['user'], '双语 文档');
    assert.ok(found.paths.length);
    assert.ok(found.entities.some((e) => e.displayName.includes('双语')));
    assert.equal(
      graph.search(['user'], '私密场景唯一线索', Date.now(), 2, 'current').paths.length,
      0,
    );
    assert.equal(graph.search(['project:other'], 'Amadeus').entities.length, 0);
    const empty = graph.search(['user'], 'unrelated-token');
    assert.equal(empty.diagnostics.status, 'no-matching-nodes');
    assert.equal(empty.diagnostics.usableEdges, 2);
    life.update('a', { active: false }, 1);
    assert.equal(graph.catalog(['user']).total, 1);
    assert.equal(graph.search(['user'], '双语 文档').paths.length, 0);
    assert.ok(store.list<any>('memory-entity').some((e) => e.name === 'memory:a'));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('partial bilingual labels and source evidence discover semantic relations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'graph-label-')),
    store = new Store(join(dir, 'db.sqlite'));
  try {
    const life = new MemoryLifecycle(store),
      graph = new KnowledgeGraph(store);
    const m = life.create({
      id: 'fact',
      scope: 'user',
      source: 'User',
      content: 'Atlas project depends on SQLite database',
      active: true,
      revision: 1,
      createdAt: 1,
      expiresAt: null,
    });
    const a = life.saveEntity('user', 'Atlas project', []),
      b = life.saveEntity('user', 'SQLite database', []);
    graph.put({
      scope: 'user',
      from: a.id,
      to: b.id,
      relation: 'depends on',
      active: true,
      validFrom: Date.now(),
      validUntil: null,
      evidence: [{ type: 'memory', id: m.id, quote: m.content }],
    });
    assert.ok(graph.search(['user'], 'Atlas').paths.length);
    assert.ok(graph.search(['user'], 'depends').paths.length);
    assert.equal(graph.catalog(['user']).statistics.usableRelations, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('same topic is additive; exclusive attributes still conflict within matching conditions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-cardinality-')),
    store = new Store(join(dir, 'db.sqlite'));
  try {
    const life = new MemoryLifecycle(store);
    const add = (id: string, extra: any = {}) =>
      life.create({
        id,
        scope: 'user',
        source: 'User',
        content: id,
        active: true,
        revision: 1,
        createdAt: 1,
        expiresAt: null,
        topic: 'shared topic',
        ...extra,
      });
    add('first');
    assert.equal(add('second').active, true);
    add('single-a', {
      entityId: 'user',
      attribute: 'runtime',
      factCardinality: 'single',
      value: 'A',
      conditions: 'project X',
    });
    assert.equal(
      add('single-b', {
        entityId: 'user',
        attribute: 'runtime',
        factCardinality: 'single',
        value: 'B',
        conditions: 'project X',
      }).status,
      'disputed',
    );
    assert.equal(
      add('other-condition', {
        entityId: 'user',
        attribute: 'runtime',
        factCardinality: 'single',
        value: 'B',
        conditions: 'project Y',
      }).active,
      true,
    );
    add('member-a', {
      entityId: 'user',
      attribute: 'membership',
      value: 'A',
      factCardinality: 'multiple',
    });
    assert.equal(
      add('member-b', {
        entityId: 'user',
        attribute: 'membership',
        value: 'B',
        factCardinality: 'multiple',
      }).active,
      true,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('automatic graph learning checks human quotations, deduplicates calls and retires derived nodes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'graph-learning-')),
    store = new Store(join(dir, 'db.sqlite'));
  try {
    const life = new MemoryLifecycle(store),
      graph = new KnowledgeGraph(store);
    const c: any = { id: 'chat', projectId: null },
      profile: any = { id: 'p', baseUrl: 'https://model.example', model: 'test' };
    store.put('conversation', c);
    const event = store.event('chat', null, 'user.message', { content: 'Atlas depends on SQLite' });
    const m = life.create({
      id: 'm',
      scope: 'user',
      source: 'User',
      sourceConversationId: 'chat',
      sourceEventId: event.id,
      content: 'Atlas depends on SQLite',
      automatic: true,
      active: true,
      revision: 1,
      createdAt: 1,
      expiresAt: null,
    });
    let calls = 0;
    const provider: any = {
      complete: async () => {
        calls++;
        return {
          message: {
            role: 'assistant',
            content: JSON.stringify({
              relations: [
                {
                  memoryId: m.id,
                  from: 'Atlas',
                  to: 'SQLite',
                  relation: 'depends on',
                  quote: m.content,
                },
                {
                  memoryId: m.id,
                  from: 'Atlas',
                  to: 'Unknown',
                  relation: 'owns',
                  quote: 'Atlas owns Unknown',
                },
              ],
            }),
          },
        };
      },
    };
    await learnMemoryGraph(store, c, profile, provider, new AbortController().signal, () => true);
    assert.equal(graph.catalog(['user']).statistics.usableRelations, 1);
    await learnMemoryGraph(store, c, profile, provider, new AbortController().signal, () => true);
    assert.equal(calls, 1);
    life.update(m.id, { active: false }, m.revision);
    assert.equal(graph.catalog(['user']).statistics.semanticEntities, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('graph verifies duplicate quotes once per search, rechecks changes, and uses document index', () => {
  const store = new Store(':memory:');
  try {
    store.put('document', { id: 'doc', scope: 'general', createdAt: 1 });
    store.db
      .prepare(
        'INSERT INTO chunks(id,scope,document_id,name,ordinal,text,source_hash) VALUES(?,?,?,?,?,?,?)',
      )
      .run('chunk', 'general', 'doc', 'source', 0, 'original evidence', 'fixture');
    for (const id of ['a', 'b', 'c'])
      store.put('memory-entity', { id, scope: 'general', name: id, aliases: [], automatic: true });
    for (const [id, to] of [
      ['one', 'b'],
      ['two', 'c'],
    ])
      store.put('knowledge-edge', {
        id,
        scope: 'general',
        from: 'a',
        to,
        relation: 'related',
        evidence: [{ type: 'document', id: 'doc', quote: 'original evidence' }],
        active: true,
        validFrom: 1,
        validUntil: null,
      });
    const graph = new KnowledgeGraph(store);
    const original = graph.supported.bind(graph);
    let checked = 0;
    graph.supported = (...args) => {
      checked++;
      return original(...args);
    };
    assert.equal(graph.search(['general'], 'original').diagnostics.usableEdges, 2);
    assert.equal(checked, 1);
    assert.match(
      JSON.stringify(
        store.db
          .prepare(
            'EXPLAIN QUERY PLAN SELECT 1 FROM chunks WHERE document_id=? AND instr(text,?)>0 LIMIT 1',
          )
          .all('doc', 'original'),
      ),
      /chunks_document_ordinal/,
    );
    store.db.prepare('UPDATE chunks SET text=? WHERE id=?').run('replacement', 'chunk');
    assert.equal(graph.search(['general'], 'original').diagnostics.usableEdges, 0);
    assert.equal(checked, 2);
    assert.equal(graph.search(['other'], 'original').paths.length, 0);
  } finally {
    store.close();
  }
});
