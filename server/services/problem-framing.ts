import { z } from 'zod';
import type { Run } from '../../shared/types.js';
import type { Store } from '../storage/store.js';
import { assert } from '../core/errors.js';

const text = z.string().trim().min(1).max(1200);
export const problemFrameInput = z.object({
  revision: z.number().int().min(0),
  objective: text,
  requirements: z.array(text).min(1).max(12),
  assumptions: z.array(text).max(12),
  unknowns: z.array(text).max(12),
  hypotheses: z
    .array(
      z.object({
        explanation: text,
        discriminator: text,
        evidence: z.array(z.number().int().positive()).max(12),
        assessment: z.enum(['unassessed', 'supported', 'contradicted']),
      }),
    )
    .max(8),
  acceptance: z.array(text).max(12),
  decisionEvidence: z.array(z.number().int().positive()).max(12).default([]),
  verificationGaps: z.array(text).max(12).default([]),
  changeReason: text.optional(),
  decision: z.enum(['investigate', 'plan', 'inconclusive']),
  reason: text,
  nextCheck: text,
  investigationBudget: z.number().int().min(1).max(20),
});
type Frame = z.infer<typeof problemFrameInput> & {
  id: string;
  startedAfterEventId: number;
};

// Run-local model assessments, not permissions, truth scores or completion gates.
export function inspectProblemFrame(store: Store, run: Run) {
  const frame = store.maybe<Frame>('problem-frame', run.id);
  if (!frame) return null;
  const observations = store.db
    .prepare(
      "SELECT COUNT(*) AS count FROM events WHERE run_id=? AND id>? AND type='tool.completed' AND json_extract(data,'$.name') NOT IN ('update_problem_frame','inspect_problem_frame')",
    )
    .get(run.id, frame.startedAfterEventId) as { count: number };
  return {
    ...frame,
    observedCalls: observations.count,
    reviewDue: frame.decision === 'investigate' && observations.count >= frame.investigationBudget,
    meaning:
      'Model-authored problem definition. Evidence IDs establish provenance only; failed checks may be diagnostic evidence. Budget is a reassessment point, not permission or an execution limit. Compare current user intent and artifacts before relying on this record.',
  };
}

export function updateProblemFrame(store: Store, run: Run, input: unknown) {
  const value = problemFrameInput.parse(input);
  assert(
    JSON.stringify(value).length <= 16000,
    'FRAME_TOO_LARGE',
    'Keep the problem frame within 16000 characters; reference evidence rather than copying it.',
  );
  return store.transaction(() => {
    const previous = store.maybe<Frame>('problem-frame', run.id);
    assert(
      value.revision === (previous?.revision || 0),
      'FRAME_CHANGED',
      'Inspect the current problem frame before updating.',
    );
    const removedRequirements =
      previous?.requirements.filter((r) => !value.requirements.includes(r)) || [];
    const objectiveChanged = !!previous && previous.objective !== value.objective;
    assert(
      !previous || (!removedRequirements.length && !objectiveChanged) || value.changeReason,
      'FRAME_SCOPE_CHANGE',
      'Explain changed objectives or removed requirements in changeReason; a revision is not authorization to reduce scope.',
    );
    for (const hypothesis of value.hypotheses) {
      assert(
        hypothesis.assessment === 'unassessed' || hypothesis.evidence.length > 0,
        'FRAME_EVIDENCE',
        'Assessed hypotheses require observed evidence.',
      );
    }
    for (const eventId of new Set([
      ...value.decisionEvidence,
      ...value.hypotheses.flatMap((h) => h.evidence),
    ])) {
      const event = store.db
        .prepare('SELECT run_id,type,data FROM events WHERE id=?')
        .get(eventId) as any;
      assert(
        event?.run_id === run.id &&
          event.type === 'tool.completed' &&
          !['update_problem_frame', 'inspect_problem_frame'].includes(JSON.parse(event.data).name),
        'FRAME_EVIDENCE',
        'Evidence must reference an actual tool result in this run, not a framing assertion.',
      );
    }
    assert(
      value.decision !== 'plan' ||
        (value.acceptance.length > 0 &&
          (value.decisionEvidence.length > 0 ||
            value.hypotheses.some((h) => h.assessment === 'supported'))),
      'FRAME_NOT_READY',
      'Planning from an investigation requires acceptance criteria and observed decision evidence or a supported hypothesis. Feature work need not invent a defect hypothesis.',
    );
    const latest = store.db
      .prepare('SELECT COALESCE(MAX(id),0) AS id FROM events WHERE run_id=?')
      .get(run.id) as { id: number };
    const frame: Frame = {
      ...value,
      id: run.id,
      revision: value.revision + 1,
      startedAfterEventId: previous?.startedAfterEventId ?? latest.id,
      // Revising a frame cannot silently replenish its investigation allowance.
      investigationBudget: previous?.investigationBudget ?? value.investigationBudget,
    };
    store.put('problem-frame', frame);
    store.event(run.conversationId, run.id, 'problem.framed', {
      ...frame,
      removedRequirements,
      previousObjective: objectiveChanged ? previous?.objective : undefined,
    });
    return inspectProblemFrame(store, run);
  });
}
