param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")),
  [string]$ConfigPath = ""
)

$ErrorActionPreference = "Stop"

$RepoRoot = $RepoRoot.Trim().Trim('"')
$RepoRoot = (Resolve-Path $RepoRoot).Path
$WorkspaceRoot = Join-Path $RepoRoot "workspace"
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
  $ConfigPath = Join-Path $WorkspaceRoot "deploy.remote.env"
}
$BackendDir = Join-Path $RepoRoot "workspace\backend"
$FrontendDir = Join-Path $RepoRoot "workspace\frontend"
$LogDir = Join-Path $RepoRoot "workspace\logs"
$TempDir = [System.IO.Path]::GetTempPath()
$BackendCmd = Join-Path $TempDir "openagents-backend-$PID.cmd"
$FrontendCmd = Join-Path $TempDir "openagents-frontend-$PID.cmd"
$BackendLog = Join-Path $LogDir "local-backend.log"
$BackendErr = Join-Path $LogDir "local-backend.err.log"
$FrontendLog = Join-Path $LogDir "local-frontend.log"
$FrontendErr = Join-Path $LogDir "local-frontend.err.log"
$Backend = $null
$Frontend = $null

function Read-EnvConfig([string]$Path) {
  $config = @{}
  if (-not (Test-Path $Path)) {
    return $config
  }
  foreach ($line in Get-Content -LiteralPath $Path) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#")) {
      continue
    }
    $match = [regex]::Match($trimmed, '^([A-Za-z_][A-Za-z0-9_]*)=(.*)$')
    if (-not $match.Success) {
      continue
    }
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
  if (-not [string]::IsNullOrWhiteSpace($envValue)) {
    return $envValue
  }
  if ($DeployConfig.ContainsKey($Name) -and -not [string]::IsNullOrWhiteSpace($DeployConfig[$Name])) {
    return [string]$DeployConfig[$Name]
  }
  return $Fallback
}

$LocalBackendHost = Get-ConfigValue "OA_LOCAL_BACKEND_HOST" "127.0.0.1"
$LocalBackendBind = Get-ConfigValue "OA_LOCAL_BACKEND_BIND" "0.0.0.0"
$LocalBackendPort = [int](Get-ConfigValue "OA_LOCAL_BACKEND_PORT" "8000")
$LocalFrontendHost = Get-ConfigValue "OA_LOCAL_FRONTEND_HOST" "localhost"
$LocalFrontendPort = [int](Get-ConfigValue "OA_LOCAL_FRONTEND_PORT" "3001")
$LocalBackendUrl = "http://${LocalBackendHost}:${LocalBackendPort}"
$LocalFrontendUrl = "http://${LocalFrontendHost}:${LocalFrontendPort}"

function Require-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name was not found in PATH."
  }
}

function Test-Url([string]$Url, [int]$TimeoutSec = 2) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec $TimeoutSec
    return ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500)
  } catch {
    return $false
  }
}

function Wait-Url([string]$Url, [int]$Seconds, [string]$Label) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Url $Url 2) {
      return
    }
    Start-Sleep -Seconds 1
  }
  throw "Timed out waiting for $Label at $Url"
}

function Stop-ListeningPort([int]$Port) {
  Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object {
      Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
    }
}

function Stop-ChildProcess($Process) {
  if ($Process -and -not $Process.HasExited) {
    Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
  }
}

Write-Host "OpenAgents local Web startup"
Write-Host "Root: $RepoRoot"
Write-Host "Config: $ConfigPath"
Write-Host ""

Require-Command python
Require-Command node
Require-Command npm

if (-not (Test-Path (Join-Path $BackendDir "app\main.py"))) {
  throw "Workspace backend was not found: $(Join-Path $BackendDir 'app\main.py')"
}
if (-not (Test-Path (Join-Path $FrontendDir "package.json"))) {
  throw "Workspace frontend was not found: $(Join-Path $FrontendDir 'package.json')"
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

try {
  Write-Host "Stopping existing local Web processes on ports $LocalBackendPort and $LocalFrontendPort..."
  Stop-ListeningPort $LocalBackendPort
  Stop-ListeningPort $LocalFrontendPort
  Start-Sleep -Seconds 1

  Write-Host "Stopping existing agent-connector daemon so local runtime code is reloaded..."
  $connectorBin = Join-Path $RepoRoot "packages\agent-connector\bin\agent-connector.js"
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & cmd.exe /d /c "node `"$connectorBin`" down >nul 2>nul"
  } catch {
    Write-Warning "Could not stop existing agent-connector daemon; continuing local Web startup."
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }

  @(
    "@echo off",
    "cd /d `"$BackendDir`"",
    "set `"DATABASE_URL=sqlite:///./workspace_dev.db`"",
    "set `"CORS_ORIGINS=*`"",
    "set `"WORKSPACE_CREATION_ENABLED=true`"",
    "set `"WORKSPACE_DIRECTORY_ENABLED=true`"",
    "python -m uvicorn app.main:app --host $LocalBackendBind --port $LocalBackendPort"
  ) | Set-Content -Encoding ASCII -Path $BackendCmd

  Write-Host "Starting backend on $LocalBackendUrl"
  Write-Host "  stdout: $BackendLog"
  Write-Host "  stderr: $BackendErr"
  $Backend = Start-Process -FilePath "cmd.exe" -ArgumentList "/d", "/c", "call `"$BackendCmd`"" -WindowStyle Hidden -RedirectStandardOutput $BackendLog -RedirectStandardError $BackendErr -PassThru

  Write-Host "Waiting for backend API..."
  Wait-Url "$LocalBackendUrl/v1/workspaces" 60 "backend API"

  @(
    "@echo off",
    "cd /d `"$FrontendDir`"",
    "set `"NEXT_PUBLIC_API_URL=`"",
    "set `"NEXT_PUBLIC_WORKSPACE_CREATION_ENABLED=true`"",
    "set `"NEXT_PUBLIC_WORKSPACE_DIRECTORY_ENABLED=true`"",
    "npm run dev"
  ) | Set-Content -Encoding ASCII -Path $FrontendCmd

  Write-Host "Starting frontend on $LocalFrontendUrl"
  Write-Host "  stdout: $FrontendLog"
  Write-Host "  stderr: $FrontendErr"
  $Frontend = Start-Process -FilePath "cmd.exe" -ArgumentList "/d", "/c", "call `"$FrontendCmd`"" -WindowStyle Hidden -RedirectStandardOutput $FrontendLog -RedirectStandardError $FrontendErr -PassThru

  Write-Host "Waiting for frontend Web page..."
  Wait-Url $LocalFrontendUrl 90 "frontend Web page"

  Write-Host ""
  Write-Host "OpenAgents local Web is ready:"
  Write-Host "  $LocalFrontendUrl"
  Write-Host ""
  Write-Host "Keep this window open while using OpenAgents."
  Write-Host "Press Ctrl+C to stop backend and frontend."
  Start-Process $LocalFrontendUrl

  while (($Backend -and -not $Backend.HasExited) -and ($Frontend -and -not $Frontend.HasExited)) {
    Start-Sleep -Seconds 5
  }

  if ($Backend -and $Backend.HasExited) {
    throw "Backend exited with code $($Backend.ExitCode). Check $BackendLog and $BackendErr."
  }
  if ($Frontend -and $Frontend.HasExited) {
    throw "Frontend exited with code $($Frontend.ExitCode). Check $FrontendLog and $FrontendErr."
  }
} finally {
  Stop-ChildProcess $Backend
  Stop-ChildProcess $Frontend
  Stop-ListeningPort $LocalBackendPort
  Stop-ListeningPort $LocalFrontendPort
  Remove-Item -LiteralPath $BackendCmd, $FrontendCmd -Force -ErrorAction SilentlyContinue
}
