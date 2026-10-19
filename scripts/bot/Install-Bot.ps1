param([Parameter(Mandatory=$true)][string]$Config,[switch]$NoShortcuts)
$ErrorActionPreference='Stop'
$Config=(Resolve-Path -LiteralPath $Config).Path
$c=Get-Content -LiteralPath $Config -Raw -Encoding UTF8|ConvertFrom-Json
if($c.version -ne 1 -or $c.taskPrefix -notmatch '^[A-Za-z0-9_-]{1,60}$'){throw 'Invalid task prefix or configuration version'}
foreach($p in @($Config,$PSScriptRoot)){if($p.Contains('"')){throw 'Invalid quoted path'}}
$principal=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$names=@(($c.taskPrefix+'-All'),($c.taskPrefix+'-Bridge'),($c.taskPrefix+'-Notices'))
foreach($n in $names){if((Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue).State -eq 'Running'){throw "Task $n is running. Installation refuses to interrupt it."}}
foreach($mode in @('all','bridge')){
    $suffix=if($mode -eq 'all'){'All'}else{'Bridge'}
    $taskArguments='-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -Config "{1}" -Mode {2}' -f (Join-Path $PSScriptRoot 'Run-Bot.ps1'),$Config,$mode
    $action=New-ScheduledTaskAction -Execute $c.powershell -Argument $taskArguments -WorkingDirectory $PSScriptRoot
    Register-ScheduledTask -TaskName ($c.taskPrefix+'-'+$suffix) -Action $action -Principal $principal -Settings $settings -Force|Out-Null
}
$action=New-ScheduledTaskAction -Execute $c.node -Argument ('"{0}" "{1}"' -f (Join-Path $PSScriptRoot 'offline-notice.mjs'),$Config) -WorkingDirectory $PSScriptRoot
Register-ScheduledTask -TaskName ($c.taskPrefix+'-Notices') -Action $action -Principal $principal -Settings $settings -Force|Out-Null
if(-not $NoShortcuts){
    $shell=New-Object -ComObject WScript.Shell
    foreach($mode in @('all','bridge')){
        $label=if($mode -eq 'all'){'Amadeus + Bot'}else{'Bot only'}
        $link=$shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) ($label+'.lnk')))
        $link.TargetPath=$c.powershell
        $link.Arguments='-NoProfile -ExecutionPolicy Bypass -File "{0}" -Config "{1}" -Mode {2}' -f (Join-Path $PSScriptRoot 'Open-Bot.ps1'),$Config,$mode
        $link.WorkingDirectory=$PSScriptRoot;$link.Save()
    }
}
Write-Host 'Registered on-demand tasks. No service was started or stopped. No logon trigger was added.'
