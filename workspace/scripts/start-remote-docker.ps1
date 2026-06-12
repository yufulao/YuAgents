param(
  [int]$Port = 18080,
  [string]$Bind = "127.0.0.1",
  [string]$PublicUrl = "",
  [string]$ProjectName = "openagents-remote-sim",
  [string]$DbPassword = "remote-sim-dev",
  [switch]$Build,
  [switch]$Down,
  [switch]$Logs,
  [switch]$Status
)

$ErrorActionPreference = "Stop"

$WorkspaceRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$ComposeFile = Join-Path $WorkspaceRoot "docker-compose.prod.yml"

function Require-Docker {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "Docker CLI was not found. Install Docker Desktop or run this script on the Linux server with Docker installed."
  }
}

function Set-RemoteEnv {
  if ([string]::IsNullOrWhiteSpace($PublicUrl)) {
    $script:PublicUrl = "http://localhost:$Port"
  }

  $env:REMOTE_WEB_BIND = $Bind
  $env:REMOTE_WEB_PORT = [string]$Port
  $env:DB_PASSWORD = $DbPassword
  $env:API_URL = $PublicUrl
  $env:CORS_ORIGINS = $PublicUrl
  $env:WORKSPACE_CREATION_ENABLED = "false"
  $env:WORKSPACE_DIRECTORY_ENABLED = "false"
  $env:NEXT_PUBLIC_WORKSPACE_CREATION_ENABLED = "false"
  $env:NEXT_PUBLIC_WORKSPACE_DIRECTORY_ENABLED = "false"
}

function Invoke-Compose([string[]]$Args) {
  & docker compose -p $ProjectName -f $ComposeFile @Args
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

$upArgs = @("up", "-d")
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
      Write-Host "No workspace was created or seeded by this script."
      return
    }
  } catch {}

  Start-Sleep -Seconds 2
}

Invoke-Compose @("ps")
throw "Timed out waiting for $healthUrl"
