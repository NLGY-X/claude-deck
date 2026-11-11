# Keeps the deck bridge running. Started hidden at login by the scheduled task
# that server/install.ps1 registers. Restarts the bridge if it crashes, backs off
# if it keeps crashing, and stops for good when it exits cleanly (which is
# what it does when another copy already holds the port).
#
# ASCII only: PowerShell 5.1 reads a BOM-less .ps1 as ANSI.
param([Parameter(Mandatory = $true)][string]$Node)

$repo = Split-Path -Parent $PSScriptRoot
$bridge = Join-Path $PSScriptRoot 'bridge.ts'
$dir = if ($env:CLAUDE_DECK_HOME) { $env:CLAUDE_DECK_HOME } else { Join-Path $env:USERPROFILE '.claude-deck' }
$log = Join-Path $dir 'deck.log'
New-Item -ItemType Directory -Force $dir | Out-Null
Set-Location $repo

function Say([string]$line) {
  [IO.File]::AppendAllText($log, "$(Get-Date -Format s) service: $line`r`n")
}

$crashes = @()
while ($true) {
  if ((Test-Path $log) -and (Get-Item $log).Length -gt 5MB) { Move-Item $log "$log.1" -Force }
  Say 'starting bridge'
  & cmd.exe /d /c "`"$Node`" `"$bridge`" >> `"$log`" 2>&1"
  $code = $LASTEXITCODE
  if ($code -eq 0) { Say 'bridge exited cleanly; not restarting'; break }
  $now = Get-Date
  $crashes = @($crashes + $now | Where-Object { ($now - $_).TotalSeconds -lt 120 })
  if ($crashes.Count -ge 5) {
    Say "bridge exited with $code, 5 times in 2 minutes; waiting 5 minutes before trying again"
    Start-Sleep -Seconds 300
    $crashes = @()
  } else {
    Say "bridge exited with $code; restarting in 5 seconds"
    Start-Sleep -Seconds 5
  }
}
