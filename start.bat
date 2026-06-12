@echo off
setlocal

set "ROOT=%~dp0"
set "BACKEND_DIR=%ROOT%workspace\backend"
set "FRONTEND_DIR=%ROOT%workspace\frontend"
set "BACKEND_CMD=%TEMP%\openagents-backend-%RANDOM%.cmd"
set "FRONTEND_CMD=%TEMP%\openagents-frontend-%RANDOM%.cmd"

echo OpenAgents local Web startup
echo Root: %ROOT%
echo.

where python >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Python was not found in PATH.
  echo Install Python or open this from a terminal where python works.
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found in PATH.
  echo Install Node.js or open this from a terminal where node works.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm was not found in PATH.
  echo Install Node.js/npm or open this from a terminal where npm works.
  pause
  exit /b 1
)

if not exist "%BACKEND_DIR%\app\main.py" (
  echo [ERROR] Workspace backend was not found:
  echo %BACKEND_DIR%\app\main.py
  pause
  exit /b 1
)

if not exist "%FRONTEND_DIR%\package.json" (
  echo [ERROR] Workspace frontend was not found:
  echo %FRONTEND_DIR%\package.json
  pause
  exit /b 1
)

echo Starting backend on http://127.0.0.1:8000
(
  echo @echo off
  echo cd /d "%BACKEND_DIR%"
  echo set "DATABASE_URL=sqlite:///./workspace_dev.db"
  echo set "CORS_ORIGINS=http://localhost:3001,http://127.0.0.1:3001,http://localhost:3000,http://127.0.0.1:3000"
  echo set "WORKSPACE_CREATION_ENABLED=true"
  echo set "WORKSPACE_DIRECTORY_ENABLED=true"
  echo python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
) > "%BACKEND_CMD%"
start "OpenAgents backend :8000" cmd /k call "%BACKEND_CMD%"

echo Starting frontend on http://localhost:3001
(
  echo @echo off
  echo cd /d "%FRONTEND_DIR%"
  echo set "NEXT_PUBLIC_API_URL=http://127.0.0.1:8000"
  echo set "NEXT_PUBLIC_WORKSPACE_CREATION_ENABLED=true"
  echo set "NEXT_PUBLIC_WORKSPACE_DIRECTORY_ENABLED=true"
  echo npm run dev
) > "%FRONTEND_CMD%"
start "OpenAgents frontend :3001" cmd /k call "%FRONTEND_CMD%"

echo.
echo Two terminal windows were opened. Keep them open while using OpenAgents.
echo Browser will open shortly:
echo http://localhost:3001
echo.
timeout /t 4 /nobreak >nul
start "" "http://localhost:3001"

endlocal
