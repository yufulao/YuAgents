param(
  [string]$ConfigPath = "",
  [string]$SshHost = "",
  [int]$SshPort = 0,
  [string]$User = "",
  [string]$RemoteDir = "",
  [string]$Domain = "",
  [int]$RemoteWebPort = 0,
  [switch]$ConfigureNginx,
  [switch]$InstallDocker
)

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$WorkspaceRoot = Join-Path $RepoRoot "workspace"
$Archive = Join-Path ([System.IO.Path]::GetTempPath()) ("openagents-remote-relay-" + [System.Guid]::NewGuid().ToString("N") + ".tar.gz")
$RemoteArchive = "/tmp/openagents-remote-relay.tar.gz"

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

if (-not $PSBoundParameters.ContainsKey("SshHost") -or [string]::IsNullOrWhiteSpace($SshHost)) { $SshHost = Get-ConfigValue "OA_REMOTE_SSH_HOST" "" }
if (-not $PSBoundParameters.ContainsKey("SshPort") -or $SshPort -le 0) { $SshPort = [int](Get-ConfigValue "OA_REMOTE_SSH_PORT" "22") }
if (-not $PSBoundParameters.ContainsKey("User") -or [string]::IsNullOrWhiteSpace($User)) { $User = Get-ConfigValue "OA_REMOTE_SSH_USER" "root" }
if (-not $PSBoundParameters.ContainsKey("RemoteDir") -or [string]::IsNullOrWhiteSpace($RemoteDir)) { $RemoteDir = Get-ConfigValue "OA_REMOTE_DIR" "/opt/openagents" }
if (-not $PSBoundParameters.ContainsKey("Domain") -or [string]::IsNullOrWhiteSpace($Domain)) { $Domain = Get-ConfigValue "OA_REMOTE_DOMAIN" "localhost" }
if (-not $PSBoundParameters.ContainsKey("RemoteWebPort") -or $RemoteWebPort -le 0) { $RemoteWebPort = [int](Get-ConfigValue "OA_REMOTE_WEB_PORT" "18080") }

$Remote = "$User@$SshHost"
if ([string]::IsNullOrWhiteSpace($SshHost)) {
  throw "Remote SSH host is required. Set OA_REMOTE_SSH_HOST in $ConfigPath or pass -SshHost."
}

function Require-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name was not found in PATH."
  }
}

function Invoke-Ssh([string]$Command) {
  & ssh -p $SshPort $Remote $Command
  if ($LASTEXITCODE -ne 0) {
    throw "ssh command failed with exit code $LASTEXITCODE"
  }
}

Require-Command ssh
Require-Command scp
Require-Command git

$ArchivePaths = @(
  "workspace/docker-compose.prod.yml",
  "workspace/deploy.remote.env",
  "workspace/nginx.conf.template",
  "workspace/start.sh",
  "workspace/frontend",
  ":(exclude)workspace/frontend/workspace-test-response.png"
)

$dirtyRelevant = & git -C $RepoRoot status --porcelain -- $ArchivePaths
if ($LASTEXITCODE -ne 0) {
  throw "git status failed with exit code $LASTEXITCODE"
}
if ($dirtyRelevant) {
  Write-Host "[WARN] These deploy-relevant files have uncommitted changes and will not be included by git archive:"
  $dirtyRelevant | ForEach-Object { Write-Host "  $_" }
  Write-Host "Commit or stash them first if they must be deployed."
  Write-Host ""
}

try {
  Push-Location $RepoRoot
  Write-Host "Packaging tracked remote relay files with git archive..."
  & git archive --format=tar.gz --output $Archive HEAD -- $ArchivePaths
  if ($LASTEXITCODE -ne 0) {
    throw "git archive failed with exit code $LASTEXITCODE"
  }
} finally {
  Pop-Location
}

Write-Host "Preparing remote directory ${Remote}:$RemoteDir ..."
Invoke-Ssh "mkdir -p '$RemoteDir'"

if ($InstallDocker) {
  Write-Host "Ensuring Docker is installed on the remote server..."
  Invoke-Ssh "if ! command -v docker >/dev/null 2>&1; then curl -fsSL https://get.docker.com | sh; fi; if ! docker compose version >/dev/null 2>&1; then echo 'docker compose is unavailable after install' >&2; exit 1; fi"
}

Write-Host "Uploading archive to $Remote..."
& scp -P $SshPort $Archive "${Remote}:$RemoteArchive"
if ($LASTEXITCODE -ne 0) {
  throw "scp failed with exit code $LASTEXITCODE"
}

Write-Host "Extracting relay files..."
Invoke-Ssh "tar -xzf '$RemoteArchive' -C '$RemoteDir' && rm -f '$RemoteArchive' && chmod +x '$RemoteDir/workspace/start.sh'"

if ($ConfigureNginx) {
  Write-Host "Configuring host nginx reverse proxy for $Domain -> 127.0.0.1:$RemoteWebPort ..."
  $nginx = @"
server {
    listen 80;
    server_name $Domain;

    location / {
        proxy_pass http://127.0.0.1:$RemoteWebPort;
        proxy_http_version 1.1;
        proxy_set_header Host `$host;
        proxy_set_header X-Real-IP `$remote_addr;
        proxy_set_header X-Forwarded-For `$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto `$scheme;
        proxy_set_header Upgrade `$http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
"@
  $tmpConf = Join-Path ([System.IO.Path]::GetTempPath()) ("openagents-nginx-" + [System.Guid]::NewGuid().ToString("N") + ".conf")
  Set-Content -Path $tmpConf -Value $nginx -Encoding ascii
  & scp -P $SshPort $tmpConf "${Remote}:/tmp/openagents-nginx.conf"
  if ($LASTEXITCODE -ne 0) {
    throw "scp nginx config failed with exit code $LASTEXITCODE"
  }
  Invoke-Ssh "if ! command -v nginx >/dev/null 2>&1; then if command -v apt-get >/dev/null 2>&1; then apt-get update && apt-get install -y nginx; else echo 'nginx is not installed and apt-get is unavailable' >&2; exit 1; fi; fi; cp /tmp/openagents-nginx.conf /etc/nginx/conf.d/openagents-relay.conf; nginx -t; systemctl enable nginx >/dev/null 2>&1 || true; systemctl reload nginx || nginx -s reload || systemctl start nginx"
  Remove-Item -Force $tmpConf -ErrorAction SilentlyContinue
}

Remove-Item -Force $Archive -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Remote relay files deployed."
Write-Host "Remote workspace: $RemoteDir/workspace"
Write-Host "Next: run workspace\scripts\connect-remote-relay.ps1 to open the SSH reverse tunnel and start the relay."
