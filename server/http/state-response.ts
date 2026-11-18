import { createHash } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';

/** Explicit client revalidation; no disk/browser cache of private workspace state. */
export function conditionalState(req: FastifyRequest, reply: FastifyReply, state: unknown) {
  const body = JSON.stringify(state);
  const etag = '"' + createHash('sha256').update(body).digest('hex') + '"';
  reply.header('ETag', etag).header('Cache-Control', 'no-store');
  if (req.headers['if-none-match'] === etag) return reply.code(304).send();
  return reply.type('application/json').send(body);
}

/** Detailed model-input diagnostics remain available through the inspector. */
export function stateRun(
  run: import('../../shared/types.js').Run,
  shell: boolean,
): Omit<import('../../shared/types.js').Run, 'checkpoints'> {
  const { checkpoints, ...metadata } = run;
  if (!shell) return metadata;
  const { contextSample, providerFingerprint, ...summary } = metadata;
  return summary;
}

/** Keep current conversation trees and unfinished work; historical turns load via conversation history. */
export function shellRuns(runs: import('../../shared/types.js').Run[]) {
  const latest = new Map<string, string>(),
    byId = new Map(runs.map((r) => [r.id, r]));
  const children = new Map<string, string[]>(),
    keep = new Set<string>();
  for (const run of runs) {
    latest.set(run.conversationId, run.id);
    if (run.parentRunId)
      children.set(run.parentRunId, [...(children.get(run.parentRunId) || []), run.id]);
    if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)) keep.add(run.id);
  }
  for (const id of latest.values()) keep.add(id);
  for (const id of [...keep]) {
    let parent = byId.get(id)?.parentRunId;
    const visited = new Set<string>();
    while (parent && !visited.has(parent)) {
      visited.add(parent);
      keep.add(parent);
      parent = byId.get(parent)?.parentRunId;
    }
  }
  const queue = [...keep];
  for (let i = 0; i < queue.length; i++)
    for (const child of children.get(queue[i]) || [])
      if (!keep.has(child)) {
        keep.add(child);
        queue.push(child);
      }
  return runs.filter((r) => keep.has(r.id));
}
