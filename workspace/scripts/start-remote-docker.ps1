param(
  [string]$ConfigPath = "",
  [int]$Port = 0,
  [string]$Bind = "",
  [string]$PublicUrl = "",
  [string]$LocalControlApiUrl = "",
  [string]$ProjectName = "",
  [switch]$Build,
  [switch]$Down,
  [switch]$Logs,
  [switch]$Status
)

$ErrorActionPreference = "Stop"

$WorkspaceRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$ComposeFile = Join-Path $WorkspaceRoot "docker-compose.prod.yml"
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
  $ConfigPath = Join-Path $WorkspaceRoot "deploy.remote.env"
}

function Read-EnvConfig([string]$Path) {
  $config = @{}
  if (-not (Test-Path $Path)) {
    return $config
  }
  foreach ($line in Get-Content -LiteralPath $Path) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#")) { continue }
    $match = [regex]::Match($trimmed, '^([A-Za-z_][A-Za-z0-9_]*)=(.*)$')
    if (-not $match.Success) { continue }
    $value = $match.Groups[2].Value.Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    $config[$match.Groups[1].Value] = $value
  }
  return $config
}

$DeployConfig = Read-EnvConfig $ConfigPath

function Get-ConfigValue([string]$Name, [string]$Fallback) {
  $envValue = [Environment]::GetEnvironmentVariable($Name)
  if (-not [string]::IsNullOrWhiteSpace($envValue)) { return $envValue }
  if ($DeployConfig.ContainsKey($Name) -and -not [string]::IsNullOrWhiteSpace($DeployConfig[$Name])) {
    return [string]$DeployConfig[$Name]
  }
  return $Fallback
}

if (-not $PSBoundParameters.ContainsKey("Port") -or $Port -le 0) { $Port = [int](Get-ConfigValue "OA_REMOTE_WEB_PORT" "18080") }
if (-not $PSBoundParameters.ContainsKey("Bind") -or [string]::IsNullOrWhiteSpace($Bind)) { $Bind = Get-ConfigValue "OA_REMOTE_WEB_BIND" "127.0.0.1" }
if (-not $PSBoundParameters.ContainsKey("PublicUrl") -or [string]::IsNullOrWhiteSpace($PublicUrl)) { $PublicUrl = Get-ConfigValue "OA_REMOTE_PUBLIC_URL" "http://localhost:$Port" }
if (-not $PSBoundParameters.ContainsKey("LocalControlApiUrl") -or [string]::IsNullOrWhiteSpace($LocalControlApiUrl)) { $LocalControlApiUrl = Get-ConfigValue "OA_LOCAL_CONTROL_API_URL" "http://host.docker.internal:8000" }
if (-not $PSBoundParameters.ContainsKey("ProjectName") -or [string]::IsNullOrWhiteSpace($ProjectName)) { $ProjectName = Get-ConfigValue "OA_REMOTE_PROJECT_NAME" "openagents-remote-sim" }

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
