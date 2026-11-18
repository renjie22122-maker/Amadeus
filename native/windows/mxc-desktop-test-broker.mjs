// Trusted broker for the fixed desktop identity test. No caller-provided shell script.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join } from 'node:path';
const [entry, requestFile, desktop, title, output, python] = process.argv.slice(2);
process.on('uncaughtException', (e) => {
  writeFileSync(output, JSON.stringify({ error: e.message }));
  process.exit(1);
});
const request = JSON.parse(readFileSync(requestFile, 'utf8'));
const { spawn } = await import(pathToFileURL(entry).href);
const exe = join(request.workingDirectory, 'WindowFixture.exe');
if (!/^amadeus-fixture-[a-f0-9-]+$/.test(title) || /[\r\n"%!&|<>^]/.test(exe))
  throw Error('Unsafe fixture argument');
const task = await spawn({
  ...request,
  command:
    '"' +
    join(process.env.SystemRoot, 'System32', 'cmd.exe') +
    '" /D /Q /C set /p READY= & "' +
    exe +
    '" check ' +
    title,
});
let stdout = '';
try {
  task.standardOutput.on('data', (b) => {
    stdout += b.toString();
  });
  task.standardError.resume();
  const helper = fileURLToPath(new URL('./mxc-private-desktop-test.py', import.meta.url));
  execFileSync(python, [helper, 'grant', desktop, String(task.id)], {
    windowsHide: true,
    timeout: 5000,
  });
  task.standardInput.end('ready\r\n');
  const result = await task.wait();
  writeFileSync(
    output,
    JSON.stringify({
      exitCode: result.exitCode,
      hidden: stdout.trim() === 'hidden',
      found: stdout.trim() === 'found',
    }),
  );
} finally {
  task.dispose();
}
