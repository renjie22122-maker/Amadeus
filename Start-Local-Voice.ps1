param([switch]$NoWait)
$ErrorActionPreference = 'Stop'
$taskData = if ($env:AGENTDEMO_DATA_DIR) { [IO.Path]::GetFullPath($env:AGENTDEMO_DATA_DIR) } else { Join-Path $PSScriptRoot '.data' }
$taskPython = Join-Path $taskData 'voice-asr-python/Scripts/python.exe'
if (-not (Test-Path $taskPython)) { throw 'Run Setup-Local-Voice.cmd first.' }
# Lightweight startup only (no model loading/downloads); readiness is bounded to five seconds.
& $taskPython (Join-Path $PSScriptRoot 'scripts/local_voice/manage.py') start
if ($LASTEXITCODE -ne 0) { throw 'Local voice did not start. Check voice-service/stderr.log.' }
