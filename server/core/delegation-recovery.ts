import { createHash } from 'node:crypto';
import type { Store } from '../storage/store.js';
import { AppError } from './errors.js';

// Rate-limit an unchanged failing delegation, not the lifetime of a productive task.
export function delegationFingerprint(task: string, deliverable = '') {
  return createHash('sha256')
    .update(JSON.stringify([task.trim(), deliverable.trim()]))
    .digest('hex');
}
export function assertDelegationRecovery(
  store: Store,
  root: string,
  fingerprint: string,
  now = Date.now(),
) {
  const recent = store
    .list<{ id: string; root: string; fingerprint: string; at: number }>('delegation-attempt')
    .filter((a) => a.root === root && a.fingerprint === fingerprint)
    .sort((a, b) => b.at - a.at)
    .slice(0, 3);
  if (recent.length < 3) return;
  const runs = recent.map((a) => store.maybeRunHeader(a.id));
  if (runs.some((r) => !r || !['failed', 'interrupted'].includes(r.status) || !r.error)) return;
  if (runs.some((r) => r!.error !== runs[0]!.error)) return;
  const until = Math.max(...runs.map((r) => r!.updatedAt || 0)) + 60000;
  if (now < until)
    throw new AppError(
      'DELEGATION_REPEATED_FAILURE',
      `Three identical delegations ended with the same failure. Inspect the existing member and change the approach, or retry after ${Math.ceil((until - now) / 1000)} seconds. Completed work and permissions are unchanged.`,
      429,
    );
}
