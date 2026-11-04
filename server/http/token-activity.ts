import { Worker } from 'node:worker_threads';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
export function tokenActivityRoutes(app: FastifyInstance, path: string) {
  const cache = new Map<string, { at: number; value: unknown }>();
  const pending = new Map<string, Promise<unknown>>();
  const workers = new Set<Worker>();
  app.addHook('onClose', async () => {
    await Promise.all([...workers].map((w) => w.terminate()));
  });
  app.get('/api/token-activity', async (req) => {
    const q = z
      .object({
        year: z.coerce.number().int().min(2000).max(2200),
        timeZone: z
          .string()
          .max(100)
          .refine((v) => {
            try {
              new Intl.DateTimeFormat('en', { timeZone: v });
              return true;
            } catch {
              return false;
            }
          }, 'Invalid time zone')
          .default('UTC'),
      })
      .parse(req.query);
    new Intl.DateTimeFormat('en', { timeZone: q.timeZone }).format();
    const key = JSON.stringify(q),
      saved = cache.get(key);
    if (saved && Date.now() - saved.at < 30000) return saved.value;
    if (!pending.has(key)) {
      // One bounded read-only worker avoids blocking chat and bootstrap requests.
      while (pending.size >= 1) {
        if (pending.has(key)) return pending.get(key);
        await Promise.allSettled([...pending.values()]);
        const cached = cache.get(key);
        if (cached && Date.now() - cached.at < 30000) return cached.value;
      }
      if (!pending.has(key))
        pending.set(
          key,
          new Promise((resolve, reject) => {
            const w = new Worker(
              new URL('../services/token-activity-worker.cjs', import.meta.url),
              { workerData: { path, ...q } },
            );
            workers.add(w);
            const timer = setTimeout(() => {
              void w.terminate();
              reject(Error('Usage statistics timed out.'));
            }, 15000);
            w.once('message', (m) => (m.error ? reject(Error(m.error)) : resolve(m.result)));
            w.once('error', reject);
            w.once('exit', () => {
              clearTimeout(timer);
              workers.delete(w);
              reject(Error('Usage worker stopped.'));
            });
          })
            .then((value) => {
              cache.set(key, { at: Date.now(), value });
              if (cache.size > 4) cache.delete(cache.keys().next().value!);
              return value;
            })
            .finally(() => pending.delete(key)),
        );
    }
    return pending.get(key);
  });
}
