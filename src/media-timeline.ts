import type { AgentEvent } from '../shared/types';
import type { MediaJob } from '../shared/media';
/** Keep each job at its first receipt; later progress never moves it to a newer turn. */
export function mediaTimeline(events: AgentEvent[]) {
  const first = new Map<string, number>(),
    latest = new Map<string, MediaJob>();
  for (const event of events) {
    const job = event.type === 'media.updated' ? event.data.job : undefined;
    if (!job?.id) continue;
    if (!first.has(job.id)) first.set(job.id, event.id);
    latest.set(job.id, job);
  }
  return new Map(
    [...first]
      .filter(([id]) => latest.get(id)?.purpose !== 'read-aloud')
      .map(([id, eventId]) => [eventId, latest.get(id)!]),
  );
}
