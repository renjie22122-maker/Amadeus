import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
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
$c.bridgePage='https://example.com';$blocked=$false
try{Get-BotBridgePage $c|Out-Null}catch{$blocked=$true}
if(-not $blocked){throw 'Remote token disclosure'}
if((Get-BotBridgePage ([pscustomobject]@{bridgePage='http://localhost:1234'})) -ne 'http://localhost:1234'){throw 'Legacy behavior changed'}
`;
      const path = join(dir, 'test.ps1');
      writeFileSync(path, script);
      const result = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path],
        { encoding: 'utf8', timeout: 15000 },
      );
      assert.equal(result.status, 0, result.stdout + result.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
