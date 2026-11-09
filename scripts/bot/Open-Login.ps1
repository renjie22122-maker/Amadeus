param([Parameter(Mandatory=$true)][string]$Config)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Bridge-Page.ps1')
$c=Get-Content -LiteralPath $Config -Raw -Encoding UTF8|ConvertFrom-Json
$page=Get-BotBridgePage $c
if($page){Start-Process $page}
