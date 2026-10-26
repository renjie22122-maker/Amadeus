import type { MemorySource } from './chat-memory-source.js';
import type { Memory } from '../../shared/types.js';
/** Old sources explain new evidence; they never advance the incremental cursor. */
export function memoryContext(
  sources: MemorySource[],
  pending: MemorySource[],
  existing: Memory[],
  eligible: (s: MemorySource) => boolean,
) {
  const current = new Set(pending.map((s) => s.id));
  const last = pending.at(-1)?.id ?? 0;
  const old = sources.filter((s) => s.id <= last && !current.has(s.id) && eligible(s));
  const referenced = new Set(existing.flatMap((m) => (m.evidence || []).map((e) => e.eventId)));
  const selected = new Map<number, MemorySource>();
  const add = (candidates: MemorySource[], budget: number) => {
    for (const source of candidates) {
      if (selected.has(source.id)) continue;
      const text = source.text.slice(0, 4000);
      if (text.length > budget) continue;
      selected.set(source.id, { ...source, text });
      budget -= text.length;
    }
    return budget;
  };
  const remaining = add(old.slice(-24).reverse(), 16000);
  add(old.filter((s) => referenced.has(s.id)).reverse(), 16000 + remaining);
  return [...selected.values()].sort((a, b) => a.id - b.id);
}
/** These host-generated labels are metadata, never recursively embedded prose. */
export function memoryProse(content: string) {
  return content
    .replace(
      /^(?:\s*\[(?:Assistant interaction context|Conversation context|Platform sender [^\]]+)\]\s*)+/i,
      '',
    )
    .trim();
}
export const contextualMemoryGuidance =
  ' Interpret a discussion as a whole, not one memory per message. Resolve pronouns and references using contextMessages and existing evidence. If unresolved, omit the fragment rather than store an ambiguous durable instruction. Combine supporting quotes for one coherent preference or procedure. Questions, jokes and assistant promises are not adopted user requirements. Content must be plain prose without platform/interaction wrapper labels. An item must cite a NEW messages entry as its primary eventId; older contextMessages may support it. To refine an existing automatic memory, return updatesMemoryId only when the same subject, conditions and meaning are preserved or explicitly clarified; include enough evidence for the complete revised content. Do not erase unrelated details. For experience, distinguish observed success and observed failure using experienceOutcome. A failed test may support a conditional pitfall or recovery method, not a universal prohibition. Never infer root cause from a timeout, cancellation or rejected approval. Later successful evidence may qualify or explicitly replace an earlier failure conclusion, preserving its conditions and history. For experience, cite verified-tool evidence, state tested prerequisites, ordered steps, validation, failure boundaries and when to revalidate. A successful command is not proof that the entire task succeeded; never invent unseen intermediate steps. Old successful methods are conditional guidance, not authority to bypass checks. Expiration must be grounded in a source deadline, never guessed; age alone lowers relevance, not truth. Summaries and existing memories are navigation aids, not substitute evidence.';

/** An event receipt can confirm a memory once. Reading or recalling it does not. */
export function reinforcement(memory: Memory, source: MemorySource, conversationId: string) {
  if (
    !memory.active ||
    !memory.automatic ||
    memory.conflictReviewRequired ||
    memory.status === 'disputed' ||
    (memory.expiresAt && memory.expiresAt <= Date.now()) ||
    memory.validUntil ||
    memory.sourceConversationId !== conversationId ||
    memory.sourceEventId === source.id ||
    memory.evidence?.some((e) => e.conversationId === conversationId && e.eventId === source.id)
  )
    return {};
  if (source.at <= (memory.reinforcedAt || memory.observedAt || memory.createdAt)) return {};
  return {
    reinforcedAt: source.at,
    reinforcedEventId: source.id,
    reinforcementCount: (memory.reinforcementCount || 0) + 1,
  };
}
