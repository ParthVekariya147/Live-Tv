@echo off
title SMK TV Setup

:: Double-clickable wrapper around setup.ps1 — checks every dependency SMK TV
:: needs on this PC and installs what it can. Run this first on any new machine,
:: and whenever something works on one PC but not another (push notifications
:: being the usual case).
::
:: -ExecutionPolicy Bypass is scoped to this one process only; it does not
:: change the machine's policy.

echo.
echo  +==========================================+
echo  ^|   SMK TV - dependency setup and doctor   ^|
echo  +==========================================+
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*

echo.
pause
