@echo off
REM ============================================================
REM   Student Score Tracker - local launcher
REM
REM   - Serves the Students folder at http://localhost:8000/
REM   - Opens the site in your default browser
REM   - Keep this window OPEN while using the site
REM     (close it to stop the server)
REM ============================================================

setlocal
title Student Score Tracker

set "HERE=%~dp0"
set "PS_SCRIPT=%HERE%serve.ps1"

echo ============================================
echo   Student Score Tracker - starting server...
echo   Site:  http://localhost:8000/
echo   Folder: %HERE%
echo   Keep this window OPEN while using the site.
echo ============================================

REM --- Open the browser after a short delay so the server is up --
start "" cmd /c "timeout /t 1 /nobreak >nul && start "" "http://localhost:8000/""

REM --- Run the server in the foreground -------------------------
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%"

echo.
echo   Server stopped.
pause
endlocal
