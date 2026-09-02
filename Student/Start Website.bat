@echo off
REM ============================================================
REM   Student page - local launcher
REM
REM   - Serves the Student folder at http://localhost:8002/
REM   - The Python backend is expected to already be running
REM     on port 3000 (started by the Login launcher).
REM   - Opens the Login page in your default browser so the
REM     student can sign in and be redirected here with ?u=.
REM   - Keep this window OPEN while using the site
REM     (close it to stop the server)
REM ============================================================

setlocal
title Student page - 1%% Healthy Habit

set "HERE=%~dp0"
set "PS_SCRIPT=%HERE%serve.ps1"

echo ============================================
echo   Student page - starting server...
echo   Site:  http://localhost:8002/
echo   Folder: %HERE%
echo   Keep this window OPEN while using the site.
echo ============================================

REM --- Open the Login page after a short delay so the server is up --
start "" cmd /c "timeout /t 1 /nobreak >nul && start "" "http://localhost:8001/""

REM --- Run the server in the foreground -------------------------
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%"

echo.
echo   Server stopped.
pause
endlocal
