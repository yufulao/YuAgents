param(
  [string]$SshHost = "159.75.188.203",
  [int]$SshPort = 22222,
  [string]$User = "root",
  [string]$RemoteDir = "/opt/openagents",
  [string]$Domain = "oa.yodaze.com",
  [switch]$ConfigureNginx,
  [switch]$InstallDocker
)

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$WorkspaceRoot = Join-Path $RepoRoot "workspace"
$Remote = "$User@$SshHost"
$Archive = Join-Path ([System.IO.Path]::GetTempPath()) ("openagents-remote-relay-" + [System.Guid]::NewGuid().ToString("N") + ".tar.gz")
$RemoteArchive = "/tmp/openagents-remote-relay.tar.gz"

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
Require-Command tar

try {
  Push-Location $RepoRoot
  Write-Host "Packaging remote relay files..."
  & tar `
    --exclude "workspace/frontend/node_modules" `
    --exclude "workspace/frontend/.next" `
    --exclude "workspace/frontend/out" `
    --exclude "workspace/.remote-web-test" `
    --exclude "workspace/.remote-docker-ui" `
    -czf $Archive `
    workspace/docker-compose.prod.yml `
    workspace/nginx.conf.template `
    workspace/start.sh `
    workspace/frontend
  if ($LASTEXITCODE -ne 0) {
    throw "tar failed with exit code $LASTEXITCODE"
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
  Write-Host "Configuring host nginx reverse proxy for $Domain -> 127.0.0.1:18080 ..."
  $nginx = @"
server {
    listen 80;
    server_name $Domain;

    location / {
        proxy_pass http://127.0.0.1:18080;
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
