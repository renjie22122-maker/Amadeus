import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
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
      const r = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(dir, 'test.ps1')],
        { encoding: 'utf8', timeout: 15000 },
      );
      assert.equal(r.status, 0, r.stdout + r.stderr);
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
    const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  },
);

test('all-mode starts optional services even when main HTTP is already ready',
  { skip: process.platform !== 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot optional '));
  try {
    const source = readFileSync(new URL('./Run-Bot.ps1', import.meta.url), 'utf8').split('# Keep the Windows')[0];
    writeFileSync(join(dir, 'run.ps1'), source);
    writeFileSync(join(dir, 'Start-Amadeus.ps1'), "param([switch]$NoBrowser)\nSet-Content -LiteralPath (Join-Path $PSScriptRoot 'called.txt') -Value 'optional checked'\n");
    writeFileSync(join(dir, 'config.json'), JSON.stringify({version:1,taskPrefix:'OptionalTest'+process.pid,logDirectory:dir,agentRoot:dir,powershell:'powershell.exe',agent:{healthUrl:'http://fixture.invalid/health'}}));
    const quote = s => s.replaceAll("'", "''");
    const script = `function Invoke-RestMethod {[pscustomobject]@{ready=$true;application='Amadeus'}}
& '${quote(join(dir,'run.ps1'))}' -Config '${quote(join(dir,'config.json'))}' -Mode all
if(-not(Test-Path -LiteralPath '${quote(join(dir,'called.txt'))}')){throw 'Optional service startup was skipped'}`;
    const r = spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-Command',script],{encoding:'utf8',timeout:15000});
    assert.equal(r.status,0,r.stdout+r.stderr);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
