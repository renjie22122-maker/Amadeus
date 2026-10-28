import { z } from 'zod';
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const executionWindowSchema = z.object({
  timeZone: z
    .string()
    .min(1)
    .max(100)
    .refine((zone) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: zone }).format(0);
        return true;
      } catch {
        return false;
      }
    }, 'Use a valid IANA time zone'),
  start: clock,
  end: clock,
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
});
export type ExecutionWindow = z.infer<typeof executionWindowSchema>;
// Equal endpoints mean all day. Overnight windows belong to their starting weekday.
export function nextWindowTime(window: ExecutionWindow, now: number): number {
  const w = executionWindowSchema.parse(window);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: w.timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const minute = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  const start = minute(w.start),
    end = minute(w.end);
  const allowed = (at: number) => {
    const parts = Object.fromEntries(fmt.formatToParts(at).map((p) => [p.type, p.value]));
    let day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
    const time = Number(parts.hour) * 60 + Number(parts.minute);
    if (start !== end) {
      if (start < end) {
        if (time < start || time >= end) return false;
      } else {
        if (time >= end && time < start) return false;
        if (time < end) day = (day + 6) % 7;
      }
    }
    return w.weekdays.includes(day);
  };
  if (allowed(now)) return now;
  // UTC minute stepping handles skipped/repeated wall times without inventing DST offsets.
  const first = Math.floor(now / 60000) * 60000 + 60000;
  for (let at = first; at <= now + 8 * 86400000; at += 60000) if (allowed(at)) return at;
  throw Error('No available execution window in the next eight days');
}
