import type { Store } from '../storage/store.js';
import type { CommandJob } from './background-commands.js';
/** Host-owned references only. Model text and exit-code guesses cannot settle an effect. */
export function inspectReceipt(store: Store, effect: any, conversationId: string) {
  const ref = store.maybe<any>('effect-reference', effect.id);
  if (!ref || ref.runId !== effect.run_id) return undefined;
  if (ref.protocol === 'media-job') {
    const job = store.maybe<any>('media-job', ref.jobId);
    if (!job || job.runId !== effect.run_id || job.conversationId !== conversationId)
      return undefined;
    if (
      job.status === 'completed' ||
      (job.remoteId && ['queued', 'running', 'failed', 'cancelled'].includes(job.status))
    )
      return {
        protocol: ref.protocol,
        jobId: job.id,
        outcome: 'submission-observed',
        note: 'Durable media receipt identifies the original submission. Continue polling the same job; this is not an acceptance verdict.',
      };
  }
  if (ref.protocol === 'command-job') {
    const job = store.maybe<CommandJob>('command-job', ref.jobId);
    if (
      !job ||
      job.effectId !== effect.id ||
      job.runId !== effect.run_id ||
      job.conversationId !== conversationId
    )
      return undefined;
    if (job.notStarted === true)
      return {
        protocol: ref.protocol,
        jobId: job.id,
        outcome: 'not-started',
        note: 'Adapter recorded that execution never started.',
      };
    if (
      ['completed', 'failed'].includes(job.status) &&
      job.result &&
      Number.isInteger(job.result.code) &&
      !job.result.timedOut &&
      !job.result.aborted
    )
      return {
        protocol: ref.protocol,
        jobId: job.id,
        outcome: 'execution-observed',
        note: 'Durable command receipt records termination, not business success or descendant cleanup.',
      };
  }
  return undefined;
}
