import type { Run } from '../../shared/types.js';
import type { Store } from '../storage/store.js';
import { AppError } from '../core/errors.js';

/** Wall clock observations only. Never infer productive work from lifecycle time. */
export function runtimeClock(store: Store, run: Run, timeZone?: string, now = Date.now()) {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('sv-SE', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    throw new AppError('TIME_ZONE', 'Use a supported IANA time zone such as Asia/Shanghai or UTC.');
  }
  const latest = store.db
    .prepare(
      "SELECT created_at,data FROM events WHERE run_id=? AND type='run.status' ORDER BY id DESC LIMIT 1",
    )
    .get(run.id) as { created_at: number; data: string } | undefined;
  const elapsed = (start: number | undefined) =>
    typeof start === 'number' && Number.isFinite(start) && start <= now ? now - start : null;
  return {
    observedAtUtc: new Date(now).toISOString(),
    unixMilliseconds: now,
    timeZone: formatter.resolvedOptions().timeZone,
    timeZoneSource: timeZone ? 'requested' : 'execution-host',
    localDateTime: formatter.format(new Date(now)),
    runId: run.id,
    elapsedSinceRunCreatedMs: elapsed(run.createdAt),
    currentStatus: latest ? JSON.parse(latest.data).status : run.status,
    elapsedInRecordedStatusMs: latest ? elapsed(latest.created_at) : null,
    clockMovedBackwards: [run.createdAt, latest?.created_at].some(
      (t) => typeof t === 'number' && t > now,
    ),
    meaning:
      'Host wall clock at observation, not a live clock or user timezone. Run elapsed includes queues, approval/user waits, commands, interruptions and downtime; status time follows recorded transitions and is not CPU or productive work. Clock corrections can affect durations. Use scheduling tools for wake-ups, not repeated clock polling.',
  };
}
