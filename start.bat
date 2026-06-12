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

echo Stopping existing local Web processes on ports 8000 and 3001...
powershell -NoProfile -ExecutionPolicy Bypass -Command "foreach ($port in 8000,3001) { Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } }" >nul 2>nul
timeout /t 1 /nobreak >nul

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

echo Waiting for backend API...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ok=$false; for ($i=0; $i -lt 60; $i++) { try { $r=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8000/v1/workspaces' -TimeoutSec 2; if ($r.StatusCode -eq 200) { $ok=$true; break } } catch {}; Start-Sleep -Seconds 1 }; if (-not $ok) { exit 1 }"
if errorlevel 1 (
  echo [ERROR] Backend did not become ready on http://127.0.0.1:8000.
  echo Check the "OpenAgents backend :8000" window for the real error.
  pause
  exit /b 1
)

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

echo Waiting for frontend Web page...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ok=$false; for ($i=0; $i -lt 90; $i++) { try { $r=Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:3001' -TimeoutSec 2; if ($r.StatusCode -eq 200) { $ok=$true; break } } catch {}; Start-Sleep -Seconds 1 }; if (-not $ok) { exit 1 }"
if errorlevel 1 (
  echo [ERROR] Frontend did not become ready on http://localhost:3001.
  echo Check the "OpenAgents frontend :3001" window for the real error.
  pause
  exit /b 1
)

echo.
echo OpenAgents local Web is ready.
echo Keep the backend and frontend windows open while using OpenAgents.
echo http://localhost:3001
echo.
start "" "http://localhost:3001"

endlocal
