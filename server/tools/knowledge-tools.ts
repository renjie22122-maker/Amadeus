import { ResearchCases } from '../services/research-case.js';
import { installResearchTools } from './research.js';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { assert } from '../core/errors.js';
import { documentAt } from '../services/knowledge-versions.js';
import type { ToolRegistry } from './registry.js';
const text = (value: unknown) => ({
  content: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
});
export function installKnowledgeTools(registry: ToolRegistry) {
  installResearchTools(registry);
  registry.add({
    name: 'read_knowledge_document',
    effect: 'read',
    description:
      'Read indexed passages in document order, including neighboring context. Does not require source-file access or embeddings. Paginate to inspect evidence; during research pass caseId to share the reading budget and register evidence. Never claim full-document coverage from one page.',
    schema: z.object({
      documentId: z.string(),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(12).default(4),
      asOf: z.number().optional(),
      caseId: z.string().optional(),
    }),
    run: (a, c) => {
      const research = new ResearchCases(c.store, c.run, c.scopes);
      const caseRecord = a.caseId ? research.get(a.caseId) : undefined;
      const doc = c.store.get<any>('document', a.documentId);
      assert(
        c.scopes.includes(doc.scope) && documentAt(doc, caseRecord?.asOf ?? a.asOf ?? Date.now()),
        'KNOWLEDGE_SCOPE',
        'Document is outside the current accessible version.',
      );
      const total = (
        c.store.db
          .prepare('SELECT count(*) AS n FROM chunks WHERE document_id=?')
          .get(doc.id) as any
      ).n;
      const chunks = c.store.db
        .prepare(
          'SELECT id,ordinal,text FROM chunks WHERE document_id=? ORDER BY ordinal LIMIT ? OFFSET ?',
        )
        .all(doc.id, a.limit, a.offset);
      if (caseRecord)
        research.recordRead(
          caseRecord.id,
          'document:' +
            doc.id +
            ':' +
            a.offset +
            ':' +
            a.limit +
            ':' +
            createHash('sha256').update(JSON.stringify(chunks)).digest('hex'),
          chunks.reduce((n: number, r: any) => n + r.text.length, 0),
          chunks.map((r: any) => r.id),
        );
      return text({
        caseRevision: caseRecord ? research.get(caseRecord.id).revision : undefined,
        documentId: doc.id,
        name: doc.name,
        version: doc.version,
        total,
        chunks,
        nextOffset: a.offset + a.limit < total ? a.offset + a.limit : null,
        notice: 'Source passages, not a verification verdict.',
      });
    },
  });
  registry.add({
    name: 'list_knowledge_documents',
    effect: 'read',
    description:
      'List current scoped knowledge document IDs and names without vector search. Filter by title before document-specific retrieval.',
    schema: z.object({
      query: z.string().default(''),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(100).default(30),
    }),
    run: (a, c) => {
      const docs = c.store
        .list<any>('document')
        .filter(
          (d) =>
            c.scopes.includes(d.scope) &&
            documentAt(d, Date.now()) &&
            String(d.name).toLowerCase().includes(a.query.toLowerCase()),
        )
        .sort((a, b) => a.id.localeCompare(b.id));
      return text({
        total: docs.length,
        documents: docs
          .slice(a.offset, a.offset + a.limit)
          .map((d) => ({ id: d.id, name: d.name, scope: d.scope })),
        nextOffset: a.offset + a.limit < docs.length ? a.offset + a.limit : null,
      });
    },
  });
  registry.add({
    name: 'search_knowledge',
    description:
      'Search only knowledge attached to this conversation or project. Auto/lookup performs one query; research broadens candidates without manufacturing query variants. Use a research case for hypothesis-driven follow-up. Cite returned document and chunk IDs.',
    effect: 'read',
    schema: z.object({
      query: z.string().min(1),
      strategy: z.enum(['auto', 'lookup', 'research']).default('auto'),
      mode: z.enum(['hybrid', 'lexical']).default('hybrid'),
      documentIds: z.array(z.string()).max(20).default([]),
      limit: z.number().int().min(1).max(12).default(6),
      asOf: z.number().int().nonnegative().optional(),
    }),
    run: async (a, c) => {
      const research = a.strategy === 'research';
      if (research && a.mode !== 'lexical') {
        return text(
          await c.knowledge.investigate(
            c.scopes,
            [a.query],
            a.limit,
            c.signal,
            a.asOf,
            a.documentIds,
          ),
        );
      }
      const results = await c.knowledge.hybrid(
        c.scopes,
        a.query,
        a.limit,
        c.signal,
        a.asOf,
        false,
        a.documentIds,
        a.mode,
      );
      return text(
        results.length
          ? results
          : {
              results,
              diagnostics: c.knowledge.diagnostics(c.scopes, a.asOf),
              retrievalDiagnostics: c.knowledge.lastRetrieval,
            },
      );
    },
  });
  registry.add({
    name: 'investigate_knowledge',
    effect: 'read',
    description:
      'Bounded agentic RAG: supply up to four focused query variants or counterqueries. Inspect trace and citations, then decide whether another investigation is needed. No automatic truth verdict.',
    schema: z.object({
      documentIds: z.array(z.string()).max(20).default([]),
      queries: z.array(z.string().trim().min(1).max(1000)).min(1).max(4),
      limit: z.number().int().min(1).max(6).default(6),
      asOf: z.number().int().nonnegative().optional(),
    }),
    run: async (a, c) =>
      text(
        await c.knowledge.investigate(
          c.scopes,
          a.queries,
          a.limit,
          c.signal,
          a.asOf,
          a.documentIds,
        ),
      ),
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
      'Record an agent assessment against retrieved evidence. Insufficient or conflicting evidence is not a negative corpus fact; no verification status is granted. Optional claims separate source nature, inference, edition context and limitations; classifications are agent assessments, not automatic truth labels.',
    schema: z.object({
      id: z.string(),
      status: z.enum(['sufficient', 'insufficient', 'conflicting']),
      evidenceIds: z.array(z.string()).max(24),
      reason: z.string().min(1).max(2000),
      missing: z.array(z.string().max(500)).max(12),
      claims: z
        .array(
          z.object({
            claim: z.string().min(1).max(1000),
            evidenceIds: z.array(z.string()).min(1).max(24),
            sourceNature: z.enum([
              'direct-observation',
              'attributed-statement',
              'editorial-commentary',
              'secondary-source',
              'uncertain',
            ]),
            conclusion: z.enum(['observation', 'reported-claim', 'inference', 'unresolved']),
            versionContext: z.string().max(1000).optional(),
            limitation: z.string().max(1000).optional(),
          }),
        )
        .max(24)
        .default([]),
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
      for (const claim of a.claims) {
        assert(
          claim.evidenceIds.every((id: string) => a.evidenceIds.includes(id)),
          'RETRIEVAL_EVIDENCE',
          'Claim citations must be among assessed retrieved chunks.',
        );
        assert(
          claim.conclusion !== 'observation' || claim.sourceNature === 'direct-observation',
          'RETRIEVAL_ATTRIBUTION',
          'Testimony, commentary and secondary sources cannot be recorded as direct observations; attribute or qualify the claim.',
        );
      }
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
