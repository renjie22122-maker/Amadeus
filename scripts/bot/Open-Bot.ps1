param([Parameter(Mandatory=$true)][string]$Config,[ValidateSet('all','bridge')][string]$Mode='all',[switch]$NoBrowser)
$ErrorActionPreference='Stop'
try{
    $c=Get-Content -LiteralPath $Config -Raw|ConvertFrom-Json
    $suffix=if($Mode -eq 'bridge'){'Bridge'}else{'All'}
    foreach($name in @(($c.taskPrefix+'-'+$suffix),($c.taskPrefix+'-Notices'))){
        if((Get-ScheduledTask -TaskName $name).State -ne 'Running'){Start-ScheduledTask -TaskName $name}
    }
    Write-Host 'Startup requested through Windows Task Scheduler. This does not prove account login.'
    if(-not $NoBrowser){$url=if($Mode -eq 'bridge'){$c.bridgePage}else{$c.agentPage};if($url){Start-Process $url}}
}catch{Write-Host $_.Exception.Message;exit 1}
