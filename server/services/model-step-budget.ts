import type { ResearchProgress } from './research-progress.js';
/** Advisory only: never extends the configured budget or bypasses delivery checks. */
export function modelStepBudget(limit: number, used: number, research?: ResearchProgress) {
  const remaining = limit > 0 ? Math.max(0, limit - used) : null;
  if (remaining === null || remaining > Math.max(3, Math.ceil(limit / 4))) return [];
  return [
    {
      role: 'system' as const,
      content:
        `Model calls remaining including this request: ${remaining}. Reserve capacity for a final response. ` +
        (research?.attempts
          ? `Acquisition attempts: ${research.attempts}; unusable responses/errors: ${research.unusable || 0}; novel response bodies/source lists: ${research.novel || 0}. Novel content is not verified relevance or independent evidence. `
          : '') +
        'Prioritize decisive verification over more broad searches. If evidence is insufficient, state the unresolved gap; do not guess or claim completion. Existing verification and approval requirements still apply.',
    },
  ];
}
