param(
    [string]$InstallDir = "D:\CLIProxyAPI",
    [int]$BackendPort = 8317,
    [int]$StopTimeoutSeconds = 12,
    [int]$StartTimeoutSeconds = 30
)

$ErrorActionPreference = "Stop"

$installRoot = [System.IO.Path]::GetFullPath($InstallDir)
$logDir = Join-Path $installRoot "logs"
$exePath = Join-Path $installRoot "cli-proxy-api.exe"
$configPath = Join-Path $installRoot "config.yaml"
$startScript = Join-Path $installRoot "Start-CLIProxyAPI-Logged.ps1"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logPath = Join-Path $logDir "restart-$stamp.log"
$latestLogPath = Join-Path $logDir "restart-latest.log"

New-Item -ItemType Directory -Path $logDir -Force | Out-Null
Set-Content -LiteralPath $latestLogPath -Value "" -Encoding UTF8

function Write-RestartLog {
    param([string]$Message)
    $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff"), $Message
    Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
    Add-Content -LiteralPath $latestLogPath -Value $line -Encoding UTF8
}

function Get-CLIProxyAPIListener {
    Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort $BackendPort -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1
}

function Get-CLIProxyAPIListenerProcess {
    $listener = Get-CLIProxyAPIListener
    if (-not $listener) {
        return $null
    }
    $process = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
    [pscustomobject]@{
        Listener = $listener
        Process = $process
    }
}

function Test-ExpectedProcessPath {
    param([string]$ActualPath)
    if ([string]::IsNullOrWhiteSpace($ActualPath)) {
        return $false
    }
    $actual = [System.IO.Path]::GetFullPath($ActualPath).TrimEnd('\')
    $expected = [System.IO.Path]::GetFullPath($exePath).TrimEnd('\')
    return $actual -ieq $expected
}

function Resolve-PwshPath {
    $candidates = @(
        "C:\Program Files\PowerShell\7\pwsh.exe",
        (Join-Path $env:ProgramFiles "PowerShell\7\pwsh.exe"),
        (Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe")
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) {
            return $candidate
        }
    }
    return "pwsh.exe"
}

function Invoke-StartupWrapper {
    $pwsh = Resolve-PwshPath
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $pwsh
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    foreach ($argument in @("-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $startScript, "-DelaySeconds", "0")) {
        [void]$startInfo.ArgumentList.Add($argument)
    }
    $process = [System.Diagnostics.Process]::Start($startInfo)
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()

    if ($stdout) {
        Write-RestartLog "Startup stdout: $($stdout.Trim())"
    }
    if ($stderr) {
        Write-RestartLog "Startup stderr: $($stderr.Trim())"
    }
    if ($process.ExitCode -ne 0) {
        throw "Startup wrapper failed with exit code $($process.ExitCode)."
    }
}

function Wait-ForPortState {
    param(
        [Parameter(Mandatory = $true)]
        [bool]$Listening,
        [Parameter(Mandatory = $true)]
        [int]$TimeoutSeconds
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $hasListener = [bool](Get-CLIProxyAPIListener)
        if ($hasListener -eq $Listening) {
            return $true
        }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

$startedAt = (Get-Date).ToString("o")
$oldPid = $null
$newPid = $null

try {
    Write-RestartLog "CLIProxyAPI restart wrapper begin. Root=$installRoot BackendPort=$BackendPort"

    if ($BackendPort -ne 8317) {
        throw "This local restart wrapper only supports the current backend port 8317."
    }
    if (-not (Test-Path -LiteralPath $exePath)) {
        throw "Executable not found: $exePath"
    }
    if (-not (Test-Path -LiteralPath $configPath)) {
        throw "Config not found: $configPath"
    }
    if (-not (Test-Path -LiteralPath $startScript)) {
        throw "Startup wrapper not found: $startScript"
    }

    $listenerInfo = Get-CLIProxyAPIListenerProcess
    if ($listenerInfo) {
        $oldPid = [int]$listenerInfo.Listener.OwningProcess
        $processPath = $listenerInfo.Process.Path
        Write-RestartLog "Existing listener found. PID=$oldPid Path=$processPath"
        if (-not (Test-ExpectedProcessPath -ActualPath $processPath)) {
            throw "Refusing to stop PID $oldPid because it is not $exePath"
        }

        Stop-Process -Id $oldPid -Force -ErrorAction Stop
        Write-RestartLog "Stopped old process PID=$oldPid"
        if (-not (Wait-ForPortState -Listening $false -TimeoutSeconds $StopTimeoutSeconds)) {
            throw "Timed out waiting for 127.0.0.1:$BackendPort to stop listening."
        }
    } else {
        Write-RestartLog "No existing listener on 127.0.0.1:$BackendPort; startup will create one."
    }

    Invoke-StartupWrapper
    if (-not (Wait-ForPortState -Listening $true -TimeoutSeconds $StartTimeoutSeconds)) {
        throw "Timed out waiting for 127.0.0.1:$BackendPort to listen."
    }

    $newListenerInfo = Get-CLIProxyAPIListenerProcess
    if (-not $newListenerInfo) {
        throw "Listener check failed after startup."
    }
    $newPid = [int]$newListenerInfo.Listener.OwningProcess
    $newPath = $newListenerInfo.Process.Path
    if (-not (Test-ExpectedProcessPath -ActualPath $newPath)) {
        throw "New listener PID $newPid is not $exePath"
    }

    Write-RestartLog "CLIProxyAPI restart wrapper completed successfully. OldPID=$oldPid NewPID=$newPid"

    $payload = [pscustomobject]@{
        ok = $true
        oldPid = $oldPid
        newPid = $newPid
        backendPort = $BackendPort
        startedAt = $startedAt
        completedAt = (Get-Date).ToString("o")
        logPath = $logPath
    }
    $payload | ConvertTo-Json -Compress -Depth 4
    exit 0
}
catch {
    $message = $_.Exception.Message
    Write-RestartLog "ERROR: $message"
    $payload = [pscustomobject]@{
        ok = $false
        oldPid = $oldPid
        newPid = $newPid
        backendPort = $BackendPort
        startedAt = $startedAt
        completedAt = (Get-Date).ToString("o")
        logPath = $logPath
        error = $message
    }
    $payload | ConvertTo-Json -Compress -Depth 4
    exit 1
}
