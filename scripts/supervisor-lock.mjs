import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
// A PID is not a process identity: Windows reuses it after exit or reboot.
export function processStartedAt(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw Error('Invalid lock owner PID');
  if (process.platform !== 'win32') return undefined;
  try {
    const shell = join(
      process.env.SystemRoot || 'C:/Windows',
      'System32/WindowsPowerShell/v1.0/powershell.exe',
    );
    const text = execFileSync(
      shell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$ErrorActionPreference='Stop'; [DateTimeOffset]::new((Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction Stop).CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds()`,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    const value = Number(text);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  } // Lack of access must not authorize removing a live lock.
}
export function isReusedOwner(saved, lockModifiedAt, actualStartedAt) {
  if (!Number.isFinite(actualStartedAt)) return false;
  if (Number.isFinite(saved.startedAt)) return Math.abs(saved.startedAt - actualStartedAt) > 1;
  // Legacy locks have only a PID; allow timestamp filesystem precision tolerance.
  return Number.isFinite(lockModifiedAt) && actualStartedAt > lockModifiedAt + 1000;
}
