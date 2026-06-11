@echo off
setlocal EnableDelayedExpansion
title SMK TV Launcher

:: ── Project root is the folder containing this .bat file ─────────────────────
set "ROOT=%~dp0"
set "ROOT=%ROOT:~0,-1%"
set "ECOSYSTEM=%ROOT%\ecosystem.config.cjs"
set "APP_URL=http://localhost:3004"

echo.
echo  +==============================+
echo  ^|       SMK TV Launcher        ^|
echo  +==============================+
echo.

:: ── Check Node.js is installed ───────────────────────────────────────────────
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo  ERROR: Node.js is not installed.
    echo  Download and install it from: https://nodejs.org
    echo  Then re-run this launcher.
    echo.
    pause
    exit /b 1
)

:: ── Kill any process on port 3000 ─────────────────────────────────────────────
echo [1/5] Clearing port 3000...
for /f "tokens=5" %%P in ('netstat -aon 2^>nul ^| findstr ":3000 "') do (
    taskkill /F /PID %%P >nul 2>&1
)

:: ── Kill any process on port 3004 ─────────────────────────────────────────────
echo [2/5] Clearing port 3004...
for /f "tokens=5" %%P in ('netstat -aon 2^>nul ^| findstr ":3004 "') do (
    taskkill /F /PID %%P >nul 2>&1
)

timeout /t 1 /nobreak >nul

:: ── Find or auto-install PM2 ─────────────────────────────────────────────────
echo [3/5] Checking PM2...
set "PM2_CMD="

:: Check if pm2 is already in PATH
where pm2 >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    set "PM2_CMD=pm2"
)

:: Not in PATH — try the default npm global location on Windows
if "!PM2_CMD!" == "" (
    if exist "%APPDATA%\npm\pm2.cmd" (
        set "PM2_CMD=%APPDATA%\npm\pm2.cmd"
    )
)

:: Still not found — install it now
if "!PM2_CMD!" == "" (
    echo  PM2 not found - installing automatically...
    npm install -g pm2
    :: Check the file directly — don't rely on ERRORLEVEL (npm can exit non-zero even on success)
    if exist "%APPDATA%\npm\pm2.cmd" (
        set "PM2_CMD=%APPDATA%\npm\pm2.cmd"
        echo  PM2 installed successfully.
    ) else (
        echo.
        echo  ERROR: PM2 install failed. Please run manually:
        echo    npm install -g pm2
        echo.
        pause
        exit /b 1
    )
)

echo  Using PM2: !PM2_CMD!

:: ── Install node_modules if missing (first run) ───────────────────────────────
echo [4/5] Checking dependencies...
if not exist "%ROOT%\live-tv-api\node_modules" (
    echo  Installing API dependencies...
    pushd "%ROOT%\live-tv-api"
    npm install
    popd
)
if not exist "%ROOT%\live-tv-controller-react\node_modules" (
    echo  Installing UI dependencies...
    pushd "%ROOT%\live-tv-controller-react"
    npm install
    popd
)

:: ── Start services via PM2 ────────────────────────────────────────────────────
echo [5/5] Starting services...
"!PM2_CMD!" startOrRestart "%ECOSYSTEM%" --update-env
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo  ERROR: PM2 failed to start services.
    echo  Run: pm2 logs
    echo.
    pause
    exit /b 1
)

:: ── Wait for port 3004 to respond (max 30s) ───────────────────────────────────
echo  Waiting for SMK TV to be ready...
set READY=0
for /l %%i in (1,1,30) do (
    if !READY! EQU 0 (
        powershell -Command "try { (Invoke-WebRequest -Uri '%APP_URL%' -TimeoutSec 1 -UseBasicParsing).StatusCode } catch { 0 }" 2>nul | findstr "200" >nul 2>&1
        if !ERRORLEVEL! EQU 0 (
            set READY=1
        ) else (
            timeout /t 1 /nobreak >nul
        )
    )
)

:: ── Open browser ─────────────────────────────────────────────────────────────
echo.
echo  SMK TV is running at %APP_URL%
echo.
start "" "%APP_URL%"

echo  Services managed by PM2. To stop, run "Stop SMK TV.bat"
echo  To view logs: pm2 logs
echo.
timeout /t 3 /nobreak >nul
exit /b 0
