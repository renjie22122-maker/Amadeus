import { memoryDecay } from '../../shared/memory-decay.js';
import { memoryAccessible, memoryReach } from '../../shared/memory-scope.js';
import { memoryValid } from './memory-lifecycle.js';
import type { Memory } from '../../shared/types.js';
export function terms(text: string) {
  const words = text.toLowerCase().match(/[a-z0-9_]+|[\u3400-\u9fff]+/g) || [];
  return new Set(
    words.flatMap((word) =>
      /[\u3400-\u9fff]/.test(word)
        ? word.length < 2
          ? [word]
          : Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2))
        : [word],
    ),
  );
}
export function recallMemories(
  memories: Memory[],
  query: string,
  projectId: string | null,
  now = Date.now(),
  semantic = new Map<string, number>(),
  conversationId?: string,
  activityAges = new Map<string, number>(),
  isolatedScope?: string,
) {
  const queryTerms = terms(query);
  const eligible = memories.filter(
    (m) =>
      memoryValid(m, now) &&
      memoryAccessible(m, conversationId) &&
      (isolatedScope
        ? m.scope === isolatedScope
        : m.scope === 'user' || (!!projectId && m.scope === 'project:' + projectId)),
  );
  const frequency = new Map<string, number>();
  for (const m of eligible)
    for (const term of terms(m.content)) frequency.set(term, (frequency.get(term) || 0) + 1);
  const ranked = eligible
    .map((m) => {
      const tokens = terms(m.content + ' ' + (m.conditions || ''));
      // Shared interaction context is useful even for short greetings. It remains
      // fallible, conditional data; cap it below and never import another chat.
      let relevance =
        (isolatedScope && m.chatSubject === 'assistant' ? 1 : 0) + 3 * (semantic.get(m.id) || 0);
      for (const term of queryTerms)
        if (tokens.has(term))
          relevance += Math.log(1 + eligible.length / (frequency.get(term) || 1));
      const decay = memoryDecay(m, now, activityAges.get(m.id) || 0);
      return {
        ...m,
        decay,
        relevance,
        score:
          (relevance / Math.sqrt(Math.max(1, tokens.size)) +
            (m.scope.startsWith('project:') ? 0.08 : 0)) *
          decay.factor,
      };
    })
    .filter((m) => m.relevance > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  // Specific structured facts override broader facts only for the same entity,
  // attribute and applicability condition. Original memories are never mutated.
  const specificity = (m: Memory) =>
    (memoryReach(m) === 'conversation' ? 2 : 0) + (m.scope.startsWith('project:') ? 1 : 0);
  const factKey = (m: Memory) =>
    m.entityId && m.attribute
      ? JSON.stringify([m.entityId, m.attribute, (m.conditions || '').trim().toLowerCase()])
      : null;
  const winners = new Map<string, number>();
  for (const m of ranked) {
    const key = factKey(m);
    if (key) winners.set(key, Math.max(winners.get(key) || 0, specificity(m)));
  }
  const applicable = ranked.filter((m) => {
    const key = factKey(m);
    return !key || specificity(m) === winners.get(key);
  });
  const seen = new Set<string>(),
    selected = [];
  let size = 0,
    interactionCount = 0;
  for (const m of applicable) {
    if (m.chatSubject === 'assistant' && interactionCount >= 4) continue;
    const key = m.content.trim().toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key) || size + m.content.length > 8000) continue;
    if (m.chatSubject === 'assistant') interactionCount++;
    seen.add(key);
    size += m.content.length;
    selected.push({
      id: m.id,
      content: m.content,
      source: m.source,
      scope: m.scope,
      revision: m.revision,
      status: m.status,
      kind: m.kind,
      stability: m.stability,
      observedAt: m.observedAt ?? m.validFrom ?? m.createdAt,
      freshness:
        m.stability === 'evolving' || m.kind === 'fact' || m.kind === 'goal'
          ? 'dated-report-not-guaranteed-current'
          : 'source-bound-context',
      assessedReach: memoryReach(m),
      validFrom: m.validFrom,
      validUntil: m.validUntil,
      entityId: m.entityId,
      chatSubject: m.chatSubject,
      attribute: m.attribute,
      value: m.value,
      evidence: m.evidence,
      conditions: m.conditions,
      applicability: m.conditions?.trim()
        ? 'check-conditions-before-use'
        : 'within-authorized-scope',
      relevance: { lexicalOrSemanticMatch: m.relevance, calibratedConfidence: null },
      broaderMemoryIds: ranked
        .filter(
          (other) =>
            factKey(m) && factKey(other) === factKey(m) && specificity(other) < specificity(m),
        )
        .map((other) => other.id),
      conflictingMemoryIds: applicable
        .filter(
          (other) =>
            other.id !== m.id &&
            factKey(m) &&
            factKey(other) === factKey(m) &&
            other.value !== m.value,
        )
        .map((other) => other.id),
      recallScope: m.recallScope,
      decay: m.decay,
    });
    if (selected.length === 12) break;
  }
  return selected;
}
