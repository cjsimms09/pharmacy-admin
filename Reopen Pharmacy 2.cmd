@echo off
title Reopen Pharmacy 2
cd /d "%~dp0"
node scripts\reopen-session.mjs "Pharmacy 2" fdc58d54-c3f0-42af-b6f6-62e319c31b93 %*
echo.
echo Pharmacy 2 has finished. You can close this window.
pause
