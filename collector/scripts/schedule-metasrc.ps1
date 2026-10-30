# Registers the MetaSRC collector as a daily Windows Task Scheduler job that runs without a window.
#   powershell -ExecutionPolicy Bypass -File scripts\schedule-metasrc.ps1            # daily at 04:00
#   powershell -ExecutionPolicy Bypass -File scripts\schedule-metasrc.ps1 -At 05:00
#   powershell -ExecutionPolicy Bypass -File scripts\schedule-metasrc.ps1 -Status    # is it running?
#   powershell -ExecutionPolicy Bypass -File scripts\schedule-metasrc.ps1 -Start     # start now
#   powershell -ExecutionPolicy Bypass -File scripts\schedule-metasrc.ps1 -Remove
#
# Output goes to logs\metasrc.log; to watch it live:
#   Get-Content logs\metasrc.log -Wait

param(
  [string]$At = '04:00',
  [switch]$Remove,
  [switch]$Status,
  [switch]$Start
)

$TaskName = 'Itachio MetaSRC Scraper'
$Dir = Split-Path -Parent $PSScriptRoot

function Get-MetaCollector {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'src[\\/]run\.js' -and $_.CommandLine -match 'metasrc' }
}

if ($Remove) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed: $TaskName"
  return
}
if ($Status) {
  $running = @(Get-MetaCollector)
  $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
  Write-Host ("MetaSRC Scraper: " + $(if ($running.Count) { "running (since $($running[0].CreationDate))" } else { 'not running' }))
  if ($info) { Write-Host "Last start: $($info.LastRunTime)  Next start: $($info.NextRunTime)" }
  return
}
if ($Start) {
  Start-ScheduledTask -TaskName $TaskName
  Write-Host "Started. Log: $Dir\logs\metasrc.log"
  return
}

if (-not (Test-Path (Join-Path $Dir '.env'))) { throw ".env not found: $Dir\.env" }
New-Item -ItemType Directory -Force (Join-Path $Dir 'logs') | Out-Null

$Node = (Get-Command node -ErrorAction Stop).Source
$Action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\conhost.exe" `
  -Argument "--headless `"$Node`" --env-file=.env src\run.js --source metasrc --log logs\metasrc.log" -WorkingDirectory $Dir
$Trigger = New-ScheduledTaskTrigger -Daily -At $At
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
  -MultipleInstances IgnoreNew -RunOnlyIfNetworkAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 10)

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Force | Out-Null
Write-Host "Registered '$TaskName' daily at $At, without a window. Log: $Dir\logs\metasrc.log"

