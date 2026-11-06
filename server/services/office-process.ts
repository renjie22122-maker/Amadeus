import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
let running = false;
const queue: {
  resolve: () => void;
  reject: (e: unknown) => void;
  signal: AbortSignal;
  abort: () => void;
}[] = [];
function acquire(signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const item = {
      resolve,
      reject,
      signal,
      abort: () => {
        const i = queue.indexOf(item);
        if (i >= 0) queue.splice(i, 1);
        reject(signal.reason || Error('Cancelled'));
      },
    };
    if (!running) {
      running = true;
      resolve();
    } else {
      queue.push(item);
      signal.addEventListener('abort', item.abort, { once: true });
    }
  });
}
function release() {
  const next = queue.shift();
  if (next) {
    next.signal.removeEventListener('abort', next.abort);
    next.resolve();
  } else running = false;
}
/** Fixed Office subprocess, one at a time; no model-provided program or network calls. */
export async function officeProcess(
  message: Record<string, unknown>,
  signal: AbortSignal,
): Promise<any> {
  await acquire(signal);
  try {
    signal.throwIfAborted();
    return await new Promise((resolve, reject) => {
      const child = fork(
        fileURLToPath(
          new URL(
            import.meta.url.endsWith('.ts') ? './office-worker.ts' : './office-worker.js',
            import.meta.url,
          ),
        ),
        [],
        {
          execArgv: [
            ...(import.meta.url.endsWith('.ts') ? ['--import', 'tsx'] : []),
            '--max-old-space-size=768',
          ],
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        },
      );
      let done = false;
      const finish = (error?: unknown, result?: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        child.kill();
        error ? reject(error) : resolve(result);
      };
      const abort = () => finish(signal.reason || Error('Office task cancelled'));
      const timer = setTimeout(
        () =>
          finish(
            Error('OFFICE_TIMEOUT: Processing exceeded 120 seconds; no result claimed complete.'),
          ),
        120000,
      );
      child.once('message', (m: any) =>
        m.error ? finish(Error(m.error)) : finish(undefined, m.result),
      );
      child.once('error', (e) => finish(e));
      child.once('exit', (code) => finish(Error('OFFICE_PROCESS: Worker exited (' + code + ').')));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      else child.send(message);
    });
  } finally {
    release();
  }
}
