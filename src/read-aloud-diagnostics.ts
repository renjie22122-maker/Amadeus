/** Explicit opt-in, memory-only diagnostics. No credentials or reference audio. */
export class ReadAloudDiagnostics {
  readonly id = crypto.randomUUID();
  readonly startedAt = new Date().toISOString();
  private readonly origin = performance.now();
  private bytes = 0;
  private events: Record<string, unknown>[] = [];
  truncated = false;
  constructor(private readonly maxBytes = 32 * 1024 * 1024) {}
  record(type: string, data: Record<string, unknown> = {}) {
    const event = { type, elapsedMs: performance.now() - this.origin, ...data };
    const bytes = new TextEncoder().encode(JSON.stringify(event)).length;
    if (this.bytes + bytes > this.maxBytes || this.events.length >= 10000) {
      this.truncated = true;
      return;
    }
    this.bytes += bytes;
    this.events.push(event);
  }
  snapshot() {
    return {
      schema: 'amadeus-read-aloud-v1',
      id: this.id,
      startedAt: this.startedAt,
      truncated: this.truncated,
      capturedBytes: this.bytes,
      clock: 'elapsedMs: browser monotonic; audioTime/scheduledStart/End: AudioContext seconds',
      limits: '32 MiB / 10000 events; capture may truncate without interrupting playback',
      meaning:
        'WAV chunks are received audio, not acoustic recordings. Scheduled times are not measured speaker output. ended callbacks may be delayed by the browser. No transcript or language verdict.',
      events: this.events.slice(),
    };
  }
}
/** A small initial lead absorbs short delivery jitter; sustained slow generation still underruns. */
export function speechSchedule(previousEnd: number, now: number, first: boolean) {
  // A finite lead covers model startup chunk jitter without waiting for the whole utterance.
  // Once underrun occurs, rebuild a cushion rather than repeatedly scheduling at the deadline.
  const late = now + 0.025 > previousEnd;
  const lead = first ? 1.5 : late ? Math.min(3, Math.max(0.5, now - previousEnd)) : 0.025;
  const start = Math.max(now + lead, previousEnd);
  return { start, gapSeconds: first ? 0 : Math.max(0, start - previousEnd) };
}
