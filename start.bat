@echo off
setlocal

for %%I in ("%~dp0openagents-launcher-v0.8.4") do set "OPENAGENTS_ROOT=%%~fI"
set "CONNECTOR_DIR=%OPENAGENTS_ROOT%\packages\agent-connector"
set "OPENAGENTS_SKIP_UPDATE_CHECK=1"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found in PATH.
  echo Install Node.js or open this from a terminal where node works.
  pause
  exit /b 1
)

if not exist "%CONNECTOR_DIR%\bin\agent-connector.js" (
  echo [ERROR] agent-connector.js was not found:
  echo %CONNECTOR_DIR%\bin\agent-connector.js
  pause
  exit /b 1
)

echo OpenAgents local daemon
echo Connector: %CONNECTOR_DIR%
echo.
echo This script only starts existing agents from your OpenAgents config.
echo Manage agent creation, deletion, workspace binding, and project paths in the launcher.
echo.
echo Starting in foreground. Keep this window open.
echo Press Ctrl+C to stop.
echo.

pushd "%CONNECTOR_DIR%"
node bin\agent-connector.js up --foreground --no-update-check
popd

pause
