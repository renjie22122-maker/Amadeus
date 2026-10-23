import { createHash } from 'node:crypto';
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
// Stable environment and authorization precede changing evidence and the exact action.
export function reviewContent(data: Record<string, any>) {
  const order = [
    'sandbox',
    'network',
    'cwdIsSecurityBoundary',
    'hostAccountPermissions',
    'humanMessages',
    'humanDecisions',
    'observedSource',
    'inspectedSource',
    'writtenFiles',
    'executionEvidence',
    'risk',
    'commandSignals',
    'request',
  ];
  return JSON.stringify(
    Object.fromEntries(order.filter((k) => k in data).map((k) => [k, canonical(data[k])])),
  );
}
export const reviewHash = (text: string) => createHash('sha256').update(text).digest('hex');

// Only concurrent identical computations with a shared cancellation scope are joined.
// No completed assessment or permission is cached.
export class ReviewFlights<T> {
  private flights = new WeakMap<AbortSignal, Map<string, { owner: string; work: Promise<T> }>>();
  get(signal: AbortSignal, key: string, owner: string, start: () => Promise<T>) {
    let group = this.flights.get(signal);
    if (!group) {
      group = new Map();
      this.flights.set(signal, group);
    }
    const existing = group.get(key);
    if (existing) return { ...existing, joined: true };
    const work = Promise.resolve().then(start);
    const entry = { owner, work };
    group.set(key, entry);
    const cleanup = () => {
      if (group!.get(key) === entry) group!.delete(key);
    };
    void work.then(cleanup, cleanup);
    return { ...entry, joined: false };
  }
}
