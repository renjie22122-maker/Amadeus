import { z } from 'zod';
import { ResearchCases } from '../services/research-case.js';
import type { ToolRegistry, ToolContext } from './registry.js';
const service = (c: ToolContext) => new ResearchCases(c.store, c.run, c.scopes);
const text = (v: unknown) => ({ content: JSON.stringify(v) });
export function installResearchTools(registry: ToolRegistry) {
  registry.add({
    name: 'read_knowledge_context',
    effect: 'coordinate',
    atomic: true,
    description:
      'Long-range reading navigation without vector retrieval or extra model calls. overview returns paginated source openings in order; context expands an ordinal anchor to nearby passages, across chunk boundaries. During research pass caseId: records fully returned passages and applies a shared 16-read / 160,000-character budget. Repeated windows from the same member are rejected. Not a chapter summary, exhaustive reading or truth verdict.',
    schema: z.object({
      documentId: z.string(),
      view: z.enum(['overview', 'context']).default('context'),
      offset: z.number().int().min(0).default(0),
      anchor: z.number().int().min(0).default(0),
      radius: z.number().int().min(0).max(4).default(2),
      caseId: z.string().optional(),
    }),
    run: (a, c) =>
      text(
        a.view === 'overview'
          ? service(c).outline(a.documentId, a.offset, a.caseId)
          : service(c).readContext(a.documentId, a.anchor, a.radius, a.caseId),
      ),
  });
  registry.add({
    name: 'create_research_case',
    effect: 'coordinate',
    atomic: true,
    description:
      'For genuinely ambiguous multi-source work, persist a bounded comparison of alternative explanations, reading notes and discriminating evidence gaps. Not needed for simple lookup. Visible only in this conversation or task tree with compatible scopes. Do not create cases to bypass retrieval limits.',
    schema: z.object({ question: z.string().trim().min(1).max(2000) }),
    run: (a, c) => text(service(c).create(a.question)),
  });
  registry.add({
    name: 'inspect_research_case',
    effect: 'coordinate',
    atomic: true,
    description:
      'Read shared research hypotheses; reconcile pending attempts of stopped owners as interrupted without replay (elapsed time estimated conservatively). Read source-bound notes, missing observations, retrieval attempts and stale evidence. Repeated citations or peer agreement are not independent evidence. Reuse existing context before searching again.',
    schema: z.object({ id: z.string() }),
    run: (a, c) => text(service(c).recover(a.id)),
  });
  registry.add({
    name: 'update_research_case',
    effect: 'coordinate',
    atomic: true,
    description:
      'Record alternative explanations, support/counterevidence, what would distinguish them, and source-bound reading notes (timeline, relations, recurring patterns or constraints). Replace the current working comparison with a revision check; prior assessments stay in audit events. A conclusion is an agent interpretation, never proof. Use inconclusive when evidence cannot distinguish alternatives. No fabricated numeric confidence.',
    schema: z.object({
      id: z.string(),
      revision: z.number().int().min(1),
      hypotheses: z
        .array(
          z.object({
            id: z.string().min(1).max(80),
            explanation: z.string().min(1).max(2000),
            supports: z.array(z.string()).max(24),
            counters: z.array(z.string()).max(24),
            missing: z.array(z.string().max(500)).max(8),
            discriminator: z.string().min(1).max(1000),
          }),
        )
        .min(1)
        .max(6),
      notes: z
        .array(
          z.object({
            kind: z
              .enum(['timeline', 'relationship', 'pattern', 'constraint', 'summary'])
              .default('summary'),
            timeContext: z.string().max(500).optional(),
            text: z.string().min(1).max(1500),
            evidenceIds: z.array(z.string()).min(1).max(12),
            nature: z.enum(['observation', 'reported-claim', 'inference']),
            limitation: z.string().max(1000),
          }),
        )
        .max(24)
        .default([]),
      status: z.enum(['open', 'concluded', 'inconclusive']).default('open'),
      conclusion: z.string().max(4000).default(''),
    }),
    run: (a, c) =>
      text(service(c).update(a.id, a.revision, a.hypotheses, a.notes, a.status, a.conclusion)),
  });
  registry.add({
    name: 'investigate_research_gap',
    effect: 'coordinate',
    description:
      'Execute ONE focused retrieval for a specific missing observation that distinguishes recorded alternatives. Reads existing case budget first: max six attempts, stops after two successful attempts without new passage hashes, rejects repeated queries and concurrent replay. Failed attempts consume count/time budget, not the evidence no-gain counter. Single-query deadline is 180 seconds, extended to 300 after a timeout, within 12 minutes cumulative retrieval time. Two consecutive service failures stop with a service diagnosis; one explicit retry of a failed query is allowed, never an automatic loop. Prefer expanding already-found passages before new search. Returns remaining gaps, not an answer or corpus-absence claim.',
    schema: z.object({
      id: z.string(),
      query: z.string().trim().min(1).max(1000),
      gap: z.string().trim().min(1).max(1000),
      distinguishes: z.array(z.string()).min(2).max(6),
      documentIds: z.array(z.string()).max(20).default([]),
    }),
    run: async (a, c) => {
      const s = service(c),
        current = s.get(a.id),
        index = s.reserve(a.id, a.query, a.gap, a.distinguishes);
      try {
        const result = await c.knowledge.investigate(
          c.scopes,
          [a.query],
          6,
          c.signal,
          current.asOf,
          a.documentIds,
          s.get(a.id).attempts[index].timeLimitMs,
        );
        const failed =
          result.budget.stopReason === 'retrieval-failed' ||
          result.budget.stopReason === 'time-budget';
        return text({
          retrieval: result,
          research: s.finish(
            a.id,
            index,
            result,
            failed,
            failed
              ? result.budget.stopReason === 'time-budget'
                ? 'timeout'
                : 'retrieval-failed'
              : undefined,
          ),
        });
      } catch (error) {
        if (s.get(a.id).attempts[index].status === 'running')
          s.finish(
            a.id,
            index,
            undefined,
            true,
            c.signal.aborted ? 'cancelled' : 'retrieval-failed',
          );
        throw error;
      }
    },
  });
}
