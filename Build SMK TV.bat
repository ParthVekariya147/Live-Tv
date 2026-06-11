@echo off
setlocal
title SMK TV — Build

echo.
echo   SMK TV — Auto Builder
echo   =========================
echo.

where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo   ERROR: Node.js is not installed.
    echo   Download from: https://nodejs.org
    echo.
    pause
    exit /b 1
)

cd /d "%~dp0"
node build.cjs

if %ERRORLEVEL% EQU 0 (
    echo.
    echo   Done! Opening exe folder...
    start "" "%~dp0exe"
) else (
    echo.
    echo   Build failed. Check the output above.
)

echo.
pause
