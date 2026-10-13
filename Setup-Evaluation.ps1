param([string]$AnalysisImage = 'amadeus-analysis:local', [string]$Image = 'amadeus-evaluation:local')
$ErrorActionPreference = 'Stop'
foreach ($taskTag in @($AnalysisImage, $Image)) {
    if ($taskTag -notmatch '^[a-z0-9][a-z0-9./:_-]*$') { throw 'Use valid lowercase Docker image tags.' }
}
& (Join-Path $PSScriptRoot 'Setup-Analysis.ps1') -Image $AnalysisImage
& docker build --build-arg "ANALYSIS_IMAGE=$AnalysisImage" --tag $Image --file (Join-Path $PSScriptRoot 'docker/analysis/Dockerfile.eval') (Join-Path $PSScriptRoot 'docker/analysis')
if ($LASTEXITCODE -ne 0) { throw 'Evaluation image build failed; no benchmark or model calls started.' }
& docker run --rm --pull=never --network=none --read-only --cap-drop=ALL --security-opt=no-new-privileges --user 1000:1000 $Image python3 -c 'import shutil,smolagents,ddgs,markdownify,openpyxl,pypdf,PIL; assert shutil.which("ffmpeg"); print("Evaluation dependencies ready")'
if ($LASTEXITCODE -ne 0) { throw 'Evaluation image preflight failed.' }
& docker image inspect --format '{{.Id}}' $Image
Write-Host 'Use the immutable image ID with the evaluation runner. This setup does not launch paid evaluations or change application settings.'
