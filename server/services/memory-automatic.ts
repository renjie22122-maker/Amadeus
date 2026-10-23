import { memoryPartition } from '../../shared/memory-scope.js';
import type { Memory } from '../../shared/types.js';
import { Store } from '../storage/store.js';
import { MemoryLifecycle, memoryValid } from './memory-lifecycle.js';
import { KnowledgeGraph } from './knowledge-graph.js';

// Deterministic maintenance: inferred semantic equivalence never authorizes replacement.
export function manageAutomaticMemory(store: Store, memory: Memory) {
  if (memory.conflictReviewRequired) return;
  const lifecycle = new MemoryLifecycle(store);
  let current = memory;
  const conflicts = (memory.conflictsWith || [])
    .map((id) => store.maybe<Memory>('memory', id))
    .filter(
      (m): m is Memory =>
        !!m && m.scope === memory.scope && memoryPartition(m) === memoryPartition(memory),
    );
  if (
    conflicts.length &&
    memory.revisionIntent === 'replace' &&
    memory.attribute &&
    memory.sourceEventId != null
  ) {
    const source = store
      .events(memory.sourceConversationId!)
      .find((e) => e.id === memory.sourceEventId);
    const newer =
      source &&
      conflicts.every((old) => {
        const previous =
          old.sourceConversationId &&
          store.events(old.sourceConversationId).find((e) => e.id === old.sourceEventId);
        return (
          old.automatic &&
          old.attribute === memory.attribute &&
          old.entityId === memory.entityId &&
          previous &&
          source.createdAt > previous.createdAt
        );
      });
    if (newer)
      current = lifecycle.resolve(
        memory.id,
        conflicts.map((m) => m.id),
        memory.revision,
        Date.now(),
        true,
      );
  }
  if (!current.active) return;
  // A sourced memory relation, not an invented real-world causal relation.
  const name = 'memory:' + current.id;
  const entities = store.list<any>('memory-entity');
  const entity =
    entities.find((e) => e.scope === current.scope && e.name === name) ||
    lifecycle.saveEntity(current.scope, name, []);
  const graph = new KnowledgeGraph(store);
  if (!graph.list(current.scope).some((e) => e.to === entity.id && e.from === current.scope))
    graph.put({
      scope: current.scope,
      from: current.scope,
      to: entity.id,
      relation: 'has recorded memory',
      evidence: [{ type: 'memory', id: current.id, quote: current.content }],
      active: true,
      validFrom: Date.now(),
      validUntil: current.validUntil ?? null,
    });
}

export function reconsiderMemoryConflicts(store: Store, scope: string) {
  let resolved = 0;
  for (const m of store
    .list<Memory>('memory')
    .filter(
      (m) =>
        m.scope === scope && m.automatic && !m.conflictReviewRequired && m.status === 'disputed',
    )) {
    const source =
      m.sourceConversationId &&
      store.events(m.sourceConversationId).find((e) => e.id === m.sourceEventId);
    if (
      !source ||
      !['user.message', 'chat.memory-source'].includes(source.type) ||
      source.data.scheduledTrigger
    )
      continue;
    const activeConflicts = new MemoryLifecycle(store).conflicts(m);
    for (const key of m.conflictsWith || []) {
      const old = store.maybe<Memory>('memory', key);
      if (
        old &&
        old.scope === scope &&
        memoryPartition(old) === memoryPartition(m) &&
        memoryValid(old) &&
        !activeConflicts.some((x) => x.id === old.id)
      )
        activeConflicts.push(old);
    }
    if (!activeConflicts.length && (m.conflictsWith || []).length) {
      new MemoryLifecycle(store).update(m.id, { active: true, conflictsWith: [] }, m.revision);
      resolved++;
    } else if (activeConflicts.length) {
      manageAutomaticMemory(store, { ...m, conflictsWith: activeConflicts.map((x) => x.id) });
      if (store.get<Memory>('memory', m.id).active) resolved++;
    }
  }
  return resolved;
}
