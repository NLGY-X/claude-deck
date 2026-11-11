# Runs the deck bridge at every login, hidden, via server/service.ps1.
#   npm run install:task      register and start it now
#   npm run uninstall:task    stop it and remove the task
#
# ASCII only: PowerShell 5.1 reads a BOM-less .ps1 as ANSI.
param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$name = 'Claude Deck'
$repo = Split-Path -Parent $PSScriptRoot

# Only this repo's copies: another project may have a server\bridge.ts too.
$bridgeRe = [regex]::Escape((Join-Path $PSScriptRoot 'bridge.ts')) -replace '\\\\', '[\\/]'
$serviceRe = [regex]::Escape((Join-Path $PSScriptRoot 'service.ps1')) -replace '\\\\', '[\\/]'

function Stop-Bridge {
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -match $bridgeRe } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force; "stopped bridge (pid $($_.ProcessId))" }
  Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" |
    Where-Object { $_.CommandLine -match $serviceRe } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force; "stopped service loop (pid $($_.ProcessId))" }
}

if ($Remove) {
  if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
    "removed scheduled task '$name'"
  } else { "no scheduled task '$name' to remove" }
  Stop-Bridge
  exit 0
}

$node = (Get-Command node -ErrorAction Stop).Source
$service = Join-Path $PSScriptRoot 'service.ps1'
# conhost --headless: -WindowStyle Hidden alone still opens a Windows Terminal
# window that takes focus.
$action = New-ScheduledTaskAction -Execute 'conhost.exe' `
  -Argument "--headless powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$service`" -Node `"$node`"" `
  -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
# A 30 s delay keeps it out of the logon rush (a task started in it can be
# killed with 0xC000013A and never restarted), and re-firing every 10 minutes
# brings it back if it dies: while the service is alive, IgnoreNew makes each
# re-fire a no-op.
$trigger.Delay = 'PT30S'
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Minutes 10)).Repetition
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings `
  -Description 'Claude Deck bridge for the desk tablet (server/service.ps1). Remove with: npm run uninstall:task' -Force | Out-Null
"registered scheduled task '$name' (runs at login)"

# A copy started by hand holds the port; replace it with the service.
Stop-Bridge
Start-ScheduledTask -TaskName $name
"started. Log: $env:USERPROFILE\.claude-deck\deck.log   Status: npm run status"
