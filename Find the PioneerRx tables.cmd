@echo off
title Pharmacy Admin - Find the PioneerRx tables
cd /d "%~dp0"
echo.
echo  Looking inside PioneerRx for the tables its prescriptions live in.
echo.
echo  This reads the LIST OF TABLE NAMES and nothing else. No patient
echo  information is opened, nothing is changed, and nothing is written
echo  to PioneerRx.
echo.
set "SRV="
set /p SRV=  Server address (press Enter to search this computer): 
set "LOGIN="
set /p LOGIN=  SQL login, if PioneerRx gave you one (Enter to use Windows): 
if defined LOGIN set /p PW=  Password: 
echo.
if defined LOGIN (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\pioneer-discover.ps1" -Server "%SRV%" -User "%LOGIN%" -Password "%PW%"
) else if defined SRV (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\pioneer-discover.ps1" -Server "%SRV%"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\pioneer-discover.ps1"
)
echo.
echo  If a file called pioneer-schema.json was written, send that back.
echo.
pause
