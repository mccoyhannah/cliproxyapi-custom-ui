param(
    [string]$TaskName = "CPAMC Token Ledger",
    [string]$InstallDir = "D:\CLIProxyAPI",
    [string]$CustomUiDir = "D:\CLIProxyAPI_Maintenance\custom-ui",
    [int]$IntervalMinutes = 10
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

$taskArguments = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`" -InstallDir `"$InstallDir`" -CustomUiDir `"$CustomUiDir`""
$action = New-ScheduledTaskAction -Execute $pwsh.Source -Argument $taskArguments
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes($IntervalMinutes) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)
$trigger.Repetition.StopAtDurationEnd = $false
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 72)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

[pscustomobject]@{
    TaskName = $TaskName
    IntervalMinutes = $IntervalMinutes
    InstallDir = $InstallDir
    CustomUiDir = $CustomUiDir
    Execute = $pwsh.Source
    Arguments = $taskArguments
}
