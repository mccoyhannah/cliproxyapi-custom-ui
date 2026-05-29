param(
    [string]$InstallDir = "D:\CLIProxyAPI",
    [string]$CustomUiDir = "D:\CLIProxyAPI_Maintenance\custom-ui",
    [string]$ProtocolName = "cpamc-cliproxyapi-control",
    [int]$Port = 8319,
    [int]$BackendPort = 8317,
    [int]$IdleShutdownMinutes = 10,
    [switch]$StartNow
)

$ErrorActionPreference = "Stop"

if ($Port -lt 1 -or $Port -gt 65535) {
    throw "Port must be between 1 and 65535."
}
if ($BackendPort -ne 8317) {
    throw "This control helper only supports the current backend port 8317."
}
if ($IdleShutdownMinutes -lt 1 -or $IdleShutdownMinutes -gt 180) {
    throw "IdleShutdownMinutes must be between 1 and 180."
}
if ($ProtocolName -notmatch '^[a-z][a-z0-9+.-]*$') {
    throw "Protocol name is invalid: $ProtocolName"
}

$wscript = Join-Path $env:WINDIR "System32\wscript.exe"
if (-not (Test-Path -LiteralPath $wscript)) {
    throw "wscript.exe not found: $wscript"
}

$hiddenRunner = Join-Path $CustomUiDir "scripts\run-cliproxyapi-control-sidecar-hidden.vbs"
$sidecar = Join-Path $CustomUiDir "scripts\cliproxyapi-control-sidecar.mjs"
$restartScriptSource = Join-Path $CustomUiDir "scripts\Restart-CLIProxyAPI-Logged.ps1"
$restartScriptTarget = Join-Path $InstallDir "Restart-CLIProxyAPI-Logged.ps1"

foreach ($required in @($hiddenRunner, $sidecar, $restartScriptSource)) {
    if (-not (Test-Path -LiteralPath $required)) {
        throw "Required file not found: $required"
    }
}
if (-not (Test-Path -LiteralPath $InstallDir)) {
    throw "InstallDir not found: $InstallDir"
}

Copy-Item -LiteralPath $restartScriptSource -Destination $restartScriptTarget -Force

$protocolRoot = "HKCU:\Software\Classes\$ProtocolName"
$commandKey = Join-Path $protocolRoot "shell\open\command"
$taskArguments = "//B //NoLogo `"$hiddenRunner`" `"$InstallDir`" `"$CustomUiDir`" `"$Port`" `"$BackendPort`" `"$IdleShutdownMinutes`""
$protocolCommand = "`"$wscript`" $taskArguments `"%1`""

New-Item -Path $protocolRoot -Force | Out-Null
Set-Item -Path $protocolRoot -Value "URL:CPAMC CLIProxyAPI Control Helper"
New-ItemProperty -Path $protocolRoot -Name "URL Protocol" -Value "" -PropertyType String -Force | Out-Null
New-Item -Path $commandKey -Force | Out-Null
Set-Item -Path $commandKey -Value $protocolCommand

if ($StartNow) {
    Start-Process -FilePath $wscript -ArgumentList $taskArguments -WindowStyle Hidden
}

[pscustomobject]@{
    InstallDir = $InstallDir
    CustomUiDir = $CustomUiDir
    Port = $Port
    BackendPort = $BackendPort
    IdleShutdownMinutes = $IdleShutdownMinutes
    ProtocolName = $ProtocolName
    ProtocolCommand = $protocolCommand
    RestartScript = $restartScriptTarget
    Started = [bool]$StartNow
}
