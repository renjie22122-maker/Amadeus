param([string]$Python = 'python', [switch]$ReusePythonPackages, [string]$Wheelhouse, [string]$EmbeddingModel, [string]$EmbeddingPath, [string]$RerankPath, [string]$OfflineBundle, [switch]$Gpu, [string]$TorchIndexUrl = 'https://download.pytorch.org/whl/cu124')
$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
$taskData = if ($env:AGENTDEMO_DATA_DIR) { [IO.Path]::GetFullPath($env:AGENTDEMO_DATA_DIR) } else { Join-Path $taskRoot '.data' }
Push-Location $taskRoot
try {
    try { $taskHealth = Invoke-RestMethod 'http://127.0.0.1:8811/health' -TimeoutSec 2 } catch { $taskHealth = $null }
    if ($taskHealth) { throw 'Stop the existing local RAG service before changing its dependencies.' }
    $taskRecord = Join-Path $taskData 'retrieval-service/process.json'
    if (Test-Path -LiteralPath $taskRecord) {
        $taskSaved = Get-Content -LiteralPath $taskRecord -Raw | ConvertFrom-Json
        $taskProcess = Get-Process -Id $taskSaved.id -ErrorAction SilentlyContinue
        if ($taskProcess -and $taskProcess.StartTime.ToUniversalTime().Ticks -eq ([datetime]$taskSaved.start).ToUniversalTime().Ticks) {
            throw 'Local RAG is still starting. Stop it before changing dependencies.'
        }
    }
    & $Python -c "import sys; assert (3,11)<=sys.version_info[:2]<(3,14), 'Use Python 3.11-3.13'"
    if ($LASTEXITCODE -ne 0) { throw 'Install Python 3.11-3.13 or pass -Python with its absolute path.' }
    $taskEnv = Join-Path $taskData 'retrieval-python'
    if (-not (Test-Path "$taskEnv/Scripts/python.exe")) {
        if ($ReusePythonPackages) { & $Python -m venv --system-site-packages $taskEnv }
        else { & $Python -m venv $taskEnv }
        if ($LASTEXITCODE -ne 0) { throw 'Could not create the dedicated local RAG environment.' }
    }
    $taskOffline = @()
    if ($OfflineBundle) {
        $taskBundle = (Resolve-Path -LiteralPath $OfflineBundle).Path
        $Wheelhouse = Join-Path $taskBundle 'wheelhouse'
        if (-not $EmbeddingModel) { $EmbeddingModel = 'intfloat/multilingual-e5-large' }
        if (-not $EmbeddingPath) { $EmbeddingPath = Join-Path $taskBundle 'models/multilingual-e5-large' }
        if (-not $RerankPath) { $RerankPath = Join-Path $taskBundle 'models/bge-reranker-v2-m3' }
    }

    if ($Wheelhouse) { $taskOffline = @('--no-index', '--find-links', (Resolve-Path -LiteralPath $Wheelhouse).Path) }
    if ($OfflineBundle) {
        $taskTorch = 'torch'
        $taskConstraints = Join-Path $taskBundle 'constraints.txt'
        if ($Gpu) {
            $taskTorch = 'torch'
            $taskConstraints = Join-Path $taskBundle 'constraints-gpu.txt'
            $taskOffline += @('--find-links',(Join-Path $taskBundle 'wheelhouse-gpu'))
        }
        $taskOffline += @('--constraint',$taskConstraints)
        & "$taskEnv/Scripts/python.exe" -X utf8 -m pip install @taskOffline $taskTorch
        if ($LASTEXITCODE -ne 0) { throw 'Offline PyTorch installation failed.' }
    }
    if ($Gpu -and -not $OfflineBundle) {
        if ($TorchIndexUrl -notmatch '^https://') { throw 'PyTorch package index must use HTTPS.' }
        & "$taskEnv/Scripts/python.exe" -X utf8 -m pip install --index-url $TorchIndexUrl torch
        if ($LASTEXITCODE -ne 0) { throw 'GPU package installation failed. Check the index matches your GPU driver.' }
    }
    & "$taskEnv/Scripts/python.exe" -X utf8 -m pip install @taskOffline --disable-pip-version-check --progress-bar off --timeout 30 --retries 2 -r scripts/requirements-rag.txt
    if ($LASTEXITCODE -ne 0) { throw 'Local RAG dependency installation failed; existing data is preserved.' }
    . (Join-Path $taskRoot 'Launcher.Common.ps1')
    $taskNode = Get-AgentDemoNode
    $taskModelArgs = @()
    if ($EmbeddingModel) { $taskModelArgs += @('--embedding-model',$EmbeddingModel) }
    if ($EmbeddingPath) { $taskModelArgs += @('--embedding-path',(Resolve-Path -LiteralPath $EmbeddingPath).Path) }
    if ($RerankPath) { $taskModelArgs += @('--rerank-path',(Resolve-Path -LiteralPath $RerankPath).Path) }
    & $taskNode --import tsx scripts/local-rag-config.ts @taskModelArgs
    if ($LASTEXITCODE -ne 0) { throw 'Install the app dependencies with First Start before local RAG setup.' }
    & "$taskEnv/Scripts/python.exe" -X utf8 scripts/prepare_retrieval_models.py
    if ($LASTEXITCODE -ne 0) { throw 'Model preparation incomplete. Rerun setup to resume; existing data is preserved.' }
    Write-Host 'Local RAG installed. Run Start-Local-RAG.cmd; first model download can take several minutes. Then configure local connections in Settings.'
} finally { Pop-Location }
