@echo off
title Pharmacy Admin - Find where PioneerRx lives
cd /d "%~dp0"
echo.
echo  There is no database on this computer, so PioneerRx keeps it somewhere
echo  else. This asks PioneerRx itself where that is.
echo.
echo  It only reads settings on this computer. It connects to nothing, changes
echo  nothing, and removes any password before writing its answer.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\pioneer-locate.ps1"
echo.
echo  Send back the file called pioneer-location.json
echo.
pause
