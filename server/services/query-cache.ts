/** Bounded, short-lived memoization of deterministic inference only, never search results. */
export class QueryCache<T> {
  private values = new Map<string, { value: T; until: number }>();
  private pending = new Map<
    string,
    { controller: AbortController; promise: Promise<T>; users: number; settled: boolean }
  >();
  constructor(
    private capacity = 64,
    private ttlMs = 120000,
  ) {}
  get(key: string, compute: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const hit = this.values.get(key);
    if (hit && hit.until > Date.now()) {
      this.values.delete(key);
      this.values.set(key, hit);
      return Promise.resolve(structuredClone(hit.value));
    }
    this.values.delete(key);
    let job = this.pending.get(key);
    if (!job) {
      if (this.pending.size >= this.capacity)
        return compute(signal ?? new AbortController().signal);
      const controller = new AbortController();
      job = { controller, promise: undefined as any, users: 0, settled: false };
      const entry = job;
      entry.promise = Promise.resolve()
        .then(() => compute(controller.signal))
        .then((value) => {
          if (!controller.signal.aborted) {
            this.values.set(key, { value: structuredClone(value), until: Date.now() + this.ttlMs });
            while (this.values.size > this.capacity)
              this.values.delete(this.values.keys().next().value!);
          }
          return value;
        })
        .finally(() => {
          entry.settled = true;
          if (this.pending.get(key) === entry) this.pending.delete(key);
        });
      this.pending.set(key, entry);
    }
    const entry = job;
    entry.users++;
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const finish = (error: unknown, value?: T) => {
        if (done) return;
        done = true;
        signal?.removeEventListener('abort', abort);
        entry.users--;
        if (!entry.users && !entry.settled) {
          entry.controller.abort();
          if (this.pending.get(key) === entry) this.pending.delete(key);
        }
        if (error) reject(error);
        else resolve(structuredClone(value!));
      };
      const abort = () => finish(signal?.reason ?? new Error('Aborted'));
      signal?.addEventListener('abort', abort, { once: true });
      entry.promise.then(
        (v) => finish(undefined, v),
        (e) => finish(e),
      );
      if (signal?.aborted) abort();
    });
  }
}
