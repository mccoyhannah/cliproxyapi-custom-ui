param(
    [string]$TaskName = "CPAMC Token Ledger",
    [string]$InstallDir = "D:\CLIProxyAPI",
    [string]$CustomUiDir = "D:\CLIProxyAPI_Maintenance\custom-ui",
    [int]$IntervalMinutes = 5
)

$ErrorActionPreference = "Stop"

if ($IntervalMinutes -lt 1) {
    throw "IntervalMinutes must be at least 1."
}

$pwsh = Get-Command pwsh -ErrorAction Stop
$scriptPath = Join-Path $CustomUiDir "scripts\update-token-ledger.ps1"
if (-not (Test-Path -LiteralPath $scriptPath)) {
    throw "Token ledger wrapper not found: $scriptPath"
}

$taskCommand = "`"$($pwsh.Source)`" -NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`" -InstallDir `"$InstallDir`" -CustomUiDir `"$CustomUiDir`""

$result = schtasks.exe /Create /F /SC MINUTE /MO $IntervalMinutes /TN $TaskName /TR $taskCommand /RL LIMITED
if ($LASTEXITCODE -ne 0) {
    throw "Failed to register scheduled task: $result"
}

[pscustomobject]@{
    TaskName = $TaskName
    IntervalMinutes = $IntervalMinutes
    InstallDir = $InstallDir
    CustomUiDir = $CustomUiDir
    Command = $taskCommand
}
