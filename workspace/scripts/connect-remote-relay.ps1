param(
  [string]$SshHost = "159.75.188.203",
  [int]$SshPort = 22222,
  [string]$User = "root",
  [string]$RemoteDir = "/opt/openagents",
  [string]$Domain = "oa.yodaze.com",
  [int]$RemoteWebPort = 18080,
  [int]$TunnelPort = 8000,
  [switch]$StartLocal,
  [switch]$SkipOpenBrowser,
  [switch]$StopExistingTunnel
)

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$Remote = "$User@$SshHost"
$PublicUrl = "http://$Domain"

function Require-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name was not found in PATH."
  }
}

function Test-Url([string]$Url, [int]$TimeoutSec = 3) {
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
    if (Test-Url $Url 3) {
      return
    }
    Start-Sleep -Seconds 1
  }
  throw "Timed out waiting for $Label at $Url"
}

function Invoke-Ssh([string]$Command) {
  & ssh -p $SshPort $Remote $Command
  if ($LASTEXITCODE -ne 0) {
    throw "ssh command failed with exit code $LASTEXITCODE"
  }
}

Require-Command ssh

if ($StartLocal) {
  Write-Host "Starting local OpenAgents control plane..."
  $localStart = Join-Path $RepoRoot "start.bat"
  Start-Process -FilePath $localStart -WorkingDirectory $RepoRoot
}

Write-Host "Checking local control plane at http://127.0.0.1:8000 ..."
Wait-Url "http://127.0.0.1:8000/v1/agent-catalog" 90 "local control plane"

$gateway = (& ssh -p $SshPort $Remote "docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null || echo 172.17.0.1").Trim()
if (-not $gateway) {
  $gateway = "172.17.0.1"
}

if ($StopExistingTunnel) {
  Write-Host "Stopping existing remote listeners on $gateway`:$TunnelPort if possible..."
  Invoke-Ssh "if command -v fuser >/dev/null 2>&1; then fuser -k ${TunnelPort}/tcp >/dev/null 2>&1 || true; elif command -v lsof >/dev/null 2>&1; then lsof -ti tcp:${TunnelPort} | xargs -r kill; fi"
}

Write-Host "Opening SSH reverse tunnel: server $gateway`:$TunnelPort -> local 127.0.0.1:8000"
$sshArgs = @(
  "-p", [string]$SshPort,
  "-N",
  "-o", "ExitOnForwardFailure=yes",
  "-o", "ServerAliveInterval=30",
  "-o", "ServerAliveCountMax=3",
  "-R", "$gateway`:$TunnelPort`:127.0.0.1:8000",
  $Remote
)
$tunnel = Start-Process -FilePath "ssh" -ArgumentList $sshArgs -WindowStyle Hidden -PassThru

try {
  Start-Sleep -Seconds 2
  if ($tunnel.HasExited) {
    throw "SSH reverse tunnel exited early with code $($tunnel.ExitCode). If sshd rejected the bind address, set 'GatewayPorts clientspecified' on the server and reload sshd."
  }

  Write-Host "Checking tunnel from remote host..."
  Invoke-Ssh "curl -fsS --max-time 5 http://$gateway`:$TunnelPort/v1/agent-catalog >/dev/null"

  Write-Host "Starting remote Docker relay..."
  $remoteCommand = "cd '$RemoteDir/workspace' && REMOTE_WEB_BIND=127.0.0.1 REMOTE_WEB_PORT=$RemoteWebPort PUBLIC_URL=http://127.0.0.1:$RemoteWebPort LOCAL_CONTROL_API_URL=http://host.docker.internal:$TunnelPort CONTROL_CHECK_URL=http://$gateway`:$TunnelPort bash start.sh"
  Invoke-Ssh $remoteCommand

  Write-Host "Checking public URL $PublicUrl ..."
  Wait-Url "$PublicUrl/relay-health" 60 "public relay"
  Wait-Url "$PublicUrl/v1/agent-catalog" 60 "public relay API"

  Write-Host ""
  Write-Host "Remote OpenAgents relay is ready:"
  Write-Host "  $PublicUrl"
  Write-Host ""
  Write-Host "Keep this PowerShell window open. Closing it stops the SSH reverse tunnel."
  Write-Host "Press Ctrl+C when you want to disconnect."
  if (-not $SkipOpenBrowser) {
    Start-Process $PublicUrl
  }

  while (-not $tunnel.HasExited) {
    Start-Sleep -Seconds 5
  }
  throw "SSH reverse tunnel exited with code $($tunnel.ExitCode)"
} finally {
  if ($tunnel -and -not $tunnel.HasExited) {
    Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue
  }
}
