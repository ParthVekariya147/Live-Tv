@echo off
title SMK TV — Stop

echo.
echo  Stopping SMK TV services...
echo.

where pm2 >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo  ERROR: pm2 not found in PATH.
    pause
    exit /b 1
)

pm2 stop smk-api smk-controller
echo.
echo  SMK TV services stopped.
echo.
timeout /t 2 /nobreak >nul
exit /b 0
