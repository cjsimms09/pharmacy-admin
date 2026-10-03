@echo off
title Pharmacy Admin
cd /d "%~dp0"
echo Starting Pharmacy Admin. Keep this window open while you use the app.
echo The browser will open automatically at http://localhost:3000
echo.
node scripts\launch.mjs
echo.
echo Pharmacy Admin has stopped. You can close this window.
pause
