# ============================================================
# Student Score Tracker — minimal static file server
# Uses raw TCPListener + HTTP/1.1, not HttpListener.
# On Windows, HttpListener.Start() can silently succeed even when
# another process (often System / PID 4) is holding the port.
# TcpListener throws if the bind actually fails.
# ============================================================

$ErrorActionPreference = 'Stop'

# Bind to 127.0.0.1 only — this is a dev server, not a public server.
$BindHost = '127.0.0.1'

# Port 8000 (with fallback to 8001-8010 if it's already taken).
$StartPort = 8000
$EndPort   = 8010

# Root of the static server. Resolve relative to this script so the
# launcher works no matter where FINISHED/ is checked out.
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$root = (Resolve-Path $scriptDir).Path
# Append a path separator so the StartsWith check below can't be
# bypassed by a sibling directory whose name starts with the same
# prefix.
$rootWithSep = $root.TrimEnd('\') + '\'

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
    }
}
if ($null -eq $listener) {
    Write-Output "FATAL: no free port in $StartPort..$EndPort"
    exit 1
}

$url = "http://localhost:$chosenPort/"
Write-Output "Serving $root at $url (Ctrl+C or close window to stop)"

$contentTypes = @{
  ".html" = "text/html; charset=utf-8"
  ".css"  = "text/css; charset=utf-8"
  ".js"   = "application/javascript; charset=utf-8"
  ".png"  = "image/png"
  ".jpg"  = "image/jpeg"
  ".jpeg" = "image/jpeg"
  ".gif"  = "image/gif"
  ".svg"  = "image/svg+xml"
  ".ico"  = "image/x-icon"
  ".json" = "application/json; charset=utf-8"
}

try {
    while ($true) {
        $client = $listener.AcceptTcpClient()
        try {
            $stream = $client.GetStream()
            $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::ASCII)
            $requestLine = $reader.ReadLine()
            if ([string]::IsNullOrWhiteSpace($requestLine)) { continue }

            # Drain request headers (we don't use them for a GET).
            for ($i = 0; $i -lt 100; $i++) {
                $h = $reader.ReadLine()
                if ($null -eq $h -or $h -eq '') { break }
            }

            $parts = $requestLine.Split(' ')
            if ($parts.Length -lt 2) { continue }
            $method = $parts[0].ToUpperInvariant()
            $rawPath = $parts[1]
            $qIdx = $rawPath.IndexOf('?')
            if ($qIdx -ge 0) { $rawPath = $rawPath.Substring(0, $qIdx) }
            $decoded = [System.Uri]::UnescapeDataString($rawPath)
            if ($decoded -eq '/' -or $decoded -eq '') { $decoded = '/index.html' }
            if ($decoded.StartsWith('/')) { $decoded = $decoded.Substring(1) }

            $file = [System.IO.Path]::GetFullPath((Join-Path $root ($decoded -replace "/", "\")))

            # Block path traversal. We compare against $rootWithSep
            # (root + "\") so that sibling directories sharing the same
            # name prefix can't slip through. OrdinalIgnoreCase because
            # Windows file system is case-insensitive.
            if (-not $file.StartsWith($rootWithSep, [System.StringComparison]::OrdinalIgnoreCase) -and
                -not $file.Equals($root, [System.StringComparison]::OrdinalIgnoreCase)) {
                $body = [System.Text.Encoding]::UTF8.GetBytes("403 Forbidden")
                $headers = "HTTP/1.1 403 Forbidden`r`nContent-Type: text/plain; charset=utf-8`r`nContent-Length: $($body.Length)`r`nConnection: close`r`n`r`n"
                $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($headers)
                $stream.Write($headerBytes, 0, $headerBytes.Length)
                $stream.Write($body, 0, $body.Length)
                $stream.Flush()
            } elseif ($method -ne 'GET' -and $method -ne 'HEAD') {
                $body = [System.Text.Encoding]::UTF8.GetBytes("405 Method Not Allowed")
                $headers = "HTTP/1.1 405 Method Not Allowed`r`nContent-Type: text/plain; charset=utf-8`r`nContent-Length: $($body.Length)`r`nConnection: close`r`n`r`n"
                $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($headers)
                $stream.Write($headerBytes, 0, $headerBytes.Length)
                $stream.Write($body, 0, $body.Length)
                $stream.Flush()
            } elseif (Test-Path -LiteralPath $file -PathType Leaf) {
                $ext = [System.IO.Path]::GetExtension($file).ToLower()
                $ct = if ($contentTypes.ContainsKey($ext)) { $contentTypes[$ext] } else { "application/octet-stream" }
                $bytes = [System.IO.File]::ReadAllBytes($file)
                $headers = "HTTP/1.1 200 OK`r`nContent-Type: $ct`r`nContent-Length: $($bytes.Length)`r`nCache-Control: no-cache`r`nConnection: close`r`n`r`n"
                $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($headers)
                $stream.Write($headerBytes, 0, $headerBytes.Length)
                if ($method -eq 'GET') { $stream.Write($bytes, 0, $bytes.Length) }
                $stream.Flush()
            } else {
                $body = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found")
                $headers = "HTTP/1.1 404 Not Found`r`nContent-Type: text/plain; charset=utf-8`r`nContent-Length: $($body.Length)`r`nConnection: close`r`n`r`n"
                $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($headers)
                $stream.Write($headerBytes, 0, $headerBytes.Length)
                $stream.Write($body, 0, $body.Length)
                $stream.Flush()
            }
        } catch {
            Write-Output "ERR: $($_.Exception.Message)"
        } finally {
            try { $client.Close() } catch {}
        }
    }
} finally {
    $listener.Stop()
}
