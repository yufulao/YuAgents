@echo off
setlocal

cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "workspace\scripts\package-remote-relay.ps1" ^
  -OutputDir "dist"

if errorlevel 1 (
  echo.
  echo [ERROR] Server package creation failed.
  pause
  exit /b 1
)

echo.
echo Package created under dist.
pause
