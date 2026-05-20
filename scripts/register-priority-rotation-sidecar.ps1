param(
    [string]$TaskName = "CPAMC Priority Rotation Sidecar",
    [string]$InstallDir = "D:\CLIProxyAPI",
    [string]$CustomUiDir = "D:\CLIProxyAPI_Maintenance\custom-ui",
    [string]$ProtocolName = "cpamc-priority-rotation",
    [int]$Port = 8318,
    [switch]$StartNow,
    [switch]$SkipStartup
)

$ErrorActionPreference = "Stop"

if ($Port -lt 1 -or $Port -gt 65535) {
    throw "Port must be between 1 and 65535."
}

$wscript = Join-Path $env:WINDIR "System32\wscript.exe"
if (-not (Test-Path -LiteralPath $wscript)) {
    throw "wscript.exe not found: $wscript"
}

$hiddenRunner = Join-Path $CustomUiDir "scripts\run-priority-rotation-sidecar-hidden.vbs"
if (-not (Test-Path -LiteralPath $hiddenRunner)) {
    throw "Hidden sidecar runner not found: $hiddenRunner"
}

$sidecar = Join-Path $CustomUiDir "scripts\priority-rotation-sidecar.mjs"
if (-not (Test-Path -LiteralPath $sidecar)) {
    throw "Priority rotation sidecar not found: $sidecar"
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

function Register-UrlProtocol {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [string]$CommandLine
    )

    if ($Name -notmatch '^[a-z][a-z0-9+.-]*$') {
        throw "Protocol name is invalid: $Name"
    }

    $protocolRoot = "HKCU:\Software\Classes\$Name"
    $commandKey = Join-Path $protocolRoot "shell\open\command"

    New-Item -Path $protocolRoot -Force | Out-Null
    Set-Item -Path $protocolRoot -Value "URL:CPAMC Priority Rotation Sidecar"
    New-ItemProperty -Path $protocolRoot -Name "URL Protocol" -Value "" -PropertyType String -Force | Out-Null
    New-Item -Path $commandKey -Force | Out-Null
    Set-Item -Path $commandKey -Value $CommandLine
}

$taskArguments = "//B //NoLogo `"$hiddenRunner`" `"$InstallDir`" `"$CustomUiDir`" `"$Port`""
$protocolCommand = "`"$wscript`" $taskArguments `"%1`""
$registeredBy = if ($SkipStartup) { "Skipped" } else { "ScheduledTasks" }
$fallbackReason = $null

Register-UrlProtocol -Name $ProtocolName -CommandLine $protocolCommand

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
    ProtocolName = $ProtocolName
    ProtocolCommand = $protocolCommand
    Execute = $wscript
    Arguments = $taskArguments
    Started = [bool]($StartNow -and -not $SkipStartup)
    RegisteredBy = $registeredBy
    FallbackReason = $fallbackReason
}
