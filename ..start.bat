@echo off
setlocal

cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "workspace\scripts\start-local-web.ps1" -RepoRoot "%CD%"

if errorlevel 1 (
  echo.
  echo [ERROR] OpenAgents local Web failed.
  pause
  exit /b 1
)

endlocal
