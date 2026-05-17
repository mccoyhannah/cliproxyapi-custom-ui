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

$wscript = Join-Path $env:WINDIR "System32\wscript.exe"
if (-not (Test-Path -LiteralPath $wscript)) {
    throw "wscript.exe not found: $wscript"
}

$scriptPath = Join-Path $CustomUiDir "scripts\update-token-ledger.ps1"
if (-not (Test-Path -LiteralPath $scriptPath)) {
    throw "Token ledger wrapper not found: $scriptPath"
}

$hiddenRunner = Join-Path $CustomUiDir "scripts\run-token-ledger-hidden.vbs"
if (-not (Test-Path -LiteralPath $hiddenRunner)) {
    throw "Hidden token ledger runner not found: $hiddenRunner"
}

$taskArguments = "//B //NoLogo `"$hiddenRunner`" `"$InstallDir`" `"$CustomUiDir`""
$action = New-ScheduledTaskAction -Execute $wscript -Argument $taskArguments
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
    Execute = $wscript
    Arguments = $taskArguments
}
