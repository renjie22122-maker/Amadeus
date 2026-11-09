import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPowerShellTest } from './test-process.mjs';
test(
  'bridge login prefill reads local token and rejects non-loopback targets',
  { skip: process.platform !== 'win32' },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'bridge page '));
    const q = (s) => s.replaceAll("'", "''");
    try {
      const config = join(dir, 'webui.json');
      writeFileSync(config, JSON.stringify({ token: 'fixture+?&token' }));
      const script = `$ErrorActionPreference='Stop'
. '${q(fileURLToPath(new URL('./Bridge-Page.ps1', import.meta.url)))}'
$c=[pscustomobject]@{bridgePage='http://127.0.0.1:6099';bridgeWebUiConfig='${q(config)}'}
$u=[Uri](Get-BotBridgePage $c)
if($u.AbsolutePath -ne '/webui/web_login' -or $u.Query -ne '?token=fixture%2B%3F%26token'){throw 'Incorrect prefill'}
$script:probes=0
function Invoke-WebRequest { param($Uri,[switch]$UseBasicParsing,$TimeoutSec,$MaximumRedirection)
 $script:probes++
 if($Uri -match 'secret' -or $MaximumRedirection -ne 0){throw 'Unsafe probe'}
 return [pscustomobject]@{StatusCode=200}
}
$c.bridgePage='http://127.0.0.1:6099/?token=secret'
if(-not (Test-BotManagementReady $c)){throw 'Login page should count as management readiness'}
$c.bridgePage='https://example.com'
if(Test-BotManagementReady $c){throw 'Remote probe accepted'}
if($script:probes -ne 1){throw 'Unexpected external probe'}
$c.bridgePage='https://example.com';$blocked=$false
try{Get-BotBridgePage $c|Out-Null}catch{$blocked=$true}
if(-not $blocked){throw 'Remote token disclosure'}
if((Get-BotBridgePage ([pscustomobject]@{bridgePage='http://localhost:1234'})) -ne 'http://localhost:1234'){throw 'Legacy behavior changed'}
`;
      const launcherConfig = join(dir, 'launcher.json');
      writeFileSync(
        launcherConfig,
        JSON.stringify({
          taskPrefix: 'fixture',
          bridge: { port: 1 },
          bridgePage: 'http://127.0.0.1:6099',
          bridgeWebUiConfig: config,
          agentPage: 'http://127.0.0.1:8810',
        }),
      );
      const launchChecks = `
function Get-ScheduledTask { param($TaskName) return [pscustomobject]@{State='Ready'} }
function Start-ScheduledTask { param($TaskName) }
function Start-Process { param($FilePath) $global:fixtureOpened=$FilePath }
& '${q(fileURLToPath(new URL('./Open-Bot.ps1', import.meta.url)))}' -Config '${q(launcherConfig)}' -Mode all
if($LASTEXITCODE -eq 1){throw 'Management-only readiness was rejected'}
if(([Uri]$global:fixtureOpened).Port -ne 6099){throw 'Combined launcher did not open login management'}
`;
      const path = join(dir, 'test.ps1');
      writeFileSync(path, script + launchChecks);
      runPowerShellTest(['-ExecutionPolicy', 'Bypass', '-File', path], 'bridge login prefill');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
