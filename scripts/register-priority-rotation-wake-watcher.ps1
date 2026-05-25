param(
    [string]$TaskName = "CPAMC Priority Rotation Wake Watcher",
    [string]$InstallDir = "D:\CLIProxyAPI",
    [string]$CustomUiDir = "D:\CLIProxyAPI_Maintenance\custom-ui",
    [int]$Port = 8318,
    [int]$IdleShutdownMinutes = 20,
    [int]$PollSeconds = 5,
    [int]$CooldownSeconds = 30,
    [switch]$StartNow,
    [switch]$SkipStartup
)

$ErrorActionPreference = "Stop"

if ($Port -lt 1 -or $Port -gt 65535) {
    throw "Port must be between 1 and 65535."
}

if ($IdleShutdownMinutes -lt 1 -or $IdleShutdownMinutes -gt 180) {
    throw "IdleShutdownMinutes must be between 1 and 180."
}

if ($PollSeconds -lt 1 -or $PollSeconds -gt 300) {
    throw "PollSeconds must be between 1 and 300."
}

if ($CooldownSeconds -lt 1 -or $CooldownSeconds -gt 600) {
    throw "CooldownSeconds must be between 1 and 600."
}

$wscript = Join-Path $env:WINDIR "System32\wscript.exe"
if (-not (Test-Path -LiteralPath $wscript)) {
    throw "wscript.exe not found: $wscript"
}

$hiddenRunner = Join-Path $CustomUiDir "scripts\run-priority-rotation-wake-watcher-hidden.vbs"
if (-not (Test-Path -LiteralPath $hiddenRunner)) {
    throw "Hidden wake watcher runner not found: $hiddenRunner"
}

$watcher = Join-Path $CustomUiDir "scripts\priority-rotation-wake-watcher.mjs"
if (-not (Test-Path -LiteralPath $watcher)) {
    throw "Priority rotation wake watcher not found: $watcher"
}

function Invoke-NativeCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [Parameter(Mandatory = $true)]
        [string[]]$ArgumentList
    )

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $FilePath
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    foreach ($argument in $ArgumentList) {
        [void]$startInfo.ArgumentList.Add($argument)
    }

    $process = [System.Diagnostics.Process]::Start($startInfo)
    $standardOutput = $process.StandardOutput.ReadToEnd()
    $standardError = $process.StandardError.ReadToEnd()
    $process.WaitForExit()

    [pscustomobject]@{
        ExitCode = $process.ExitCode
        Output = (@($standardOutput, $standardError) | Where-Object { $_ }) -join [Environment]::NewLine
    }
}

function Register-RunKeyStartup {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [string]$CommandLine
    )

    $runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
    New-Item -Path $runKey -Force | Out-Null
    New-ItemProperty -Path $runKey -Name $Name -Value $CommandLine -PropertyType String -Force | Out-Null
}

$taskArguments = "//B //NoLogo `"$hiddenRunner`" `"$InstallDir`" `"$CustomUiDir`" `"$Port`" `"$IdleShutdownMinutes`" `"$PollSeconds`" `"$CooldownSeconds`""
$registeredBy = if ($SkipStartup) { "Skipped" } else { "ScheduledTasks" }
$fallbackReason = $null

if (-not $SkipStartup) {
    try {
        $action = New-ScheduledTaskAction -Execute $wscript -Argument $taskArguments
        $trigger = New-ScheduledTaskTrigger -AtLogOn
        $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Days 7) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
        $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

        Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

        if ($StartNow) {
            Start-ScheduledTask -TaskName $TaskName
        }
    } catch {
        $registeredBy = "schtasks"
        $schtasks = Join-Path $env:WINDIR "System32\schtasks.exe"
        if (-not (Test-Path -LiteralPath $schtasks)) {
            throw "schtasks.exe not found: $schtasks"
        }

        $taskRun = "`"$wscript`" $taskArguments"
        $createArgs = @(
            "/Create",
            "/F",
            "/TN", $TaskName,
            "/SC", "ONLOGON",
            "/RL", "LIMITED",
            "/TR", $taskRun
        )
        $createResult = Invoke-NativeCommand -FilePath $schtasks -ArgumentList $createArgs
        if ($createResult.ExitCode -ne 0) {
            $registeredBy = "HKCU Run"
            $fallbackReason = "schtasks.exe registration failed: $($createResult.Output)"
            Register-RunKeyStartup -Name $TaskName -CommandLine $taskRun
            if ($StartNow) {
                Start-Process -FilePath $wscript -ArgumentList $taskArguments -WindowStyle Hidden
            }
        } elseif ($StartNow) {
            $runResult = Invoke-NativeCommand -FilePath $schtasks -ArgumentList @("/Run", "/TN", $TaskName)
            if ($runResult.ExitCode -ne 0) {
                $registeredBy = "HKCU Run"
                $fallbackReason = "schtasks.exe start failed: $($runResult.Output)"
                Register-RunKeyStartup -Name $TaskName -CommandLine $taskRun
                Start-Process -FilePath $wscript -ArgumentList $taskArguments -WindowStyle Hidden
            }
        }
    }
}

[pscustomobject]@{
    TaskName = $TaskName
    InstallDir = $InstallDir
    CustomUiDir = $CustomUiDir
    Port = $Port
    IdleShutdownMinutes = $IdleShutdownMinutes
    PollSeconds = $PollSeconds
    CooldownSeconds = $CooldownSeconds
    Execute = $wscript
    Arguments = $taskArguments
    Started = [bool]($StartNow -and -not $SkipStartup)
    RegisteredBy = $registeredBy
    FallbackReason = $fallbackReason
}
