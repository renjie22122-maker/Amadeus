/** Advisory only: never extends the configured budget or bypasses delivery checks. */
export function modelStepBudget(limit: number, used: number) {
  const remaining = limit > 0 ? Math.max(0, limit - used) : null;
  if (remaining === null || remaining > 3) return [];
  return [
    {
      role: 'system' as const,
      content:
        `Model calls remaining including this request: ${remaining}. Reserve capacity for a final response. ` +
        'Prioritize decisive verification over more broad searches. If evidence is insufficient, state the unresolved gap; do not guess or claim completion. Existing verification and approval requirements still apply.',
    },
  ];
}
