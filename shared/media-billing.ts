import type { MediaBilling, MediaJob } from './media.js';
function valueAt(data: unknown, path?: string): number | undefined {
  if (!path || !/^[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*$/.test(path)) return;
  let value: any = data;
  for (const key of path.split('.')) {
    if (
      ['__proto__', 'constructor', 'prototype'].includes(key) ||
      value == null ||
      !Object.hasOwn(value, key)
    )
      return;
    value = value[key];
  }
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
/** Only explicitly configured USD fields/units are used. No currency guessing or extra API calls. */
export function observeMediaBilling(
  data: unknown,
  billing?: MediaBilling,
): MediaJob['billingObservation'] {
  if (!billing) return;
  const amount = valueAt(data, billing.amountPath);
  if (amount !== undefined)
    return { source: 'provider-reported', usd: amount, observedAt: Date.now() };
  const units = valueAt(data, billing.unitsPath),
    rate = billing.usdPerUnit;
  if (
    units === undefined ||
    rate == null ||
    !Number.isFinite(rate) ||
    rate < 0 ||
    !Number.isFinite(units * rate)
  )
    return;
  return { source: 'usage-calculated', usd: units * rate, units, observedAt: Date.now() };
}
export function mediaCostLabel(
  job: Pick<MediaJob, 'estimatedUsd' | 'actualUsd' | 'billingObservation'>,
  zh: boolean,
) {
  const b = job.billingObservation;
  if (b)
    return (
      (b.source === 'provider-reported'
        ? zh
          ? '服务报告 $'
          : 'Provider reported $'
        : zh
          ? '按用量估算 ~$'
          : 'Usage estimate ~$') + b.usd
    );
  if (job.actualUsd != null) return (zh ? '服务报告 $' : 'Provider reported $') + job.actualUsd;
  return job.estimatedUsd == null
    ? zh
      ? '费用未知'
      : 'Cost unknown'
    : (zh ? '预估 ~$' : 'Estimate ~$') + job.estimatedUsd;
}
