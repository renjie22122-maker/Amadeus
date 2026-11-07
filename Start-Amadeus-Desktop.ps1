$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Launcher.Common.ps1')
$taskNode = Get-AgentDemoNode
Push-Location $PSScriptRoot
try {
    & $taskNode desktop/launch.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Amadeus desktop exited with an error. Run pnpm install and pnpm build before the first desktop launch.' }
} finally { Pop-Location }
