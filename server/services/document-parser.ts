import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// Parse outside the server: a bad document must not block its event loop.
export function extractIsolated(
  path: string,
  timeoutMs = 120_000,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = fork(
      fileURLToPath(
        new URL(
          import.meta.url.endsWith('.ts') ? './document-worker.ts' : './document-worker.js',
          import.meta.url,
        ),
      ),
      [],
      {
        execArgv: [
          ...(import.meta.url.endsWith('.ts') ? ['--import', 'tsx'] : []),
          '--max-old-space-size=768',
        ],
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        windowsHide: true,
      },
    );
    let settled = false;
    const finish = (error?: Error, text?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      child.kill();
      if (error) reject(error);
      else resolve(text!);
    };
    const timer = setTimeout(
      () => finish(Error('Document parsing timed out; split or repair this source.')),
      timeoutMs,
    );
    const onAbort = () => finish(new Error('Document parsing cancelled.'));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    child.once('error', (e) => finish(e));
    child.once('exit', (code) =>
      finish(Error('Document parser exited before completing (code ' + code + ').')),
    );
    child.once('message', (m: any) =>
      m.error ? finish(Error(m.error)) : finish(undefined, m.text),
    );
    child.send(path, (e) => {
      if (e) finish(e);
    });
  });
}
