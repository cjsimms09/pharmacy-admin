@echo off
rem Makes Pharmacy Admin start automatically (hidden) whenever this user signs in to Windows.
cd /d "%~dp0"
schtasks /Create /F /SC ONLOGON /TN "Pharmacy Admin" /TR "wscript.exe \"%~dp0scripts\start-hidden.vbs\""
if %errorlevel% neq 0 (
  echo Could not create the scheduled task. Right-click this file and choose "Run as administrator".
) else (
  echo Done. Pharmacy Admin will start in the background at sign-in. Open http://localhost:3000 any time.
  echo To remove: run "Remove autostart.cmd".
)
pause
