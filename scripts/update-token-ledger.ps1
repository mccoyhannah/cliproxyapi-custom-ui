param(
    [string]$InstallDir = "D:\CLIProxyAPI",
    [string]$CustomUiDir = "D:\CLIProxyAPI_Maintenance\custom-ui",
    [switch]$Rebuild,
    [switch]$DryRun,
    [switch]$PruneRecordedLogs,
    [switch]$PruneOnly,
    [int]$ActiveWindowMinutes = 5
)

$ErrorActionPreference = "Stop"

$node = Get-Command node -ErrorAction Stop
$scriptPath = Join-Path $CustomUiDir "scripts\update-token-ledger.mjs"
if (-not (Test-Path -LiteralPath $scriptPath)) {
    throw "Token ledger script not found: $scriptPath"
}

$arguments = @(
    $scriptPath,
    "--install-dir",
    $InstallDir,
    "--custom-ui-dir",
    $CustomUiDir
)

if ($Rebuild) {
    $arguments += "--rebuild"
}
if ($DryRun) {
    $arguments += "--dry-run"
}
if ($PruneRecordedLogs) {
    $arguments += "--prune-recorded-logs"
}
if ($PruneOnly) {
    $arguments += "--prune-only"
}
if ($PSBoundParameters.ContainsKey("ActiveWindowMinutes")) {
    $arguments += "--active-window-minutes"
    $arguments += [string]$ActiveWindowMinutes
}

& $node.Source @arguments
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
