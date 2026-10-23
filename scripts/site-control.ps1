# The one script behind "Update the site.cmd" and "Start Pharmacy Admin.cmd".
#
# There used to be five files for this (Start, Update, Restart, Stop the old site, and update.ps1), and
# using two of them in a row started a second launcher that fought the first for port 3000. This script
# looks before it acts: it never starts a launcher while one is running, it never stops the launcher
# itself, and it never resets the working copy (the launcher fast-forwards to what GitHub holds, which
# cannot erase a commit that is only here).
#
#   -Action Start    open the site, starting it first if nothing is running
#   -Action Update   install the newest version and restart; the site is down while it rebuilds
#   -DryRun          say what would be done and do none of it
param(
  [ValidateSet("Update", "Start")] [string]$Action = "Update",
  [switch]$OnlyIfNewer,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location -Path $root
$port = 3000
$url = "http://localhost:$port"

function Say($text) { Write-Host "  $text" }

function Get-NodeProcesses { @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'") }

# Whatever is listening on the port: the site, or the launcher's own page while it builds.
function Get-Holders {
  @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
}

# The launcher is the long-lived node process that keeps the site alive and does the rebuilds. Windows shows an
# empty command line for one started hidden, so the command line alone can miss it: it is also the parent of
# whatever node process is holding the port (scripts/deploy.mjs finds it the same way).
function Get-Launchers {
  $nodes = Get-NodeProcesses
  $ids = @($nodes | Where-Object { $_.CommandLine -like "*launch.mjs*" } | ForEach-Object { $_.ProcessId })
  foreach ($h in (Get-Holders)) {
    $holder = $nodes | Where-Object { $_.ProcessId -eq $h }
    if ($holder -and ($nodes.ProcessId -contains $holder.ParentProcessId) -and ($ids -notcontains $holder.ParentProcessId)) {
      $ids += $holder.ParentProcessId
    }
  }
  @($ids | Sort-Object -Unique)
}

# The site itself, as opposed to the launcher: the node process whose parent is another node process.
function Test-IsSite([int]$procId, $launcherIds) {
  if ($launcherIds -contains $procId) { return $false }
  $nodes = Get-NodeProcesses
  $p = $nodes | Where-Object { $_.ProcessId -eq $procId }
  if (-not $p) { return $false }
  if ($p.CommandLine -like "*next*") { return $true }
  return [bool]($nodes.ProcessId -contains $p.ParentProcessId)
}

function Open-Site {
  if ($DryRun) { Say "[dry run] would open $url"; return }
  Start-Process $url
}

function Start-Launcher {
  if ($DryRun) { Say "[dry run] would start the launcher in the background"; return }
  Start-Process -FilePath "wscript.exe" -ArgumentList ('"' + (Join-Path $PSScriptRoot "start-hidden.vbs") + '"')
}

# Wait for the port to answer, up to the given seconds. True if it did.
function Wait-ForPort([int]$seconds) {
  $until = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $until) {
    if ((Get-Holders).Count -gt 0) { return $true }
    Start-Sleep -Seconds 3
  }
  return $false
}

$launchers = @(Get-Launchers)
$holders = @(Get-Holders)
$listening = if ($holders.Count) { $holders -join ", " } else { "nothing" }
$running = if ($launchers.Count) { $launchers -join ", " } else { "none" }
Say "Launcher: $running.  Listening on port ${port}: $listening."

if ($Action -eq "Start") {
  if ($holders.Count -gt 0) {
    Say "Pharmacy Admin is already running. Opening it."
    Open-Site
    exit 0
  }
  if ($launchers.Count -gt 0) {
    Say "Pharmacy Admin is already starting up. Opening the address; if it shows a page saying what it is doing, give it a few minutes."
    Open-Site
    exit 0
  }
  Say "Starting Pharmacy Admin in the background..."
  Start-Launcher
  if ($DryRun) { exit 0 }
  if (Wait-ForPort 180) { Say "It is answering. Opening it."; Open-Site } else { Say "It has not answered yet. Open $url in a few minutes." }
  exit 0
}

# ── Update ───────────────────────────────────────────────────────────
if ($OnlyIfNewer) {
  # What is built is recorded in .next\source-stamp as "<commit>:<lockfile time>"; what is waiting is what GitHub holds.
  $branch = (git rev-parse --abbrev-ref HEAD).Trim()
  git fetch origin $branch 2>$null
  $head = (git rev-parse HEAD).Trim()
  $remoteHead = (git rev-parse "origin/$branch").Trim()
  $stampFile = Join-Path $root ".next\source-stamp"
  $built = if (Test-Path $stampFile) { ((Get-Content $stampFile -Raw) -split ":")[0].Trim() } else { "" }
  if ($head -eq $remoteHead -and $built -eq $head) {
    Say "Nothing new is waiting: the site is already running $($head.Substring(0, 8))."
    exit 0
  }
  Say "Something new is waiting. Updating."
}

Say "Your data is never touched by an update: it lives in the data folder, which is not part of the code."

# The request the launcher looks for when the site stops. It is also how the site's own "Install and restart" button asks.
$flag = Join-Path $root "data\.update-requested"
if ($DryRun) { Say "[dry run] would write $flag" }
else {
  New-Item -ItemType Directory -Force -Path (Join-Path $root "data") | Out-Null
  Set-Content -Path $flag -Value "requested by Update the site.cmd"
}

if ($launchers.Count -eq 0) {
  # Nothing is there to take the update, so take it here and let the new launcher build what it finds.
  Say "No launcher is running, so this takes the newest version itself."
  $branch = (git rev-parse --abbrev-ref HEAD).Trim()
  if ($DryRun) { Say "[dry run] would run: git fetch origin $branch, then git merge --ff-only origin/$branch" }
  else {
    git fetch origin $branch
    if ($LASTEXITCODE -ne 0) { Say "Could not reach GitHub. It will build what is already here." }
    else {
      git merge --ff-only "origin/$branch"
      if ($LASTEXITCODE -ne 0) { Say "The newest version could not be taken cleanly, so nothing was changed. Take a picture of this window." }
    }
  }
}

# The running site is stopped; the launcher that keeps it alive sees the request and installs the update.
foreach ($h in $holders) {
  if (-not (Test-IsSite $h $launchers)) {
    Say "Process $h is holding the port but is not the site itself (it looks like the launcher), so it is left running."
    continue
  }
  if ($DryRun) { Say "[dry run] would stop the running site (process $h)"; continue }
  try {
    Stop-Process -Id $h -Force -ErrorAction Stop
    Say "Stopped the running site (process $h)."
  } catch {
    Say "Windows would not let this stop process ${h}: $($_.Exception.Message)"
    Say "Right-click this file and choose Run as administrator, then try again."
    exit 1
  }
}

if ($launchers.Count -eq 0) { Start-Launcher }

Say ""
Say "Done. The site is now installing the update and restarting."
Say "It is down for about 10 to 25 minutes. Open $url then; until it is ready that address"
Say "shows a page saying what it is doing, or nothing for the first half minute."
Say "Then press Ctrl+Shift+R in any browser tab that was open before, so it loads the new version."
