# Registers the collector as a daily Windows Task Scheduler job.
#   powershell -ExecutionPolicy Bypass -File scripts\schedule-windows.ps1            # at 10:00
#   powershell -ExecutionPolicy Bypass -File scripts\schedule-windows.ps1 -At 08:30
#   powershell -ExecutionPolicy Bypass -File scripts\schedule-windows.ps1 -Remove
# If the computer is off at that time, the job runs when it starts. Output is appended to logs\collect.log.
# A run lasts up to ~23 hours (until the development key expires); the next day's
# run starts with the new key. If a run is still going, the next start is skipped.

param(
  [string]$At = '10:00',
  [switch]$Remove
)

$TaskName = 'Flex Drafter Collector'

if ($Remove) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed: $TaskName"
  return
}

$Dir = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $Dir '.env'))) { throw ".env not found: $Dir\.env (copy it from .env.example)" }
New-Item -ItemType Directory -Force (Join-Path $Dir 'logs') | Out-Null

$Command = "cd /d `"$Dir`" && npm run collect >> logs\collect.log 2>&1"
$Action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c $Command"
$Trigger = New-ScheduledTaskTrigger -Daily -At $At
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 23 -Minutes 55) `
  -MultipleInstances IgnoreNew -RunOnlyIfNetworkAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Force | Out-Null
Write-Host "Registered '$TaskName' daily at $At. Log: $Dir\logs\collect.log"
