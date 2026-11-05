/** Relative active-day distribution, not an absolute token ratio.
 * Midranks keep tied values identical; linear interpolation avoids fixed bands.
 * Zero/missing days do not dilute the distribution. */
export function tokenHeatScale(values: number[]): (value: number) => number {
  const sorted = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  const points: { value: number; rank: number }[] = [];
  for (let i = 0; i < sorted.length;) {
    let end = i + 1;
    while (end < sorted.length && sorted[end] === sorted[i]) end++;
    points.push({ value: sorted[i], rank: (i + end - 1) / 2 });
    i = end;
  }
  return (value) => {
    if (!Number.isFinite(value) || value <= 0 || !points.length) return 0;
    if (points.length === 1) return 0.5;
    const first = points[0],
      last = points[points.length - 1];
    if (value <= first.value) return 0;
    if (value >= last.value) return 1;
    let low = 0,
      high = points.length - 1;
    while (high - low > 1) {
      const mid = (low + high) >> 1;
      if (points[mid].value <= value) low = mid;
      else high = mid;
    }
    const a = points[low],
      b = points[high];
    const rank = a.rank + ((b.rank - a.rank) * (value - a.value)) / (b.value - a.value);
    return (rank - first.rank) / (last.rank - first.rank);
  };
}
