// Opt-in design probe only: no saved backend changes, arbitrary commands or real credentials.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:net';

if (process.platform !== 'win32') throw Error('Windows is required');
const entry = process.argv[2];
if (!entry || !isAbsolute(entry))
  throw Error('Pass the absolute MXC SDK 1.1.0 dist/v1/index.js path');
const manifest = JSON.parse(readFileSync(resolve(dirname(entry), '../../package.json'), 'utf8'));
if (manifest.name !== '@microsoft/mxc-sdk' || manifest.version !== '1.1.0')
  throw Error('This design probe requires @microsoft/mxc-sdk 1.1.0');
const { probe, run } = await import(pathToFileURL(entry).href);
const root = mkdtempSync(join(tmpdir(), 'amadeus-mxc-design-probe-'));
const work = join(root, 'workspace'),
  outside = join(root, 'outside'),
  temp = join(work, 'temp');
for (const dir of [work, outside, temp, join(work, '.git')]) mkdirSync(dir, { recursive: true });
writeFileSync(join(outside, 'canary.txt'), 'synthetic-canary');
writeFileSync(join(work, '.git', 'config'), 'synthetic-metadata');
const listener = createServer((socket) => socket.end());
await new Promise((accept, reject) => {
  listener.once('error', reject);
  listener.listen(0, '127.0.0.1', accept);
});
const port = listener.address().port;
// Positive control prevents an absent listener from passing the network denial test.
const { createConnection } = await import('node:net');
await new Promise((accept, reject) => {
  const socket = createConnection({ host: '127.0.0.1', port });
  socket.once('connect', () => {
    socket.destroy();
    accept();
  });
  socket.once('error', reject);
});
const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
const ps = [
  "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $r=@{}",
  'Set-Content -LiteralPath ' + quote(join(work, 'ok.txt')) + ' -Value inside; $r.inside=$true',
  'try {Get-Content -LiteralPath ' +
    quote(join(outside, 'canary.txt')) +
    ' | Out-Null; $r.outsideRead=$true} catch {$r.outsideRead=$false}',
  'try {Set-Content -LiteralPath ' +
    quote(join(outside, 'bad.txt')) +
    ' -Value bad; $r.outsideWrite=$true} catch {$r.outsideWrite=$false}',
  'try {Get-Content -LiteralPath ' +
    quote(join(work, '.git', 'config')) +
    ' | Out-Null; $r.metadata=$true} catch {$r.metadata=$false}',
  '$r.secretEnvironment=Test-Path Env:AMADEUS_MXC_PROBE_SECRET',
  "$c=[Net.Sockets.TcpClient]::new();try{$t=$c.ConnectAsync('127.0.0.1'," +
    port +
    ");if(-not $t.Wait(3000)){throw 'timeout'};$r.loopback=$true}catch{$r.loopback=$false}finally{$c.Dispose()}",
  '$r | ConvertTo-Json -Compress',
].join('; ');
const windows = process.env.SystemRoot;
if (!windows) throw Error('SystemRoot missing');
const policy = {
  containment: {
    type: 'processcontainer',
    config: {
      ui: { isolation: 'desktop', desktopSystemControl: false, systemSettings: 'none', ime: false },
    },
  },
  workingDirectory: work,
  timeoutMs: 15000,
  inheritDefaultEnvironment: false,
  environment: {
    SystemRoot: windows,
    WINDIR: windows,
    TEMP: temp,
    TMP: temp,
    USERPROFILE: temp,
    LOCALAPPDATA: temp,
    APPDATA: temp,
    PATH: windows + '\\System32',
  },
  filesystem: {
    readonlyPaths: [windows, dirname(process.execPath)],
    readwritePaths: [work],
    deniedPaths: [outside, join(work, '.git')],
    clearPolicyOnExit: true,
  },
  network: { egress: { default: 'deny' }, ingress: { default: 'deny', hostLoopback: 'deny' } },
  ui: { disable: false, clipboard: 'none', allowInputInjection: false },
};
const previous = process.env.AMADEUS_MXC_PROBE_SECRET;
process.env.AMADEUS_MXC_PROBE_SECRET = 'synthetic-only';
const results = [];
try {
  const commands = [
    ['cmd', '"' + windows + '\\System32\\cmd.exe" /d /c echo MXC_CMD_OK', 'MXC_CMD_OK'],
    ['node', '"' + process.execPath + '" -e "console.log(123)"', '123'],
    [
      'powershell-boundaries',
      '"' +
        windows +
        '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile -NonInteractive -EncodedCommand ' +
        Buffer.from(ps, 'utf16le').toString('base64'),
    ],
  ];
  for (const [name, command, expected] of commands) {
    const request = { ...policy, command };
    const support = probe(request);
    if (support.error || support.needsDaclAugmentation || support.tier !== 'base-container')
      throw Error('Required base-container policy unavailable; no fallback');
    const start = performance.now();
    const result = await run(request);
    if (result.timedOut || result.exitCode !== 0) throw Error(name + ' failed: ' + result.exitCode);
    if (expected && result.stdout.trim() !== expected)
      throw Error(name + ' positive control failed');
    let boundaries;
    if (!expected) {
      boundaries = JSON.parse(result.stdout.trim());
      if (
        boundaries.inside !== true ||
        ['outsideRead', 'outsideWrite', 'metadata', 'secretEnvironment', 'loopback'].some(
          (key) => boundaries[key] !== false,
        )
      )
        throw Error('Boundary assertion failed');
    }
    results.push({ name, milliseconds: Math.round(performance.now() - start), boundaries });
  }
  if (
    readFileSync(join(outside, 'canary.txt'), 'utf8') !== 'synthetic-canary' ||
    existsSync(join(outside, 'bad.txt'))
  )
    throw Error('Host canary changed');
  console.log(
    JSON.stringify(
      {
        status: 'targeted-probe-passed',
        sdk: manifest.version,
        root,
        results,
        limitation:
          'Not a complete isolation assessment; lifecycle, aliasing and UI boundaries still require tests.',
      },
      null,
      2,
    ),
  );
} finally {
  if (previous === undefined) delete process.env.AMADEUS_MXC_PROBE_SECRET;
  else process.env.AMADEUS_MXC_PROBE_SECRET = previous;
  listener.close();
}
