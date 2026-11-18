$ErrorActionPreference='Stop'
$framework=Join-Path $env:SystemRoot 'Microsoft.NET/Framework64/v4.0.30319'
$refs=@('System.dll','System.Core.dll','System.Drawing.dll','System.Windows.Forms.dll','System.Net.Http.dll','System.Web.Extensions.dll','WPF/WindowsBase.dll','WPF/UIAutomationClient.dll','WPF/UIAutomationTypes.dll') | ForEach-Object { '/r:'+(Join-Path $framework $_) }
$exe=Join-Path ([IO.Path]::GetTempPath()) ('Amadeus-writing-fixture-'+[Guid]::NewGuid().ToString('N')+'.exe')
try{
  & (Join-Path $framework 'csc.exe') /nologo /codepage:65001 /main:Fixture "/out:$exe" $refs (Join-Path $PSScriptRoot '../desktop/windows-writing/Writing.cs') (Join-Path $PSScriptRoot 'windows-writing-fixture.cs')
  if($LASTEXITCODE -ne 0){throw 'Failed to compile Windows writing fixture'}
  & $exe
  if($LASTEXITCODE -ne 0){throw 'Windows writing fixture failed'}
}finally{if(Test-Path -LiteralPath $exe){Remove-Item -LiteralPath $exe}}
