import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPowerShellTest } from './test-process.mjs';
test(
  'client version guard rejects drift before starting a process',
  { skip: process.platform !== 'win32' },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'bot-version-'));
    try {
      const source = readFileSync(new URL('./Run-Bot.ps1', import.meta.url), 'utf8');
      const fn = source.slice(
        source.indexOf('function Ensure-Service'),
        source.indexOf('New-Item -ItemType Directory'),
      );
      const manifest = join(dir, 'version.json');
      writeFileSync(manifest, JSON.stringify({ curVersion: 'changed' }));
      const script = `$ErrorActionPreference='Stop'
  function Ready {return $false}
  function Get-CimInstance {return @()}
  function Start-Process {throw 'Should not start'}
  ${fn}
  $service=[pscustomobject]@{executable='${process.execPath.replaceAll("'", "''")}';versionCheck=[pscustomobject]@{path='${manifest.replaceAll("'", "''")}';field='curVersion';expected='tested'}}
  try {Ensure-Service $service;throw 'Missing guard'} catch {if($_.Exception.Message -notlike '*version changed*'){throw}}
  `;
      writeFileSync(join(dir, 'test.ps1'), script);
      runPowerShellTest(
        ['-ExecutionPolicy', 'Bypass', '-File', join(dir, 'test.ps1')],
        'client version guard',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
test(
  'hidden dispatcher rejects unknown launch modes without starting a service',
  { skip: process.platform !== 'win32' },
  () => {
    const result = spawnSync(
      'cscript.exe',
      [
        '//nologo',
        new URL('../Launch-Hidden.vbs', import.meta.url).pathname.slice(1).replaceAll('/', '\\'),
        'invalid',
      ],
      { windowsHide: true, timeout: 10000 },
    );
    assert.equal(result.status, 2);
  },
);
