$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$previewData = Join-Path $projectRoot '.personal-preview'
if (-not (Test-Path (Join-Path $projectRoot 'build/server/main.js'))) { throw 'Build the project first.' }
New-Item -ItemType Directory -Force $previewData | Out-Null
if (-not (Test-Path (Join-Path $previewData 'settings.json')) -and (Test-Path (Join-Path $projectRoot '.data/settings.json'))) {
  Copy-Item -LiteralPath (Join-Path $projectRoot '.data/settings.json') -Destination (Join-Path $previewData 'settings.json')
}
$env:AGENTDEMO_DATA_DIR = $previewData
$env:PORT = '8820'
$env:AMADEUS_REMOTE_PORT = '8821'
$nodeBinary = (Get-Command node.exe -ErrorAction Stop).Source
$process = Start-Process -FilePath $nodeBinary -ArgumentList 'build/server/main.js' -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $previewData 'server.log') -RedirectStandardError (Join-Path $previewData 'server-error.log') -PassThru
Write-Output "Preview process: $($process.Id). Local UI: http://127.0.0.1:8820. Original service is unchanged."
