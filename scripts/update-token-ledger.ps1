param(
    [string]$InstallDir = "D:\CLIProxyAPI",
    [string]$CustomUiDir = "D:\CLIProxyAPI_Maintenance\custom-ui",
    [ValidateSet("Refresh", "Preview", "Execute")]
    [string]$Mode = "Refresh",
    [string]$PreviewId = "",
    [switch]$Rebuild,
    [switch]$DryRun,
    [switch]$Embed,
    [switch]$EmbedFull,
    [switch]$PruneRecordedLogs,
    [switch]$PruneOnly,
    [switch]$RescueLowSpace,
    [Nullable[long]]$MinFreeBytes = $null,
    [ValidateRange(5, 1440)]
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

if ($Mode -ne "Refresh") {
    $hasLegacyMaintenanceArguments =
        $Rebuild -or $DryRun -or $Embed -or $EmbedFull -or $PruneRecordedLogs -or
        $PruneOnly -or $RescueLowSpace -or $PSBoundParameters.ContainsKey("MinFreeBytes")
    if ($hasLegacyMaintenanceArguments) {
        [Console]::Error.WriteLine('{"schemaVersion":1,"status":"error","code":"TOKEN_LEDGER_FIXED_PATHS","message":"Token ledger maintenance uses fixed production paths."}')
        exit 1
    }
    if ($Mode -eq "Execute" -and [string]::IsNullOrWhiteSpace($PreviewId)) {
        [Console]::Error.WriteLine('{"schemaVersion":1,"status":"error","code":"TOKEN_LEDGER_PREVIEW_REQUIRED","message":"A current token ledger maintenance preview is required."}')
        exit 1
    }
    $arguments += "--maintenance"
    $arguments += $Mode.ToLowerInvariant()
    if ($Mode -eq "Execute") {
        $arguments += "--preview-id"
        $arguments += $PreviewId
    }
} else {
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
}
if ($PSBoundParameters.ContainsKey("ActiveWindowMinutes")) {
    $arguments += "--active-window-minutes"
    $arguments += [string]$ActiveWindowMinutes
}

& $node.Source @arguments
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
