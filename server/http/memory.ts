import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { memoryReach } from '../../shared/memory-scope.js';
import type { Conversation, Memory, Run } from '../../shared/types.js';
import { assert } from '../core/errors.js';
import { Store, id } from '../storage/store.js';
import { Configuration } from '../services/settings.js';
import { MemoryIndex } from '../services/memory-index.js';
import { memoryHooks } from '../services/tool-hooks.js';
import { inheritedMemory } from '../services/memory-policy.js';
import { memoryTarget } from '../services/memory-learning.js';
import { KnowledgeGraph } from '../services/knowledge-graph.js';
import { MemoryLifecycle } from '../services/memory-lifecycle.js';

export function memoryRoutes(
  app: FastifyInstance,
  {
    store,
    config,
    memories,
  }: {
    store: Store;
    config: Configuration;
    memories: MemoryIndex;
  },
) {
  app.post('/api/memories/index', async (req) => {
    const { scope } = z.object({ scope: z.string().optional() }).parse(req.body || {});
    assert(
      !scope ||
        scope === 'user' ||
        (scope.startsWith('project:') && store.maybe('project', scope.slice(8))),
      'SCOPE',
      'Select a valid memory scope.',
    );
    return memories.index(scope);
  });
  const memoryLifecycle = new MemoryLifecycle(store, (stage, m) =>
    memoryHooks(store, config, stage, m),
  );
  const memoryFields = {
    decayPolicy: z.enum(['auto', 'stable', 'time', 'turns', 'time-and-turns']).optional(),
    halfLifeDays: z.number().int().min(1).max(36500).optional(),
    halfLifeTurns: z.number().int().min(1).max(100000).optional(),
    recallScope: z.enum(['auto', 'conversation', 'scope']).optional(),
    topic: z.string().max(80).optional(),
    entityId: z.string().max(200).optional(),
    attribute: z.string().max(80).optional(),
    value: z.string().max(1200).optional(),
    kind: z.enum(['preference', 'decision', 'episode', 'experience']).optional(),
    validFrom: z.number().int().nonnegative().optional(),
    validUntil: z.number().int().nonnegative().nullable().optional(),
    conditions: z.string().max(4000).optional(),
    evidence: z
      .array(
        z.object({
          conversationId: z.string(),
          eventId: z.number().int(),
          quote: z.string().max(1200).optional(),
        }),
      )
      .max(20)
      .optional(),
  };
  function checkMemoryScope(scope: string) {
    assert(
      scope === 'user' || (scope.startsWith('project:') && store.maybe('project', scope.slice(8))),
      'SCOPE',
      'Select a valid memory scope.',
    );
  }
  app.get<{ Params: { id: string } }>('/api/memories/:id/history', async (req) =>
    store
      .list<any>('memory-history')
      .filter((h) => h.memoryId === req.params.id)
      .sort((a, b) => b.after.revision - a.after.revision),
  );
  app.post<{ Params: { id: string } }>('/api/memories/:id/resolve', async (req) => {
    const data = z
      .object({
        losers: z.array(z.string()).max(80),
        revision: z.number().int(),
        at: z.number().optional(),
      })
      .parse(req.body);
    return memoryLifecycle.resolve(req.params.id, data.losers, data.revision, data.at);
  });
  app.post<{ Params: { id: string } }>('/api/memories/:id/undo', async (req) => {
    const { historyId } = z.object({ historyId: z.string() }).parse(req.body);
    return memoryLifecycle.undo(req.params.id, historyId);
  });
  app.post('/api/memories/inspect', async (req) => {
    const { scope } = z.object({ scope: z.string() }).parse(req.body);
    checkMemoryScope(scope);
    return memoryLifecycle.inspect(scope);
  });
  app.post('/api/memories/batch', async (req) => {
    const data = z
      .object({
        scope: z.string(),
        action: z.enum(['confirm', 'deactivate', 'forget', 'local', 'share', 'auto-reach']),
        items: z
          .array(z.object({ id: z.string(), revision: z.number().int() }))
          .min(1)
          .max(200),
      })
      .parse(req.body);
    checkMemoryScope(data.scope);
    return memoryLifecycle.batch(data.scope, data.action, data.items);
  });
  app.post('/api/memories/consolidate', async (req) => {
    const { scope } = z.object({ scope: z.string() }).parse(req.body);
    checkMemoryScope(scope);
    return memoryLifecycle.consolidate(scope);
  });
  app.get<{ Querystring: { scope: string } }>('/api/memory-entities', async (req) => {
    checkMemoryScope(req.query.scope);
    return store
      .list<any>('memory-entity')
      .filter((e) => e.scope === req.query.scope)
      .map((e) => {
        const m = e.name.startsWith('memory:')
          ? store.maybe<Memory>('memory', e.name.slice(7))
          : null;
        return {
          ...e,
          displayName: m?.content.slice(0, 160) || e.name,
          sourceStatus: m?.status,
          kind: e.name.startsWith('memory:') ? 'memory-source' : 'entity',
        };
      });
  });
  app.post('/api/memory-entities', async (req) => {
    const d = z
      .object({
        id: z.string().optional(),
        scope: z.string(),
        name: z.string().trim().min(1).max(100),
        aliases: z.array(z.string().trim().min(1).max(100)).max(20),
      })
      .parse(req.body);
    checkMemoryScope(d.scope);
    return memoryLifecycle.saveEntity(d.scope, d.name, d.aliases, d.id);
  });
  const graph = new KnowledgeGraph(store);
  const graphEvidence = z.object({
    type: z.enum(['memory', 'document', 'event']),
    id: z.string(),
    conversationId: z.string().optional(),
    quote: z.string().trim().min(1).max(1200),
  });
  const edgeInput = z.object({
    scope: z.string(),
    from: z.string(),
    to: z.string(),
    relation: z.string().trim().min(1).max(120),
    evidence: z.array(graphEvidence).min(1).max(10),
    active: z.boolean().default(false),
    validFrom: z
      .number()
      .int()
      .nonnegative()
      .default(() => Date.now()),
    validUntil: z.number().int().nonnegative().nullable().default(null),
  });
  app.get<{ Querystring: { scope: string } }>('/api/knowledge-graph', async (req) => {
    checkMemoryScope(req.query.scope);
    return graph.list(req.query.scope).map((e) => ({
      ...e,
      supportedNow: e.evidence.every((x) => graph.supported(e.scope, x, Date.now())),
      current:
        e.active &&
        e.validFrom <= Date.now() &&
        (e.validUntil == null || e.validUntil > Date.now()) &&
        e.evidence.every((x) => graph.supported(e.scope, x, Date.now())),
    }));
  });
  app.post('/api/knowledge-graph', async (req) => {
    const d = edgeInput.parse(req.body);
    checkMemoryScope(d.scope);
    return graph.put(d);
  });
  app.patch<{ Params: { id: string } }>('/api/knowledge-graph/:id', async (req) => {
    const old = store.get<any>('knowledge-edge', req.params.id);
    const d = z.object({ active: z.boolean(), revision: z.number().int() }).parse(req.body);
    assert(d.revision === old.revision, 'GRAPH_CHANGED', 'Refresh this relationship.');
    return graph.put({ ...old, active: d.active }, old.id);
  });
  app.delete<{ Params: { id: string } }>('/api/knowledge-graph/:id', async (req) => {
    store.remove('knowledge-edge', req.params.id);
    for (const h of store.list<any>('knowledge-edge-history'))
      if (h.edgeId === req.params.id) store.remove('knowledge-edge-history', h.id);
    return { ok: true };
  });
  app.post('/api/knowledge-graph/search', async (req) => {
    const d = z
      .object({
        scope: z.string(),
        query: z.string().min(1),
        asOf: z.number().optional(),
        depth: z.number().int().min(1).max(3).default(2),
      })
      .parse(req.body);
    checkMemoryScope(d.scope);
    return graph.search([d.scope], d.query, d.asOf, d.depth);
  });
  app.post('/api/memories/search', async (req) => {
    const d = z
      .object({ scope: z.string(), query: z.string().min(1), asOf: z.number().optional() })
      .parse(req.body);
    checkMemoryScope(d.scope);
    return memories.recall(
      d.query,
      d.scope === 'user' ? null : d.scope.slice(8),
      new AbortController().signal,
      d.scope === 'user',
      d.asOf,
    );
  });
  app.post('/api/memories', async (req) => {
    const data = z
      .object({
        ...memoryFields,
        content: z.string().trim().min(1).max(4000),
        scope: z.string(),
        source: z.string().max(1000).default('User'),
        sourceConversationId: z.string().optional(),
        active: z.boolean().default(true),
        expiresAt: z.number().nullable().default(null),
      })
      .parse(req.body);
    assert(
      data.scope === 'user' ||
        (data.scope.startsWith('project:') && store.maybe('project', data.scope.slice(8))),
      'SCOPE',
      'Select a valid memory scope.',
    );
    if (data.sourceConversationId) {
      const chat = store.maybe<Conversation>('conversation', data.sourceConversationId);
      assert(
        chat &&
          !store.list<Run>('run').some((r) => r.conversationId === chat.id && r.parentRunId) &&
          (chat.projectId ? 'project:' + chat.projectId : 'user') === data.scope,
        'MEMORY_SCOPE',
        'Choose an original conversation in this storage group.',
      );
    }
    assert(
      memoryReach(data as Memory) !== 'conversation' || data.sourceConversationId,
      'MEMORY_SOURCE',
      'Choose the original conversation first.',
    );
    return memoryLifecycle.create({ id: id(), ...data, revision: 1, createdAt: Date.now() });
  });
  app.patch<{ Params: { id: string } }>('/api/memories/:id', async (req) => {
    const old = store.get<Memory>('memory', req.params.id);
    const data = z
      .object({
        ...memoryFields,
        revision: z.number().int().optional(),
        content: z.string().min(1).max(4000).optional(),
        active: z.boolean().optional(),
        expiresAt: z.number().nullable().optional(),
      })
      .parse(req.body);
    const { revision, ...patch } = data;
    return memoryLifecycle.update(old.id, patch, revision);
  });
  app.delete<{ Params: { id: string } }>('/api/memories/:id', async (req) => {
    return memoryLifecycle.forget(req.params.id);
  });
  app.get<{ Querystring: { scope: string } }>('/api/memory-policy', async (req) => {
    const scope = req.query.scope;
    assert(
      scope === 'user' || (scope.startsWith('project:') && store.maybe('project', scope.slice(8))),
      'SCOPE',
      'Invalid memory scope.',
    );
    return store.maybe('memory-policy', scope) || { id: scope, enabled: false, targets: [] };
  });
  app.post('/api/memory-policy', async (req) => {
    const d = z
      .object({ scope: z.string(), enabled: z.boolean(), profileId: z.string() })
      .parse(req.body);
    assert(
      d.scope === 'user' ||
        (d.scope.startsWith('project:') && store.maybe('project', d.scope.slice(8))),
      'SCOPE',
      'Invalid memory scope.',
    );
    const profile = config.profile(d.profileId),
      target = memoryTarget(profile),
      old = store.maybe<any>('memory-policy', d.scope);
    const policy = store.put('memory-policy', {
      id: d.scope,
      enabled: d.enabled,
      targets: [...new Set([...(old?.targets || []), target])],
    });
    for (const c of store.list<Conversation>('conversation'))
      if (
        c.memoryPolicy === 'inherit' &&
        (c.projectId ? 'project:' + c.projectId : 'user') === d.scope
      )
        store.put('conversation', { ...c, ...inheritedMemory(store, config, c) });
    return policy;
  });
}
