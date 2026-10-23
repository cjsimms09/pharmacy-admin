@echo off
title Set up this computer
cd /d "%~dp0"

:menu
echo.
echo  Set up this computer. Each of these is done once; running one again does no harm.
echo.
echo    1  Start the site by itself whenever Windows starts
echo    2  Let other computers in the pharmacy open the site   (right-click this file, Run as administrator)
echo    3  Let Claude push and restart the site by itself
echo    4  Stop starting the site by itself
echo    5  Close
echo.
choice /c 12345 /n /m " Type a number: "
if errorlevel 5 goto :eof
if errorlevel 4 goto remove
if errorlevel 3 goto claude
if errorlevel 2 goto network

:autostart
schtasks /Create /F /SC ONLOGON /TN "Pharmacy Admin" /TR "wscript.exe \"%~dp0scripts\start-hidden.vbs\""
if %errorlevel% neq 0 (
  echo.
  echo  Could not create the scheduled task. Close this window, right-click this file and choose "Run as administrator".
) else (
  echo.
  echo  Done. Pharmacy Admin will start in the background whenever Windows starts.
)
goto again

:network
netsh advfirewall firewall add rule name="Pharmacy Admin (port 3000)" dir=in action=allow protocol=TCP localport=3000 profile=private,domain
if %errorlevel% neq 0 (
  echo.
  echo  Could not add the firewall rule. Close this window, right-click this file and choose "Run as administrator", then type 2.
) else (
  echo.
  echo  Done. Other computers on this network can open the address shown under Settings - Network.
)
goto again

:claude
echo.
echo  This sets the computer up so Claude can push, rebuild and restart the site on its own,
echo  and so its session comes back after a restart. The site is down for a minute or two
echo  while it installs the latest version.
echo.
node scripts\let-claude-work.mjs
goto again

:remove
schtasks /Delete /F /TN "Pharmacy Admin"
echo.
echo  The site will no longer start by itself. Use "Start Pharmacy Admin" to start it.
goto again

:again
echo.
pause
goto menu
