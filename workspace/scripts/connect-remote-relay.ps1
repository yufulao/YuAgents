param(
  [string]$ConfigPath = "",
  [string]$SshHost = "",
  [int]$SshPort = 0,
  [string]$User = "",
  [string]$RemoteDir = "",
  [string]$Domain = "",
  [string]$PublicUrl = "",
  [int]$RemoteWebPort = 0,
  [int]$TunnelPort = 0,
  [int]$LocalBackendPort = 0,
  [switch]$StartLocal,
  [switch]$SkipOpenBrowser,
  [switch]$StopExistingTunnel,
  [switch]$EnsureGatewayPorts,
  [switch]$TunnelOnly,
  [int]$ReconnectDelaySeconds = 5,
  [int]$MaxReconnectAttempts = 0
)

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
  $ConfigPath = Join-Path $RepoRoot "workspace\deploy.remote.env"
}

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

if (-not $PSBoundParameters.ContainsKey("SshHost") -or [string]::IsNullOrWhiteSpace($SshHost)) { $SshHost = Get-ConfigValue "OA_REMOTE_SSH_HOST" "" }
if (-not $PSBoundParameters.ContainsKey("SshPort") -or $SshPort -le 0) { $SshPort = [int](Get-ConfigValue "OA_REMOTE_SSH_PORT" "22") }
if (-not $PSBoundParameters.ContainsKey("User") -or [string]::IsNullOrWhiteSpace($User)) { $User = Get-ConfigValue "OA_REMOTE_SSH_USER" "root" }
if (-not $PSBoundParameters.ContainsKey("RemoteDir") -or [string]::IsNullOrWhiteSpace($RemoteDir)) { $RemoteDir = Get-ConfigValue "OA_REMOTE_DIR" "/opt/openagents" }
if (-not $PSBoundParameters.ContainsKey("Domain") -or [string]::IsNullOrWhiteSpace($Domain)) { $Domain = Get-ConfigValue "OA_REMOTE_DOMAIN" "localhost" }
if (-not $PSBoundParameters.ContainsKey("PublicUrl") -or [string]::IsNullOrWhiteSpace($PublicUrl)) { $PublicUrl = Get-ConfigValue "OA_REMOTE_PUBLIC_URL" "http://$Domain" }
if (-not $PSBoundParameters.ContainsKey("RemoteWebPort") -or $RemoteWebPort -le 0) { $RemoteWebPort = [int](Get-ConfigValue "OA_REMOTE_WEB_PORT" "18080") }
if (-not $PSBoundParameters.ContainsKey("TunnelPort") -or $TunnelPort -le 0) { $TunnelPort = [int](Get-ConfigValue "OA_TUNNEL_PORT" "8000") }
if (-not $PSBoundParameters.ContainsKey("LocalBackendPort") -or $LocalBackendPort -le 0) { $LocalBackendPort = [int](Get-ConfigValue "OA_LOCAL_BACKEND_PORT" "8000") }

$Remote = "$User@$SshHost"
if ([string]::IsNullOrWhiteSpace($SshHost)) {
  throw "Remote SSH host is required. Set OA_REMOTE_SSH_HOST in $ConfigPath or pass -SshHost."
}

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

function Invoke-SshOutput([string]$Command) {
  $output = (& ssh -p $SshPort $Remote $Command 2>&1) -join "`n"
  if ($LASTEXITCODE -ne 0) {
    throw "ssh command failed with exit code $LASTEXITCODE. Output: $output"
  }
  return $output
}

function Select-LastIpv4([string]$Text) {
  $matches = [regex]::Matches($Text, "(?<![\d.])(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?![\d.])")
  if ($matches.Count -eq 0) {
    return $null
  }
  return $matches[$matches.Count - 1].Value
}

function Join-RemoteCommands([string[]]$Commands) {
  return ($Commands -join "; ")
}

Require-Command ssh

if ($StartLocal) {
  Write-Host "Starting local OpenAgents control plane..."
  $localStart = Join-Path $RepoRoot "..start.bat"
  if (-not (Test-Path $localStart)) {
    $localStart = Join-Path $RepoRoot "start.bat"
  }
  Start-Process -FilePath $localStart -WorkingDirectory $RepoRoot
}

Write-Host "Using config: $ConfigPath"
Write-Host "Checking local control plane at http://127.0.0.1:$LocalBackendPort ..."
Wait-Url "http://127.0.0.1:$LocalBackendPort/v1/agent-catalog" 90 "local control plane"

if ($EnsureGatewayPorts) {
  Write-Host "Checking remote Docker gateway, SSH GatewayPorts, and existing remote listeners..."
} elseif ($StopExistingTunnel) {
  Write-Host "Checking remote Docker gateway and stopping existing remote listeners if possible..."
} else {
  Write-Host "Checking remote Docker gateway..."
}

$preflightCommands = @(
  "gateway=`$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null || echo 172.17.0.1)"
)

if ($EnsureGatewayPorts) {
  $preflightCommands += @(
    "sshd_bin=`$(command -v sshd || echo /usr/sbin/sshd)",
    "current_gateway_ports=`$(`$sshd_bin -T 2>/dev/null | awk 'tolower(`$1)==`"gatewayports`" {print tolower(`$2); exit}')",
    "if [ `"x`$current_gateway_ports`" != `"xclientspecified`" ]; then echo OPENAGENTS_SETTING_GATEWAYPORTS; cp /etc/ssh/sshd_config /etc/ssh/sshd_config.openagents.bak; if grep -Eiq '^[[:space:]]*GatewayPorts[[:space:]]+' /etc/ssh/sshd_config; then sed -i -E 's/^[[:space:]]*GatewayPorts[[:space:]]+.*/GatewayPorts clientspecified/I' /etc/ssh/sshd_config; elif grep -Eiq '^[[:space:]]*Match[[:space:]]+' /etc/ssh/sshd_config; then sed -i -E '0,/^[[:space:]]*Match[[:space:]]+/s//GatewayPorts clientspecified\n&/' /etc/ssh/sshd_config; else printf '\nGatewayPorts clientspecified\n' >> /etc/ssh/sshd_config; fi; if ! `$sshd_bin -t; then cp /etc/ssh/sshd_config.openagents.bak /etc/ssh/sshd_config; echo OPENAGENTS_GATEWAYPORTS_FAILED; exit 70; fi; if ! (systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || service ssh reload 2>/dev/null || service sshd reload 2>/dev/null); then echo OPENAGENTS_SSHD_RELOAD_FAILED; exit 71; fi; fi"
  )
}

if ($StopExistingTunnel) {
  $preflightCommands += "if command -v fuser >/dev/null 2>&1; then fuser -k ${TunnelPort}/tcp >/dev/null 2>&1 || true; elif command -v lsof >/dev/null 2>&1; then lsof -ti tcp:${TunnelPort} | xargs -r kill; fi"
}

$preflightCommands += "echo OPENAGENTS_GATEWAY=`$gateway"
$preflightCommand = Join-RemoteCommands $preflightCommands
$gatewayOutput = Invoke-SshOutput $preflightCommand
$gateway = Select-LastIpv4 $gatewayOutput
if (-not $gateway) {
  Write-Warning "Could not parse Docker bridge gateway from remote output; using 172.17.0.1."
  $gateway = "172.17.0.1"
}

function Start-TunnelProcess {
  $sshArgs = @(
    "-p", [string]$SshPort,
    "-N",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    "-R", "$gateway`:$TunnelPort`:127.0.0.1:$LocalBackendPort",
    $Remote
  )
  Start-Process -FilePath "ssh" -ArgumentList $sshArgs -NoNewWindow -PassThru
}

function Start-RemoteRelayIfNeeded {
  if (-not $TunnelOnly) {
    Write-Host "Starting remote Docker relay..."
    $remoteCommand = "cd '$RemoteDir/workspace' && OPENAGENTS_DEPLOY_CONFIG='$RemoteDir/workspace/deploy.remote.env' REMOTE_WEB_BIND=127.0.0.1 REMOTE_WEB_PORT=$RemoteWebPort PUBLIC_URL=http://127.0.0.1:$RemoteWebPort LOCAL_CONTROL_API_URL=http://host.docker.internal:$TunnelPort CONTROL_CHECK_URL=http://$gateway`:$TunnelPort bash start.sh"
    Invoke-Ssh $remoteCommand
  } else {
    Write-Host "Tunnel only mode: assuming remote start.sh is already running."
  }
}

$attempt = 0
$announcedReady = $false
$openedBrowser = $false
$tunnel = $null

try {
  while ($true) {
    $attempt += 1
    Write-Host "Opening SSH reverse tunnel: server $gateway`:$TunnelPort -> local 127.0.0.1:$LocalBackendPort"
    Write-Host "If an SSH password prompt appears, enter the server password in this window and keep this window open."
    if ($attempt -gt 1) {
      Write-Host "Reconnect attempt $attempt..."
    }
    $tunnel = Start-TunnelProcess

    Start-Sleep -Seconds 2
    if ($tunnel.HasExited) {
      $message = "SSH reverse tunnel exited early with code $($tunnel.ExitCode). If sshd rejected the bind address, set 'GatewayPorts clientspecified' on the server and reload sshd."
      if ($MaxReconnectAttempts -gt 0 -and $attempt -ge $MaxReconnectAttempts) {
        throw $message
      }
      Write-Warning $message
      Write-Host "Retrying in $ReconnectDelaySeconds seconds. Press Ctrl+C to stop."
      Start-Sleep -Seconds $ReconnectDelaySeconds
      continue
    }

    if (-not $announcedReady) {
      Start-RemoteRelayIfNeeded

      Write-Host "Checking public URL $PublicUrl ..."
      try {
        Wait-Url "$PublicUrl/relay-health" 60 "public relay"
      } catch {
        throw "Remote relay is not reachable at $PublicUrl/relay-health. Make sure server workspace/start.sh is running and the domain points to this server."
      }
      try {
        Wait-Url "$PublicUrl/v1/agent-catalog" 60 "public relay API"
      } catch {
        throw "Remote relay is running, but it cannot reach the local control plane through the SSH tunnel. Enter the server password in this window if SSH is waiting, and leave this window open. If SSH exited after login, verify GatewayPorts clientspecified in /etc/ssh/sshd_config and rerun ..connect_prod.bat."
      }

      Write-Host ""
      Write-Host "Remote OpenAgents relay is ready:"
      Write-Host "  $PublicUrl"
      Write-Host ""
      Write-Host "Keep this PowerShell window open. Closing it stops the SSH reverse tunnel."
      Write-Host "If the SSH connection resets, this script will reconnect automatically."
      Write-Host "Press Ctrl+C when you want to disconnect."
      $announcedReady = $true
      if (-not $SkipOpenBrowser -and -not $openedBrowser) {
        Start-Process $PublicUrl
        $openedBrowser = $true
      }
    }

    while (-not $tunnel.HasExited) {
      Start-Sleep -Seconds 5
    }

    $message = "SSH reverse tunnel exited with code $($tunnel.ExitCode)"
    if ($MaxReconnectAttempts -gt 0 -and $attempt -ge $MaxReconnectAttempts) {
      throw $message
    }
    Write-Warning "$message. Reconnecting in $ReconnectDelaySeconds seconds..."
    Start-Sleep -Seconds $ReconnectDelaySeconds
  }
} finally {
  if ($tunnel -and -not $tunnel.HasExited) {
    Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue
  }
}
