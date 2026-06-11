@echo off
setlocal EnableDelayedExpansion
title SMK TV Launcher

:: ── Project root is the folder containing this .bat file ─────────────────────
set "ROOT=%~dp0"
set "ROOT=%ROOT:~0,-1%"
set "ECOSYSTEM=%ROOT%\ecosystem.config.cjs"
set "APP_URL=http://localhost:3004"

echo.
echo  ╔══════════════════════════════╗
echo  ║       SMK TV Launcher        ║
echo  ╚══════════════════════════════╝
echo.

:: ── Kill any process on port 3000 ─────────────────────────────────────────────
echo [1/4] Clearing port 3000...
for /f "tokens=5" %%P in ('netstat -aon 2^>nul ^| findstr ":3000 "') do (
    taskkill /F /PID %%P >nul 2>&1
)

:: ── Kill any process on port 3004 ─────────────────────────────────────────────
echo [2/4] Clearing port 3004...
for /f "tokens=5" %%P in ('netstat -aon 2^>nul ^| findstr ":3004 "') do (
    taskkill /F /PID %%P >nul 2>&1
)

timeout /t 1 /nobreak >nul

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

:: ── Auto-install PM2 if missing ───────────────────────────────────────────────
echo [3/4] Checking PM2...
where pm2 >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo  PM2 not found — installing automatically...
    npm install -g pm2
    if %ERRORLEVEL% NEQ 0 (
        echo.
        echo  ERROR: Failed to install PM2. Check your internet connection.
        echo.
        pause
        exit /b 1
    )
    echo  PM2 installed successfully.
)

:: ── Install node_modules if missing (first run) ───────────────────────────────
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

echo [3/4] Starting services...

pm2 startOrRestart "%ECOSYSTEM%" --update-env
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo  ERROR: PM2 failed to start services.
    echo  Check the ecosystem config or run: pm2 logs
    echo.
    pause
    exit /b 1
)

:: ── Wait for port 3004 to respond (max 30s) ───────────────────────────────────
echo [4/4] Waiting for SMK TV to be ready...
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
