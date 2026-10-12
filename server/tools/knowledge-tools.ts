import { z } from 'zod';
import { createHash } from 'node:crypto';
import { assert } from '../core/errors.js';
import type { ToolRegistry } from './registry.js';
const text = (value: unknown) => ({
  content: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
});
export function installKnowledgeTools(registry: ToolRegistry) {
  registry.add({
    name: 'search_knowledge',
    description:
      'Search only knowledge attached to this conversation or project. Cite returned document and chunk IDs.',
    effect: 'read',
    schema: z.object({
      query: z.string().min(1),
      documentIds: z.array(z.string()).max(20).default([]),
      limit: z.number().int().min(1).max(12).default(6),
      asOf: z.number().int().nonnegative().optional(),
    }),
    run: async (a, c) => {
      const results = await c.knowledge.hybrid(
        c.scopes,
        a.query,
        a.limit,
        c.signal,
        a.asOf,
        false,
        a.documentIds,
      );
      return text(
        results.length
          ? results
          : { results, diagnostics: c.knowledge.diagnostics(c.scopes, a.asOf) },
      );
    },
  });
  registry.add({
    name: 'investigate_knowledge',
    effect: 'read',
    description:
      'Bounded agentic RAG: supply up to four focused query variants or counterqueries. Inspect trace and citations, then decide whether another investigation is needed. No automatic truth verdict.',
    schema: z.object({
      queries: z.array(z.string().trim().min(1).max(1000)).min(1).max(4),
      limit: z.number().int().min(1).max(6).default(6),
      asOf: z.number().int().nonnegative().optional(),
    }),
    run: async (a, c) =>
      text(await c.knowledge.investigate(c.scopes, a.queries, a.limit, c.signal, a.asOf)),
  });
  registry.add({
    name: 'inspect_retrieval_trace',
    effect: 'read',
    description:
      'Read a scoped retrieval audit with candidate hashes, rankings and configuration identity. Candidates are not proof of relevance.',
    schema: z.object({ id: z.string() }),
    run: (a, c) => {
      const trace = c.store.get<any>('retrieval-trace', a.id);
      assert(
        trace.scopes.every((scope: string) => c.scopes.includes(scope)),
        'RETRIEVAL_SCOPE',
        'Trace belongs to another scope.',
      );
      const { query, ...metadata } = trace;
      return text(metadata);
    },
  });
  registry.add({
    name: 'assess_retrieval',
    effect: 'coordinate',
    atomic: true,
    description:
      'Record an agent assessment against retrieved evidence. Insufficient or conflicting evidence is not a negative corpus fact; no verification status is granted.',
    schema: z.object({
      id: z.string(),
      status: z.enum(['sufficient', 'insufficient', 'conflicting']),
      evidenceIds: z.array(z.string()).max(24),
      reason: z.string().min(1).max(2000),
      missing: z.array(z.string().max(500)).max(12),
    }),
    run: (a, c) => {
      const trace = c.store.get<any>('retrieval-trace', a.id);
      assert(
        trace.scopes.every((scope: string) => c.scopes.includes(scope)),
        'RETRIEVAL_SCOPE',
        'Trace belongs to another scope.',
      );
      assert(
        a.evidenceIds.every((id: string) => trace.hits?.some((hit: any) => hit.chunkId === id)) &&
          (a.status === 'insufficient' || a.evidenceIds.length > 0),
        'RETRIEVAL_EVIDENCE',
        'Cite retrieved chunks.',
      );
      for (const key of a.evidenceIds) {
        const hit = trace.hits.find((h: any) => h.chunkId === key);
        const chunk = c.store.db
          .prepare('SELECT text,scope,document_id FROM chunks WHERE id=?')
          .get(key) as any;
        assert(
          chunk &&
            c.scopes.includes(chunk.scope) &&
            chunk.document_id === hit.documentId &&
            createHash('sha256').update(chunk.text).digest('hex') === hit.contentHash,
          'RETRIEVAL_STALE',
          'Evidence changed or was removed; search again.',
        );
      }
      const assessment = {
        ...a,
        runId: c.run.id,
        at: Date.now(),
        kind: 'agent-assessment-not-proof',
      };
      c.store.put('retrieval-assessment', { ...assessment, id: c.run.id + ':' + a.id });
      return text(assessment);
    },
  });
}
