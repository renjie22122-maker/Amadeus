import { transportFailure } from '../providers/failure.js';
import { AppError } from './errors.js';

// Only failed model requests are retried. Never use this for tool execution.
export function transientModelFailure(error: unknown): boolean {
  if (error instanceof AppError) {
    if (
      [
        'MODEL_NETWORK',
        'MODEL_TIMEOUT',
        'MODEL_STREAM_IDLE',
        'TRUNCATED_STREAM',
        'INVALID_STREAM',
      ].includes(error.code)
    )
      return true;
    if (error.code === 'MODEL_INCOMPLETE')
      return (error as AppError & { finishReason?: string }).finishReason === '';
    return false;
  }
  return transportFailure(error).kind === 'network';
}
export const modelReconnectDelay = (attempt: number) =>
  Math.min(2000 * 2 ** Math.max(0, attempt - 1), 30000);

/** One model step shares its request timeout across transport retries, not tools or the whole task. */
export function remainingModelTime(deadline: number, now = Date.now()): number {
  return Math.max(0, deadline - now);
}
export function canReconnectModel(attempts: number, deadline: number, now = Date.now()): boolean {
  return attempts < 5 && remainingModelTime(deadline, now) > modelReconnectDelay(attempts + 1);
}
