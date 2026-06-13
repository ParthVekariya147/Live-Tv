@echo off
setlocal EnableDelayedExpansion
title STOP EVERYTHING — SMK TV

echo.
echo ============================================================
echo   STOP EVERYTHING — SMK TV
echo ============================================================
echo.

:: ── STEP 1: Stop PM2 services ────────────────────────────────
echo [1/5] Stopping PM2 services...

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

:: ── STEP 2: Kill SMK TV EXE processes ────────────────────────
echo.
echo [2/5] Killing SMK TV EXE processes...

set "FOUND=0"
for /f "tokens=1,2" %%A in ('tasklist /FO TABLE /NH 2^>nul') do (
    echo %%A | findstr /I "SMK" >nul 2>&1
    if !ERRORLEVEL! EQU 0 (
        taskkill /IM "%%A" /F >nul 2>&1
        echo     Killed: %%A  (PID %%B)
        set "FOUND=1"
    )
)
if "!FOUND!"=="0" echo     No SMK TV EXE running.

:: Also kill by image name pattern using WMIC
wmic process where "name like 'SMK TV%%'" delete >nul 2>&1

:: ── STEP 3: Kill all node.exe processes ──────────────────────
echo.
echo [3/5] Killing all node.exe processes...
taskkill /IM node.exe /F >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo     All node.exe processes killed.
) else (
    echo     No node.exe processes found.
)

:: ── STEP 4: Kill anything on ports 3000, 3003, 3004 ─────────
echo.
echo [4/5] Freeing ports 3000, 3003, 3004...

for %%P in (3000 3003 3004) do (
    for /f "tokens=5" %%A in ('netstat -aon 2^>nul ^| findstr ":%%P "') do (
        set "PID=%%A"
        if not "!PID!"=="0" if not "!PID!"=="" (
            taskkill /PID !PID! /F >nul 2>&1
            echo     Port %%P  ^(PID !PID!^) killed.
        )
    )
)

:: ── STEP 5: Kill yt-dlp if running (recording) ───────────────
echo.
echo [5/5] Killing yt-dlp.exe if running...
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
