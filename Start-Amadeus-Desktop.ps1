$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Launcher.Common.ps1')
$taskNode = Get-AgentDemoNode
Push-Location $PSScriptRoot
try {
    # Attach to the same independent service as the browser; never create a second workspace.
    $taskPreviousBackend = $env:AMADEUS_BACKEND_URL
    if (-not $env:AMADEUS_BACKEND_URL) {
        $taskUrl = 'http://127.0.0.1:8810'
        if (-not (Test-AmadeusHealth $taskUrl)) { & (Join-Path $PSScriptRoot 'Start-Amadeus.ps1') -NoBrowser }
        if (-not (Test-AmadeusHealth $taskUrl)) { throw 'Shared Amadeus service is not ready; desktop was not opened with a separate database.' }
        $env:AMADEUS_BACKEND_URL = $taskUrl
    }
    & $taskNode desktop/launch.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Amadeus desktop exited with an error. Run pnpm install and pnpm build before the first desktop launch.' }
} finally { $env:AMADEUS_BACKEND_URL = $taskPreviousBackend; Pop-Location }
