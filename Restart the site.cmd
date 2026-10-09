@echo off
title Pharmacy Admin - Restart the site
cd /d "%~dp0"
echo.
echo  Restarting Pharmacy Admin. The site is down while it rebuilds, about 10 to 25 minutes.
echo  Close other big programs first if you can. Your data is not touched.
echo.
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*launch.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"
wscript.exe "%~dp0scripts\start-hidden.vbs"
echo  Started. It is building in the background. Open http://localhost:3000 in a few minutes;
echo  until it is ready that address shows a page saying what it is doing.
echo.
pause
