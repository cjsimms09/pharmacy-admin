<#
  Find the tables PioneerRx keeps a dispensing in, so a report can be written against them.

  Needs nothing installed. Windows already carries what this uses, so there is no Python, no
  pip, no SQL tools and no download. It finds the SQL Server on this machine by itself, finds
  the PioneerRx database by itself, and asks it what its tables are called.

  It reads INFORMATION_SCHEMA and nothing else: table and column NAMES only. No patient data is
  opened, nothing is written, no lock is taken, and the connection is read-only. The file it
  produces is safe to send on, because it contains no values of any kind.

  Just double-click "Find the PioneerRx tables.cmd". Or from PowerShell, in the app folder:
      powershell -ExecutionPolicy Bypass -File scripts\pioneer-discover.ps1
#>
[CmdletBinding()]
param(
  [string]$Server,
  [string]$Database,
  [string]$User,
  [string]$Password,
  [string]$Out = "pioneer-schema.json"
)

$ErrorActionPreference = "Stop"

function Connect-Sql([string]$srv, [string]$db) {
  $auth = if ($User) { "User ID=$User;Password=$Password;" } else { "Integrated Security=SSPI;" }
  $cs = "Server=$srv;Database=$db;$auth" + "Connect Timeout=10;TrustServerCertificate=True;ApplicationIntent=ReadOnly;"
  $cn = New-Object System.Data.SqlClient.SqlConnection $cs
  $cn.Open()
  return $cn
}

function Read-Rows($cn, [string]$sql) {
  $cmd = $cn.CreateCommand()
  $cmd.CommandText = $sql
  $cmd.CommandTimeout = 60
  $rd = $cmd.ExecuteReader()
  $rows = @()
  while ($rd.Read()) {
    $o = [ordered]@{}
    for ($i = 0; $i -lt $rd.FieldCount; $i++) { $o[$rd.GetName($i)] = $rd.GetValue($i) }
    $rows += [pscustomobject]$o
  }
  $rd.Close()
  return $rows
}

# ── Is anything even listening, and will it let us in ───────────────────────
$candidates = @()
if ($Server) {
  # An address on its own means the default instance; also try the usual named ones.
  $candidates += $Server
  if ($Server -notmatch '\\') { $candidates += @("$Server\PIONEERRX", "$Server\SQLEXPRESS", "$Server\PIONEER") }
} else {
  Write-Host "Looking for a SQL Server on this computer..."
  foreach ($svc in Get-Service | Where-Object { $_.Name -like "MSSQL*" -and $_.Status -eq "Running" }) {
    if ($svc.Name -eq "MSSQLSERVER") { $candidates += "localhost" }
    elseif ($svc.Name -like "MSSQL`$*") { $candidates += "localhost\" + $svc.Name.Substring(6) }
  }
  $candidates += @("localhost", "localhost\PIONEERRX", "localhost\SQLEXPRESS", ".\PIONEERRX")
}

# Reaching the machine at all is a different problem from being let in, and they need
# different things from support, so they are told apart before anything is tried.
$hostOnly = ($candidates[0] -split '\\')[0]
if ($hostOnly -notin @("localhost", ".")) {
  Write-Host "Can this computer reach $hostOnly on the SQL port?"
  $reach = Test-NetConnection -ComputerName $hostOnly -Port 1433 -WarningAction SilentlyContinue
  if ($reach.TcpTestSucceeded) { Write-Host "  yes - port 1433 is open" -ForegroundColor Green }
  else {
    Write-Host "  no - nothing is listening on 1433, or a firewall is in the way" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  Tell PioneerRx support: the pharmacy computer cannot reach $hostOnly on TCP 1433."
    Write-Host "  Ask them to enable TCP/IP for the instance and allow 1433 from this computer,"
    Write-Host "  or to give you the port the instance actually listens on."
    Write-Host "  (A named instance on a non-standard port is common and is not a refusal.)"
  }
}

$cn = $null; $server = $null; $whyNot = @()
foreach ($c in ($candidates | Select-Object -Unique)) {
  try { $cn = Connect-Sql $c "master"; $server = $c; Write-Host "  connected to $c" -ForegroundColor Green; break }
  catch {
    $m = $_.Exception.Message
    $whyNot += "$c : $m"
    if ($m -match "Login failed") { Write-Host "  $c - the server answered but refused the login" -ForegroundColor Yellow }
    elseif ($m -match "not allow remote|network-related|not accessible") { Write-Host "  $c - no answer" }
    else { Write-Host "  $c - $($m.Split([Environment]::NewLine)[0])" }
  }
}
if (-not $cn) {
  Write-Host ""
  $refused = $whyNot | Where-Object { $_ -match "Login failed" }
  if ($refused) {
    Write-Host "The server is there and running. It refused the login." -ForegroundColor Yellow
    Write-Host "That is the answer we needed: the route works, we just need an account."
    Write-Host ""
    Write-Host "Send PioneerRx support the request in docs\reference\pioneerrx-support-request.md"
    Write-Host "and tell them the server is $hostOnly. Ask for a db_datareader login."
    Write-Host "When they give you one, run this again with:"
    Write-Host "    -Server $($candidates[0]) -User THELOGIN -Password THEPASSWORD"
  } else {
    Write-Host "Nothing answered as SQL Server at $hostOnly." -ForegroundColor Yellow
    Write-Host "Most likely TCP/IP is off for the instance, or it is on another port,"
    Write-Host "or the Windows firewall on that server is blocking this computer."
  }
  Write-Host ""
  Write-Host "Details, for the support ticket:"
  $whyNot | Select-Object -First 4 | ForEach-Object { Write-Host "  $_" }
  exit 1
}

# ── Which database, if nobody said ──────────────────────────────────────────
if (-not $Database) {
  $dbs = Read-Rows $cn "select name from sys.databases where database_id > 4 order by name"
  Write-Host "Databases on it: $(($dbs.name) -join ', ')"
  $Database = ($dbs | Where-Object { $_.name -match "pioneer|pharm|rx" } | Select-Object -First 1).name
  if (-not $Database) { $Database = ($dbs | Select-Object -First 1).name }
  Write-Host "  reading $Database"
}
$cn.Close()
$cn = Connect-Sql $server $Database

# ── The catalogue of names, and only the names ──────────────────────────────
$cols = Read-Rows $cn @"
select TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE
from INFORMATION_SCHEMA.COLUMNS
order by TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION
"@
$cn.Close()

$words = @("rx","prescription","fill","dispens","claim","adjudicat","transmit","third","party","plan",
           "payer","payor","remit","reimburs","basis","copay","ndc","drug","item","product",
           "inventory","cost","acquisition","price","awp","wac","nadac","mac","gcn")

$tables = @{}
foreach ($c in $cols) {
  $k = "$($c.TABLE_SCHEMA).$($c.TABLE_NAME)"
  if (-not $tables.ContainsKey($k)) { $tables[$k] = @() }
  $tables[$k] += [pscustomobject]@{ column = $c.COLUMN_NAME; type = $c.DATA_TYPE }
}
$kept = @{}
foreach ($k in $tables.Keys) {
  $hay = ($k + " " + (($tables[$k].column) -join " ")).ToLower()
  foreach ($w in $words) { if ($hay.Contains($w)) { $kept[$k] = $tables[$k]; break } }
}

$out = [ordered]@{
  takenAt           = (Get-Date).ToString("s")
  server            = $server
  database          = $Database
  tablesInDatabase  = $tables.Count
  tablesKept        = $kept.Count
  note              = "Column names only. No row was read and nothing was written."
  tables            = $kept
}
$out | ConvertTo-Json -Depth 6 | Set-Content -Path $Out -Encoding UTF8

Write-Host ""
Write-Host "$($tables.Count) tables in $Database; $($kept.Count) look relevant." -ForegroundColor Green
Write-Host "Written to $((Resolve-Path $Out).Path)"
Write-Host "Send that file back - it holds column names only, no patient data."
