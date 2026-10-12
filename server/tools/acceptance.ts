import { z } from 'zod';
import type { ToolRegistry } from './registry.js';
import { TaskAcceptance } from '../services/task-acceptance.js';
export function installAcceptance(registry: ToolRegistry) {
  registry.add({
    name: 'record_task_acceptance',
    effect: 'coordinate',
    atomic: true,
    description:
      'Record a separate semantic acceptance judgment against current machine evidence. Explain criterion coverage and a counterexample attempted; use uncertain for gaps. This is not mathematical proof or human approval. Independent contracts reject author-only review.',
    schema: z.object({
      taskId: z.string(),
      revision: z.number().int(),
      verdict: z.enum(['accepted', 'rejected', 'uncertain']),
      rationale: z.string().min(10).max(4000),
      counterexample: z.string().min(10).max(4000),
      eventIds: z.array(z.number().int()).min(1).max(30),
    }),
    run: async (a, c) => ({
      content: JSON.stringify(await new TaskAcceptance(c.store).record(c.run, c.files, a)),
    }),
  });
}
