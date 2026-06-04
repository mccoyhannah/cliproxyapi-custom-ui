Option Explicit

Dim shell, fso, scriptDir, installDir, customUiDir, port, backendPort, idleShutdownMinutes
Dim nodePath, scriptPath, command

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

If WScript.Arguments.Count >= 3 Then
    port = WScript.Arguments.Item(2)
Else
    port = "8319"
End If

If WScript.Arguments.Count >= 4 Then
    backendPort = WScript.Arguments.Item(3)
Else
    backendPort = "8317"
End If

If WScript.Arguments.Count >= 5 Then
    If IsNumeric(WScript.Arguments.Item(4)) Then
        idleShutdownMinutes = WScript.Arguments.Item(4)
    Else
        idleShutdownMinutes = "10"
    End If
Else
    idleShutdownMinutes = "10"
End If

nodePath = "D:\install\nodejs\node.exe"
If Not fso.FileExists(nodePath) Then
    nodePath = fso.BuildPath(shell.ExpandEnvironmentStrings("%ProgramFiles%"), "nodejs\node.exe")
End If
If Not fso.FileExists(nodePath) Then
    nodePath = fso.BuildPath(shell.ExpandEnvironmentStrings("%ProgramFiles(x86)%"), "nodejs\node.exe")
End If
If Not fso.FileExists(nodePath) Then
    nodePath = "node.exe"
End If

scriptPath = fso.BuildPath(scriptDir, "cliproxyapi-control-sidecar.mjs")
If Not fso.FileExists(scriptPath) Then
    WScript.Quit 2
End If

command = Quote(nodePath) & " " & Quote(scriptPath) & _
    " --install-dir " & Quote(installDir) & _
    " --custom-ui-dir " & Quote(customUiDir) & _
    " --port " & Quote(port) & _
    " --backend-port " & Quote(backendPort) & _
    " --idle-shutdown-minutes " & Quote(idleShutdownMinutes)
shell.Run command, 0, False
WScript.Quit 0

Function Quote(value)
    Quote = Chr(34) & Replace(value, Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function
