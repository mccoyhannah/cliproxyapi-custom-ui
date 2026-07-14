param(
    [string]$InstallDir = "D:\CLIProxyAPI",
    [string]$CustomUiDir = "D:\CLIProxyAPI_Maintenance\custom-ui",
    [switch]$Rebuild,
    [switch]$DryRun,
    [switch]$Embed,
    [switch]$EmbedFull,
    [switch]$PruneRecordedLogs,
    [switch]$PruneOnly,
    [switch]$RescueLowSpace,
    [Nullable[long]]$MinFreeBytes = $null,
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
if ($Embed) {
    $arguments += "--embed"
}
if ($EmbedFull) {
    $arguments += "--embed-full"
}
if ($PruneRecordedLogs) {
    $arguments += "--prune-recorded-logs"
}
if ($PruneOnly) {
    $arguments += "--prune-only"
}
if ($RescueLowSpace) {
    $arguments += "--rescue-low-space"
}
if ($PSBoundParameters.ContainsKey("MinFreeBytes")) {
    $arguments += "--min-free-bytes"
    $arguments += [string]$MinFreeBytes
}
if ($PSBoundParameters.ContainsKey("ActiveWindowMinutes")) {
    $arguments += "--active-window-minutes"
    $arguments += [string]$ActiveWindowMinutes
}

& $node.Source @arguments
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
