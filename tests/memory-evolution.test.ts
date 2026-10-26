import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/storage/store.js';
import { MemoryLifecycle, memoryValid, sourceKey } from '../server/services/memory-lifecycle.js';
import { KnowledgeGraph } from '../server/services/knowledge-graph.js';
import { Knowledge } from '../server/services/knowledge.js';
import { recallMemories } from '../server/services/memory-retrieval.js';
import type { Memory } from '../shared/types.js';
const fixture = async () =>
  new Store(join(await mkdtemp(join(tmpdir(), 'memory-evolution-')), 'db.sqlite'));
function memory(id: string, extra: Partial<Memory> = {}): Memory {
  return {
    id,
    scope: 'project:a',
    content: 'Python version 3.11',
    source: 'User',
    active: true,
    revision: 1,
    createdAt: 1,
    validFrom: 100,
    expiresAt: null,
    entityId: 'project:a',
    attribute: 'python_version',
    factCardinality: 'single',
    value: '3.11',
    ...extra,
  };
}
test('temporal conflict resolution preserves historical truth and scope', async () => {
  const s = await fixture(),
    life = new MemoryLifecycle(s);
  try {
    const old = life.create(memory('old'));
    const next = life.create(
      memory('new', { content: 'Python version 3.12', value: '3.12', validFrom: 200 }),
    );
    assert.equal(old.status, 'active');
    assert.equal(next.status, 'disputed');
    assert.equal(next.active, false);
    assert.throws(() => life.update('new', { active: true }), /Resolve conflicting/);
    life.resolve('new', ['old'], next.revision, 300);
    assert.equal(memoryValid(s.get('memory', 'old'), 200), true);
    assert.equal(memoryValid(s.get('memory', 'old'), 300), false);
    assert.equal(memoryValid(s.get('memory', 'new'), 300), true);
    assert.deepEqual(
      recallMemories(s.list('memory'), 'Python', 'a', 200).map((m) => m.id),
      ['old'],
    );
    assert.deepEqual(
      recallMemories(s.list('memory'), 'Python', 'a', 400).map((m) => m.id),
      ['new'],
    );
    assert.deepEqual(recallMemories(s.list('memory'), 'Python', 'b', 400), []);
    assert.throws(() => life.resolve('new', ['old'], 1, 400), /changed/);
  } finally {
    s.close();
  }
});
test('source-level forgetting blocks paraphrased regeneration and removes undo copies', async () => {
  const s = await fixture(),
    life = new MemoryLifecycle(s);
  try {
    life.create(memory('m', { sourceConversationId: 'chat', sourceEventId: 7 }));
    life.forget('m');
    assert.ok(s.maybe('memory-source-forgotten', sourceKey('project:a', 'chat', 7)));
    assert.equal(s.list('memory-history').length, 0);
    assert.throws(
      () =>
        life.create(
          memory('paraphrase', {
            content: 'Use the 3.11 Python runtime',
            sourceConversationId: 'chat',
            sourceEventId: 7,
          }),
        ),
      /excluded/,
    );
  } finally {
    s.close();
  }
});
test('revision undo and evidence-gated experience reject unverified claims', async () => {
  const s = await fixture(),
    life = new MemoryLifecycle(s);
  try {
    life.create(memory('m'));
    const edited = life.update('m', { content: 'Python runtime 3.11' }, 1);
    const h = s.list<any>('memory-history').find((h) => h.after.revision === edited.revision)!;
    life.undo('m', h.id);
    assert.equal(s.get<any>('memory', 'm').content, 'Python version 3.11');
    assert.throws(() => life.update('m', { content: 'stale' }, edited.revision), /changed/);
    const experience = life.create(
      memory('exp', {
        attribute: 'fix',
        kind: 'experience',
        conditions: 'Windows',
        content: 'Fix works',
      }),
    );
    assert.equal(experience.active, false);
    assert.throws(() => life.update('exp', { active: true }), /evidence/);
    s.put('conversation', { id: 'chat', projectId: 'a' });
    const e = s.event('chat', null, 'tool.completed', {
      verification: { passed: true },
      output: 'verified',
    });
    assert.equal(
      life.update('exp', {
        active: true,
        evidence: [{ conversationId: 'chat', eventId: e.id, quote: 'verified' }],
      }).active,
      true,
    );
  } finally {
    s.close();
  }
});
test('document versions filter BEFORE retrieval, expose citations and historical chunks', async () => {
  const s = await fixture(),
    k = new Knowledge(s);
  try {
    const a = k.import(
      'project:a',
      'Spec',
      '# Runtime\n\nPython 3.11 is required.\n\n| Name | Value |\n| Cache | local |',
      { validFrom: 100, source: 'spec' },
    );
    const b: any = k.import('project:a', 'Spec', '# Runtime\n\nPython 3.12 is required.', {
      revisionOf: (a as any).id,
      validFrom: 200,
      source: 'spec',
    });
    assert.deepEqual(
      k.search(['project:a'], 'Python', 6, 150).map((x) => x.documentId),
      [(a as any).id],
    );
    const current = await k.hybrid(['project:a'], 'Python', 6, undefined, 300);
    assert.equal(current[0].documentId, b.id);
    assert.equal(current[0].version, 2);
    assert.ok(current[0].citation.chunkId);
    assert.ok(current[0].heading.includes('Runtime'));
    assert.deepEqual(k.search(['project:b'], 'Python', 6, 300), []);
    assert.throws(
      () => k.import('project:b', 'Spec', 'wrong', { revisionOf: b.id }),
      /another scope/,
    );
    assert.throws(
      () => k.import('project:a', 'Spec', 'stale', { revisionOf: (a as any).id, validFrom: 400 }),
      /latest version/,
    );
  } finally {
    k.close();
    s.close();
  }
});
test('graph resolves aliases, follows sourced multi-hop paths and drops deleted evidence', async () => {
  const s = await fixture(),
    life = new MemoryLifecycle(s),
    g = new KnowledgeGraph(s);
  try {
    const a = life.saveEntity('project:a', 'App', ['frontend']),
      b = life.saveEntity('project:a', 'API', []),
      c = life.saveEntity('project:a', 'Database', []);
    assert.throws(() => life.saveEntity('project:a', 'Other', ['frontend']), /already uses/);
    const now = Date.now(),
      m = life.create(
        memory('facts', {
          entityId: undefined,
          attribute: undefined,
          content: 'App uses API. API uses Database.',
          validFrom: 1,
        }),
      );
    const common = {
      scope: 'project:a',
      relation: 'uses',
      active: true,
      validFrom: now,
      validUntil: null,
      evidence: [{ type: 'memory' as const, id: m.id, quote: 'App uses API.' }],
    };
    g.put({ ...common, from: a.id, to: b.id });
    g.put({
      ...common,
      from: b.id,
      to: c.id,
      evidence: [{ type: 'memory', id: m.id, quote: 'API uses Database.' }],
    });
    assert.ok(g.search(['project:a'], 'frontend').paths.some((p) => p.edges.length === 2));
    assert.equal(g.search(['project:b'], 'frontend').paths.length, 0);
    assert.equal(g.search(['project:a'], 'frontend', now - 1).paths.length, 0);
    assert.throws(
      () => g.put({ ...common, scope: 'project:b', from: a.id, to: b.id }),
      /another scope/,
    );
    life.forget(m.id);
    assert.equal(g.search(['project:a'], 'frontend').paths.length, 0);
  } finally {
    s.close();
  }
});

test('consolidation is scoped and idempotent with retained source history', async () => {
  const s = await fixture(),
    life = new MemoryLifecycle(s);
  try {
    life.create(
      memory('a', {
        content: 'Use Python',
        source: 'chat:first#event:1',
        attribute: undefined,
        entityId: undefined,
      }),
    );
    life.create(
      memory('b', {
        content: 'Use Python',
        source: 'chat:second#event:2',
        attribute: undefined,
        entityId: undefined,
      }),
    );
    life.create(
      memory('c', {
        scope: 'project:b',
        content: 'Use Python',
        attribute: undefined,
        entityId: undefined,
      }),
    );
    assert.equal(life.consolidate('project:a').merged, 1);
    assert.equal(life.consolidate('project:a').merged, 0);
    const active = s.list<Memory>('memory').find((m) => m.scope === 'project:a' && m.active)!;
    assert.equal(active.sourceRefs?.length, 2);
    assert.equal(s.get<Memory>('memory', 'c').active, true);
    life.forget(active.id);
    assert.ok(s.maybe('memory-source-forgotten', sourceKey('project:a', 'second', 2)));
  } finally {
    s.close();
  }
});

test('bulk memory operations keep per-item scope, revision, conflict and history boundaries', async () => {
  const s = await fixture(),
    life = new MemoryLifecycle(s);
  try {
    life.create(memory('a', { active: false }));
    life.create(memory('other', { scope: 'project:b', entityId: 'project:b', active: false }));
    life.create(memory('stale', { active: false, content: 'unrelated', attribute: 'other' }));
    life.update('stale', { content: 'changed' }, 1);
    const result = life.batch(
      'project:a',
      'confirm',
      ['a', 'other', 'stale'].map((id) => ({ id, revision: 1 })),
    );
    assert.equal(result.changed, 1);
    assert.equal(result.failed, 2);
    assert.equal(s.get<Memory>('memory', 'other').active, false);
    const conflict = life.create(memory('conflict', { value: '3.12', content: 'Python 3.12' }));
    assert.equal(life.batch('project:a', 'confirm', [{ id: conflict.id, revision: 1 }]).failed, 1);
    assert.equal(s.get<Memory>('memory', 'conflict').active, false);
    assert.equal(life.batch('project:a', 'deactivate', [{ id: 'a', revision: 2 }]).changed, 1);
    assert.equal(s.get<Memory>('memory', 'a').automatic, false);
    assert.equal(life.batch('project:a', 'forget', [{ id: 'a', revision: 3 }]).changed, 1);
    assert.equal(s.maybe('memory', 'a'), undefined);
  } finally {
    s.close();
  }
});

test('candidate duplicate consolidation reduces pending entries without activating them', async () => {
  const s = await fixture(),
    life = new MemoryLifecycle(s);
  try {
    life.create(memory('one', { active: false }));
    life.create(memory('two', { active: false }));
    assert.equal(life.consolidate('project:a').merged, 1);
    assert.equal(s.list<Memory>('memory').filter((m) => m.status === 'candidate').length, 1);
    assert.equal(
      s.list<Memory>('memory').some((m) => m.active),
      false,
    );
    assert.equal(life.consolidate('project:a').merged, 0);
  } finally {
    s.close();
  }
});

test('conversation-local memories cannot leak through lexical or graph recall and never merge across chats', async () => {
  const s = await fixture(),
    life = new MemoryLifecycle(s);
  try {
    const a = life.create(
      memory('local-a', {
        scope: 'user',
        entityId: 'user',
        kind: 'episode',
        sourceConversationId: 'a',
        content: 'river encounter',
        attribute: 'scene',
        value: 'river',
      }),
    );
    life.create(
      memory('local-b', {
        scope: 'user',
        entityId: 'user',
        kind: 'episode',
        sourceConversationId: 'b',
        content: 'river encounter',
        attribute: 'scene',
        value: 'river',
      }),
    );
    assert.equal(recallMemories(s.list('memory'), 'river', null, Date.now()).length, 0);
    assert.deepEqual(
      recallMemories(s.list('memory'), 'river', null, Date.now(), undefined, 'a').map((m) => m.id),
      ['local-a'],
    );
    assert.equal(life.consolidate('user').merged, 0);
    const entity = life.saveEntity('user', 'river', []);
    const graph = new KnowledgeGraph(s);
    graph.put({
      scope: 'user',
      from: 'user',
      to: entity.id,
      relation: 'visited',
      evidence: [{ type: 'memory', id: a.id, quote: 'river' }],
      active: true,
      validFrom: Date.now(),
      validUntil: null,
    });
    assert.equal(graph.search(['user'], 'river').paths.length, 0);
    assert.ok(graph.search(['user'], 'river', Date.now(), 2, 'a').paths.length > 0);
  } finally {
    s.close();
  }
});

test('system provenance follows edits and deactivation without inventing entity relations', async () => {
  const s = await fixture(),
    life = new MemoryLifecycle(s);
  try {
    life.create(memory('source'));
    const entity = life.saveEntity('project:a', 'memory:source', []);
    const graph = new KnowledgeGraph(s);
    const edge = graph.put({
      scope: 'project:a',
      from: 'project:a',
      to: entity.id,
      relation: 'has recorded memory',
      evidence: [{ type: 'memory', id: 'source', quote: 'Python version 3.11' }],
      active: true,
      validFrom: Date.now(),
      validUntil: null,
    });
    life.update('source', { content: 'Python version 3.11 is required' }, 1);
    assert.equal(
      s.get<any>('knowledge-edge', edge.id).evidence[0].quote,
      'Python version 3.11 is required',
    );
    life.update('source', { active: false }, 2);
    assert.equal(s.get<any>('knowledge-edge', edge.id).active, false);
    life.forget('source');
    assert.equal(s.maybe('memory-entity', entity.id), undefined);
  } finally {
    s.close();
  }
});

test('distinct episodes sharing a topic are additive, not automatically contradictory', async () => {
  const s = await fixture(),
    life = new MemoryLifecycle(s);
  try {
    life.create(
      memory('event1', {
        kind: 'episode',
        sourceConversationId: 'a',
        topic: 'progress',
        attribute: undefined,
        value: undefined,
        content: 'First milestone',
      }),
    );
    const second = life.create(
      memory('event2', {
        kind: 'episode',
        sourceConversationId: 'a',
        topic: 'progress',
        attribute: undefined,
        value: undefined,
        content: 'Second milestone',
      }),
    );
    assert.equal(second.status, 'active');
  } finally {
    s.close();
  }
});

test('deactivated memory is separate from candidate and remains inactive on edits', async () => {
  const s = await fixture(),
    life = new MemoryLifecycle(s);
  try {
    life.create(memory('enabled'));
    const inactive = life.update('enabled', { active: false }, 1);
    assert.equal(inactive.status, 'inactive');
    assert.equal(life.update('enabled', { content: 'Updated wording' }, 2).status, 'inactive');
    assert.equal(life.batch('project:a', 'confirm', [{ id: 'enabled', revision: 3 }]).changed, 1);
    assert.equal(s.get<Memory>('memory', 'enabled').status, 'active');
    const candidate = life.create(memory('candidate', { active: false, attribute: 'other' }));
    assert.equal(candidate.status, 'candidate');
  } finally {
    s.close();
  }
});
