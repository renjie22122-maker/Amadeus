import { transientModelFailure } from './model-recovery.js';
import { AppError } from './errors.js';
import type { Run } from '../../shared/types.js';
export function termination(error: unknown, aborted = false): NonNullable<Run['termination']> {
  const code = error instanceof AppError ? error.code : 'EXECUTION_FAILED';
  if (aborted || code === 'CANCELLED')
    return { code: 'CANCELLED', category: 'cancelled', recoverable: true };
  if (transientModelFailure(error))
    return {
      code: code === 'EXECUTION_FAILED' ? 'MODEL_NETWORK' : code,
      category: 'execution',
      recoverable: true,
    };
  if (code === 'STEP_LIMIT') return { code, category: 'limit', recoverable: true };
  if (code === 'STAGNATION') return { code, category: 'stagnation', recoverable: true };
  if (
    [
      'MODEL_INCOMPLETE',
      'MODEL_PROTOCOL',
      'EMPTY_RESPONSE',
      'EMPTY_ANSWER',
      'OUTPUT_FORMAT',
      'MEMORY_CHECK_PENDING',
      'TEAM_REVIEW_PENDING',
      'TOOL_ARGUMENTS',
      'DUPLICATE_CALL_ID',
      'INVALID_ARGUMENTS',
      'DUPLICATE_CALL',
    ].includes(code)
  )
    return { code, category: 'protocol', recoverable: true };
  return { code, category: 'execution', recoverable: false };
}
