@echo off
title Pharmacy Admin - Update
cd /d "%~dp0"
echo.
echo  Updating Pharmacy Admin.
echo  Your data is never touched by this - it lives in the data folder,
echo  which is not part of the update.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update.ps1"
if errorlevel 1 (
  echo.
  echo  The update did not finish. Nothing was changed.
  pause
  exit /b 1
)
echo.
echo  Starting up again...
echo.
node scripts\launch.mjs
echo.
echo  Pharmacy Admin has stopped. You can close this window.
pause
