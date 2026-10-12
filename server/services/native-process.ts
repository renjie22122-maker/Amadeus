import { nativeReceipt } from './native-receipt.js';
import { spawnProcess as spawn } from './spawn-process.js';
import { fileURLToPath } from 'node:url';
import { isAbsolute } from 'node:path';
import type { Settings } from '../../shared/types.js';
import type { CommandResult } from './process.js';
import { AppError, NotStartedError } from '../core/errors.js';
export function executeNative(
  command: string,
  cwd: string,
  signal: AbortSignal,
  timeoutMs: number,
  settings: Settings,
): Promise<CommandResult> {
  if (process.platform !== 'win32' || !settings.nativePython || !isAbsolute(settings.nativePython))
    return Promise.reject(
      new NotStartedError(
        'NATIVE_UNAVAILABLE',
        'Windows native isolation requires an absolute Python interpreter path in Settings. No host fallback.',
      ),
    );
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'LOCALAPPDATA', 'TEMP', 'TMP'])
      if (process.env[key]) env[key] = process.env[key];
    const child = spawn(
      settings.nativePython!,
      ['-X', 'utf8', fileURLToPath(new URL('../../native/windows/bridge.py', import.meta.url))],
      { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let spawned = false;
    child.once('spawn', () => {
      spawned = true;
    });
    let out = '',
      err = '',
      ended = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      if (ended || deadline) return;
      deadline = setTimeout(() => {
        child.kill();
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        finish(
          new AppError(
            'NATIVE_OUTCOME_UNKNOWN',
            'Native adapter did not return after cancellation. Execution and cleanup are unconfirmed; inspect before retrying. ' +
              err,
          ),
        );
      }, 2000);
      if (!child.stdin.destroyed) child.stdin.end('\n');
    };
    const guard = setTimeout(cancel, timeoutMs + 120000);
    signal.addEventListener('abort', cancel, { once: true });
    child.stdout.on('data', (v) => {
      if (out.length + v.length > 7000000) cancel();
      out = (out + v.toString()).slice(0, 7000000);
    });
    child.stderr.on('data', (v) => (err = (err + v.toString()).slice(-4000)));
    child.stdin.on('error', () => {});
    child.on('error', (e) =>
      finish(
        spawned
          ? new AppError('NATIVE_OUTCOME_UNKNOWN', e.message)
          : new NotStartedError('NATIVE_UNAVAILABLE', e.message),
      ),
    );
    function finish(error?: Error, result?: CommandResult) {
      if (ended) return;
      ended = true;
      clearTimeout(guard);
      clearTimeout(deadline);
      signal.removeEventListener('abort', cancel);
      if (error) reject(error);
      else resolve(result!);
    }
    child.on('close', () => {
      try {
        const r = nativeReceipt(JSON.parse(out), settings.nativeNetwork || 'deny');
        finish(undefined, {
          ...r,
          aborted: signal.aborted,
          execution: { backend: 'native-windows', shell: 'cmd.exe', cwd },
        });
      } catch (e) {
        finish(
          e instanceof AppError ? e : new AppError('NATIVE_OUTCOME_UNKNOWN', String(e) + ' ' + err),
        );
      }
    });
    child.stdin.write(
      JSON.stringify({ command, cwd, timeoutMs, network: settings.nativeNetwork || 'deny' }) + '\n',
    );
    if (signal.aborted) cancel();
  });
}
