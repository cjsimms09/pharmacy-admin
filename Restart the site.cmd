@echo off
title Pharmacy Admin - Restart the site
cd /d "%~dp0"
echo.
echo  Restarting Pharmacy Admin. The site is down while it rebuilds, about 10 to 25 minutes.
echo  Close other big programs first if you can. Your data is not touched.
echo.
echo  Stopping the running site...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"
echo  Waiting 30 seconds to see whether the launcher takes over...
timeout /t 30 /nobreak >nul
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if errorlevel 1 (
  echo  No launcher answered, so starting one.
  wscript.exe "%~dp0scripts\start-hidden.vbs"
) else (
  echo  The launcher is already rebuilding it.
)
echo.
echo  Open http://localhost:3000 in a few minutes. Until it is ready, that address
echo  shows a page saying what it is doing.
echo.
pause
