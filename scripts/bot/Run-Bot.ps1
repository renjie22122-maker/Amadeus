param([Parameter(Mandatory=$true)][string]$Config, [ValidateSet('all','bridge')][string]$Mode='all', [switch]$RestartBridge)
$ErrorActionPreference='Stop'
$c=Get-Content -LiteralPath $Config -Raw -Encoding UTF8 | ConvertFrom-Json
if($c.version -ne 1){throw 'Unsupported bot configuration'}
function Ready($service){
    if($service.healthUrl){try{$r=Invoke-RestMethod $service.healthUrl -TimeoutSec 2;return $r.ready -eq $true -and $r.application -in @('Amadeus','AgentDemo')}catch{return $false}}
    if($service.port){$tcp=New-Object Net.Sockets.TcpClient;try{$wait=$tcp.ConnectAsync('127.0.0.1',[int]$service.port);return $wait.Wait(1000) -and $tcp.Connected}catch{return $false}finally{$tcp.Dispose()}}
    return $false
}
function Restart-Bridge($service){
    if(-not $service.processArgument){throw 'Restart requires an explicit process identity argument'}
    $processes=@(Get-CimInstance Win32_Process)
    $roots=@($processes | Where-Object {$_.ExecutablePath -eq $service.executable -and $_.CommandLine -and $_.CommandLine.Contains([string]$service.processArgument)})
    if($roots.Count -gt 1){throw 'Ambiguous bridge processes; refusing restart'}
    if($roots.Count -eq 0){return}
    $ids=@([uint32]$roots[0].ProcessId)
    do {$children=@($processes|Where-Object {$_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids});$ids+=@($children | ForEach-Object {[uint32]$_.ProcessId})}while($children.Count)
    [array]::Reverse($ids)
    foreach($id in $ids){
        $saved=$processes|Where-Object ProcessId -eq $id
        $current=Get-CimInstance Win32_Process -Filter ('ProcessId='+$id)
        if($current -and $current.CreationDate -eq $saved.CreationDate -and $current.ExecutablePath -eq $saved.ExecutablePath){Stop-Process -Id $id -ErrorAction Stop}
    }
    Start-Sleep -Seconds 2
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
    if($RestartBridge){Restart-Bridge $c.bridge}
    Ensure-Service $c.bridge
    if($Mode -eq 'all'){
        if(-not(Ready $c.agent)){
            & $c.powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $c.agentRoot 'Start-Amadeus.ps1') -NoBrowser
            if($LASTEXITCODE -ne 0){throw 'Amadeus launcher failed'}
        }
    }
}finally{if($held){$mutex.ReleaseMutex()};$mutex.Dispose()}
if($RestartBridge){exit 0}
# Keep the Windows scheduler session alive, independently of the launching terminal.
# Do not restart or stop services automatically: a paused service may be intentional.
while($true){Start-Sleep -Seconds 30}

