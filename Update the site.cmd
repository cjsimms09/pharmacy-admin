@echo off
title Update the pharmacy site
cd /d "%~dp0"
echo.
echo  This installs the newest version of Pharmacy Admin and restarts the site.
echo  The site is down while it rebuilds, usually 10 to 25 minutes.
echo  Close other big programs first if you can. Your data is not touched.
echo.
echo  Click this once only. Press any key to start, or close this window to cancel.
pause >nul
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\site-control.ps1" -Action Update
echo.
pause
