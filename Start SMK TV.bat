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

:: ── Start services via PM2 ────────────────────────────────────────────────────
echo [3/4] Starting services...
where pm2 >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo  ERROR: pm2 not found in PATH.
    echo  Please install it first:
    echo    npm install -g pm2
    echo.
    pause
    exit /b 1
)

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
