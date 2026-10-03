@echo off
rem Lets other computers on the pharmacy's own network open Pharmacy Admin on this computer.
rem Right-click this file and choose "Run as administrator".
netsh advfirewall firewall add rule name="Pharmacy Admin (port 3000)" dir=in action=allow protocol=TCP localport=3000 profile=private,domain
if %errorlevel% neq 0 (
  echo Could not add the firewall rule. Right-click this file and choose "Run as administrator".
) else (
  echo Done. Other computers on this network can open the address shown under Settings - Network.
)
pause
