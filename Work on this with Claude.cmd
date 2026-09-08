@echo off
title Work on the pharmacy site with Claude
cd /d "%~dp0"
node scripts\claude-here.mjs
echo.
echo Claude has finished. You can close this window.
pause
