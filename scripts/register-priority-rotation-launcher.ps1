param(
    [string]$InstallDir = "D:\CLIProxyAPI",
    [string]$CustomUiDir = "D:\CLIProxyAPI_Maintenance\custom-ui",
    [string]$ProtocolName = "cpamc-priority-rotation",
    [int]$Port = 8318
)

$ErrorActionPreference = "Stop"

$registerScript = Join-Path $PSScriptRoot "register-priority-rotation-sidecar.ps1"
if (-not (Test-Path -LiteralPath $registerScript)) {
    throw "Sidecar registration script not found: $registerScript"
}

& $registerScript `
    -InstallDir $InstallDir `
    -CustomUiDir $CustomUiDir `
    -ProtocolName $ProtocolName `
    -Port $Port `
    -SkipStartup
