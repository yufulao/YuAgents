param(
  [string]$OutputDir = "",
  [string]$ArchiveName = ""
)

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")

function Require-Command([string[]]$Names) {
  foreach ($name in $Names) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) {
      return $cmd.Source
    }
  }
  throw ("None of these commands were found in PATH: " + ($Names -join ", "))
}

$Git = Require-Command @("git")
$Tar = Require-Command @("tar")

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
  $OutputDir = Join-Path $RepoRoot "dist"
}
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

if ([string]::IsNullOrWhiteSpace($ArchiveName)) {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $ArchiveName = "openagents-remote-relay-$stamp.zip"
}
$OutputPath = Join-Path $OutputDir $ArchiveName

$ArchivePaths = @(
  "workspace/docker-compose.prod.yml",
  "workspace/deploy.remote.env",
  "workspace/nginx.conf.template",
  "workspace/start.sh",
  "workspace/frontend",
  ":(exclude)workspace/frontend/workspace-test-response.png"
)

$dirtyRelevant = & $Git -C $RepoRoot status --porcelain -- $ArchivePaths
if ($LASTEXITCODE -ne 0) {
  throw "git status failed with exit code $LASTEXITCODE"
}
if ($dirtyRelevant) {
  Write-Host "[WARN] Deploy-relevant files have uncommitted changes and will not be included:"
  $dirtyRelevant | ForEach-Object { Write-Host "  $_" }
  Write-Host "Commit them first if they must be in the server package."
  Write-Host ""
}

$TempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("openagents-relay-package-" + [System.Guid]::NewGuid().ToString("N"))
$TempTar = Join-Path $TempRoot "relay.tar"
$Stage = Join-Path $TempRoot "stage"

try {
  New-Item -ItemType Directory -Force -Path $Stage | Out-Null

  Push-Location $RepoRoot
  Write-Host "Collecting tracked remote relay files..."
  & $Git archive --format=tar --output $TempTar HEAD -- $ArchivePaths
  if ($LASTEXITCODE -ne 0) {
    throw "git archive failed with exit code $LASTEXITCODE"
  }
  Pop-Location

  Write-Host "Preparing package staging directory..."
  & $Tar -xf $TempTar -C $Stage
  if ($LASTEXITCODE -ne 0) {
    throw "tar extract failed with exit code $LASTEXITCODE"
  }

  $serverStart = Join-Path $Stage "workspace\start.sh"
  if (Test-Path $serverStart) {
    $content = [System.IO.File]::ReadAllText($serverStart)
    $content = $content -replace "`r`n", "`n"
    $content = $content -replace "`r", "`n"
    [System.IO.File]::WriteAllText($serverStart, $content, [System.Text.UTF8Encoding]::new($false))
  }

  if (Test-Path $OutputPath) {
    Remove-Item -Force $OutputPath
  }

  Write-Host "Creating zip package..."
  Compress-Archive -Path (Join-Path $Stage "workspace") -DestinationPath $OutputPath -CompressionLevel Optimal -Force

  $item = Get-Item $OutputPath
  Write-Host ""
  Write-Host "Package ready:"
  Write-Host "  $($item.FullName)"
  Write-Host "  $($item.Length) bytes"
  Write-Host ""
  Write-Host "Included:"
  Write-Host "  workspace/docker-compose.prod.yml"
  Write-Host "  workspace/deploy.remote.env"
  Write-Host "  workspace/nginx.conf.template"
  Write-Host "  workspace/start.sh"
  Write-Host "  workspace/frontend"
  Write-Host ""
  Write-Host "Not included: node_modules, .next, .env, logs, exports, SQLite DBs, local start scripts, untracked files."
} finally {
  Pop-Location -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $TempRoot -ErrorAction SilentlyContinue
}
