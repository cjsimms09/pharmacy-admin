@echo off
title Pharmacy Admin
cd /d "%~dp0"
echo.
echo  Opening Pharmacy Admin. If it is not running, this starts it in the background.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\site-control.ps1" -Action Start
echo.
echo  You can close this window. The site keeps running without it.
pause
