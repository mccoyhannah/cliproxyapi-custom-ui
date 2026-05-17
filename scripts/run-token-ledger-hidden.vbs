Option Explicit

Dim shell, fso, scriptDir, installDir, customUiDir, programFiles, pwshPath, scriptPath, command, exitCode

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

If WScript.Arguments.Count >= 1 Then
    installDir = WScript.Arguments.Item(0)
Else
    installDir = "D:\CLIProxyAPI"
End If

If WScript.Arguments.Count >= 2 Then
    customUiDir = WScript.Arguments.Item(1)
Else
    customUiDir = "D:\CLIProxyAPI_Maintenance\custom-ui"
End If

programFiles = shell.ExpandEnvironmentStrings("%ProgramFiles%")
pwshPath = fso.BuildPath(programFiles, "PowerShell\7\pwsh.exe")
If Not fso.FileExists(pwshPath) Then
    pwshPath = "pwsh.exe"
End If

scriptPath = fso.BuildPath(scriptDir, "update-token-ledger.ps1")
If Not fso.FileExists(scriptPath) Then
    WScript.Quit 2
End If

command = Quote(pwshPath) & " -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File " & Quote(scriptPath) & " -InstallDir " & Quote(installDir) & " -CustomUiDir " & Quote(customUiDir)
exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode

Function Quote(value)
    Quote = Chr(34) & Replace(value, Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function
