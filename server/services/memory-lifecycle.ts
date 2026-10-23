import { conversationMemoryScope } from '../../shared/memory-scope.js';
import { memoryPartition, memoryConversation } from '../../shared/memory-scope.js';
import { createHash } from 'node:crypto';
import { Store, id } from '../storage/store.js';
import type { Memory } from '../../shared/types.js';
import { assert } from '../core/errors.js';
export const normalizedMemory = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
export const forgottenKey = (scope: string, content: string) =>
  createHash('sha256')
    .update(scope + '\n' + normalizedMemory(content))
    .digest('hex');
export const sourceKey = (scope: string, chat: string, event: number) =>
  createHash('sha256')
    .update(JSON.stringify([scope, chat, event]))
    .digest('hex');
export function memoryValid(m: Memory, at = Date.now()) {
  return (
    (m.active || (m.status === 'superseded' && at < (m.validUntil ?? 0))) &&
    !m.conflictReviewRequired &&
    m.status !== 'disputed' &&
    m.status !== 'forgotten' &&
    (m.validFrom ?? m.createdAt) <= at &&
    (m.validUntil == null || at < m.validUntil) &&
    (!m.expiresAt || at < m.expiresAt)
  );
}
export class MemoryLifecycle {
  constructor(
    private store: Store,
    private hook: (
      stage: 'beforeMemoryWrite' | 'afterMemoryWrite',
      memory: Memory,
    ) => void = () => {},
  ) {}
  private record(before: Memory | null, after: Memory, reason: string) {
    this.hook('beforeMemoryWrite', after);
    this.store.put('memory-history', {
      id: id(),
      memoryId: after.id,
      scope: after.scope,
      before,
      after,
      reason,
      at: Date.now(),
    });
    this.store.put('memory', after);
    this.store.remove('memory-vector', after.id);
    // Maintain only system-owned provenance links, never invent domain relationships.
    for (const edge of this.store.list<any>('knowledge-edge')) {
      const entity = this.store.maybe<any>('memory-entity', edge.to);
      if (
        edge.scope !== after.scope ||
        edge.from !== after.scope ||
        edge.relation !== 'has recorded memory' ||
        entity?.name !== 'memory:' + after.id ||
        edge.evidence.length !== 1 ||
        edge.evidence[0].type !== 'memory' ||
        edge.evidence[0].id !== after.id
      )
        continue;
      const next = {
        ...edge,
        active: edge.active && memoryValid(after),
        validUntil: after.validUntil ?? null,
        evidence: [{ type: 'memory', id: after.id, quote: after.content }],
        revision: edge.revision + 1,
      };
      this.store.put('knowledge-edge-history', {
        id: id(),
        edgeId: edge.id,
        before: edge,
        after: next,
        at: Date.now(),
      });
      this.store.put('knowledge-edge', next);
    }

    this.hook('afterMemoryWrite', after);
    return after;
  }
  evidenceValid(m: Memory) {
    const sourceId = m.sourceConversationId || /^chat:(.+)#event:\d+$/.exec(m.source)?.[1];
    const source = sourceId ? this.store.maybe<any>('conversation', sourceId) : undefined;
    if (
      source &&
      (source.remoteChatOnly || source.remoteMemoryOnly) &&
      m.scope !== conversationMemoryScope(source)
    )
      return false;
    if (m.scope.startsWith('chat:') && (!source || m.scope !== conversationMemoryScope(source)))
      return false;
    if (m.kind !== 'experience') return true;
    return (
      !!m.evidence?.length &&
      !!m.conditions?.trim() &&
      m.evidence.every((e) => {
        const event = this.store.events(e.conversationId).find((x) => x.id === e.eventId);
        const conversation = this.store.maybe<any>('conversation', e.conversationId);
        const scope = conversation ? conversationMemoryScope(conversation) : 'user';
        return (
          scope === m.scope &&
          event?.type === 'tool.completed' &&
          event.data.verification?.passed === true &&
          (!e.quote || JSON.stringify(event.data).includes(e.quote))
        );
      })
    );
  }
  create(m: Memory) {
    if (m.scope.startsWith('chat:'))
      m = { ...m, recallScope: 'conversation', applicability: 'conversation' };
    if (m.sourceConversationId && m.sourceEventId != null)
      assert(
        !this.store.maybe(
          'memory-source-forgotten',
          sourceKey(m.scope, m.sourceConversationId, m.sourceEventId),
        ),
        'FORGOTTEN_SOURCE',
        'This source was excluded from memory extraction.',
      );
    assert(
      !this.store.maybe('memory-forgotten', forgottenKey(m.scope, m.content)),
      'FORGOTTEN',
      'This content was forgotten.',
    );
    if (m.entityId) this.entity(m.scope, m.entityId);
    const conflicts = this.conflictReferences(m);
    const safe = m.active && !conflicts.length && this.evidenceValid(m);
    return this.record(
      null,
      {
        ...m,
        active: safe,
        status: conflicts.length ? 'disputed' : safe ? 'active' : 'candidate',
        recordedAt: Date.now(),
        validFrom: m.validFrom ?? Date.now(),
        conflictsWith: conflicts.map((x) => x.id),
      },
      'created',
    );
  }
  entity(scope: string, key: string) {
    if (key === scope || (scope === 'user' && key === 'user'))
      return { id: key, scope, name: key, aliases: [] };
    const e = this.store.get<any>('memory-entity', key);
    assert(e.confirmed !== false, 'ENTITY_UNCONFIRMED', 'Confirm this entity before use.');
    assert(e.scope === scope, 'ENTITY_SCOPE', 'Entity belongs to another scope.');
    return e;
  }
  saveEntity(scope: string, name: string, aliases: string[], key?: string) {
    const previous = key ? this.store.get<any>('memory-entity', key) : null;
    assert(
      !previous || previous.scope === scope,
      'ENTITY_SCOPE',
      'Entity belongs to another scope.',
    );
    const labels = [name, ...aliases].map(normalizedMemory);
    assert(
      !this.store
        .list<any>('memory-entity')
        .some(
          (e) =>
            e.scope === scope &&
            e.id !== key &&
            [e.name, ...e.aliases].some((x: string) => labels.includes(normalizedMemory(x))),
        ),
      'ALIAS_CONFLICT',
      'An entity already uses this name or alias in this scope.',
    );
    return this.store.put('memory-entity', {
      id: key || id(),
      scope,
      name,
      confirmed: true,
      aliases: [...new Set(aliases)],
      revision: (previous?.revision || 0) + 1,
    });
  }
  conflicts(m: Memory) {
    return this.store
      .list<Memory>('memory')
      .filter(
        (x) =>
          x.id !== m.id &&
          x.scope === m.scope &&
          memoryPartition(x) === memoryPartition(m) &&
          memoryValid(x) &&
          m.factCardinality !== 'multiple' &&
          x.factCardinality !== 'multiple' &&
          !!m.entityId &&
          !!m.attribute &&
          x.entityId === m.entityId &&
          normalizedMemory(x.attribute || '') === normalizedMemory(m.attribute) &&
          normalizedMemory(x.conditions || '') === normalizedMemory(m.conditions || '') &&
          normalizedMemory(x.value || x.content) !== normalizedMemory(m.value || m.content),
      );
  }
  private conflictReferences(m: Memory) {
    const conflicts = this.conflicts(m);
    const at = Date.now();
    for (const key of m.conflictsWith || []) {
      const other = this.store.maybe<Memory>('memory', key);
      if (
        other &&
        other.id !== m.id &&
        other.scope === m.scope &&
        memoryPartition(other) === memoryPartition(m) &&
        (memoryValid(other, at) ||
          (other.status === 'disputed' &&
            (other.validFrom ?? other.createdAt) <= at &&
            (other.validUntil == null || other.validUntil > at) &&
            (!other.expiresAt || other.expiresAt > at))) &&
        !conflicts.some((x) => x.id === key)
      )
        conflicts.push(other);
    }
    return conflicts;
  }
  /** Repair inconsistent conflict metadata without granting recall or model review permission. */
  reconcileConflicts() {
    const report = { checked: 0, linked: 0, needsReview: 0 };
    const at = Date.now();
    for (const m of this.store.list<Memory>('memory')) {
      if (
        m.status !== 'disputed' ||
        (m.validUntil != null && m.validUntil <= at) ||
        (m.expiresAt != null && m.expiresAt <= at)
      )
        continue;
      report.checked++;
      const ids = this.conflictReferences(m)
        .map((x) => x.id)
        .sort();
      if (
        ids.length &&
        !m.active &&
        JSON.stringify(ids) === JSON.stringify([...(m.conflictsWith || [])].sort())
      )
        continue;
      this.store.transaction(() =>
        this.record(
          m,
          {
            ...m,
            active: false,
            status: ids.length ? 'disputed' : 'candidate',
            conflictsWith: ids,
            conflictReviewRequired: true,
            revision: m.revision + 1,
            candidateReview: {
              status: 'needs_review',
              reason: ids.length
                ? 'Conflict references repaired; human review required.'
                : 'No current conflict counterpart could be established; human review required.',
              at,
            },
          },
          'conflict metadata reconciled; recall remains disabled',
        ),
      );
      if (ids.length) report.linked++;
      else report.needsReview++;
    }
    return report;
  }
  update(key: string, patch: Partial<Memory>, revision?: number) {
    const old = this.store.get<Memory>('memory', key);
    assert(
      revision == null || old.revision === revision,
      'MEMORY_CHANGED',
      'Memory changed. Refresh before editing.',
    );
    const next = { ...old, ...patch, id: old.id, scope: old.scope, revision: old.revision + 1 };
    if (next.scope.startsWith('chat:')) {
      next.recallScope = 'conversation';
      next.applicability = 'conversation';
    }
    if (next.entityId) this.entity(next.scope, next.entityId);
    assert(
      next.validUntil == null || next.validUntil > (next.validFrom ?? next.createdAt),
      'MEMORY_TIME',
      'End must be after start.',
    );
    const conflicts = this.conflictReferences(next);
    next.conflictsWith = conflicts.map((m) => m.id);

    if (next.active) {
      assert(
        !conflicts.length,
        'MEMORY_CONFLICT',
        'Resolve conflicting entries before activation.',
      );
      assert(
        this.evidenceValid(next),
        'MEMORY_EVIDENCE',
        'Experience needs successful tool evidence and applicability conditions.',
      );
    }
    next.status = next.active
      ? 'active'
      : patch.active === false || old.status === 'inactive'
        ? 'inactive'
        : conflicts.length
          ? 'disputed'
          : 'candidate';
    if (patch.active === true) next.conflictReviewRequired = false;
    return this.record(old, next, 'edited');
  }
  resolve(
    winnerId: string,
    loserIds: string[],
    revision: number,
    at = Date.now(),
    automatic = false,
  ) {
    return this.store.transaction(() => {
      const winner = this.store.get<Memory>('memory', winnerId);
      assert(
        !automatic || !winner.conflictReviewRequired,
        'MEMORY_REVIEW',
        'Human review is required.',
      );
      assert(winner.revision === revision, 'MEMORY_CHANGED', 'Memory changed. Refresh.');
      assert(at > 0 && at <= Date.now(), 'MEMORY_TIME', 'Choose a past or current effective time.');
      assert(this.evidenceValid(winner), 'MEMORY_EVIDENCE', 'Experience evidence is missing.');
      const losers = loserIds.map((k) => this.store.get<Memory>('memory', k));
      assert(
        losers.every(
          (m) =>
            m.id !== winner.id && m.scope === winner.scope && (m.validFrom ?? m.createdAt) <= at,
        ),
        'MEMORY_SCOPE',
        'Invalid replacement scope or time.',
      );
      const remaining = this.conflicts(winner).filter((m) => !loserIds.includes(m.id));
      assert(!remaining.length, 'MEMORY_CONFLICT', 'Include all current conflicting entries.');
      for (const old of losers)
        this.record(
          old,
          {
            ...old,
            active: false,
            status: 'superseded',
            validUntil: at,
            revision: old.revision + 1,
          },
          'superseded by ' + winnerId,
        );
      return this.record(
        winner,
        {
          ...winner,
          active: true,
          status: 'active',
          conflictReviewRequired: false,
          validFrom: at,
          supersedes: loserIds,
          conflictsWith: [],
          revision: winner.revision + 1,
        },
        automatic
          ? 'newer explicit source automatically superseded prior memory'
          : 'conflict resolved by user',
      );
    });
  }
  forget(key: string) {
    return this.store.transaction(() => {
      const m = this.store.get<Memory>('memory', key);
      this.store.put('memory-forgotten', {
        id: forgottenKey(m.scope, m.content),
        scope: m.scope,
        at: Date.now(),
      });
      if (m.sourceConversationId && m.sourceEventId != null)
        this.store.put('memory-source-forgotten', {
          id: sourceKey(m.scope, m.sourceConversationId, m.sourceEventId),
          scope: m.scope,
          at: Date.now(),
        });
      for (const ref of [m.source, ...(m.sourceRefs || [])]) {
        const match = /^chat:(.+)#event:(\d+)$/.exec(ref);
        if (match)
          this.store.put('memory-source-forgotten', {
            id: sourceKey(m.scope, match[1], Number(match[2])),
            scope: m.scope,
            at: Date.now(),
          });
      }
      for (const edge of this.store.list<any>('knowledge-edge'))
        if (
          edge.scope === m.scope &&
          edge.evidence.some((e: any) => e.type === 'memory' && e.id === m.id)
        ) {
          this.store.remove('knowledge-edge', edge.id);
          for (const h of this.store.list<any>('knowledge-edge-history'))
            if (h.edgeId === edge.id) this.store.remove('knowledge-edge-history', h.id);
        }
      for (const entity of this.store.list<any>('memory-entity'))
        if (
          entity.scope === m.scope &&
          entity.name === 'memory:' + key &&
          !this.store
            .list<any>('knowledge-edge')
            .some((e) => e.from === entity.id || e.to === entity.id)
        )
          this.store.remove('memory-entity', entity.id);
      this.store.remove('memory', key);
      this.store.remove('memory-vector', key);
      for (const h of this.store.list<any>('memory-history'))
        if (h.memoryId === key) this.store.remove('memory-history', h.id);
      return { ok: true, sourceExcluded: !!m.sourceConversationId };
    });
  }
  undo(key: string, historyId: string) {
    return this.store.transaction(() => {
      const h = this.store.get<any>('memory-history', historyId),
        current = this.store.get<Memory>('memory', key);
      assert(
        h.memoryId === key && h.before && h.after.revision === current.revision,
        'UNDO_STALE',
        'Only the latest edit can be undone.',
      );
      assert(
        !h.reason.startsWith('superseded') &&
          !h.reason.startsWith('conflict resolved') &&
          !h.reason.startsWith('consolidated'),
        'UNDO_GROUP',
        'Replacement involves multiple records; explicitly resolve again instead.',
      );
      const prior = { ...h.before, revision: current.revision + 1 };
      if (prior.active)
        assert(
          !this.conflicts(prior).length && this.evidenceValid(prior),
          'MEMORY_CONFLICT',
          'Cannot restore conflicting or unsupported memory.',
        );
      return this.record(current, prior, 'undo');
    });
  }
  batch(
    scope: string,
    action: 'confirm' | 'deactivate' | 'forget' | 'local' | 'share' | 'auto-reach',
    items: { id: string; revision: number }[],
  ) {
    const outcomes: { id: string; ok: boolean; reason?: string }[] = [];
    for (const item of items) {
      try {
        this.store.transaction(() => {
          const m = this.store.get<Memory>('memory', item.id);
          assert(m.scope === scope, 'MEMORY_SCOPE', 'Memory belongs to another scope.');
          assert(
            m.revision === item.revision,
            'MEMORY_CHANGED',
            'Memory changed. Refresh before editing.',
          );
          assert(
            action !== 'confirm' || m.status !== 'disputed',
            'MEMORY_CONFLICT',
            'Compare conflicting sources and resolve explicitly.',
          );
          if (action === 'local' || action === 'share' || action === 'auto-reach') {
            assert(
              action !== 'local' || memoryConversation(m),
              'MEMORY_SOURCE',
              'No original conversation is recorded; cannot restrict to an unknown conversation.',
            );
            assert(
              m.status !== 'superseded' && m.status !== 'forgotten',
              'MEMORY_HISTORY',
              'Historical entries cannot change reach.',
            );
            this.update(
              m.id,
              {
                recallScope:
                  action === 'local' ? 'conversation' : action === 'share' ? 'scope' : 'auto',
              },
              m.revision,
            );
          } else if (action === 'forget') this.forget(m.id);
          else {
            assert(
              m.status !== 'superseded' && m.status !== 'forgotten',
              'MEMORY_HISTORY',
              'Historical entries cannot be reactivated.',
            );
            assert(
              action !== 'confirm' ||
                ((!m.expiresAt || m.expiresAt > Date.now()) &&
                  (m.validUntil == null || m.validUntil > Date.now())),
              'MEMORY_EXPIRED',
              'Update validity before confirming.',
            );
            this.update(m.id, { active: action === 'confirm', automatic: false }, m.revision);
          }
        });
        outcomes.push({ id: item.id, ok: true });
      } catch (error) {
        outcomes.push({
          id: item.id,
          ok: false,
          reason: error instanceof Error ? error.message : 'Failed',
        });
      }
    }
    return {
      outcomes,
      changed: outcomes.filter((x) => x.ok).length,
      failed: outcomes.filter((x) => !x.ok).length,
    };
  }
  consolidate(scope: string) {
    return this.store.transaction(() => {
      const groups = new Map<string, Memory[]>();
      for (const m of this.store
        .list<Memory>('memory')
        .filter(
          (m) =>
            m.scope === scope &&
            !m.conflictReviewRequired &&
            (memoryValid(m) ||
              (m.status === 'candidate' &&
                !m.active &&
                !m.conflictsWith?.length &&
                (!m.expiresAt || m.expiresAt > Date.now()) &&
                m.validUntil == null)),
        )) {
        const key = JSON.stringify([
          m.active ? 'active' : 'candidate',
          memoryPartition(m),
          m.decayPolicy || 'auto',
          m.halfLifeDays || 30,
          m.halfLifeTurns || 100,
          normalizedMemory(m.content),
          m.entityId || '',
          m.attribute || '',
          m.kind || 'preference',
          m.stability || '',
          normalizedMemory(m.conditions || ''),
          m.stability === 'evolving' ? m.observedAt : null,
        ]);
        groups.set(key, [...(groups.get(key) || []), m]);
      }
      let merged = 0;
      for (const group of groups.values()) {
        if (group.length < 2) continue;
        group.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
        const [primary, ...duplicates] = group;
        const sourceRefs = [...new Set(group.flatMap((m) => [m.source, ...(m.sourceRefs || [])]))];
        this.record(
          primary,
          { ...primary, sourceRefs, revision: primary.revision + 1 },
          'consolidated duplicate sources',
        );
        for (const old of duplicates)
          this.record(
            old,
            {
              ...old,
              active: false,
              status: 'superseded',
              validUntil: Date.now(),
              duplicateOf: primary.id,
              revision: old.revision + 1,
            },
            'superseded duplicate',
          );
        merged += duplicates.length;
      }
      return { merged, issues: this.inspect(scope) };
    });
  }
  inspect(scope: string) {
    const entries = this.store.list<Memory>('memory').filter((m) => m.scope === scope);
    return entries
      .map((m) => ({
        id: m.id,
        expired: !!m.expiresAt && m.expiresAt <= Date.now(),
        missingSource:
          !!m.sourceConversationId &&
          !this.store.events(m.sourceConversationId).some((e) => e.id === m.sourceEventId),
        conflicts: this.conflicts(m).map((x) => x.id),
        duplicates: entries
          .filter(
            (x) => x.id !== m.id && normalizedMemory(x.content) === normalizedMemory(m.content),
          )
          .map((x) => x.id),
      }))
      .filter((x) => x.expired || x.missingSource || x.conflicts.length || x.duplicates.length);
  }
}
