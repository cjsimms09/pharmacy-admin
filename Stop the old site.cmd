@echo off
title Pharmacy Admin - Stop the old site
cd /d "%~dp0"
echo.
echo  This stops the old site that is stuck on port 3000. The launcher that is already
echo  running then rebuilds the site by itself, about 10 to 25 minutes, with the site down.
echo.
set FOUND=0
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":3000 .*LISTENING"') do (
  set FOUND=1
  echo  Stopping process %%P ...
  taskkill /F /PID %%P
)
if "%FOUND%"=="0" echo  Nothing is listening on port 3000, so there is nothing to stop.
echo.
echo  Done. Open http://localhost:3000 in a few minutes. Until it is ready, that address
echo  shows a page saying what it is doing, or nothing for the first half minute.
echo  If you see an error above, take a picture of this window.
echo.
pause
