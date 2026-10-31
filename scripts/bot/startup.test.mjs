import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPowerShellTest } from './test-process.mjs';
test(
  'Windows launcher parses and reuses existing processes without duplicates',
  { skip: process.platform !== 'win32' },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'bot launch '));
    try {
      const source = readFileSync(new URL('./Run-Bot.ps1', import.meta.url), 'utf8').split(
        '# Keep the Windows',
      )[0];
      writeFileSync(join(dir, 'run.ps1'), source);
      const config = {
        version: 1,
        notice: '中文配置与日语テスト',
        taskPrefix: 'BotTest' + process.pid,
        logDirectory: dir,
        bridge: {
          executable: process.execPath,
          arguments: '--version',
          workingDirectory: dir,
          processArgument: 'fixture',
        },
      };
      writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
      const ps = `$ErrorActionPreference='Stop'
  $global:started=0;$global:exists=$false
  function Get-CimInstance {if($global:exists){[pscustomobject]@{ExecutablePath='${process.execPath.replaceAll("'", "''")}';CommandLine='fixture'}}}
  function Start-Process {$global:started++}
  & '${join(dir, 'run.ps1').replaceAll("'", "''")}' -Config '${join(dir, 'config.json').replaceAll("'", "''")}' -Mode bridge
  if($global:started -ne 1){throw 'Cold start was not requested'}
  $global:exists=$true
  & '${join(dir, 'run.ps1').replaceAll("'", "''")}' -Config '${join(dir, 'config.json').replaceAll("'", "''")}' -Mode bridge
  if($global:started -ne 1){throw 'Duplicate process started'}
  `;
      writeFileSync(join(dir, 'test.ps1'), ps);
      runPowerShellTest(
        ['-ExecutionPolicy', 'Bypass', '-File', join(dir, 'test.ps1')],
        'launcher process reuse',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
test(
  'bridge restart stops only the matched root descendants',
  { skip: process.platform !== 'win32' },
  () => {
    const source = readFileSync(new URL('./Run-Bot.ps1', import.meta.url), 'utf8');
    const fn = source.slice(
      source.indexOf('function Restart-Bridge'),
      source.indexOf('function Ensure-Service'),
    );
    const script = `$ErrorActionPreference='Stop'
 $global:stopped=@()
 $global:rows=@(
 [pscustomobject]@{ProcessId=10;ParentProcessId=1;ExecutablePath='bridge.exe';CommandLine='bot-id';CreationDate='one'},
 [pscustomobject]@{ProcessId=11;ParentProcessId=10;ExecutablePath='QQ.exe';CommandLine='child';CreationDate='two'},
 [pscustomobject]@{ProcessId=20;ParentProcessId=1;ExecutablePath='QQ.exe';CommandLine='personal';CreationDate='three'})
 function Get-CimInstance {param($ClassName,$Filter);if($Filter){$id=[int]($Filter -replace 'ProcessId=','');$global:rows|Where-Object ProcessId -eq $id}else{$global:rows}}
 function Stop-Process {param($Id,$ErrorAction);$global:stopped+=$Id}
 function Start-Sleep {}
 ${fn}
 Restart-Bridge ([pscustomobject]@{executable='bridge.exe';processArgument='bot-id'})
 if(($global:stopped -join ',') -ne '11,10'){throw 'Wrong process tree stopped'}
 `;
    runPowerShellTest(['-Command', script], 'bridge scoped restart');
  },
);

test(
  'all-mode starts optional services even when main HTTP is already ready',
  { skip: process.platform !== 'win32' },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'bot optional '));
    try {
      const source = readFileSync(new URL('./Run-Bot.ps1', import.meta.url), 'utf8').split(
        '# Keep the Windows',
      )[0];
      writeFileSync(join(dir, 'run.ps1'), source);
      writeFileSync(
        join(dir, 'Start-Amadeus.ps1'),
        "param([switch]$NoBrowser)\nSet-Content -LiteralPath (Join-Path $PSScriptRoot 'called.txt') -Value 'optional checked'\n",
      );
      writeFileSync(
        join(dir, 'config.json'),
        JSON.stringify({
          version: 1,
          taskPrefix: 'OptionalTest' + process.pid,
          logDirectory: dir,
          agentRoot: dir,
          powershell: 'powershell.exe',
          agent: { healthUrl: 'http://fixture.invalid/health' },
        }),
      );
      const quote = (s) => s.replaceAll("'", "''");
      const script = `function Invoke-RestMethod {[pscustomobject]@{ready=$true;application='Amadeus'}}
& '${quote(join(dir, 'run.ps1'))}' -Config '${quote(join(dir, 'config.json'))}' -Mode all
if(-not(Test-Path -LiteralPath '${quote(join(dir, 'called.txt'))}')){throw 'Optional service startup was skipped'}`;
      runPowerShellTest(
        ['-ExecutionPolicy', 'Bypass', '-Command', script],
        'optional service startup',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  'main readiness waits through transient failures and preserves live supervisor locks',
  { skip: process.platform !== 'win32' },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'amadeus readiness '));
    try {
      const common = new URL('../../Launcher.Common.ps1', import.meta.url);
      writeFileSync(join(dir, 'common.ps1'), readFileSync(common, 'utf8'));
      const script = `$ErrorActionPreference='Stop'
. '${join(dir, 'common.ps1').replaceAll("'", "''")}'
$global:checks=0
function Invoke-RestMethod { $global:checks++; if($global:checks -lt 3){throw 'temporarily busy'}; [pscustomobject]@{application='Amadeus';ready=$true} }
if(-not (Wait-AmadeusHealth 'http://fixture' 10)){throw 'Did not wait for recovery'}
if($global:checks -ne 3){throw 'Unexpected health retries'}
if(Wait-AmadeusHealth 'http://fixture' 0){throw 'Timeout reported as ready'}
function Invoke-RestMethod { [pscustomobject]@{application='Amadeus';ready=$false} }
if(Test-AmadeusHealth 'http://fixture'){throw 'Unready response accepted'}
$dir='${dir.replaceAll("'", "''")}'
if(Test-AmadeusSupervisor $dir){throw 'Missing lock accepted'}
@{pid=$PID}|ConvertTo-Json|Set-Content (Join-Path $dir 'supervisor.lock')
if(-not (Test-AmadeusSupervisor $dir)){throw 'Live owner ignored'}
if(-not(Test-Path (Join-Path $dir 'supervisor.lock'))){throw 'Live lock was deleted'}
@{pid=2147483647}|ConvertTo-Json|Set-Content (Join-Path $dir 'supervisor.lock')
if(Test-AmadeusSupervisor $dir){throw 'Dead owner accepted'}
$errors=$null;$tokens=$null
[System.Management.Automation.Language.Parser]::ParseFile('${fileURLToPath(new URL('../../Start-Amadeus.ps1', import.meta.url)).replaceAll("'", "''")}',[ref]$tokens,[ref]$errors)|Out-Null
if($errors.Count){throw ($errors|Out-String)}
`;
      writeFileSync(join(dir, 'test.ps1'), script);
      runPowerShellTest(
        ['-ExecutionPolicy', 'Bypass', '-File', join(dir, 'test.ps1')],
        'main readiness',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
