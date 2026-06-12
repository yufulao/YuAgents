param(
  [int]$Port = 18080,
  [string]$Bind = "127.0.0.1",
  [string]$PublicUrl = "",
  [string]$ProjectName = "openagents-remote-sim",
  [string]$DbPassword = "remote-sim-dev",
  [switch]$ImportLocalWorkspaces,
  [switch]$Build,
  [switch]$Down,
  [switch]$Logs,
  [switch]$Status
)

$ErrorActionPreference = "Stop"

$WorkspaceRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$ComposeFile = Join-Path $WorkspaceRoot "docker-compose.prod.yml"
$ImportScript = Join-Path $PSScriptRoot "import-local-workspaces-to-docker.ps1"

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
  $env:DB_PASSWORD = $DbPassword
  $env:API_URL = $PublicUrl
  $env:CORS_ORIGINS = $PublicUrl
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

$upArgs = @("up", "-d")
if ($Build) {
  $upArgs += "--build"
}

Invoke-Compose $upArgs

if ($ImportLocalWorkspaces) {
  & powershell -NoProfile -ExecutionPolicy Bypass -File $ImportScript -ProjectName $ProjectName
  if ($LASTEXITCODE -ne 0) {
    throw "Local workspace import failed"
  }
}

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
