# ============================================================
# 1% Healthy Habit — minimal static file server
# Uses raw TCPListener + HTTP/1.1, not HttpListener.
# On Windows, HttpListener.Start() can silently succeed even when
# another process (often System / PID 4) is holding the port.
# TcpListener throws if the bind actually fails.
# ============================================================

$ErrorActionPreference = 'Stop'

# Bind to 127.0.0.1 only — this is a dev server, not a public server.
$BindHost = '127.0.0.1'

# Walk up from 8001 to 8051 looking for a free port. (8000 is reserved
# for the Student Score Tracker; this server uses 8001+.)
$StartPort = 8001
$EndPort   = 8051
$MaxTries  = ($EndPort - $StartPort + 1)

# Root of the static server. We re-root at the FINISHED/ project root
# so that ../Teacher's/index.html (the teacher redirect target) and
# ../Students/index.html (the user redirect target) both resolve
# correctly. The login page itself is served at /Login/; the rest of
# the site is at /Teacher's/ and /Students/.
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$root = (Resolve-Path (Join-Path $scriptDir '..')).Path
$logFile = Join-Path $scriptDir 'serve.log'
$urlFile = Join-Path $scriptDir 'current-url.txt'

# Create / clear the log file using BOM-less UTF-8. The
# `Set-Content -Encoding utf8` cmdlet writes a UTF-8 BOM (EF BB BF),
# which the .bat launcher's `for /f` would read as the first
# character of any line in this file too.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($logFile, '', $utf8NoBom)

function Write-Log($msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    # BOM-less UTF-8 append (see comment on the $utf8NoBom encoding above).
    [System.IO.File]::AppendAllText($logFile, $line + "`r`n", $utf8NoBom)
    Write-Host $line
}

function Send-Response($client, $status, $statusText, $headers, $body) {
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append("HTTP/1.1 $status $statusText`r`n")
    foreach ($k in $headers.Keys) {
        $v = $headers[$k]
        [void]$sb.Append(($k + ': ' + $v + "`r`n"))
    }
    [void]$sb.Append("Connection: close`r`n")
    [void]$sb.Append("`r`n")
    $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($sb.ToString())
    $client.GetStream().Write($headerBytes, 0, $headerBytes.Length)
    if ($null -ne $body -and $body.Length -gt 0) {
        $client.GetStream().Write($body, 0, $body.Length)
    }
    $client.GetStream().Flush()
}

function Get-ContentType($ext) {
    switch ($ext.ToLowerInvariant()) {
        '.html' { 'text/html; charset=utf-8'; break }
        '.css'  { 'text/css; charset=utf-8';  break }
        '.js'   { 'application/javascript; charset=utf-8'; break }
        '.json' { 'application/json; charset=utf-8'; break }
        '.png'  { 'image/png';  break }
        '.jpg'  { 'image/jpeg'; break }
        '.jpeg' { 'image/jpeg'; break }
        '.gif'  { 'image/gif';  break }
        '.svg'  { 'image/svg+xml'; break }
        '.ico'  { 'image/x-icon'; break }
        '.txt'  { 'text/plain; charset=utf-8'; break }
        default { 'application/octet-stream' }
    }
}

# --- find a free port ---
$listener = $null
$chosenPort = $null
for ($p = $StartPort; $p -le $EndPort; $p++) {
    try {
        $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Parse($BindHost), $p)
        $listener.Start()
        $chosenPort = $p
        break
    } catch {
        $listener = $null
        Write-Log "Port $p busy: $($_.Exception.Message)"
    }
}
if ($null -eq $listener) {
    Write-Log "FATAL: no free port in $StartPort..$EndPort"
    exit 1
}

$url = "http://localhost:$chosenPort/Login/"
# Write URL as UTF-8 *without BOM* — `Start Website.bat` reads this
# and passes it to `start ""`. If the file has a UTF-8 BOM
# (EF BB BF), `start` will treat the BOM as part of the program
# name and fail with "Windows cannot find '<BOM>http://...'".
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($urlFile, $url, $utf8NoBom)
Write-Log "static server bound to $url (root = $root)"

# --- main accept loop ---
try {
    while ($true) {
        $client = $listener.AcceptTcpClient()
        try {
            $stream = $client.GetStream()
            $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::ASCII)
            $requestLine = $reader.ReadLine()
            if ([string]::IsNullOrWhiteSpace($requestLine)) { continue }

            # Drain request headers (we don't use them, but the client may not
            # have sent a body for GET). Cap at 100 lines so a misbehaving
            # client can't hang the server.
            for ($i = 0; $i -lt 100; $i++) {
                $h = $reader.ReadLine()
                if ($null -eq $h -or $h -eq '') { break }
            }

            $parts = $requestLine.Split(' ')
            if ($parts.Length -lt 2) {
                Send-Response $client 400 'Bad Request' @{'Content-Length'='0'} ([byte[]]@())
                continue
            }
            $method = $parts[0].ToUpperInvariant()
            $rawPath = $parts[1]

            # Strip query string, then URL-decode, then strip any leading slash.
            $qIdx = $rawPath.IndexOf('?')
            if ($qIdx -ge 0) { $rawPath = $rawPath.Substring(0, $qIdx) }
            $decoded = [System.Uri]::UnescapeDataString($rawPath)
            if ($decoded.StartsWith('/')) { $decoded = $decoded.Substring(1) }

            # Root → the login page. With the static root at FINISHED/,
            # the login page lives at /Login/. We serve it both as the
            # literal path and as a fallback for `/` (in case someone
            # hits the bare host).
            if ($decoded -eq '' -or $decoded -eq '/') {
                $decoded = 'Login\index.html'
            } elseif ($decoded -eq 'Login' -or $decoded -eq 'Login/') {
                $decoded = 'Login\index.html'
            }

            # --- path traversal guard: the resolved path must be under $root
            $fullPath = Join-Path $root $decoded
            $fullPath = [System.IO.Path]::GetFullPath($fullPath)
            $rootFull = [System.IO.Path]::GetFullPath($root)
            if (-not $fullPath.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
                Write-Log "REJECT traversal: $decoded -> $fullPath"
                Send-Response $client 403 'Forbidden' @{'Content-Length'='0'} ([byte[]]@())
                continue
            }

            if ($method -ne 'GET' -and $method -ne 'HEAD') {
                Send-Response $client 405 'Method Not Allowed' @{'Content-Length'='0'} ([byte[]]@())
                continue
            }

            if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
                $body = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found: $decoded")
                Send-Response $client 404 'Not Found' @{
                    'Content-Type'   = 'text/plain; charset=utf-8'
                    'Content-Length' = $body.Length.ToString()
                } $body
                Write-Log "404 $decoded"
                continue
            }

            $ext = [System.IO.Path]::GetExtension($fullPath)
            $bytes = [System.IO.File]::ReadAllBytes($fullPath)
            $headers = @{
                'Content-Type'   = (Get-ContentType $ext)
                'Content-Length' = $bytes.Length.ToString()
                'Cache-Control'  = 'no-cache'
            }
            Send-Response $client 200 'OK' $headers $(if ($method -eq 'GET') { $bytes } else { $null })
            Write-Log "200 $decoded ($($bytes.Length) bytes)"
        } catch {
            Write-Log "Request error: $($_.Exception.Message)"
        } finally {
            try { $client.Close() } catch {}
        }
    }
} finally {
    Write-Log "Shutting down static server (port $chosenPort)"
    $listener.Stop()
}
