import type { CommandResult } from './process.js';
import { AppError, NotStartedError } from '../core/errors.js';
/** Invalid/missing bridge receipts never imply that execution did not start. */
export function nativeReceipt(r: any, network: 'deny' | 'host'): CommandResult {
  if (r?.error && r.commandStarted === false)
    throw new NotStartedError('NATIVE_NOT_STARTED', String(r.error));
  if (
    !r ||
    r.error ||
    typeof r.stdout !== 'string' ||
    typeof r.stderr !== 'string' ||
    typeof r.timedOut !== 'boolean' ||
    typeof r.truncated !== 'boolean' ||
    !(r.code === null || Number.isInteger(r.code))
  )
    throw new AppError(
      'NATIVE_OUTCOME_UNKNOWN',
      'Missing or invalid native execution receipt; inspect before retrying.',
    );
  if (network === 'deny') {
    if (r.commandStarted === false && r.preflight?.allowed === false)
      throw new NotStartedError(
        'SANDBOX_PREFLIGHT_FAILED',
        r.stdout + ' Requested command was not started. No host fallback.',
      );
    if (r.preflight?.allowed !== true || r.commandStarted !== true)
      throw new AppError(
        'NATIVE_OUTCOME_UNKNOWN',
        'Strict network preflight receipt is missing or inconsistent. No fallback or automatic retry.',
      );
  }
  return r;
}
