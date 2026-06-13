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

function Resolve-7Zip {
  $cmd = Get-Command "7z" -ErrorAction SilentlyContinue
  if ($cmd) {
    return $cmd.Source
  }
  foreach ($path in @(
    "$env:ProgramFiles\7-Zip\7z.exe",
    "${env:ProgramFiles(x86)}\7-Zip\7z.exe",
    "$env:LOCALAPPDATA\Programs\7-Zip\7z.exe"
  )) {
    if ($path -and (Test-Path $path)) {
      return $path
    }
  }
  throw "7-Zip was not found. Install 7-Zip, or add 7z.exe to PATH."
}

$Git = Require-Command @("git")
$Tar = Require-Command @("tar")
$SevenZip = Resolve-7Zip

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
  $OutputDir = Join-Path $RepoRoot "dist"
}
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

if ([string]::IsNullOrWhiteSpace($ArchiveName)) {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $ArchiveName = "openagents-oa-yodaze-relay-$stamp.7z"
}
$OutputPath = Join-Path $OutputDir $ArchiveName

$ArchivePaths = @(
  "workspace/docker-compose.prod.yml",
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

  if (Test-Path $OutputPath) {
    Remove-Item -Force $OutputPath
  }

  Write-Host "Creating 7z package..."
  Push-Location $Stage
  & $SevenZip a -t7z -mx=9 $OutputPath workspace | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "7z failed with exit code $LASTEXITCODE"
  }
  Pop-Location

  $item = Get-Item $OutputPath
  Write-Host ""
  Write-Host "Package ready:"
  Write-Host "  $($item.FullName)"
  Write-Host "  $($item.Length) bytes"
  Write-Host ""
  Write-Host "Included:"
  Write-Host "  workspace/docker-compose.prod.yml"
  Write-Host "  workspace/nginx.conf.template"
  Write-Host "  workspace/start.sh"
  Write-Host "  workspace/frontend"
  Write-Host ""
  Write-Host "Not included: node_modules, .next, .env, logs, exports, SQLite DBs, local start scripts, untracked files."
} finally {
  Pop-Location -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $TempRoot -ErrorAction SilentlyContinue
}
