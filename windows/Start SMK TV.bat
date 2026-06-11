@echo off
setlocal EnableDelayedExpansion
title SMK TV Launcher

:: Project root = one level up from this file
for %%i in ("%~dp0..") do set "ROOT=%%~fi"
set "ECOSYSTEM=%ROOT%\ecosystem.config.cjs"
set "APP_URL=http://localhost:3004"

echo.
echo  +==============================+
echo  ^|       SMK TV Launcher        ^|
echo  +==============================+
echo.

:: Check Node.js
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo  ERROR: Node.js not installed. Download from: https://nodejs.org
    pause & exit /b 1
)

:: Kill ports 3000 and 3004
echo [1/5] Clearing ports...
for /f "tokens=5" %%P in ('netstat -aon 2^>nul ^| findstr ":3000 "') do taskkill /F /PID %%P >nul 2>&1
for /f "tokens=5" %%P in ('netstat -aon 2^>nul ^| findstr ":3004 "') do taskkill /F /PID %%P >nul 2>&1
timeout /t 1 /nobreak >nul

:: Find or auto-install PM2
echo [2/5] Checking PM2...
set "PM2_CMD="
where pm2 >nul 2>&1
if %ERRORLEVEL% EQU 0 ( set "PM2_CMD=pm2" )
if "!PM2_CMD!"=="" ( if exist "%APPDATA%\npm\pm2.cmd" ( set "PM2_CMD=%APPDATA%\npm\pm2.cmd" ) )
if "!PM2_CMD!"=="" (
    echo  PM2 not found - installing automatically...
    npm install -g pm2
    if exist "%APPDATA%\npm\pm2.cmd" (
        set "PM2_CMD=%APPDATA%\npm\pm2.cmd"
        echo  PM2 installed.
    ) else (
        echo  ERROR: PM2 install failed. Run: npm install -g pm2
        pause & exit /b 1
    )
)

:: Install node_modules if missing
echo [3/5] Checking dependencies...
if not exist "%ROOT%\live-tv-api\node_modules" (
    echo  Installing API dependencies...
    pushd "%ROOT%\live-tv-api" & npm install & popd
)
if not exist "%ROOT%\live-tv-controller-react\node_modules" (
    echo  Installing UI dependencies...
    pushd "%ROOT%\live-tv-controller-react" & npm install & popd
)

:: Start services
echo [4/5] Starting services...
"!PM2_CMD!" startOrRestart "%ECOSYSTEM%" --update-env
if %ERRORLEVEL% NEQ 0 (
    echo  ERROR: PM2 failed. Run: pm2 logs
    pause & exit /b 1
)

:: Wait for ready
echo [5/5] Waiting for SMK TV...
set READY=0
for /l %%i in (1,1,30) do (
    if !READY! EQU 0 (
        powershell -Command "try{(Invoke-WebRequest '%APP_URL%' -TimeoutSec 1 -UseBasicParsing).StatusCode}catch{0}" 2>nul | findstr "200" >nul 2>&1
        if !ERRORLEVEL! EQU 0 ( set READY=1 ) else ( timeout /t 1 /nobreak >nul )
    )
)

echo.
echo  SMK TV is running at %APP_URL%
echo.
start "" "%APP_URL%"
echo  To stop: run Stop SMK TV.bat
timeout /t 3 /nobreak >nul
