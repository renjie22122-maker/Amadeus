param([string]$Image = 'amadeus-analysis:local')
$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
if ($Image -notmatch '^[a-z0-9][a-z0-9./:_-]*$') { throw 'Use a valid lowercase local Docker image tag.' }
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Install and start Docker Desktop before preparing analysis tools.' }
$taskDockerOS = & docker info --format '{{.OSType}}'
if ($LASTEXITCODE -ne 0) { throw 'Docker is not running. Start Docker Desktop and rerun; no host fallback is used.' }
if ($taskDockerOS -ne 'linux') { throw 'Select Linux containers in Docker Desktop before building the analysis image.' }
Write-Host 'Building optional Python + FFmpeg analysis image. First setup downloads its base image and OS packages.'
& docker build --tag $Image --file (Join-Path $taskRoot 'docker/analysis/Dockerfile') (Join-Path $taskRoot 'docker/analysis')
if ($LASTEXITCODE -ne 0) { throw 'Analysis image build failed. Fix network/Docker and rerun. Existing settings are unchanged.' }
Write-Host "Ready: $Image. Select Docker execution and this image in Amadeus Settings. No permissions were changed automatically."
