@echo off
title Let Claude run the site
cd /d "%~dp0"
echo.
echo  This sets the pharmacy computer up so Claude can push, rebuild and restart the site
echo  on its own, and so its session comes back after a restart. The site will be down for
echo  a minute or two while it installs the latest version.
echo.
node scripts\let-claude-work.mjs
echo.
pause
