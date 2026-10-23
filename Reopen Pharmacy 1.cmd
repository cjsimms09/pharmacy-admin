@echo off
title Reopen Pharmacy 1
cd /d "%~dp0"
node scripts\reopen-session.mjs "Pharmacy 1" 58f36a83-cece-4a57-9b9c-436b8294faaa %*
echo.
echo Pharmacy 1 has finished. You can close this window.
pause
