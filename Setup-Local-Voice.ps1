param([string]$Python = 'python', [switch]$SkipDownload, [switch]$AsrOnly)
$ErrorActionPreference = 'Stop'
$taskArgs = @((Join-Path $PSScriptRoot 'scripts/local_voice/manage.py'), 'setup', '--python', $Python)
if ($SkipDownload) { $taskArgs += '--skip-download' }
if ($AsrOnly) { $taskArgs += '--asr-only' }
& $Python @taskArgs
if ($LASTEXITCODE -ne 0) { throw 'Local voice preparation failed; inspect the error above. Existing services were not restarted.' }
