@echo off
REM ============================================================
REM  1% Healthy Habit — launcher
REM
REM  Opens two background windows:
REM    1. Python auth backend (port 3000)
REM    2. PowerShell static server (port 8001+)
REM
REM  Then polls the static server's current-url.txt and opens
REM  the browser to whatever URL it picked.
REM ============================================================

setlocal

set "HERE=%~dp0"
set "SERVER_DIR=%HERE%..\server"
set "PS_SCRIPT=%HERE%serve.ps1"
set "PWSH_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"

REM --- backend ---
REM %SERVER_DIR% may contain spaces (e.g. "C:\...\NEW VISION\...").
REM We invoke cmd.exe with the FULL quoted path so start doesn't try
REM to find a program called "C:\path" (cut at the first space).
REM Inside the cmd /k string, %SERVER_DIR% is itself quoted so cmd's
REM own parser keeps the path together when it runs `cd` and `py`.
start "1%% Healthy Habit - Auth backend" "%ComSpec%" /k cd /d "%SERVER_DIR%" ^&^& py -3 "%SERVER_DIR%\server.py" ^|^| python "%SERVER_DIR%\server.py" ^|^| echo Python not found.

REM --- frontend ---
REM Same space-in-path trap: `start "title" powershell -File "C:\path
REM with space\foo.ps1"` makes start try to run "C:\path" as the
REM program. The reliable fix is to fully quote the powershell.exe
REM path. start then sees the powershell.exe path as the program
REM (no spaces to mis-split) and passes the rest of the line to
REM powershell, which is happy to take -File with a quoted path.
start "1%% Healthy Habit - Frontend" "%PWSH_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%"

REM --- wait for the static server to write its URL, then open the browser ---
set "URL_FILE=%HERE%current-url.txt"
set "TRIES=0"
:waitloop
if exist "%URL_FILE%" goto openbrowser
set /a TRIES+=1
if %TRIES% GEQ 30 goto openbrowser
ping -n 2 127.0.0.1 >nul
goto waitloop

:openbrowser
REM Read the URL via PowerShell. We use the call operator (&) on a quoted
REM path so any spaces in %URL_FILE% survive, and we strip a stray UTF-8 BOM
REM defensively before passing the URL to Start-Process.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$p = '%URL_FILE%'; if (Test-Path -LiteralPath $p) { $u = (Get-Content -LiteralPath $p -Raw); if ($u) { $u = $u -replace '^\xEF\xBB\xBF','' -replace '[\r\n]+$',''; if ($u) { Start-Process $u } } }"

endlocal
