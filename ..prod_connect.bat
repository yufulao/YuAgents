@echo off
setlocal

cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "workspace\scripts\connect-remote-relay.ps1" ^
  -SshHost "159.75.188.203" ^
  -SshPort 22222 ^
  -User "root" ^
  -RemoteDir "/opt/openagents" ^
  -Domain "oa.yodaze.com" ^
  -TunnelOnly ^
  -EnsureGatewayPorts ^
  -StopExistingTunnel

if errorlevel 1 (
  echo.
  echo [ERROR] Production tunnel failed.
  echo Make sure ..start.bat is running locally, and server workspace/start.sh is running remotely.
  pause
  exit /b 1
)

endlocal
