param([switch]$NoWait)
$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
$taskData = if ($env:AGENTDEMO_DATA_DIR) { [IO.Path]::GetFullPath($env:AGENTDEMO_DATA_DIR) } else { Join-Path $taskRoot '.data' }
$taskPython = Join-Path $taskData 'retrieval-python/Scripts/python.exe'
$taskConfig = Join-Path $taskData 'retrieval-service/config.json'
if (-not (Test-Path $taskPython) -or -not (Test-Path $taskConfig)) { throw 'Run Setup-Local-RAG.cmd first.' }
$taskExisting = $null
try { $taskExisting = Invoke-RestMethod 'http://127.0.0.1:8811/health' -TimeoutSec 2 } catch {}
if ($taskExisting) {
    if ($taskExisting.application -ne 'Amadeus Local RAG') { throw 'Port 8811 belongs to another service.' }
    Write-Host 'Local RAG already running. Configuration changes require restarting this service.'
    return
}
$taskPidFile = Join-Path $taskData 'retrieval-service/process.json'
if (Test-Path $taskPidFile) {
    $taskSaved = Get-Content $taskPidFile -Raw | ConvertFrom-Json
    $taskProcess = Get-Process -Id $taskSaved.id -ErrorAction SilentlyContinue
    if ($taskProcess -and $taskProcess.StartTime.ToUniversalTime().Ticks -eq ([datetime]$taskSaved.start).ToUniversalTime().Ticks) {
        Write-Host 'Local RAG is starting or downloading models; inspect .data/retrieval-service/stderr.log.'
        return
    }
}
$taskProcess = Start-Process -FilePath $taskPython -ArgumentList @('-X','utf8','-u','scripts/retrieval_service.py','--warmup') -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskData 'retrieval-service/stdout.log') -RedirectStandardError (Join-Path $taskData 'retrieval-service/stderr.log')
@{id=$taskProcess.Id;start=$taskProcess.StartTime.ToUniversalTime().ToString('o')} | ConvertTo-Json | Set-Content $taskPidFile
Write-Host 'Local RAG started in background. Model loading may take several minutes; configured local model folders require no download.'
if (-not $NoWait) {
    for ($taskAttempt=0; $taskAttempt -lt 30; $taskAttempt++) {
        Start-Sleep -Seconds 1
        try { $taskHealth=Invoke-RestMethod 'http://127.0.0.1:8811/health' -TimeoutSec 1; Write-Host 'Local RAG ready.'; return } catch {}
        if ($taskProcess.HasExited) { throw 'Local RAG exited. Inspect .data/retrieval-service/stderr.log.' }
    }
    Write-Host 'Still preparing; logs and process record are preserved. Do not run setup again while preparation is active.'
}
