@echo off
setlocal

cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "workspace\scripts\deploy-remote-relay.ps1" ^
  -SshHost "159.75.188.203" ^
  -SshPort 22222 ^
  -User "root" ^
  -RemoteDir "/opt/openagents" ^
  -Domain "oa.yodaze.com" ^
  -InstallDocker ^
  -ConfigureNginx

if errorlevel 1 (
  echo.
  echo [ERROR] Remote relay deployment failed.
  pause
  exit /b 1
)

echo.
echo Deployment finished. Run connect-oa-yodaze.bat to start the local tunnel and remote relay.
pause
