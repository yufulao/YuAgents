param(
  [int]$Port = 18080,
  [string]$Bind = "127.0.0.1",
  [string]$PublicUrl = "",
  [string]$LocalControlApiUrl = "http://host.docker.internal:8000",
  [string]$ProjectName = "openagents-remote-sim",
  [switch]$Build,
  [switch]$Down,
  [switch]$Logs,
  [switch]$Status
)

$ErrorActionPreference = "Stop"

$WorkspaceRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$ComposeFile = Join-Path $WorkspaceRoot "docker-compose.prod.yml"

function Quote-Cmd([string]$Value) {
  return '"' + ($Value -replace '"', '\"') + '"'
}

function Require-Docker {
  & cmd /d /c "docker compose version >nul 2>nul"
  if ($LASTEXITCODE -ne 0) {
    throw "Docker CLI was not found. Install Docker Desktop or run this script on the Linux server with Docker installed."
  }
}

function Set-RemoteEnv {
  if ([string]::IsNullOrWhiteSpace($PublicUrl)) {
    $script:PublicUrl = "http://localhost:$Port"
  }

  $env:REMOTE_WEB_BIND = $Bind
  $env:REMOTE_WEB_PORT = [string]$Port
  $env:API_URL = ""
  $env:CORS_ORIGINS = $PublicUrl
  $env:LOCAL_CONTROL_API_URL = $LocalControlApiUrl
  $env:WORKSPACE_CREATION_ENABLED = "false"
  $env:WORKSPACE_DIRECTORY_ENABLED = "false"
  $env:NEXT_PUBLIC_WORKSPACE_CREATION_ENABLED = "false"
  $env:NEXT_PUBLIC_WORKSPACE_DIRECTORY_ENABLED = "false"
}

function Invoke-Compose([string[]]$ComposeArgs) {
  $parts = @("docker", "compose", "-p", (Quote-Cmd $ProjectName), "-f", (Quote-Cmd $ComposeFile))
  foreach ($arg in $ComposeArgs) {
    $parts += Quote-Cmd $arg
  }
  & cmd /d /c ($parts -join " ")
  if ($LASTEXITCODE -ne 0) {
    throw "docker compose failed with exit code $LASTEXITCODE"
  }
}

Require-Docker
Set-RemoteEnv

if ($Down) {
  Invoke-Compose @("down")
  Write-Host "Remote Docker simulation stopped. Project: $ProjectName"
  return
}

if ($Logs) {
  Invoke-Compose @("logs", "-f")
  return
}

if ($Status) {
  Invoke-Compose @("ps")
  return
}

$upArgs = @("up", "-d", "--remove-orphans", "--force-recreate")
if ($Build) {
  $upArgs += "--build"
}

Invoke-Compose $upArgs

$deadline = (Get-Date).AddSeconds(120)
$healthUrl = "$PublicUrl/v1/agent-catalog"
while ((Get-Date) -lt $deadline) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 3
    if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
      Write-Host "Remote Docker simulation is running."
      Write-Host "URL: $PublicUrl"
      Write-Host "Project: $ProjectName"
      Write-Host "Workspace creation: disabled"
      Write-Host "Workspace directory: disabled"
      Write-Host "Local control API: $LocalControlApiUrl"
      Write-Host "No workspace data is stored or synced on the remote Docker stack."
      return
    }
  } catch {}

  Start-Sleep -Seconds 2
}

Invoke-Compose @("ps")
throw "Timed out waiting for $healthUrl"
