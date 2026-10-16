import { z } from 'zod';
import type { ToolRegistry } from './registry.js';
import { NotStartedError, errorMessage } from '../core/errors.js';
import { workflowValue, workflowObservation } from './workflow-data.js';
import { retrieveTools } from './capability-retrieval.js';
export function installComposition(registry: ToolRegistry) {
  registry.add({
    name: 'read_json',
    effect: 'read',
    parallelSafe: true,
    description:
      'Read and parse an entire scoped UTF-8 JSON file up to 1 MB. Returns structured JSON without line numbers, suitable for workflow result references. Invalid or oversized JSON fails explicitly.',
    schema: z.object({ path: z.string().min(1).max(2048) }),
    run: async (a, c) => ({
      content: JSON.stringify(JSON.parse(await c.files.read(a.path, 1000000))),
    }),
  });

  registry.add({
    name: 'tool_workflow',
    effect: 'coordinate',
    description:
      'Execute up to 12 explicit sequential tool calls in one model step. No arbitrary JS or shell bypass. Every member keeps its own permissions, approvals, effects and audit. Stops at first non-success; never retries. No nested compositions. Arguments support data-only {$ref: "0.data.field"} from earlier results and {$ref: "item"} in forEach (up to 20 items). when may reference a prior result; only a boolean is accepted. No code evaluation. Total executed calls <= 40.',
    schema: z.object({
      steps: z
        .array(
          z.object({
            name: z.string(),
            arguments: z.record(z.string(), z.unknown()),
            when: z.union([z.boolean(), z.object({ $ref: z.string() })]).optional(),
            forEach: z
              .union([z.array(z.unknown()).max(20), z.object({ $ref: z.string() })])
              .optional(),
          }),
        )
        .min(1)
        .max(12),
    }),
    run: async (a, c) => {
      if (!c.invokeTool) throw new NotStartedError('WORKFLOW_CONTEXT', 'Audited runtime required.');
      if (
        a.steps.some((s: any) =>
          ['tool_workflow', 'batch_read_tools', 'search_capabilities'].includes(s.name),
        )
      )
        throw new NotStartedError('WORKFLOW_RECURSION', 'Nested composition is not allowed.');
      const results: any[] = [];
      let callIndex = 0;
      try {
        for (const [index, step] of a.steps.entries()) {
          c.signal.throwIfAborted();
          const condition = step.when === undefined ? true : workflowValue(step.when, results);
          if (typeof condition !== 'boolean')
            throw new NotStartedError('WORKFLOW_CONDITION', 'when must resolve to a boolean.');
          if (!condition) {
            results.push({ index, name: step.name, skipped: true });
            continue;
          }
          const items =
            step.forEach === undefined ? [undefined] : workflowValue(step.forEach, results);
          if (!Array.isArray(items) || items.length > 20 || callIndex + items.length > 40)
            throw new NotStartedError(
              'WORKFLOW_BOUND',
              'Up to 20 items per step and 40 calls per workflow.',
            );
          const members: any[] = [];
          for (const item of items) {
            c.signal.throwIfAborted();
            const args = workflowValue(step.arguments, results, item);
            const result = workflowObservation(await c.invokeTool(step.name, args, callIndex++));
            members.push(result);
            c.store.event(c.run.conversationId, c.run.id, 'tool.progress', {
              callId: c.callId,
              completedCalls: callIndex,
              step: index,
              totalSteps: a.steps.length,
            });
            if (result.outcome?.code === 'COMMAND_SCHEDULED')
              return {
                content: JSON.stringify({
                  results: [...results, { index, name: step.name, ...result }],
                  pausedStep: index,
                  members,
                  notStarted: a.steps.length - index - 1,
                  replayed: false,
                  instruction:
                    'The command is still running. Handle user input, then wait for this job and reconsider only unstarted steps. Never replay completed steps.',
                }),
                outcome: { status: 'succeeded', code: 'COMMAND_SCHEDULED' },
              };
            if (result.outcome?.status !== 'succeeded')
              return {
                content: JSON.stringify({
                  results: [...results, { index, name: step.name, ...result }],
                  failedStep: index,
                  members,
                  notStarted: a.steps.length - index - 1,
                  replayed: false,
                }),
                outcome:
                  callIndex > 1
                    ? { status: 'failed', code: 'WORKFLOW_PARTIAL', executionStarted: true }
                    : result.outcome || { status: 'failed', code: 'WORKFLOW_FAILED' },
              };
          }
          results.push({
            index,
            name: step.name,
            ...(step.forEach === undefined
              ? members[0]
              : { data: members, outcome: { status: 'succeeded' } }),
          });
        }
      } catch (error) {
        c.signal.throwIfAborted();
        if (!callIndex) throw error;
        return {
          content: JSON.stringify({
            results,
            completedCalls: callIndex,
            error: errorMessage(error),
            replayed: false,
          }),
          outcome: { status: 'failed', code: 'WORKFLOW_PARTIAL', executionStarted: true },
        };
      }
      return {
        content: JSON.stringify({ results, replayed: false }),
        outcome: { status: 'succeeded', code: 'OK' },
      };
    },
  });
  registry.add({
    name: 'search_tools',
    effect: 'read',
    description:
      'Discover available tools by name/description with English keywords or Chinese aliases. semantic=true optionally uses configured LOCAL embeddings, otherwise explicitly falls back to lexical search. Empty query lists a paginated catalog. Matching schemas become available on the next model step. Discovery grants no permissions. Use for media, team, MCP, memory, skill resources and other capabilities not currently listed.',
    schema: z.object({
      query: z.string().max(300).default(''),
      semantic: z.boolean().default(false),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(12).default(6),
    }),
    run: async (a, c) => {
      const result = await retrieveTools(
        registry.specs(c),
        a.query,
        a.offset,
        a.limit,
        c.config.get().embedding,
        c.signal,
        a.semantic,
      );
      const prior = c.store.maybe<{ id: string; names: string[] }>('tool-selection', c.run.id);
      c.store.put('tool-selection', {
        id: c.run.id,
        names: [...new Set([...(prior?.names || []), ...result.results.map((t) => t.name)])],
      });
      return {
        content: JSON.stringify({
          ...result,
          offset: a.offset,
          nextOffset:
            a.offset + result.results.length < result.total
              ? a.offset + result.results.length
              : null,
          permissionsGranted: false,
        }),
      };
    },
  });
  registry.add({
    name: 'search_capabilities',
    effect: 'read',
    description:
      'Search tools, skills, memories and knowledge using their existing scope checks. Local semantic tool search is optional. Sources remain separate; retrieved text never grants permission.',
    schema: z.object({
      query: z.string().min(1).max(300),
      sources: z
        .array(z.enum(['tools', 'skills', 'memory', 'knowledge']))
        .min(1)
        .max(4)
        .default(['tools', 'skills']),
      semantic: z.boolean().default(false),
    }),
    run: async (a, c) => {
      if (!c.invokeTool) throw new NotStartedError('WORKFLOW_CONTEXT', 'Audited runtime required.');
      const calls = {
        tools: ['search_tools', { query: a.query, semantic: a.semantic }],
        skills: ['find_skills', { query: a.query, limit: 6 }],
        memory: ['recall_memories', { query: a.query }],
        knowledge: [
          'search_knowledge',
          { query: a.query, limit: 6, mode: a.semantic ? 'hybrid' : 'lexical' },
        ],
      } as const;
      const results: Record<string, unknown> = {};
      let index = 0;
      for (const source of [...new Set(a.sources)] as Array<keyof typeof calls>) {
        const [name, args] = calls[source];
        results[source] = workflowObservation(await c.invokeTool(name, args, index++));
      }
      return { content: JSON.stringify({ results, permissionsGranted: false }) };
    },
  });
  registry.add({
    name: 'batch_read_tools',
    effect: 'read',
    description:
      'Run up to 20 independent, explicitly parallel-safe read tools in one model step. Each call retains its own audit/outcome and permission checks. No writes, commands, network, MCP, images or recursive batches. Failures are returned individually; use read_spill for oversized aggregate output.',
    schema: z.object({
      calls: z
        .array(z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()) }))
        .min(1)
        .max(20),
    }),
    run: async (a, c) => {
      if (!c.invokeRead)
        throw new NotStartedError('BATCH_CONTEXT', 'Batch execution requires the audited runtime.');
      // Validate the entire plan before starting any member.
      for (const call of a.calls)
        if (
          !registry.parallelSafe(call.name) ||
          !registry.specs(c).some((t) => t.name === call.name)
        )
          throw new NotStartedError(
            'BATCH_READ_ONLY',
            'Every member must be an available parallel-safe read tool.',
          );
      const results: any[] = new Array(a.calls.length);
      let next = 0;
      const settled = await Promise.allSettled(
        Array.from({ length: Math.min(4, a.calls.length) }, async () => {
          while (next < a.calls.length) {
            c.signal.throwIfAborted();
            const index = next++;
            const call = a.calls[index];
            results[index] = {
              index,
              name: call.name,
              ...(await c.invokeRead!(call.name, call.arguments, index)),
            };
          }
        }),
      );
      const rejected = settled.find((x) => x.status === 'rejected');
      if (rejected?.status === 'rejected') throw rejected.reason;
      return {
        outcome: {
          status: results.every((x) => x.outcome?.status === 'succeeded') ? 'succeeded' : 'failed',
          code: results.every((x) => x.outcome?.status === 'succeeded') ? 'OK' : 'BATCH_PARTIAL',
        },
        content: JSON.stringify({
          results,
          note: 'Read observations only; batch success does not prove task correctness.',
        }),
      };
    },
  });
}
