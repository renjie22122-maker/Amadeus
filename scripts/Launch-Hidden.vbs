Option Explicit
Dim shell, fso, root, mode, command, arg
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
If WScript.Arguments.Count < 1 Then WScript.Quit 2
mode = WScript.Arguments(0)
If mode <> "main" And mode <> "desktop" And mode <> "all" And mode <> "bridge" Then WScript.Quit 2
command = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File " & Quote(root & "\Start-Hidden.ps1") & " -Mode " & Quote(mode)
If WScript.Arguments.Count > 1 Then command = command & " -Config " & Quote(WScript.Arguments(1))
shell.Run command, 0, False
Function Quote(value)
  If InStr(value, Chr(34)) > 0 Or InStr(value, vbCr) > 0 Or InStr(value, vbLf) > 0 Then WScript.Quit 2
  Quote = Chr(34) & value & Chr(34)
End Function
