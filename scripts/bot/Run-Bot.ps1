param([Parameter(Mandatory=$true)][string]$Config, [ValidateSet('all','bridge')][string]$Mode='all')
$ErrorActionPreference='Stop'
$c=Get-Content -LiteralPath $Config -Raw -Encoding UTF8 | ConvertFrom-Json
if($c.version -ne 1){throw 'Unsupported bot configuration'}
function Ready($service){
    if($service.healthUrl){try{$r=Invoke-RestMethod $service.healthUrl -TimeoutSec 2;return $r.ready -eq $true -and $r.application -in @('Amadeus','AgentDemo')}catch{return $false}}
    if($service.port){$tcp=New-Object Net.Sockets.TcpClient;try{$wait=$tcp.ConnectAsync('127.0.0.1',[int]$service.port);return $wait.Wait(1000) -and $tcp.Connected}catch{return $false}finally{$tcp.Dispose()}}
    return $false
}
function Ensure-Service($service){
    if(-not $service){return}
    if(Ready $service){Write-Host 'Reusing reachable service.';return}
    $existing=@(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -eq $service.executable})
    if($service.processArgument){$existing=@($existing|Where-Object {$_.CommandLine -and $_.CommandLine.Contains([string]$service.processArgument)})}
    if($existing.Count){Write-Host 'Existing process found; waiting for readiness. No duplicate was started.';return}
    if(-not(Test-Path -LiteralPath $service.executable)){throw 'Configured executable does not exist'}
    if($service.environment){foreach($p in $service.environment.PSObject.Properties){[Environment]::SetEnvironmentVariable($p.Name,[string]$p.Value,'Process')}}
    $stamp=Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    Start-Process -FilePath $service.executable -ArgumentList $service.arguments -WorkingDirectory $service.workingDirectory -WindowStyle Hidden -RedirectStandardOutput (Join-Path $c.logDirectory "$stamp.stdout.log") -RedirectStandardError (Join-Path $c.logDirectory "$stamp.stderr.log") | Out-Null
}
New-Item -ItemType Directory -Force -Path $c.logDirectory | Out-Null
# Both task modes share a machine-local launch mutex. Existing services are never killed.
$mutex=New-Object Threading.Mutex($false,('Local\'+$c.taskPrefix+'-Launch'))
$held=$false
try{
    try{$held=$mutex.WaitOne(60000)}catch [Threading.AbandonedMutexException]{$held=$true}
    if(-not $held){throw 'Another bot launch is still running'}
    Ensure-Service $c.bridge
    if($Mode -eq 'all'){
        if(-not(Ready $c.agent)){
            & $c.powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $c.agentRoot 'Start-Amadeus.ps1') -NoBrowser
            if($LASTEXITCODE -ne 0){throw 'Amadeus launcher failed'}
        }
    }
}finally{if($held){$mutex.ReleaseMutex()};$mutex.Dispose()}
# Keep the Windows scheduler session alive, independently of the launching terminal.
# Do not restart or stop services automatically: a paused service may be intentional.
while($true){Start-Sleep -Seconds 30}
