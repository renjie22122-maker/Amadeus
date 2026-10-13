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
