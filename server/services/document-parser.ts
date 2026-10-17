import { extname } from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// Parse outside the server: a bad document must not block its event loop.
export function extractIsolated(
  path: string,
  timeoutMs = 120_000,
  signal?: AbortSignal,
  options: { checkpointDirectory?: string } = {},
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
      clearTimeout(totalTimer);
      signal?.removeEventListener('abort', onAbort);
      child.kill();
      if (error) reject(error);
      else resolve(text!);
    };
    let lastPage = 0;
    let lastTile = 0;
    let tileCount: number | undefined;
    let pageCount: number | undefined;
    const stalled = () =>
      finish(
        Error(
          `DOCUMENT_PARSE_TIMEOUT: Document parsing timed out without completing a page or OCR tile for ${timeoutMs / 1000}s (completed ${lastPage}${pageCount ? '/' + pageCount : ''} pages). No partial document was imported.`,
        ),
      );
    let timer = setTimeout(stalled, timeoutMs);
    // A healthy long PDF may continue, but progress cannot extend its budget indefinitely.
    const totalTimer = setTimeout(
      () =>
        finish(
          Error(
            `DOCUMENT_PARSE_DEADLINE: Total parsing budget exceeded (completed ${lastPage} pages). No partial document was imported.`,
          ),
        ),
      extname(path).toLowerCase() === '.pdf' ? Math.max(timeoutMs, 30 * 60_000) : timeoutMs,
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
    child.on('message', (m: any) => {
      if (settled) return;
      if (m?.type === 'tile') {
        if (
          extname(path).toLowerCase() === '.pdf' &&
          m.page === lastPage + 1 &&
          Number.isSafeInteger(m.total) &&
          m.total >= m.page &&
          (pageCount === undefined || pageCount === m.total) &&
          Number.isSafeInteger(m.tile) &&
          m.tile === lastTile + 1 &&
          Number.isSafeInteger(m.tiles) &&
          m.tiles >= m.tile &&
          m.tiles <= 256 &&
          (tileCount === undefined || tileCount === m.tiles)
        ) {
          pageCount = m.total;
          lastTile = m.tile;
          tileCount = m.tiles;
          clearTimeout(timer);
          timer = setTimeout(stalled, timeoutMs);
        }
        return;
      }
      if (m?.type === 'page') {
        // Only completed, sequential pages count as progress, never a heartbeat.
        if (
          extname(path).toLowerCase() === '.pdf' &&
          Number.isSafeInteger(m.page) &&
          Number.isSafeInteger(m.total) &&
          m.page === lastPage + 1 &&
          m.page <= m.total &&
          (pageCount === undefined || pageCount === m.total)
        ) {
          lastPage = m.page;
          lastTile = 0;
          tileCount = undefined;
          pageCount = m.total;
          clearTimeout(timer);
          timer = setTimeout(stalled, timeoutMs);
        }
        return;
      }
      if (m?.error) finish(Error(m.error));
      else if (typeof m?.text === 'string') finish(undefined, m.text);
      else finish(Error('DOCUMENT_PARSE_PROTOCOL: Invalid parser result.'));
    });
    child.send({ path, checkpointDirectory: options.checkpointDirectory }, (e) => {
      if (e) finish(e);
    });
  });
}
