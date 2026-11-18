import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const [entry, input, desktop, , output, python] = process.argv.slice(2);
process.on('uncaughtException', (error) => {
  writeFileSync(output, JSON.stringify({ diagnostic: error.message }));
  process.exit(1);
});
const request = JSON.parse(readFileSync(input, 'utf8'));
const { version, name } = JSON.parse(
  readFileSync(resolve(dirname(entry), '../../package.json'), 'utf8'),
);
if (name !== '@microsoft/mxc-sdk' || version !== '1.1.0') throw Error('MXC SDK version mismatch');
const { probe, spawn } = await import(pathToFileURL(entry).href);
const command =
  '"' +
  join(process.env.SystemRoot, 'System32', 'cmd.exe') +
  '" /D /Q /V:OFF /C "set /p READY= && call .\\workload.cmd"';
const policy = { ...request, command };
const support = probe(policy);
if (support.tier !== 'base-container' || support.needsDaclAugmentation || support.error)
  throw Error('Requested MXC policy unavailable');
const task = await spawn(policy);
try {
  const chunks = { stdout: '', stderr: '' };
  let truncated = false;
  function collect(key, data) {
    const value = chunks[key] + data;
    truncated ||= value.length > 1000000;
    chunks[key] = value.slice(0, 1000000);
  }
  for (const [key, stream] of [
    ['stdout', task.standardOutput],
    ['stderr', task.standardError],
  ]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => collect(key, chunk));
  }
  execFileSync(
    python,
    [
      '-I',
      fileURLToPath(new URL('./mxc-private-desktop-test.py', import.meta.url)),
      'grant',
      desktop,
      String(task.id),
    ],
    { windowsHide: true, timeout: 5000 },
  );
  task.standardInput.end('ready\r\n');
  const result = await task.wait();
  writeFileSync(
    output,
    JSON.stringify({ ...chunks, code: result.exitCode, timedOut: result.timedOut, truncated }),
  );
} finally {
  task.dispose();
}
