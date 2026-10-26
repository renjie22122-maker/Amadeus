import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

// Test-only wall-clock budget includes Windows PowerShell cold startup.
// No retries: script failures and timeouts remain failures.
export function runPowerShellTest(args, label) {
  const timeout = 60000;
  const start = performance.now();
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', ...args], {
    encoding: 'utf8',
    timeout,
    windowsHide: true,
  });
  const elapsedMs = Math.round(performance.now() - start);
  const diagnostic = `${label}: elapsedMs=${elapsedMs}, timeoutMs=${timeout}, status=${result.status}, signal=${result.signal}, error=${result.error?.code || 'none'}\n${result.stdout || ''}${result.stderr || ''}`;
  assert.ok(!result.error, diagnostic);
  assert.equal(result.signal, null, diagnostic);
  assert.equal(result.status, 0, diagnostic);
  console.log(`${label}: PowerShell completed in ${elapsedMs}ms`);
  return result;
}
