import { terms } from './memory-retrieval.js';
import { memoryAccessible } from '../../shared/memory-scope.js';
import { Store, id } from '../storage/store.js';
import { MemoryLifecycle, memoryValid, normalizedMemory, sourceKey } from './memory-lifecycle.js';
import { assert } from '../core/errors.js';
export interface GraphEvidence {
  type: 'memory' | 'document' | 'event';
  id: string;
  conversationId?: string;
  quote: string;
}
export interface GraphEdge {
  id: string;
  scope: string;
  from: string;
  to: string;
  relation: string;
  evidence: GraphEvidence[];
  active: boolean;
  validFrom: number;
  validUntil: number | null;
  revision: number;
  createdAt: number;
}
export class KnowledgeGraph {
  constructor(private store: Store) {}
  supported(scope: string, e: GraphEvidence, at: number) {
    if (e.type === 'memory') {
      const m = this.store.maybe<any>('memory', e.id);
      return (
        !!m &&
        m.scope === scope &&
        memoryValid(m, at) &&
        new MemoryLifecycle(this.store).evidenceValid(m) &&
        m.content.includes(e.quote)
      );
    }
    if (e.type === 'document') {
      const d = this.store.maybe<any>('document', e.id);
      return (
        !!d &&
        d.scope === scope &&
        (d.validFrom ?? d.createdAt) <= at &&
        (!d.validUntil || at < d.validUntil) &&
        !!this.store.db
          .prepare('SELECT 1 FROM chunks WHERE document_id=? AND instr(text,?)>0 LIMIT 1')
          .get(e.id, e.quote)
      );
    }
    const c = this.store.maybe<any>('conversation', e.conversationId || '');
    const scoped = c?.projectId ? 'project:' + c.projectId : 'user';
    const event = c && this.store.events(c.id).find((x) => String(x.id) === e.id);
    return (
      scoped === scope &&
      !this.store.maybe(
        'memory-source-forgotten',
        sourceKey(scope, e.conversationId || '', Number(e.id)),
      ) &&
      event &&
      event.createdAt <= at &&
      ['user.message', 'tool.completed'].includes(event.type) &&
      JSON.stringify(event.data).includes(e.quote)
    );
  }
  put(edge: Omit<GraphEdge, 'id' | 'revision' | 'createdAt'>, key?: string) {
    const memory = new MemoryLifecycle(this.store);
    memory.entity(edge.scope, edge.from);
    memory.entity(edge.scope, edge.to);
    assert(edge.from !== edge.to, 'GRAPH_SELF', 'Choose two different entities.');
    assert(
      edge.evidence.length > 0 &&
        edge.evidence.every((e) => e.quote.trim() && this.supported(edge.scope, e, edge.validFrom)),
      'GRAPH_EVIDENCE',
      'Source quote, time or scope does not match.',
    );
    assert(
      edge.validUntil == null || edge.validUntil > edge.validFrom,
      'GRAPH_TIME',
      'Invalid validity interval.',
    );
    const old = key ? this.store.get<GraphEdge>('knowledge-edge', key) : null;
    assert(
      !old || old.scope === edge.scope,
      'GRAPH_SCOPE',
      'Cannot move a relation between scopes.',
    );
    const value = {
      ...edge,
      id: key || id(),
      revision: (old?.revision || 0) + 1,
      createdAt: old?.createdAt || Date.now(),
    };
    this.store.put('knowledge-edge-history', {
      id: id(),
      edgeId: value.id,
      before: old,
      after: value,
      at: Date.now(),
    });
    return this.store.put('knowledge-edge', value);
  }
  list(scope: string) {
    return this.store.list<GraphEdge>('knowledge-edge').filter((e) => e.scope === scope);
  }
  private visibleEdges(scopes: string[], at: number, conversationId?: string) {
    return this.store
      .list<GraphEdge>('knowledge-edge')
      .filter(
        (e) =>
          scopes.includes(e.scope) &&
          e.active &&
          e.validFrom <= at &&
          (e.validUntil == null || at < e.validUntil) &&
          e.evidence.length > 0 &&
          e.evidence.every(
            (x) =>
              this.supported(e.scope, x, at) &&
              (x.type !== 'memory' ||
                memoryAccessible(this.store.get('memory', x.id), conversationId)) &&
              (x.type !== 'event' || e.scope !== 'user' || x.conversationId === conversationId),
          ),
      );
  }
  private visibleEntities(scopes: string[], at: number, conversationId?: string) {
    const lifecycle = new MemoryLifecycle(this.store);
    const supportedNodes = new Set(
      this.visibleEdges(scopes, at, conversationId).flatMap((e) => [e.from, e.to]),
    );
    return this.store
      .list<any>('memory-entity')
      .filter((e) => scopes.includes(e.scope) && e.confirmed !== false)
      .flatMap((e) => {
        if (e.automatic && !supportedNodes.has(e.id)) return [];
        if (!e.name.startsWith('memory:')) return [{ ...e, kind: 'entity', displayName: e.name }];
        const m = this.store.maybe<any>('memory', e.name.slice(7));
        if (
          !m ||
          m.scope !== e.scope ||
          !memoryValid(m, at) ||
          !memoryAccessible(m, conversationId) ||
          !lifecycle.evidenceValid(m)
        )
          return [];
        return [
          {
            ...e,
            kind: 'memory-source',
            displayName: m.content.slice(0, 160),
            memoryId: m.id,
            sourceRevision: m.revision,
            searchableText: m.content,
          },
        ];
      });
  }
  catalog(
    scopes: string[],
    options: {
      asOf?: number;
      conversationId?: string;
      query?: string;
      offset?: number;
      limit?: number;
      includeSources?: boolean;
    } = {},
  ) {
    const at = options.asOf ?? Date.now();
    const rows = this.visibleEntities(scopes, at, options.conversationId);
    const q = terms(options.query || '');
    const filtered = rows
      .filter(
        (e) =>
          (options.includeSources !== false || e.kind !== 'memory-source') &&
          (!options.query || this.match(e, options.query, q) > 0),
      )
      .sort((a, b) => a.id.localeCompare(b.id));
    const offset = Math.max(0, options.offset || 0),
      limit = Math.min(200, Math.max(1, options.limit || 50));
    const edges = this.visibleEdges(scopes, at, options.conversationId);
    return {
      entities: filtered.slice(offset, offset + limit).map(({ searchableText, ...e }) => e),
      total: filtered.length,
      offset,
      limit,
      nextOffset: offset + limit < filtered.length ? offset + limit : null,
      statistics: {
        semanticEntities: rows.filter((e) => e.kind === 'entity').length,
        memorySources: rows.filter((e) => e.kind === 'memory-source').length,
        usableRelations: edges.filter((e) => e.relation !== 'has recorded memory').length,
        provenanceRelations: edges.filter((e) => e.relation === 'has recorded memory').length,
      },
      notice:
        'Counts cover current permitted scope and conversation only. Memory-source nodes are provenance, not extracted semantic entities.',
    };
  }
  private match(e: any, query: string, tokens: Set<string>) {
    const q = normalizedMemory(query);
    const labels = [e.id, e.name, ...(e.aliases || [])];
    if (labels.some((label) => label && q.includes(normalizedMemory(label)))) return 100;
    const words = terms([e.displayName, e.searchableText, ...labels].join(' '));
    return [...tokens].filter((t) => words.has(t)).length;
  }
  search(scopes: string[], query: string, at = Date.now(), depth = 2, conversationId?: string) {
    const entities = this.visibleEntities(scopes, at, conversationId);
    const allowed = this.visibleEdges(scopes, at, conversationId);
    const q = terms(query);
    const scored = new Map(entities.map((e) => [e.id, this.match(e, query, q)]));
    // Evidence can find a semantic relation even when the query doesn't contain its entire label.
    for (const edge of allowed) {
      const words = terms(edge.relation + ' ' + edge.evidence.map((e) => e.quote).join(' '));
      const score = [...q].filter((t) => words.has(t)).length;
      if (score)
        for (const id of [edge.from, edge.to]) scored.set(id, Math.max(scored.get(id) || 0, score));
    }
    const allSeeds = [...scored]
      .filter(([, score]) => score > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([id]) => id);
    const seeds = allSeeds.slice(0, 12);
    const diagnostics = {
      matchedNodes: allSeeds.length,
      usableEdges: allowed.length,
      status:
        !entities.length && !allowed.length
          ? 'no-visible-graph'
          : !allSeeds.length
            ? 'no-matching-nodes'
            : !allowed.length
              ? 'nodes-without-usable-edges'
              : 'matched',
      notice:
        'Empty paths do not prove the graph has no edges. Provenance links do not assert semantic relationships or causality.',
    };
    const present = (seen: Set<string>) => [
      ...entities.filter((e) => seen.has(e.id)).map(({ searchableText, ...e }) => e),
      ...scopes
        .filter((scope) => seen.has(scope))
        .map((scope) => ({
          id: scope,
          scope,
          name: scope,
          displayName: scope,
          kind: 'scope',
          aliases: [],
        })),
    ];
    const seen = new Set(seeds),
      paths: { entities: string[]; edges: GraphEdge[] }[] = seeds
        .slice(0, 12)
        .map((id) => ({ entities: [id], edges: [] }));
    const results: typeof paths = [];
    for (let hop = 0; hop < Math.min(3, Math.max(1, depth)); hop++) {
      const frontier = paths.filter((p) => p.edges.length === hop);
      for (const p of frontier)
        for (const e of allowed) {
          const end = p.entities.at(-1);
          if (e.from !== end && e.to !== end) continue;
          const next = e.from === end ? e.to : e.from;
          if (p.entities.includes(next)) continue;
          const path = { entities: [...p.entities, next], edges: [...p.edges, e] };
          results.push(path);
          if (!seen.has(next)) {
            seen.add(next);
            paths.push(path);
          }
          if (results.length >= 40)
            return {
              entities: present(seen),
              diagnostics,
              paths: results,
              truncated: true,
            };
        }
    }
    return {
      entities: present(seen),
      diagnostics,
      paths: results,
      truncated: allSeeds.length > seeds.length,
    };
  }
}
