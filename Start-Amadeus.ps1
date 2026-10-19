param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
$taskUrl = 'http://127.0.0.1:8810'
. (Join-Path $taskRoot 'Launcher.Common.ps1')
if (Test-Path (Join-Path $(if ($env:AGENTDEMO_DATA_DIR) { $env:AGENTDEMO_DATA_DIR } else { Join-Path $taskRoot '.data' }) 'retrieval-service/config.json')) {
    try { & (Join-Path $taskRoot 'Start-Local-RAG.ps1') -NoWait }
    catch { Write-Warning ("Optional local RAG did not start: " + $_.Exception.Message) }
}
if (Test-Path (Join-Path $(if ($env:AGENTDEMO_DATA_DIR) { $env:AGENTDEMO_DATA_DIR } else { Join-Path $taskRoot '.data' }) 'voice-service/config.json')) {
    try { & (Join-Path $taskRoot 'Start-Local-Voice.ps1') -NoWait }
    catch { Write-Warning ("Optional local voice did not start: " + $_.Exception.Message) }
}
$taskHealth = $null
try { $taskHealth = Invoke-RestMethod "$taskUrl/api/health" -TimeoutSec 2 } catch {}
if ($taskHealth.application -in @('Amadeus', 'AgentDemo')) {
        if (-not (Test-AgentDemoStamp (Join-Path $taskRoot 'dist/.agentdemo-build') (Get-AgentDemoFingerprint $taskRoot))) {
            Write-Warning 'Local files have changed since the last build. Stop the running service when your tasks are finished, then run this launcher again to apply updates. Opening the existing service does not reload it.'
        }
        if (-not $NoBrowser) { Start-Process $taskUrl }
        Write-Host "Amadeus is already running at $taskUrl. This opens the existing process; it does not restart or upgrade it."
        exit 0
}
$taskNode = Get-AgentDemoNode
$env:PATH = (Split-Path $taskNode) + ';' + $env:PATH
if (-not (Test-Path -LiteralPath (Join-Path $taskRoot 'node_modules/tsx')) -or
    -not (Test-AgentDemoStamp (Join-Path $taskRoot 'node_modules/.agentdemo-dependencies') (Get-AgentDemoFingerprint $taskRoot -DependenciesOnly))) {
    Write-Host 'First launch or dependency update detected. Preparing dependencies and frontend...'
    & (Join-Path $taskRoot 'First-Start-Amadeus.ps1') -SetupOnly -NoBrowser
}
if (-not (Test-Path -LiteralPath (Join-Path $taskRoot 'build/server/main.js')) -or
    -not (Test-Path -LiteralPath (Join-Path $taskRoot 'dist/index.html')) -or
    -not (Test-AgentDemoStamp (Join-Path $taskRoot 'dist/.agentdemo-build') (Get-AgentDemoFingerprint $taskRoot))) {
    Push-Location $taskRoot
    try {
        & $taskNode node_modules/typescript/bin/tsc --noEmit
        if ($LASTEXITCODE -ne 0) { throw 'TypeScript check failed.' }
        & $taskNode scripts/build-server.mjs
        if ($LASTEXITCODE -ne 0) { throw 'Server build failed; service was not started.' }
        & $taskNode node_modules/vite/bin/vite.js build
        if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
        Set-Content -LiteralPath (Join-Path $taskRoot 'dist/.agentdemo-build') -Value (Get-AgentDemoFingerprint $taskRoot)
    } finally { Pop-Location }
}
$taskData = if ($env:AGENTDEMO_DATA_DIR) { $env:AGENTDEMO_DATA_DIR } else { Join-Path $taskRoot '.data' }
$taskLogs = Join-Path $taskData 'logs'
New-Item -ItemType Directory -Force -Path $taskLogs | Out-Null
$taskLogStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$taskSupervisor = Start-Process -PassThru -FilePath $taskNode -ArgumentList @('scripts/supervisor.mjs') -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskLogs "supervisor-$taskLogStamp.stdout.log") -RedirectStandardError (Join-Path $taskLogs "supervisor-$taskLogStamp.stderr.log")
$taskReady = $false
$taskWait = [Diagnostics.Stopwatch]::StartNew()
while ($taskWait.Elapsed.TotalSeconds -lt 90) {
    Start-Sleep -Milliseconds 250
    try {
        $taskHealth = Invoke-RestMethod "$taskUrl/api/health" -TimeoutSec 1
        if ($taskHealth.application -in @('Amadeus', 'AgentDemo')) { $taskReady = $true; break }
    } catch {}
    if ($taskSupervisor.HasExited) {
        $taskFailure = Get-Content -LiteralPath (Join-Path $taskLogs "supervisor-$taskLogStamp.stderr.log") -Tail 8 -ErrorAction SilentlyContinue
        throw ("Amadeus supervisor exited. " + ($taskFailure -join "`n") + "`nCheck $taskLogs")
    }
}
if (-not $taskReady) { throw "Amadeus did not become ready. Check $taskLogs" }
if (-not $NoBrowser) { Start-Process $taskUrl }
Write-Host "Amadeus is ready at $taskUrl"
