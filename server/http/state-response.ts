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
