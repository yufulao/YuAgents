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
$BackendVenvDir = Join-Path $BackendDir ".venv"
$BackendPython = Join-Path $BackendVenvDir "Scripts\python.exe"
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

function Show-LogTail([string]$Path, [int]$Lines = 80) {
  if (-not (Test-Path $Path)) {
    Write-Host "  (missing log: $Path)"
    return
  }
  Write-Host ""
  Write-Host "----- Last $Lines lines: $Path -----"
  Get-Content -LiteralPath $Path -Tail $Lines
  Write-Host "----- End log -----"
}

function Wait-Url([string]$Url, [int]$Seconds, [string]$Label, $Process = $null, [string[]]$LogPaths = @()) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Url $Url 2) {
      return
    }
    Start-Sleep -Seconds 1
  }
  foreach ($path in $LogPaths) {
    Show-LogTail $path
  }
  throw "Timed out waiting for $Label at $Url"
}

function Ensure-BackendPythonEnv {
  $requirementsPath = Join-Path $BackendDir "requirements.txt"
  if (-not (Test-Path $requirementsPath)) {
    throw "Backend requirements file was not found: $requirementsPath"
  }

  if (-not (Test-Path $BackendPython)) {
    Write-Host "Creating backend Python virtual environment at $BackendVenvDir..."
    & python -m venv $BackendVenvDir
  }
  if (-not (Test-Path $BackendPython)) {
    throw "Backend virtual environment Python was not found after creation: $BackendPython"
  }

  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & $BackendPython -c "import fastapi, uvicorn, sqlalchemy" *> $null
    $dependencyCheckExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }

  if ($dependencyCheckExitCode -ne 0) {
    Write-Host "Installing backend Python dependencies..."
    & $BackendPython -m pip install --upgrade pip
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to upgrade pip in backend virtual environment."
    }
    & $BackendPython -m pip install -r $requirementsPath
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to install backend dependencies from $requirementsPath."
    }
  }
}

function Ensure-FrontendDependencies {
  $nodeModules = Join-Path $FrontendDir "node_modules"
  if (-not (Test-Path $nodeModules)) {
    Write-Host "Installing frontend npm dependencies..."
    Push-Location $FrontendDir
    try {
      if (Test-Path (Join-Path $FrontendDir "package-lock.json")) {
        & npm ci
      } else {
        & npm install
      }
      if ($LASTEXITCODE -ne 0) {
        throw "Failed to install frontend npm dependencies."
      }
    } finally {
      Pop-Location
    }
  }
}

function Stop-ListeningPort([int]$Port) {
  Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique |
    ForEach-Object {
      Stop-ProcessTree ([int]$_)
    }
}

function Stop-ChildProcess($Process) {
  if ($Process) {
    Stop-ProcessTree ([int]$Process.Id)
  }
}

function Stop-ProcessTree([int]$ProcessId) {
  if ($ProcessId -le 0) {
    return
  }
  $children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$ProcessId" -ErrorAction SilentlyContinue
  foreach ($child in $children) {
    Stop-ProcessTree ([int]$child.ProcessId)
  }
  Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

function Stop-LocalWebProcesses {
  $backendMatch = $BackendDir.ToLowerInvariant()
  $frontendMatch = $FrontendDir.ToLowerInvariant()
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $cmd = [string]$_.CommandLine
      $lower = $cmd.ToLowerInvariant()
      (
        $lower.Contains($backendMatch) -and
        $lower.Contains("uvicorn") -and
        $lower.Contains("app.main:app")
      ) -or (
        $lower.Contains($frontendMatch) -and
        ($lower.Contains("npm run dev") -or $lower.Contains("next dev") -or $lower.Contains("next\dist\bin\next"))
      )
    } |
    Select-Object -ExpandProperty ProcessId -Unique |
    ForEach-Object {
      Stop-ProcessTree ([int]$_)
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
  Remove-Item -LiteralPath $BackendLog, $BackendErr, $FrontendLog, $FrontendErr -Force -ErrorAction SilentlyContinue

  Ensure-BackendPythonEnv
  Ensure-FrontendDependencies

  Write-Host "Stopping existing local Web processes on ports $LocalBackendPort and $LocalFrontendPort..."
  Stop-LocalWebProcesses
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
    "`"$BackendPython`" -m uvicorn app.main:app --host $LocalBackendBind --port $LocalBackendPort"
  ) | Set-Content -Encoding ASCII -Path $BackendCmd

  Write-Host "Starting backend on $LocalBackendUrl"
  Write-Host "  stdout: $BackendLog"
  Write-Host "  stderr: $BackendErr"
  $Backend = Start-Process -FilePath "cmd.exe" -ArgumentList "/d", "/c", "call `"$BackendCmd`"" -WindowStyle Hidden -RedirectStandardOutput $BackendLog -RedirectStandardError $BackendErr -PassThru

  Write-Host "Waiting for backend API..."
  Wait-Url "$LocalBackendUrl/v1/agent-catalog" 90 "backend API" $Backend @($BackendErr, $BackendLog)

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
  Wait-Url $LocalFrontendUrl 120 "frontend Web page" $Frontend @($FrontendErr, $FrontendLog)

  Write-Host ""
  Write-Host "OpenAgents local Web is ready:"
  Write-Host "  $LocalFrontendUrl"
  Write-Host ""
  Write-Host "Keep this window open while using OpenAgents."
  Write-Host "Press Ctrl+C to stop backend and frontend."
  Start-Process $LocalFrontendUrl

  while ($true) {
    $backendHealthy = Test-Url "$LocalBackendUrl/v1/agent-catalog" 3
    $frontendHealthy = Test-Url $LocalFrontendUrl 3
    if (-not $backendHealthy) {
      Show-LogTail $BackendErr
      Show-LogTail $BackendLog
      throw "Backend API stopped responding. Check $BackendLog and $BackendErr."
    }
    if (-not $frontendHealthy) {
      Show-LogTail $FrontendErr
      Show-LogTail $FrontendLog
      throw "Frontend Web page stopped responding. Check $FrontendLog and $FrontendErr."
    }
    Start-Sleep -Seconds 5
  }
} finally {
  Stop-ChildProcess $Backend
  Stop-ChildProcess $Frontend
  Stop-LocalWebProcesses
  Stop-ListeningPort $LocalBackendPort
  Stop-ListeningPort $LocalFrontendPort
  Remove-Item -LiteralPath $BackendCmd, $FrontendCmd -Force -ErrorAction SilentlyContinue
}
