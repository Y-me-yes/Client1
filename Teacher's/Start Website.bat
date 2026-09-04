@echo off
REM ============================================================
REM   Teacher's Dashboard - local launcher
REM
REM   - Detects Python (py launcher first, then python on PATH)
REM   - Serves the Teacher's folder at http://localhost:8765/
REM   - Opens the site in your default browser
REM   - Keep this window OPEN while using the site
REM     (close it to stop the server)
REM ============================================================

setlocal
title Teacher's Dashboard

cd /d "%~dp0"

set "PORT=8765"
set "URL=http://localhost:%PORT%/"

REM --- Pick a Python interpreter --------------------------------
set "PYEXE="
where py     >nul 2>nul && set "PYEXE=py -3"
if not defined PYEXE where python >nul 2>nul && set "PYEXE=python"
if not defined PYEXE where python3 >nul 2>nul && set "PYEXE=python3"

if not defined PYEXE (
  echo.
  echo  X Python was not found on this computer.
  echo.
  echo    To run the Teacher's Dashboard locally you need Python 3.
  echo    Download it free from https://www.python.org/downloads/
  echo    During install, tick "Add Python to PATH".
  echo.
  pause
  exit /b 1
)

echo ============================================
echo   Teacher's Dashboard - starting server...
echo   Site:  %URL%
echo   Folder: %CD%
echo   Keep this window OPEN while using the site.
echo ============================================

REM --- Open the browser after a short delay so the server is up --
start "" cmd /c "timeout /t 1 /nobreak >nul && start "" "%URL%""

REM --- Run the server in the foreground -------------------------
%PYEXE% -m http.server %PORT% --bind 127.0.0.1

echo.
echo   Server stopped.
pause
endlocal
