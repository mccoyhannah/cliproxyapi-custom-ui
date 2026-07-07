param(
    [string]$InstallDir = "D:\CLIProxyAPI",
    [string]$CustomUiDir = "D:\CLIProxyAPI_Maintenance\custom-ui",
    [int]$BackendPort = 8317,
    [int]$ControlPort = 8319,
    [int]$LocalProxyPort = 33210,
    [int]$RecentMinutes = 360,
    [int]$MaxLogFiles = 50,
    [int]$MaxLogLinesPerFile = 400,
    [int]$MaxLogBytesPerFile = 262144,
    [switch]$Json
)

$ErrorActionPreference = "Stop"

function Protect-SensitiveText {
    param([AllowNull()][string]$Text)

    if ($null -eq $Text) {
        return $null
    }

    $value = [string]$Text
    $value = [regex]::Replace($value, '(?i)(authorization\s*[:=]\s*bearer\s+)[^\s,;''"]+', '$1[REDACTED]')
    $value = [regex]::Replace($value, '(?i)(bearer\s+)[A-Za-z0-9._~+/=-]{12,}', '$1[REDACTED]')
    $value = [regex]::Replace($value, '(?i)((?:management[-_\s]?key|api[-_\s]?key|apikey|token|secret|password|auth(?:orization)?)\s*[:=]\s*)("[^"]*"|''[^'']*''|[^\s,;]+)', '$1[REDACTED]')
    $value = [regex]::Replace($value, '(?i)\b(sk-[A-Za-z0-9_-]{12,})\b', '[REDACTED_OPENAI_KEY]')
    $value = [regex]::Replace($value, '(?i)\b(wpa-[A-Za-z0-9._-]{12,})\b', '[REDACTED_PROVIDER_KEY]')
    $value = [regex]::Replace($value, '\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b', '[REDACTED_JWT]')
    return $value
}

function Resolve-FullPath {
    param([string]$Path)
    return [System.IO.Path]::GetFullPath($Path)
}

function Convert-Bytes {
    param([Nullable[Int64]]$Bytes)
    if ($null -eq $Bytes) {
        return $null
    }
    return [Math]::Round($Bytes / 1MB, 2)
}

function Get-FileSummary {
    param(
        [string]$Name,
        [string]$Path
    )

    $item = Get-Item -LiteralPath $Path -ErrorAction SilentlyContinue
    if (-not $item) {
        return [pscustomobject]@{
            Name = $Name
            Path = $Path
            Exists = $false
            LengthBytes = $null
            LengthMB = $null
            LastWriteTime = $null
        }
    }

    return [pscustomobject]@{
        Name = $Name
        Path = $item.FullName
        Exists = $true
        LengthBytes = [int64]$item.Length
        LengthMB = Convert-Bytes -Bytes $item.Length
        LastWriteTime = $item.LastWriteTime
    }
}

function Test-TcpLoopback {
    param(
        [int]$Port,
        [int]$TimeoutMs = 1000
    )

    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $async = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMs)) {
            return [pscustomobject]@{
                Reachable = $false
                Error = "connect timed out after ${TimeoutMs}ms"
            }
        }
        $client.EndConnect($async)
        return [pscustomobject]@{
            Reachable = $true
            Error = $null
        }
    }
    catch {
        return [pscustomobject]@{
            Reachable = $false
            Error = Protect-SensitiveText -Text $_.Exception.Message
        }
    }
    finally {
        $client.Close()
    }
}

function Get-ProcessSummary {
    param([int]$ProcessId)

    $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $process) {
        return [pscustomobject]@{
            Pid = $ProcessId
            Name = $null
            Path = $null
            StartTime = $null
        }
    }

    $path = $null
    $startTime = $null
    try {
        $path = $process.Path
    }
    catch {
        $path = $null
    }
    try {
        $startTime = $process.StartTime
    }
    catch {
        $startTime = $null
    }

    return [pscustomobject]@{
        Pid = $ProcessId
        Name = $process.ProcessName
        Path = Protect-SensitiveText -Text $path
        StartTime = $startTime
    }
}

function Get-CachedTcpListeners {
    if ($script:CachedTcpListeners) {
        return $script:CachedTcpListeners
    }

    $listeners = @()
    $netstat = Join-Path $env:WINDIR "System32\netstat.exe"
    if (Test-Path -LiteralPath $netstat) {
        $lines = & $netstat -ano -p TCP
        foreach ($line in $lines) {
            $parts = $line.Trim() -split "\s+"
            if ($parts.Count -lt 5 -or $parts[0] -ne "TCP" -or $parts[3] -ne "LISTENING") {
                continue
            }
            $pidValue = 0
            if (-not [int]::TryParse($parts[4], [ref]$pidValue)) {
                continue
            }
            $portText = $null
            if ($parts[1] -match ':(?<port>\d+)$') {
                $portText = $Matches["port"]
            }
            elseif ($parts[1] -match '\.(?<port>\d+)$') {
                $portText = $Matches["port"]
            }
            if (-not $portText) {
                continue
            }
            $portValue = 0
            if (-not [int]::TryParse($portText, [ref]$portValue)) {
                continue
            }
            $listeners += [pscustomobject]@{
                LocalAddress = $parts[1]
                LocalPort = $portValue
                OwningProcess = $pidValue
            }
        }
    }

    $script:CachedTcpListeners = @($listeners)
    return $script:CachedTcpListeners
}

function Get-PortSummary {
    param(
        [int]$Port,
        [string]$Role
    )

    $listeners = @()
    $connections = @(Get-CachedTcpListeners | Where-Object { $_.LocalPort -eq $Port })
    foreach ($connection in $connections) {
        $process = Get-ProcessSummary -ProcessId ([int]$connection.OwningProcess)
        $listeners += [pscustomobject]@{
            LocalAddress = $connection.LocalAddress
            LocalPort = [int]$connection.LocalPort
            OwningProcess = [int]$connection.OwningProcess
            ProcessName = $process.Name
            ProcessPath = $process.Path
            ProcessStartTime = $process.StartTime
        }
    }

    $tcpProbe = Test-TcpLoopback -Port $Port
    return [pscustomobject]@{
        Role = $Role
        Port = $Port
        Listening = $listeners.Count -gt 0
        LoopbackConnect = $tcpProbe.Reachable
        ConnectError = $tcpProbe.Error
        ListenerCount = $listeners.Count
        Listeners = @($listeners)
    }
}

function Invoke-HttpProbe {
    param(
        [string]$Uri,
        [string]$Method = "GET",
        [int]$TimeoutSeconds = 3
    )

    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $response = Invoke-WebRequest -Uri $Uri -Method $Method -TimeoutSec $TimeoutSeconds -UseBasicParsing -ErrorAction Stop
        $timer.Stop()
        $length = $response.Headers["Content-Length"]
        return [pscustomobject]@{
            Uri = $Uri
            Method = $Method
            Reachable = $true
            StatusCode = [int]$response.StatusCode
            DurationMs = [int64]$timer.ElapsedMilliseconds
            ContentLength = $length
            Error = $null
        }
    }
    catch {
        $timer.Stop()
        $statusCode = $null
        if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
            $statusCode = [int]$_.Exception.Response.StatusCode
        }
        return [pscustomobject]@{
            Uri = $Uri
            Method = $Method
            Reachable = $false
            StatusCode = $statusCode
            DurationMs = [int64]$timer.ElapsedMilliseconds
            ContentLength = $null
            Error = Protect-SensitiveText -Text $_.Exception.Message
        }
    }
}

function Invoke-ControlStatusProbe {
    param(
        [int]$Port,
        [int]$TimeoutSeconds = 3
    )

    $uri = "http://127.0.0.1:$Port/status"
    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $payload = Invoke-RestMethod -Uri $uri -Method GET -TimeoutSec $TimeoutSeconds -ErrorAction Stop
        $timer.Stop()
        return [pscustomobject]@{
            Uri = $uri
            Reachable = $true
            StatusCode = 200
            DurationMs = [int64]$timer.ElapsedMilliseconds
            Pid = $payload.pid
            BackendRunning = $payload.backendRunning
            BackendPid = $payload.backendPid
            BackendPathMatches = $payload.backendPathMatches
            Restarting = $payload.restarting
            TokenLedgerRefreshing = $payload.tokenLedgerRefreshing
            BackendError = Protect-SensitiveText -Text $payload.backendError
            Error = $null
        }
    }
    catch {
        $timer.Stop()
        $statusCode = $null
        if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
            $statusCode = [int]$_.Exception.Response.StatusCode
        }
        return [pscustomobject]@{
            Uri = $uri
            Reachable = $false
            StatusCode = $statusCode
            DurationMs = [int64]$timer.ElapsedMilliseconds
            Pid = $null
            BackendRunning = $null
            BackendPid = $null
            BackendPathMatches = $null
            Restarting = $null
            TokenLedgerRefreshing = $null
            BackendError = $null
            Error = Protect-SensitiveText -Text $_.Exception.Message
        }
    }
}

function Get-LogTimestamp {
    param([string]$Line)

    $patterns = @(
        '(?<ts>\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,7})?(?:Z|[+-]\d{2}:?\d{2})?)',
        '(?<ts>\d{4}/\d{1,2}/\d{1,2}\s+\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,7})?)'
    )

    foreach ($pattern in $patterns) {
        $match = [regex]::Match($Line, $pattern)
        if (-not $match.Success) {
            continue
        }

        $candidate = $match.Groups["ts"].Value.Replace(",", ".")
        $parsed = [datetime]::MinValue
        if ([datetime]::TryParse($candidate, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AllowWhiteSpaces, [ref]$parsed)) {
            return $parsed
        }
    }

    return $null
}

function Get-DurationMsFromLine {
    param([string]$Line)

    $patterns = @(
        '(?i)\b(?:duration|elapsed|latency|took|cost|time|耗时)[_\-\s:=]*([0-9]+(?:\.[0-9]+)?)\s*(ms|milliseconds?|s|sec|seconds?)\b',
        '(?i)\bin\s+([0-9]+(?:\.[0-9]+)?)\s*(ms|milliseconds?|s|sec|seconds?)\b',
        '(?i)"(?:duration_ms|durationMs|elapsed_ms|elapsedMs|latency_ms|latencyMs)"\s*:\s*([0-9]+(?:\.[0-9]+)?)',
        '(?i)"(?:duration|elapsed|latency)"\s*:\s*([0-9]+(?:\.[0-9]+)?)'
    )

    foreach ($pattern in $patterns) {
        $match = [regex]::Match($Line, $pattern)
        if (-not $match.Success) {
            continue
        }

        $number = 0.0
        if (-not [double]::TryParse($match.Groups[1].Value, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$number)) {
            continue
        }

        $unit = ""
        if ($match.Groups.Count -gt 2) {
            $unit = $match.Groups[2].Value.ToLowerInvariant()
        }
        if ($unit -match '^s') {
            $number = $number * 1000
        }

        return [Math]::Round($number, 2)
    }

    return $null
}

function Test-Status502 {
    param([string]$Line)
    return $Line -match '(?i)(\b502\b|bad\s+gateway|status(?:Code)?["''\s:=]+502)'
}

function Get-Percentile {
    param(
        [double[]]$Values,
        [double]$Percentile
    )

    if (-not $Values -or $Values.Count -eq 0) {
        return $null
    }
    $sorted = @($Values | Sort-Object)
    $index = [Math]::Ceiling(($Percentile / 100) * $sorted.Count) - 1
    $index = [Math]::Max(0, [Math]::Min($sorted.Count - 1, $index))
    return [Math]::Round([double]$sorted[$index], 2)
}

function Get-DurationSummary {
    param([double[]]$Values)

    if (-not $Values -or $Values.Count -eq 0) {
        return [pscustomobject]@{
            Count = 0
            MinMs = $null
            MedianMs = $null
            P95Ms = $null
            MaxMs = $null
            AverageMs = $null
        }
    }

    $measure = $Values | Measure-Object -Minimum -Maximum -Average
    return [pscustomobject]@{
        Count = $Values.Count
        MinMs = [Math]::Round([double]$measure.Minimum, 2)
        MedianMs = Get-Percentile -Values $Values -Percentile 50
        P95Ms = Get-Percentile -Values $Values -Percentile 95
        MaxMs = [Math]::Round([double]$measure.Maximum, 2)
        AverageMs = [Math]::Round([double]$measure.Average, 2)
    }
}

function Read-LogSnippets {
    param(
        [string]$Path,
        [int]$MaxBytes,
        [int]$MaxLines
    )

    $file = Get-Item -LiteralPath $Path -ErrorAction Stop
    $length = [int64]$file.Length
    if ($length -le 0) {
        return @()
    }

    $byteCount = [Math]::Min([int64][Math]::Max(4096, $MaxBytes), $length)
    $half = [int64][Math]::Max(2048, [Math]::Floor($byteCount / 2))
    $encoding = [System.Text.Encoding]::UTF8
    $snippets = [System.Collections.Generic.List[string]]::new()
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
        if ($length -le $byteCount) {
            $buffer = [byte[]]::new($length)
            [void]$stream.Read($buffer, 0, $buffer.Length)
            [void]$snippets.Add($encoding.GetString($buffer))
        }
        else {
            $headBytes = [Math]::Min($half, $length)
            $headBuffer = [byte[]]::new($headBytes)
            [void]$stream.Read($headBuffer, 0, $headBuffer.Length)
            [void]$snippets.Add($encoding.GetString($headBuffer))

            $tailBytes = [Math]::Min($byteCount - $headBytes, $length)
            if ($tailBytes -gt 0) {
                [void]$stream.Seek(-1 * $tailBytes, [System.IO.SeekOrigin]::End)
                $tailBuffer = [byte[]]::new($tailBytes)
                [void]$stream.Read($tailBuffer, 0, $tailBuffer.Length)
                [void]$snippets.Add($encoding.GetString($tailBuffer))
            }
        }
    }
    finally {
        $stream.Dispose()
    }

    $lines = @()
    foreach ($snippet in $snippets) {
        if ([string]::IsNullOrEmpty($snippet)) {
            continue
        }
        $parts = @($snippet -split "`r?`n")
        if ($parts.Count -gt $MaxLines) {
            $parts = @($parts | Select-Object -Last $MaxLines)
        }
        $lines += $parts
    }
    return $lines
}

function Get-TopFileCounts {
    param([hashtable]$Counts)

    return @(
        $Counts.GetEnumerator() |
            Sort-Object Value -Descending |
            Select-Object -First 8 |
            ForEach-Object {
                [pscustomobject]@{
                    File = $_.Key
                    Count = $_.Value
                }
            }
    )
}

function Add-Count {
    param(
        [hashtable]$Counts,
        [string]$Key
    )

    if ($Counts.ContainsKey($Key)) {
        $Counts[$Key] += 1
    }
    else {
        $Counts[$Key] = 1
    }
}

function Get-LogDiagnostics {
    param(
        [string]$LogDir,
        [datetime]$Cutoff,
        [int]$MaxFiles,
        [int]$MaxLinesPerFile,
        [int]$MaxBytesPerFile
    )

    if (-not (Test-Path -LiteralPath $LogDir)) {
        return [pscustomobject]@{
            LogDir = $LogDir
            Exists = $false
            Cutoff = $Cutoff
            ScannedFiles = 0
            MaxSnippetBytesPerFile = $MaxBytesPerFile
            ScanErrors = @()
            ApiCall = $null
            ResetCredits = $null
        }
    }

    $allLogFiles = @(Get-ChildItem -LiteralPath $LogDir -File -Filter "*.log" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
    $candidateFiles = @($allLogFiles | Where-Object { $_.LastWriteTime -ge $Cutoff } | Select-Object -First $MaxFiles)
    if ($candidateFiles.Count -eq 0) {
        $candidateFiles = @($allLogFiles | Select-Object -First $MaxFiles)
    }

    $apiPattern = '(?i)(?:/v0/management)?/api-call\b'
    $resetPattern = '(?i)(?:rate-limit-reset-credits|reset[-_\s]?credits?|wham/rate-limit-reset-credits)'
    $apiDurations = [System.Collections.Generic.List[double]]::new()
    $apiFileCounts = @{}
    $resetFileCounts = @{}
    $scanErrors = @()
    $apiMatched = 0
    $apiRecentMatched = 0
    $apiWithoutTimestamp = 0
    $api502 = 0
    $apiRecent502 = 0
    $resetMatched = 0
    $resetRecentMatched = 0
    $reset502 = 0
    $resetRecent502 = 0
    $lastApiAt = $null
    $lastResetAt = $null

    foreach ($file in $candidateFiles) {
        try {
            $lines = @(Read-LogSnippets -Path $file.FullName -MaxBytes $MaxBytesPerFile -MaxLines $MaxLinesPerFile)
        }
        catch {
            $scanErrors += [pscustomobject]@{
                File = $file.Name
                Error = Protect-SensitiveText -Text $_.Exception.Message
            }
            continue
        }

        foreach ($line in $lines) {
            $lineText = [string]$line
            $lineTime = Get-LogTimestamp -Line $lineText
            $isRecent = if ($lineTime) { $lineTime -ge $Cutoff } else { $file.LastWriteTime -ge $Cutoff }

            if ($lineText -match $apiPattern) {
                $apiMatched += 1
                Add-Count -Counts $apiFileCounts -Key $file.Name
                if ($isRecent) {
                    $apiRecentMatched += 1
                }
                if (-not $lineTime) {
                    $apiWithoutTimestamp += 1
                }
                else {
                    if ($null -eq $lastApiAt -or $lineTime -gt $lastApiAt) {
                        $lastApiAt = $lineTime
                    }
                }
                if (Test-Status502 -Line $lineText) {
                    $api502 += 1
                    if ($isRecent) {
                        $apiRecent502 += 1
                    }
                }
                $duration = Get-DurationMsFromLine -Line $lineText
                if ($null -ne $duration) {
                    [void]$apiDurations.Add([double]$duration)
                }
            }

            if ($lineText -match $resetPattern) {
                $resetMatched += 1
                Add-Count -Counts $resetFileCounts -Key $file.Name
                if ($isRecent) {
                    $resetRecentMatched += 1
                }
                if ($lineTime) {
                    if ($null -eq $lastResetAt -or $lineTime -gt $lastResetAt) {
                        $lastResetAt = $lineTime
                    }
                }
                if (Test-Status502 -Line $lineText) {
                    $reset502 += 1
                    if ($isRecent) {
                        $resetRecent502 += 1
                    }
                }
            }
        }
    }

    return [pscustomobject]@{
        LogDir = $LogDir
        Exists = $true
        Cutoff = $Cutoff
        AvailableLogFiles = $allLogFiles.Count
        ScannedFiles = $candidateFiles.Count
        MaxTailLinesPerFile = $MaxLinesPerFile
        MaxSnippetBytesPerFile = $MaxBytesPerFile
        RecencyRule = "Line timestamp is used when parseable; otherwise file LastWriteTime is used."
        ScanErrors = @($scanErrors)
        ApiCall = [pscustomobject]@{
            RoutePattern = "/v0/management/api-call or /api-call"
            MatchedLines = $apiMatched
            RecentMatchedLines = $apiRecentMatched
            LinesWithoutTimestamp = $apiWithoutTimestamp
            Status502Lines = $api502
            RecentStatus502Lines = $apiRecent502
            LastTimestampSeen = $lastApiAt
            DurationMs = Get-DurationSummary -Values $apiDurations.ToArray()
            TopFiles = Get-TopFileCounts -Counts $apiFileCounts
        }
        ResetCredits = [pscustomobject]@{
            Pattern = "rate-limit-reset-credits / reset-credits"
            MatchedLines = $resetMatched
            RecentMatchedLines = $resetRecentMatched
            Status502Lines = $reset502
            RecentStatus502Lines = $resetRecent502
            LastTimestampSeen = $lastResetAt
            TopFiles = Get-TopFileCounts -Counts $resetFileCounts
        }
    }
}

function Format-NullableBool {
    param($Value)
    if ($null -eq $Value) {
        return "n/a"
    }
    return [string][bool]$Value
}

$installRoot = Resolve-FullPath -Path $InstallDir
$customUiRoot = Resolve-FullPath -Path $CustomUiDir
$staticDir = Join-Path $installRoot "static"
$logDir = Join-Path $installRoot "logs"
$cutoff = (Get-Date).AddMinutes(-1 * [Math]::Max(1, $RecentMinutes))

$portSummaries = @(
    Get-PortSummary -Port $BackendPort -Role "CLIProxyAPI backend"
    Get-PortSummary -Port $ControlPort -Role "CPAMC control sidecar"
    Get-PortSummary -Port $LocalProxyPort -Role "Local proxy port"
)

$managementProbe = Invoke-HttpProbe -Uri "http://127.0.0.1:$BackendPort/management.html" -Method "HEAD" -TimeoutSeconds 2
if (-not $managementProbe.Reachable -and ($managementProbe.StatusCode -eq 404 -or $managementProbe.StatusCode -eq 405)) {
    $managementProbe = Invoke-HttpProbe -Uri "http://127.0.0.1:$BackendPort/management.html" -Method "GET" -TimeoutSeconds 2
}

$controlPortSummary = $portSummaries | Where-Object { $_.Port -eq $ControlPort } | Select-Object -First 1
if ($controlPortSummary -and $controlPortSummary.LoopbackConnect) {
    $controlStatus = Invoke-ControlStatusProbe -Port $ControlPort -TimeoutSeconds 2
}
else {
    $controlStatus = [pscustomobject]@{
        Uri = "http://127.0.0.1:$ControlPort/status"
        Reachable = $false
        StatusCode = $null
        DurationMs = 0
        Pid = $null
        BackendRunning = $null
        BackendPid = $null
        BackendPathMatches = $null
        Restarting = $null
        TokenLedgerRefreshing = $null
        BackendError = $null
        Error = "port is not reachable"
    }
}
$staticFiles = @(
    Get-FileSummary -Name "management.html" -Path (Join-Path $staticDir "management.html")
    Get-FileSummary -Name "token-ledger.json" -Path (Join-Path $staticDir "token-ledger.json")
)
$logDiagnostics = Get-LogDiagnostics -LogDir $logDir -Cutoff $cutoff -MaxFiles $MaxLogFiles -MaxLinesPerFile $MaxLogLinesPerFile -MaxBytesPerFile $MaxLogBytesPerFile

$result = [pscustomobject]@{
    GeneratedAt = (Get-Date).ToString("o")
    ReadOnly = $true
    Guardrails = @(
        "No restart",
        "No reset call",
        "No management key",
        "No auth file content reads",
        "No request body output"
    )
    Paths = [pscustomobject]@{
        RuntimeInstall = $installRoot
        CustomUiSource = $customUiRoot
        StaticDir = $staticDir
        LogDir = $logDir
    }
    Ports = $portSummaries
    Http = [pscustomobject]@{
        ManagementHtml = $managementProbe
        ControlStatus = $controlStatus
    }
    StaticFiles = $staticFiles
    Logs = $logDiagnostics
}

if ($Json) {
    $result | ConvertTo-Json -Depth 12
    exit 0
}

Write-Output "CPAMC timeout diagnostics (read-only)"
Write-Output "GeneratedAt: $($result.GeneratedAt)"
Write-Output "Runtime: $($result.Paths.RuntimeInstall)"
Write-Output "Custom UI: $($result.Paths.CustomUiSource)"
Write-Output "Guardrails: $($result.Guardrails -join '; ')"
Write-Output ""

Write-Output "Ports"
$portRows = foreach ($port in $result.Ports) {
    if ($port.Listeners.Count -eq 0) {
        [pscustomobject]@{
            Role = $port.Role
            Port = $port.Port
            Listening = $port.Listening
            LoopbackConnect = $port.LoopbackConnect
            Pid = $null
            Process = $null
        }
        continue
    }
    foreach ($listener in $port.Listeners) {
        [pscustomobject]@{
            Role = $port.Role
            Port = $port.Port
            Listening = $port.Listening
            LoopbackConnect = $port.LoopbackConnect
            Pid = $listener.OwningProcess
            Process = $listener.ProcessName
        }
    }
}
$portRows | Format-Table -AutoSize

Write-Output ""
Write-Output "HTTP probes"
@(
    [pscustomobject]@{
        Name = "management.html"
        Reachable = $result.Http.ManagementHtml.Reachable
        StatusCode = $result.Http.ManagementHtml.StatusCode
        DurationMs = $result.Http.ManagementHtml.DurationMs
        Detail = $result.Http.ManagementHtml.Error
    }
    [pscustomobject]@{
        Name = "8319 /status"
        Reachable = $result.Http.ControlStatus.Reachable
        StatusCode = $result.Http.ControlStatus.StatusCode
        DurationMs = $result.Http.ControlStatus.DurationMs
        Detail = "backendRunning=$(Format-NullableBool $result.Http.ControlStatus.BackendRunning); restarting=$(Format-NullableBool $result.Http.ControlStatus.Restarting); tokenLedgerRefreshing=$(Format-NullableBool $result.Http.ControlStatus.TokenLedgerRefreshing)"
    }
) | Format-Table -AutoSize

Write-Output ""
Write-Output "Static file sizes"
$result.StaticFiles | Select-Object Name, Exists, LengthMB, LengthBytes, LastWriteTime | Format-Table -AutoSize

Write-Output ""
Write-Output "Recent log scan"
@(
    [pscustomobject]@{
        WindowMinutes = $RecentMinutes
        AvailableLogFiles = $result.Logs.AvailableLogFiles
        ScannedFiles = $result.Logs.ScannedFiles
        ScanErrors = $result.Logs.ScanErrors.Count
    }
) | Format-Table -AutoSize
Write-Output $result.Logs.RecencyRule

Write-Output ""
Write-Output "API call summary"
@(
    [pscustomobject]@{
        Matched = $result.Logs.ApiCall.MatchedLines
        RecentMatched = $result.Logs.ApiCall.RecentMatchedLines
        NoTimestamp = $result.Logs.ApiCall.LinesWithoutTimestamp
        Status502 = $result.Logs.ApiCall.Status502Lines
        Recent502 = $result.Logs.ApiCall.RecentStatus502Lines
        DurationCount = $result.Logs.ApiCall.DurationMs.Count
        P95Ms = $result.Logs.ApiCall.DurationMs.P95Ms
        MaxMs = $result.Logs.ApiCall.DurationMs.MaxMs
        LastTimestamp = $result.Logs.ApiCall.LastTimestampSeen
    }
) | Format-Table -AutoSize

Write-Output ""
Write-Output "Reset credits log counts"
@(
    [pscustomobject]@{
        Matched = $result.Logs.ResetCredits.MatchedLines
        RecentMatched = $result.Logs.ResetCredits.RecentMatchedLines
        Status502 = $result.Logs.ResetCredits.Status502Lines
        Recent502 = $result.Logs.ResetCredits.RecentStatus502Lines
        LastTimestamp = $result.Logs.ResetCredits.LastTimestampSeen
    }
) | Format-Table -AutoSize

if ($result.Logs.ScanErrors.Count -gt 0) {
    Write-Output ""
    Write-Output "Log scan errors"
    $result.Logs.ScanErrors | Format-Table -AutoSize
}
