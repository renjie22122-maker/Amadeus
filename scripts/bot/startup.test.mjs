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
