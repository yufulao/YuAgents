@echo off
setlocal EnableExtensions

cd /d "%~dp0"

if not defined REMOTE_WEB_PORT set "REMOTE_WEB_PORT=18080"
if not defined REMOTE_WEB_BIND set "REMOTE_WEB_BIND=127.0.0.1"
if not defined PUBLIC_URL set "PUBLIC_URL=http://localhost:%REMOTE_WEB_PORT%"
if not defined API_URL set "API_URL=%PUBLIC_URL%"
if not defined CORS_ORIGINS set "CORS_ORIGINS=%PUBLIC_URL%"
if not defined DB_PASSWORD set "DB_PASSWORD=changeme"
if not defined SYNC_LOCAL_WORKSPACES set "SYNC_LOCAL_WORKSPACES=1"

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
echo URL: %API_URL%
echo Bind: %REMOTE_WEB_BIND%:%REMOTE_WEB_PORT%
echo Workspace creation: disabled
echo Workspace directory: disabled

if /I "%SKIP_MIGRATIONS%"=="1" goto start_stack

echo.
echo Preparing database schema...
docker compose -f docker-compose.prod.yml up -d db
if errorlevel 1 exit /b %errorlevel%

docker compose -f docker-compose.prod.yml run --rm --build --entrypoint alembic backend upgrade head
if errorlevel 1 exit /b %errorlevel%

:start_stack
echo.
echo Running: docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml up -d --build
if errorlevel 1 exit /b %errorlevel%

if /I "%SYNC_LOCAL_WORKSPACES%"=="0" goto skip_import
if /I "%SYNC_LOCAL_WORKSPACES%"=="false" goto skip_import
if not exist "backend\workspace_dev.db" goto skip_import

echo.
echo Importing existing active local workspaces into the Docker database...
echo This does not generate new workspace tokens.
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\import-local-workspaces-to-docker.ps1
if errorlevel 1 exit /b %errorlevel%

:skip_import
echo.
echo OpenAgents is running at %API_URL%
echo Use an existing workspace slug/name and token/password.
echo To stop: docker compose -f docker-compose.prod.yml down
