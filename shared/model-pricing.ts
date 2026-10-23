import type { Profile } from './types.js';
export interface RateSchedule {
  weekdays: number[];
  utcWindows: [number, number][]; // minutes, half-open; overnight windows supported
  offPeakMultiplier: number;
  holidayTimeZone: string;
  holidays: [string, string][]; // inclusive ISO local dates from a verified calendar
}
export function scheduledRate(schedule: RateSchedule, at: number) {
  const date = new Date(at);
  const localDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: schedule.holidayTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
  const holiday = schedule.holidays.some(([start, end]) => localDate >= start && localDate <= end);
  const minute = date.getUTCHours() * 60 + date.getUTCMinutes();
  const peak =
    !holiday &&
    schedule.weekdays.includes(date.getUTCDay()) &&
    schedule.utcWindows.some(([start, end]) =>
      start <= end ? minute >= start && minute < end : minute >= start || minute < end,
    );
  return {
    band: peak ? 'peak' : 'off-peak',
    multiplier: peak ? 1 : schedule.offPeakMultiplier,
    holiday,
  };
}
// Rates and calendar are data, not provider-specific billing logic. Explicit prices always win.
const catalogs = [
  {
    origin: 'https://api.deepseek.com',
    validFrom: '2026-10-23T00:00:00Z',
    validUntil: '2026-11-23T00:00:00Z',
    source: 'https://api-docs.deepseek.com/quick_start/pricing/',
    calendarSource: 'https://www.beijing.gov.cn/cs/gncs/zcwj/202603/t20260327_4568275.html',
    models: [
      {
        names: ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'],
        prices: { input: 0.3, output: 1.2, cached: 0.006 },
      },
      { names: ['deepseek-v4-pro'], prices: { input: 1.32, output: 3.96, cached: 0.044 } },
    ],
    schedule: {
      weekdays: [1, 2, 3, 4, 5],
      utcWindows: [
        [60, 240],
        [360, 600],
      ],
      offPeakMultiplier: 0.5,
      holidayTimeZone: 'Asia/Shanghai',
      holidays: [
        ['2026-01-01', '2026-01-03'],
        ['2026-02-15', '2026-02-23'],
        ['2026-04-04', '2026-04-06'],
        ['2026-05-01', '2026-05-05'],
        ['2026-06-19', '2026-06-21'],
        ['2026-09-25', '2026-09-27'],
        ['2026-10-01', '2026-10-07'],
      ],
    } as RateSchedule,
  },
];
export function modelPricing(profile: Profile, at = Date.now()) {
  const configured = profile.prices;
  if (Object.values(configured).some((v) => v !== null))
    return { prices: configured, source: 'configured', basis: 'configured' };
  const unknown = { prices: configured, source: 'unknown', basis: 'unknown' };
  let origin: string;
  try {
    origin = new URL(profile.baseUrl).origin;
  } catch {
    return unknown;
  }
  const catalog = catalogs.find(
    (c) => c.origin === origin && at >= Date.parse(c.validFrom) && at < Date.parse(c.validUntil),
  );
  const model = catalog?.models.find((m) => m.names.includes(profile.model));
  if (!catalog || !model) return unknown;
  const rate = scheduledRate(catalog.schedule, at);
  return {
    prices: {
      input: model.prices.input * rate.multiplier,
      output: model.prices.output * rate.multiplier,
      cached: model.prices.cached * rate.multiplier,
    },
    source: catalog.source,
    calendarSource: catalog.calendarSource,
    basis: rate.band,
    at,
    validUntil: catalog.validUntil,
  };
}
