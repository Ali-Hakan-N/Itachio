# Registers the collector as a daily Windows Task Scheduler job that runs without a window.
#   powershell -ExecutionPolicy Bypass -File scripts\schedule-windows.ps1            # daily at 10:00
#   powershell -ExecutionPolicy Bypass -File scripts\schedule-windows.ps1 -At 08:30
#   powershell -ExecutionPolicy Bypass -File scripts\schedule-windows.ps1 -Status    # is it running?
#   powershell -ExecutionPolicy Bypass -File scripts\schedule-windows.ps1 -Start     # start now
#   powershell -ExecutionPolicy Bypass -File scripts\schedule-windows.ps1 -Stop      # stop, saving what it has
#   powershell -ExecutionPolicy Bypass -File scripts\schedule-windows.ps1 -Remove
#
# If the computer is off at that time, the job runs when it starts. A run lasts up to
# ~23 hours (until the development key expires); the next day's run starts with the
# new key. If a run is still going, the next start is skipped. If it crashes (e.g. no
# internet), it is restarted after 10 minutes, up to 3 times.
# Output goes to logs\collect.log; to watch it live:
#   Get-Content logs\collect.log -Wait

param(
  [string]$At = '10:00',
  [switch]$Remove,
  [switch]$Status,
  [switch]$Start,
  [switch]$Stop
)

$TaskName = 'Flex Drafter Collector'
$Dir = Split-Path -Parent $PSScriptRoot
$StopFile = Join-Path $Dir 'data\stop'

function Get-Collector {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'src[\\/]run\.js' -and $_.CommandLine -notmatch 'dry-run' }
}

if ($Remove) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed: $TaskName"
  return
}
if ($Status) {
  $running = @(Get-Collector)
  $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
  Write-Host ("Collector: " + $(if ($running.Count) { "running (since $($running[0].CreationDate))" } else { 'not running' }))
  if ($info) { Write-Host "Last start: $($info.LastRunTime)  Next start: $($info.NextRunTime)" }
  return
}
if ($Start) {
  Start-ScheduledTask -TaskName $TaskName
  Write-Host "Started. Log: $Dir\logs\collect.log"
  return
}
if ($Stop) {
  if (-not @(Get-Collector).Count) { Write-Host 'Collector is not running.'; return }
  # The collector checks for this file and stops cleanly: it scores and saves first
  New-Item -ItemType Directory -Force (Split-Path $StopFile) | Out-Null
  Set-Content -Path $StopFile -Value (Get-Date -Format o)
  Write-Host 'Asked the collector to stop. It saves what it has and exits within a few minutes.'
  return
}

if (-not (Test-Path (Join-Path $Dir '.env'))) { throw ".env not found: $Dir\.env (copy it from .env.example)" }
New-Item -ItemType Directory -Force (Join-Path $Dir 'logs') | Out-Null

# Hidden PowerShell starts node directly; the collector writes its own log
$Run = "Set-Location -LiteralPath '$Dir'; node --env-file=.env src/run.js --log logs\collect.log"
$Action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command `"$Run`""
$Trigger = New-ScheduledTaskTrigger -Daily -At $At
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 23 -Minutes 55) `
  -MultipleInstances IgnoreNew -RunOnlyIfNetworkAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 10)

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Force | Out-Null
Write-Host "Registered '$TaskName' daily at $At, without a window. Log: $Dir\logs\collect.log"
