// Opt-in design probe only: no saved backend changes, arbitrary commands or real credentials.
import {
  mkdtempSync,
  mkdirSync,
  linkSync,
  lstatSync,
  readdirSync,
  renameSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

if (process.platform !== 'win32') throw Error('Windows is required');
const entry = process.argv[2];
if (!entry || !isAbsolute(entry))
  throw Error('Pass the absolute MXC SDK 1.1.0 dist/v1/index.js path');
const manifest = JSON.parse(readFileSync(resolve(dirname(entry), '../../package.json'), 'utf8'));
if (manifest.name !== '@microsoft/mxc-sdk' || manifest.version !== '1.1.0')
  throw Error('This design probe requires @microsoft/mxc-sdk 1.1.0');
const { withPinnedDirectories } = await import('../native/windows/mxc-directory-grants.mjs');
const { createRequire } = await import('node:module');
const koffi = createRequire(entry)('koffi');
const { probe, run } = await import(pathToFileURL(entry).href);
const root = mkdtempSync(join(tmpdir(), 'amadeus-mxc-design-probe-'));
const work = join(root, 'workspace'),
  outside = join(root, 'outside'),
  temp = join(work, 'temp');
for (const dir of [work, outside, temp, join(work, '.git')]) mkdirSync(dir, { recursive: true });
writeFileSync(join(outside, 'canary.txt'), 'synthetic-canary');
writeFileSync(join(work, '.git', 'config'), 'synthetic-metadata');
// Check the actual file object before trusting a synthetic workspace path.
function assertPlainTree(directory) {
  const pending = [directory];
  while (pending.length) {
    const path = pending.pop();
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1))
      throw Error('UNSUPPORTED_WORKSPACE_ALIAS');
    if (stat.isDirectory()) for (const name of readdirSync(path)) pending.push(join(path, name));
  }
}
const aliasFixture = join(root, 'alias-fixture');
mkdirSync(aliasFixture);
linkSync(join(outside, 'canary.txt'), join(aliasFixture, 'alias.txt'));
let rejectedAlias = false;
try {
  assertPlainTree(aliasFixture);
} catch (error) {
  if (error.message !== 'UNSUPPORTED_WORKSPACE_ALIAS') throw error;
  rejectedAlias = true;
}
if (!rejectedAlias) throw Error('Hard-linked workspace was accepted');
assertPlainTree(work);
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
      ui: {
        isolation: 'container',
        desktopSystemControl: false,
        systemSettings: 'none',
        ime: false,
      },
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
const results = [{ name: 'pre-existing-hardlink-preflight', rejected: rejectedAlias }];
try {
  const project = join(work, '示例 project');
  mkdirSync(project);
  writeFileSync(join(project, 'dependency.cjs'), 'module.exports = 42;');
  writeFileSync(join(project, 'main.cjs'), "console.log(require('./dependency.cjs'));");
  const commands = [
    [
      'node-project',
      '"' +
        process.execPath +
        '" --preserve-symlinks-main --preserve-symlinks "示例 project/main.cjs"',
      '42',
    ],
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
  // Overlap two containers with different grants. Each must see only its own fixture.
  const peers = ['alpha', 'beta'].map((name) => join(root, name));
  for (const dir of peers) {
    mkdirSync(dir);
    writeFileSync(join(dir, 'marker.txt'), dir === peers[0] ? 'alpha' : 'beta');
  }
  const concurrent = await Promise.all(
    peers.map(async (dir, index) => {
      const other = peers[1 - index];
      const script = [
        "$ErrorActionPreference='Stop'",
        '$own=Get-Content -LiteralPath ' + quote(join(dir, 'marker.txt')),
        'try {Get-Content -LiteralPath ' +
          quote(join(other, 'marker.txt')) +
          ' | Out-Null; exit 9} catch [System.UnauthorizedAccessException] {}',
        'Start-Sleep -Milliseconds 350; Write-Output $own',
      ].join('; ');
      const result = await run({
        ...policy,
        workingDirectory: dir,
        filesystem: { ...policy.filesystem, readwritePaths: [dir], deniedPaths: [other] },
        environment: {
          ...policy.environment,
          TEMP: dir,
          TMP: dir,
          USERPROFILE: dir,
          APPDATA: dir,
          LOCALAPPDATA: dir,
        },
        command:
          '"' +
          windows +
          '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -EncodedCommand ' +
          Buffer.from(script, 'utf16le').toString('base64'),
      });
      if (
        result.timedOut ||
        result.exitCode !== 0 ||
        result.stdout.trim() !== ['alpha', 'beta'][index]
      )
        throw Error('Concurrent workspace control failed: ' + result.exitCode);
      return result.stdout.trim();
    }),
  );
  results.push({ name: 'concurrent-workspaces', verified: concurrent });
  // The child records its PID before sleeping so a failed spawn cannot pass cleanup.
  const childCode =
    "require('node:fs').writeFileSync('child.pid', String(process.pid));setTimeout(() => {}, 30000)";
  const encodedChild = Buffer.from(childCode).toString('base64');
  const parentCode =
    "require('node:child_process').spawn(process.execPath, ['-e', Buffer.from('" +
    encodedChild +
    "', 'base64').toString()], {stdio:'ignore'})";
  const expired = await run({
    ...policy,
    command: '"' + process.execPath + '" -e "' + parentCode + '"',
    timeoutMs: 3000,
  });
  if (!expired.timedOut) throw Error('Expected parent timeout: ' + JSON.stringify(expired));
  const childPid = Number(readFileSync(join(work, 'child.pid'), 'utf8'));
  if (!Number.isSafeInteger(childPid) || childPid <= 0) throw Error('Missing child PID');
  let reaped = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      process.kill(childPid, 0);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
      reaped = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!reaped) throw Error('Descendant survived timeout');
  results.push({ name: 'descendant-timeout', reaped });

  // A replacement directory is synthetic and starts outside the granted root.
  for (const nested of [false, true]) {
    const scope = join(root, nested ? 'mutable-parent' : 'granted');
    mkdirSync(scope);
    const granted = nested ? join(scope, 'child') : scope;
    const replacement = join(root, nested ? 'child-replacement' : 'replacement');
    if (nested) mkdirSync(granted);
    mkdirSync(replacement);
    writeFileSync(join(granted, 'identity'), 'original');
    writeFileSync(join(replacement, 'identity'), 'replacement');
    const target = quote(join(granted, 'identity'));
    const readyFile = join(work, nested ? 'child-ready' : 'path-ready');
    const proceed = join(work, nested ? 'child-continue' : 'path-continue');
    const psSwap =
      "$ErrorActionPreference='Stop';if((Get-Content " +
      target +
      ") -ne 'original'){exit 5};Set-Content " +
      quote(readyFile) +
      ' ready;while(!(Test-Path ' +
      quote(proceed) +
      ')){Start-Sleep -Milliseconds 30};try{Get-Content ' +
      target +
      "}catch [System.UnauthorizedAccessException]{'denied'}";
    await withPinnedDirectories(
      koffi,
      [scope],
      async () => {
        const pendingSwap = run({
          ...policy,
          filesystem: {
            ...policy.filesystem,
            readonlyPaths: [...policy.filesystem.readonlyPaths, scope],
          },
          command:
            '"' +
            windows +
            '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -EncodedCommand ' +
            Buffer.from(psSwap, 'utf16le').toString('base64'),
        });
        let renameDenied = false;
        try {
          for (let i = 0; i < 100 && !existsSync(readyFile); i++) await delay(50);
          if (!existsSync(readyFile)) throw Error('Replacement fixture not ready');
          try {
            renameSync(granted, join(root, nested ? 'old-child' : 'previous'));
          } catch (error) {
            if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
            renameDenied = true;
          }
          if (!renameDenied) renameSync(replacement, granted);
        } finally {
          writeFileSync(proceed, 'done');
        }
        const swap = await pendingSwap;
        results.push({
          name: nested ? 'mutable-child-replacement' : 'directory-replacement',
          passed:
            swap.exitCode === 0 && swap.stdout.trim() === (renameDenied ? 'original' : 'denied'),
          observed: swap.stdout.trim(),
        });
      },
      { pinExistingSubdirectories: true },
    );
    renameSync(scope, join(root, nested ? 'released-parent' : 'released-grant'));
  }
  // Look up only a fresh test window by its random title, first from the host.
  const desktopSource = join(work, 'WindowFixture.cs');
  const desktopExe = join(work, 'WindowFixture.exe');
  writeFileSync(
    desktopSource,
    `using System;
using System.Runtime.InteropServices;
class WindowFixture {
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr FindWindow(string cls,string title);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr CreateWindowEx(int ex,string cls,string title,uint style,int x,int y,int w,int h,IntPtr parent,IntPtr menu,IntPtr instance,IntPtr param);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,out uint value,uint size,out uint used);
 static int Main(string[] args) {
   if(args[0]=="job"){uint flags,used;bool ok=QueryInformationJobObject(IntPtr.Zero,4,out flags,4,out used);Console.WriteLine(ok?flags.ToString():"unavailable-"+Marshal.GetLastWin32Error());return 0;}
   if(args[0]=="host"){
     var window=CreateWindowEx(0,"STATIC",args[1],0,0,0,1,1,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero);
     if(window==IntPtr.Zero)return 2;
     Console.WriteLine("ready"); Console.ReadLine(); return 0;
   }
   Console.WriteLine(FindWindow("STATIC",args[1])==IntPtr.Zero?"hidden":"found"); return 0;
 }
}`,
  );
  execFileSync(
    join(windows, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    ['/nologo', '/target:exe', '/out:' + desktopExe, desktopSource],
    { windowsHide: true },
  );
  const title = 'amadeus-fixture-' + (await import('node:crypto')).randomUUID();
  const owner = spawn(desktopExe, ['host', title], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  try {
    const ready = await Promise.race([
      once(owner.stdout, 'data').then(([v]) => v.toString().trim()),
      delay(4000, 'timeout'),
    ]);
    if (
      ready !== 'ready' ||
      execFileSync(desktopExe, ['check', title], { windowsHide: true, encoding: 'utf8' }).trim() !==
        'found'
    )
      throw Error('Host window control failed');
    const job = await run({ ...policy, command: '"' + desktopExe + '" job' });
    results.push({
      name: 'current-job-ui-flags',
      value: job.stdout.trim(),
      exitCode: job.exitCode,
    });
    const check = await run({ ...policy, command: '"' + desktopExe + '" check ' + title });
    results.push({
      name: 'host-window-visibility',
      passed: check.exitCode === 0 && check.stdout.trim() === 'hidden',
    });
  } finally {
    owner.stdin.end('\n');
  }
  // Terminate only a disposable broker after its payload reports that it is running.
  const crashMarker = join(work, 'crash.pid');
  const crashPayload =
    "require('node:fs').writeFileSync('crash.pid',String(process.pid));setTimeout(()=>{},20000)";
  const crashRequest = {
    ...policy,
    timeoutMs: 25000,
    command: '"' + process.execPath + '" -e "' + crashPayload + '"',
  };
  const broker = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      'import {run} from ' +
        JSON.stringify(pathToFileURL(entry).href) +
        '; await run(JSON.parse(process.argv[1]));',
      JSON.stringify(crashRequest),
    ],
    { stdio: 'ignore', windowsHide: true },
  );
  const brokerExit = once(broker, 'exit');
  try {
    for (let i = 0; i < 50 && !existsSync(crashMarker); i++) await delay(100);
    if (!existsSync(crashMarker)) throw Error('Crash fixture did not start');
    const pid = Number(readFileSync(crashMarker, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw Error('Invalid crash fixture PID');
    broker.kill();
    await brokerExit;
    let exited = false;
    for (let i = 0; i < 30; i++) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
        exited = true;
        break;
      }
      await delay(100);
    }
    results.push({ name: 'broker-crash', passed: exited });
    if (!exited)
      throw Error(
        'MXC_BROKER_CRASH_ORPHAN: fixed payload still running three seconds after broker exit',
      );
  } finally {
    if (broker.exitCode === null && !broker.killed) broker.kill();
  }

  if (results.some((item) => item.passed === false)) process.exitCode = 1;
  console.log(
    JSON.stringify(
      {
        status: results.some((item) => item.passed === false) ? 'blocked' : 'targeted-probe-passed',
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
