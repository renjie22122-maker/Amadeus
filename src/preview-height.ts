/** Ignore subpixel rounding/scrollbar jitter without blocking real content changes. */
export function previewHeight(previous: number, measured: unknown): number {
  if (typeof measured !== 'number' || !Number.isFinite(measured) || measured <= 0) return previous;
  const next = Math.max(160, Math.min(2400, Math.ceil(measured)));
  return Math.abs(next - previous) <= 2 ? previous : next;
}
