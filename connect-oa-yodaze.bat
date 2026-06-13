@echo off
setlocal

cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "workspace\scripts\connect-remote-relay.ps1" ^
  -SshHost "159.75.188.203" ^
  -SshPort 22222 ^
  -User "root" ^
  -RemoteDir "/opt/openagents" ^
  -Domain "oa.yodaze.com" ^
  -StartLocal ^
  -StopExistingTunnel

if errorlevel 1 (
  echo.
  echo [ERROR] Remote relay connection failed.
  pause
  exit /b 1
)

endlocal
