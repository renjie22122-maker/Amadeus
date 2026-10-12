import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
const exec = promisify(execFile);
const args = process.argv.slice(2);
if (args.some((x) => x !== '--container' && !x.startsWith('--image=')))
  throw Error('Usage: node evals/benchmark/preflight.mjs [--container] [--image=local-image]');
const report = {
  schemaVersion: 1,
  date: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  checks: [],
  paidModelCalls: 0,
};
async function check(name, fn) {
  try {
    report.checks.push({ name, status: 'passed', result: await fn() });
  } catch (e) {
    report.checks.push({ name, status: 'failed', error: String(e.message).slice(0, 3000) });
  }
}
async function docker(a) {
  return (
    await exec('docker', a, { timeout: 60000, maxBuffer: 1024 * 1024, windowsHide: true })
  ).stdout.trim();
}
await check('engine', async () =>
  JSON.parse(
    await docker([
      'info',
      '--format',
      '{"os":{{json .OSType}},"cpus":{{.NCPU}},"memoryBytes":{{.MemTotal}},"version":{{json .ServerVersion}}}',
    ]),
  ),
);
if (args.includes('--container')) {
  const image = args.find((x) => x.startsWith('--image='))?.slice(8) || 'alpine:3.22';
  let fixture;
  const name = 'amadeus-eval-preflight-' + randomUUID();
  try {
    await check('container', async () => {
      const info = JSON.parse(await docker(['image', 'inspect', image]));
      const id = info[0].Id;
      fixture = await mkdtemp(join(tmpdir(), 'amadeus-eval-'));
      await writeFile(join(fixture, 'fixture.txt'), 'fixture');
      const command = [
        'set -eu',
        'test "$(id -u)" = 65534',
        'test "$(cat /input/fixture.txt)" = fixture',
        'if touch /input/unexpected 2>/dev/null; then exit 21; fi',
        'if touch /unexpected 2>/dev/null; then exit 22; fi',
        'echo ok > /tmp/check',
        'test "$(cat /tmp/check)" = ok',
        'grep -q "^NoNewPrivs:[[:space:]]*1" /proc/self/status',
        'grep -q "^CapEff:[[:space:]]*0000000000000000" /proc/self/status',
        'test "$(ls /sys/class/net)" = lo',
        'echo isolation-smoke-passed',
      ].join('; ');
      const output = await docker([
        'run',
        '--rm',
        '--pull=never',
        '--name',
        name,
        '--network=none',
        '--read-only',
        '--user',
        '65534:65534',
        '--cap-drop=ALL',
        '--security-opt',
        'no-new-privileges',
        '--pids-limit',
        '64',
        '--memory',
        '128m',
        '--cpus',
        '1',
        '--tmpfs',
        '/tmp:rw,noexec,nosuid,size=16m',
        '--mount',
        'type=bind,source=' + fixture + ',target=/input,readonly',
        id,
        'sh',
        '-c',
        command,
      ]);
      if (output !== 'isolation-smoke-passed') throw Error('Unexpected probe output');
      return { image, imageId: id, repoDigests: info[0].RepoDigests, output };
    });
  } finally {
    await docker(['rm', '-f', name]).catch(() => {});
    if (fixture) await rm(fixture, { recursive: true, force: true });
  }
} else
  report.checks.push({
    name: 'container',
    status: 'not_run',
    reason: 'Use --container with a local Alpine-compatible image; this script never downloads.',
  });
await mkdir('.diagnostics/benchmark', { recursive: true });
const file = resolve('.diagnostics/benchmark/preflight-' + Date.now() + '.json');
await writeFile(file, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
console.log('Report: ' + file);
if (report.checks.some((x) => x.status === 'failed')) process.exitCode = 1;
