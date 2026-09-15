<#
  Find out where PioneerRx keeps its database.

  The last script looked for a SQL Server on this computer and found none, which means the
  database is somewhere else: another machine in the pharmacy, or RedSail's cloud. Rather than
  ask the owner to know a server name, this asks the things that already know.

  Three places are looked at, in order of how definite the answer is:

    1. PioneerRx's own configuration files. The application on this machine has to know where its
       database is, so it says so somewhere in its install folder.
    2. SQL Servers that answer a broadcast on the local network.
    3. Whether PioneerRx looks hosted — a client talking to RedSail rather than to a server here.

  Passwords are removed before anything is written. Nothing is connected to and nothing is
  changed; this only reads configuration on this computer.

  Double-click "Find where PioneerRx lives.cmd".
#>
[CmdletBinding()]
param([string]$Out = "pioneer-location.json")

$ErrorActionPreference = "Continue"
$found = @()

function Hide-Secrets([string]$s) {
  if (-not $s) { return $s }
  # Never write a password into a file that gets sent on.
  $s = [regex]::Replace($s, '(?i)(password|pwd)\s*=\s*[^;"'']*', '$1=***REMOVED***')
  return $s.Trim()
}

Write-Host "1. Looking at what PioneerRx itself is configured with..."
$roots = @(
  "$env:ProgramFiles\PioneerRx", "${env:ProgramFiles(x86)}\PioneerRx",
  "$env:ProgramData\PioneerRx", "$env:LOCALAPPDATA\PioneerRx", "$env:APPDATA\PioneerRx",
  "$env:ProgramFiles\RedSail", "${env:ProgramFiles(x86)}\RedSail", "$env:ProgramData\RedSail"
) | Where-Object { Test-Path $_ }

# If it is installed somewhere unusual, find it from the shortcut or the running process.
if (-not $roots) {
  $proc = Get-Process | Where-Object { $_.ProcessName -match "pioneer|redsail" } | Select-Object -First 1
  if ($proc -and $proc.Path) { $roots = @(Split-Path $proc.Path -Parent) }
}
Write-Host "   folders: $(if ($roots) { $roots -join '; ' } else { 'none found' })"

foreach ($root in $roots) {
  Get-ChildItem -Path $root -Recurse -ErrorAction SilentlyContinue `
      -Include *.config,*.xml,*.ini,*.json -File |
    Select-Object -First 400 | ForEach-Object {
      try { $text = Get-Content $_.FullName -Raw -ErrorAction Stop } catch { return }
      foreach ($m in [regex]::Matches($text, '(?i)(data source|server|address|addr|network address)\s*=\s*[^;"''<>]{2,120}')) {
        $found += [pscustomobject]@{ where = "config"; file = $_.FullName; text = Hide-Secrets $m.Value }
      }
    }
}

Write-Host "2. Asking the network which SQL Servers answer..."
$onNetwork = @()
try {
  $t = [System.Data.Sql.SqlDataSourceEnumerator]::Instance.GetDataSources()
  foreach ($r in $t) {
    $name = if ($r.InstanceName) { "$($r.ServerName)\$($r.InstanceName)" } else { $r.ServerName }
    $onNetwork += $name
    Write-Host "   $name"
  }
} catch { Write-Host "   the broadcast did not answer" }
if (-not $onNetwork) { Write-Host "   none answered (many servers are configured not to)" }

Write-Host "3. Checking whether PioneerRx looks hosted..."
$hosted = $null
$running = Get-Process | Where-Object { $_.ProcessName -match "pioneer|redsail|rdpclip|mstsc" } | Select-Object -Expand ProcessName -Unique
if ($running -contains "mstsc" -or $running -contains "rdpclip") {
  $hosted = "This looks like a remote desktop session, so PioneerRx may be running on somebody else's server."
}
Write-Host "   processes: $(if ($running) { $running -join ', ' } else { 'PioneerRx does not appear to be running' })"

$out = [ordered]@{
  takenAt      = (Get-Date).ToString("s")
  computer     = $env:COMPUTERNAME
  installFound = @($roots)
  processes    = @($running)
  sqlOnNetwork = @($onNetwork)
  hostedHint   = $hosted
  connectionStrings = @($found | Select-Object -Unique -First 60)
  note = "Passwords are stripped. Nothing was connected to and nothing was changed."
}
$out | ConvertTo-Json -Depth 5 | Set-Content -Path $Out -Encoding UTF8

Write-Host ""
Write-Host "Written to $((Resolve-Path $Out).Path)" -ForegroundColor Green
Write-Host "Send that file back. Passwords have been removed from it."
