param([ValidateSet('main','desktop','all','bridge')][string]$Mode='main',[string]$Config)
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
$logs=Join-Path $root '.data/logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$log=Join-Path $logs ('launcher-'+$Mode+'-'+(Get-Date -Format 'yyyyMMdd-HHmmss-fff')+'.log')
try {
    Start-Transcript -Path $log | Out-Null
    if ($Mode -eq 'main') { & (Join-Path $root 'Start-Amadeus.ps1') }
    elseif ($Mode -eq 'desktop') { & (Join-Path $root 'Start-Amadeus-Desktop.ps1') }
    else {
        if (-not $Config) { $Config=Join-Path $root '.data/bot/config.json' }
        & (Join-Path $PSScriptRoot 'bot/Open-Bot.ps1') -Config $Config -Mode $Mode
    }
    if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw 'Launcher failed; see log.' }
} catch {
    $message=$_.Exception.Message+"`nLog: "+$log
    Write-Output $message
    (New-Object -ComObject WScript.Shell).Popup($message,0,'Amadeus startup failed',16) | Out-Null
    exit 1
} finally { try { Stop-Transcript | Out-Null } catch {} }
