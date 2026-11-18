param([Parameter(Mandatory=$true)][string]$Service,[Parameter(Mandatory=$true)][int]$ParentPid)
$ErrorActionPreference='Stop'
$framework=[Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()
$refs=@('System.dll','System.Core.dll','System.Drawing.dll','System.Windows.Forms.dll','System.Net.Http.dll','System.Web.Extensions.dll','WPF/WindowsBase.dll','WPF/UIAutomationClient.dll','WPF/UIAutomationTypes.dll') | ForEach-Object { Join-Path $framework $_ }
Add-Type -Path (Join-Path $PSScriptRoot 'Writing.cs') -ReferencedAssemblies $refs
[AmadeusWriting.Panel]::Run($Service,$ParentPid)
