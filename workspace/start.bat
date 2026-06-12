@echo off
setlocal EnableExtensions

cd /d "%~dp0"

if not defined REMOTE_WEB_PORT set "REMOTE_WEB_PORT=18080"
if not defined REMOTE_WEB_BIND set "REMOTE_WEB_BIND=127.0.0.1"
if not defined PUBLIC_URL set "PUBLIC_URL=http://localhost:%REMOTE_WEB_PORT%"
if not defined LOCAL_CONTROL_API_URL set "LOCAL_CONTROL_API_URL=http://host.docker.internal:8000"

set "WORKSPACE_CREATION_ENABLED=false"
set "WORKSPACE_DIRECTORY_ENABLED=false"
set "NEXT_PUBLIC_WORKSPACE_CREATION_ENABLED=false"
set "NEXT_PUBLIC_WORKSPACE_DIRECTORY_ENABLED=false"

docker compose version >nul 2>nul
if errorlevel 1 (
  echo Docker Compose was not found. Start Docker Desktop and make sure "docker compose" works.
  exit /b 1
)

echo Starting OpenAgents prod-style local stack...
echo URL: %PUBLIC_URL%
echo Bind: %REMOTE_WEB_BIND%:%REMOTE_WEB_PORT%
echo Local control API from Docker: %LOCAL_CONTROL_API_URL%
echo Workspace creation: disabled
echo Workspace directory: disabled
echo Workspace authority: local control plane

echo.
echo Checking local control plane at http://127.0.0.1:8000 ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ok=$false; try { $r=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8000/v1/agent-catalog' -TimeoutSec 3; if ($r.StatusCode -eq 200) { $ok=$true } } catch {}; if (-not $ok) { exit 1 }"
if errorlevel 1 (
  echo [ERROR] Local control plane is not reachable on http://127.0.0.1:8000.
  echo Start the local control plane first with ..\start.bat, then run this script again.
  exit /b 1
)

echo.
echo Running: docker compose -f docker-compose.prod.yml up -d --build --remove-orphans --force-recreate
docker compose -f docker-compose.prod.yml up -d --build --remove-orphans --force-recreate
if errorlevel 1 exit /b %errorlevel%

echo.
echo Waiting for remote relay at %PUBLIC_URL% ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ok=$false; for ($i=0; $i -lt 60; $i++) { try { $r=Invoke-WebRequest -UseBasicParsing -Uri '%PUBLIC_URL%/v1/agent-catalog' -TimeoutSec 3; if ($r.StatusCode -eq 200) { $ok=$true; break } } catch {}; Start-Sleep -Seconds 1 }; if (-not $ok) { exit 1 }"
if errorlevel 1 (
  echo [ERROR] Remote relay did not become ready at %PUBLIC_URL%.
  echo Check Docker logs with: docker compose -f docker-compose.prod.yml logs
  exit /b 1
)

echo.
echo OpenAgents is running at %PUBLIC_URL%
echo Use an existing workspace slug/name and token/password.
echo The server forwards /v1 requests to the local control plane; it does not store workspace authority.
echo To stop: docker compose -f docker-compose.prod.yml down
