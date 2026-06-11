@echo off
setlocal EnableDelayedExpansion
title SMK TV - Stop

echo.
echo  Stopping SMK TV services...
echo.

:: Find pm2 — PATH or default npm global location
set "PM2_CMD="
where pm2 >nul 2>&1
if %ERRORLEVEL% EQU 0 ( set "PM2_CMD=pm2" )
if "!PM2_CMD!" == "" (
    if exist "%APPDATA%\npm\pm2.cmd" ( set "PM2_CMD=%APPDATA%\npm\pm2.cmd" )
)
if "!PM2_CMD!" == "" (
    echo  ERROR: PM2 not found. Services may already be stopped.
    pause
    exit /b 1
)

"!PM2_CMD!" stop smk-api smk-controller
echo.
echo  SMK TV services stopped.
echo.
timeout /t 2 /nobreak >nul
exit /b 0
