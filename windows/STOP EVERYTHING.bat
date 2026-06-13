@echo off
setlocal EnableDelayedExpansion
title STOP EVERYTHING — SMK TV

echo.
echo ============================================================
echo   STOP EVERYTHING — SMK TV
echo ============================================================
echo.

:: ── STEP 1: Stop PM2 services ────────────────────────────────
echo [1/4] Stopping PM2 services...

set "PM2="
where pm2 >nul 2>&1
if %ERRORLEVEL% EQU 0 set "PM2=pm2"
if "!PM2!"=="" if exist "%APPDATA%\npm\pm2.cmd" set "PM2=%APPDATA%\npm\pm2.cmd"

if not "!PM2!"=="" (
    "!PM2!" stop all    >nul 2>&1
    "!PM2!" delete all  >nul 2>&1
    "!PM2!" kill        >nul 2>&1
    echo     PM2 stopped and killed.
) else (
    echo     PM2 not found — skipping.
)

:: ── STEP 2: Kill all node.exe processes ──────────────────────
echo.
echo [2/4] Killing all node.exe processes...
taskkill /IM node.exe /F >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo     All node.exe processes killed.
) else (
    echo     No node.exe processes found.
)

:: ── STEP 3: Kill anything on ports 3000, 3003, 3004 ─────────
echo.
echo [3/4] Freeing ports 3000, 3003, 3004...

for %%P in (3000 3003 3004) do (
    set "PIDS="
    for /f "tokens=5" %%A in ('netstat -aon 2^>nul ^| findstr ":%%P "') do (
        set "PID=%%A"
        if not "!PID!"=="0" if not "!PID!"=="" (
            taskkill /PID !PID! /F >nul 2>&1
            echo     Port %%P  ^(PID !PID!^) killed.
        )
    )
)

:: ── STEP 4: Kill yt-dlp if running (recording) ───────────────
echo.
echo [4/4] Killing yt-dlp.exe if running...
taskkill /IM yt-dlp.exe /F >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo     yt-dlp.exe killed.
) else (
    echo     yt-dlp.exe not running.
)

:: ── Done ─────────────────────────────────────────────────────
echo.
echo ============================================================
echo   DONE. Everything stopped. Ports 3000 / 3003 / 3004 free.
echo ============================================================
echo.
pause
