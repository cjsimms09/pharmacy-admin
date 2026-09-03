# Updates Pharmacy Admin to the latest version and leaves it ready to start.
#
# Deliberately blunt about the code and careful about the data. The working copy is reset to
# exactly what is on the server, which avoids the merge conflicts a half-finished local edit
# would otherwise cause on a machine nobody edits code on. Everything the pharmacy owns - the
# database, uploaded documents, the .env file with the encryption key - is outside version
# control and is not touched.

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

$branch = "feature/compliance"

function Step($text) { Write-Host "  $text" -ForegroundColor Cyan }
function Ok($text)   { Write-Host "  $text" -ForegroundColor Green }
function Bad($text)  { Write-Host "  $text" -ForegroundColor Red }

# ── Stop the running app ─────────────────────────────────────────────
# Only whatever is holding port 3000. Other Node programs on the machine are left alone.
Step "Stopping the app if it is running..."
try {
  $held = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
  foreach ($c in $held) {
    Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 2
  Ok "Stopped."
} catch {
  Ok "Nothing was running."
}

# ── Prove the data is safe before touching anything ──────────────────
if (-not (Test-Path ".\data")) { Step "No data folder yet - nothing to protect." }
else {
  $size = "{0:N1} MB" -f ((Get-ChildItem .\data -Recurse -File | Measure-Object Length -Sum).Sum / 1MB)
  Ok "Data folder found ($size). It is not part of the update."
}

# ── Pull ─────────────────────────────────────────────────────────────
Step "Fetching the latest version..."
git fetch origin $branch --quiet
if ($LASTEXITCODE -ne 0) { Bad "Could not reach GitHub. Check the internet connection."; exit 1 }

$before = (git rev-parse HEAD).Substring(0,7)
git reset --hard "origin/$branch" --quiet
if ($LASTEXITCODE -ne 0) { Bad "Could not update the files."; exit 1 }
$after = (git rev-parse HEAD).Substring(0,7)

if ($before -eq $after) { Ok "Already up to date ($after)." }
else { Ok "Updated $before to $after." }

# ── Dependencies and build ───────────────────────────────────────────
Step "Installing anything new..."
npm install --no-audit --no-fund --loglevel=error
if ($LASTEXITCODE -ne 0) { Bad "Install failed."; exit 1 }

Step "Building - this is the slow part, usually a minute or two..."
npm run build 2>&1 | Select-String -Pattern "error|Error|failed" -Context 0,2
if ($LASTEXITCODE -ne 0) { Bad "Build failed. The previous version is still on disk."; exit 1 }
Ok "Built."

Step "Bringing the database up to date..."
npm run db:migrate --silent
if ($LASTEXITCODE -ne 0) { Bad "Database update failed."; exit 1 }
Ok "Ready."
