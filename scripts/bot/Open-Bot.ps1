param([Parameter(Mandatory=$true)][string]$Config,[ValidateSet('all','bridge')][string]$Mode='all',[switch]$NoBrowser)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Bridge-Page.ps1')
try{
    $c=Get-Content -LiteralPath $Config -Raw -Encoding UTF8|ConvertFrom-Json
    $suffix=if($Mode -eq 'bridge'){'Bridge'}else{'All'}
    $launchTask=$c.taskPrefix+'-'+$suffix
    if((Get-ScheduledTask -TaskName $launchTask).State -eq 'Running') {
        # An alive scheduler wrapper does not prove its child service is ready.
        & (Join-Path $PSScriptRoot 'Run-Bot.ps1') -Config $Config -Mode $Mode -Once
        if($LASTEXITCODE -ne 0){throw 'Bot readiness recovery failed; inspect local logs.'}
    } else {Start-ScheduledTask -TaskName $launchTask}
    $noticeTask=$c.taskPrefix+'-Notices'
    if((Get-ScheduledTask -TaskName $noticeTask).State -ne 'Running'){Start-ScheduledTask -TaskName $noticeTask}
    if($c.bridge.port){
        $ready=$false
        for($attempt=0;$attempt -lt 30;$attempt++){
            $tcp=New-Object Net.Sockets.TcpClient
            try{$ready=$tcp.ConnectAsync('127.0.0.1',[int]$c.bridge.port).Wait(500) -and $tcp.Connected}catch{}finally{$tcp.Dispose()}
            if($ready){break};Start-Sleep -Seconds 2
        }
        if(-not $ready){throw ('Bot interface did not become ready. A running QQ process is not proof of login. Check QQ/NapCat compatibility and logs: '+$c.logDirectory)}
    }
    Write-Host 'Startup requested through Windows Task Scheduler. This does not prove account login.'
    if(-not $NoBrowser){$url=if($Mode -eq 'bridge'){Get-BotBridgePage $c}else{$c.agentPage};if($url){Start-Process $url}}
}catch{Write-Host $_.Exception.Message;exit 1}
