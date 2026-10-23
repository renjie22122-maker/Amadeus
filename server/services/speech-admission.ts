/** Service-wide admission. Conversations rotate; a conversation never overlaps itself. */
export class SpeechAdmission {
  private pools = new Map<
    string,
    {
      active: Set<string>;
      limit: number;
      waiting: {
        owner: string;
        resolve: (release: () => void) => void;
        reject: (e: Error) => void;
        signal?: AbortSignal;
        abort: () => void;
      }[];
    }
  >();
  acquire(key: string, owner: string, signal?: AbortSignal, limit = 1): Promise<() => void> {
    const pool = this.pools.get(key) || { active: new Set<string>(), limit, waiting: [] };
    // Conflicting declarations for one endpoint use the conservative capacity.
    pool.limit = Math.min(pool.limit, limit);
    this.pools.set(key, pool);
    return new Promise((resolve, reject) => {
      const entry = {
        owner,
        resolve,
        reject,
        signal,
        abort: () => {
          const i = pool.waiting.indexOf(entry);
          if (i >= 0) pool.waiting.splice(i, 1);
          reject(new Error('Speech admission cancelled'));
          if (!pool.active.size && !pool.waiting.length) this.pools.delete(key);
        },
      };
      if (signal?.aborted) return entry.abort();
      signal?.addEventListener('abort', entry.abort, { once: true });
      pool.waiting.push(entry);
      this.drain(key);
    });
  }
  private drain(key: string) {
    const pool = this.pools.get(key);
    if (!pool) return;
    while (pool.active.size < pool.limit) {
      const i = pool.waiting.findIndex((e) => !pool.active.has(e.owner));
      if (i < 0) return;
      const entry = pool.waiting.splice(i, 1)[0];
      entry.signal?.removeEventListener('abort', entry.abort);
      pool.active.add(entry.owner);
      let released = false;
      entry.resolve(() => {
        if (released) return;
        released = true;
        pool.active.delete(entry.owner);
        pool.waiting = [
          ...pool.waiting.filter((e) => e.owner !== entry.owner),
          ...pool.waiting.filter((e) => e.owner === entry.owner),
        ];
        this.drain(key);
        if (!pool.active.size && !pool.waiting.length) this.pools.delete(key);
      });
    }
  }
}
