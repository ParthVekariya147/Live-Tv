@echo off
setlocal
title SMK TV - Build

:: Project root = one level up from this file
for %%i in ("%~dp0..") do set "ROOT=%%~fi"

echo.
echo   SMK TV - Auto Builder
echo   =========================
echo.

where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo   ERROR: Node.js is not installed.
    echo   Download from: https://nodejs.org
    pause & exit /b 1
)

cd /d "%ROOT%"
node build.cjs

if %ERRORLEVEL% EQU 0 (
    echo.
    echo   Done! Opening exe folder...
    start "" "%ROOT%\windows\exe"
) else (
    echo.
    echo   Build failed. Check the output above.
)

echo.
pause
