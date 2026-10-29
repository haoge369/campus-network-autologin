# Campus Network Auto Login Task Setup Script
# Registers two scheduled tasks (both run elevated, no visible window):
#   CampusLogin_AutoStartup : at logon (+15s), on network profile change (+30s)
#   CampusLogin_Daily0610    : every day at 06:10 (wake the computer)
# Requires administrator rights.
$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbsPath = Join-Path $scriptDir "run_silent.vbs"
$wscriptExe = "C:\Windows\System32\wscript.exe"

Write-Host ">>> Configuring Windows Scheduled Tasks for Campus Login..." -ForegroundColor Cyan
Write-Host "Target: $vbsPath"

$action = New-ScheduledTaskAction -Execute $wscriptExe -Argument "`"$vbsPath`"" -WorkingDirectory $scriptDir
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest

# 1. Logon Trigger Task (Startup), with a 5-minute retry window after logon
$taskNameStartup = "CampusLogin_AutoStartup"

$triggerLogon = New-ScheduledTaskTrigger -AtLogOn
$triggerLogon.Delay = "PT15S"

# After logon the NIC / DHCP may still be coming up. Retry every 5 minutes for
# up to 2 hours; the login script is idempotent and exits in ~0.1s when online.
$repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 5) `
    -RepetitionDuration (New-TimeSpan -Hours 2)).Repetition
$triggerLogon.Repetition = $repetition

# RestartCount/RestartInterval: retry failed runs 3 times, 5 minutes apart.
# MultipleInstances IgnoreNew: never run two instances in parallel (the script
# also has its own lock file).
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 5) `
    -MultipleInstances IgnoreNew

Unregister-ScheduledTask -TaskName $taskNameStartup -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $taskNameStartup `
    -Action $action `
    -Trigger $triggerLogon `
    -Settings $settings `
    -Principal $principal `
    -Description "Campus Network Auto Login on Startup (retry every 5 min for 2h after logon)" | Out-Null
Write-Host "[OK] Registered Startup Task: $taskNameStartup (logon +15s, retry every 5min)" -ForegroundColor Green

# 2. Daily 06:10 Task
$taskNameDaily = "CampusLogin_Daily0610"
$triggerDaily = New-ScheduledTaskTrigger -Daily -At "06:10"

$settingsDaily = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -WakeToRun `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
    -RestartCount 2 `
    -RestartInterval (New-TimeSpan -Minutes 5) `
    -MultipleInstances IgnoreNew

Unregister-ScheduledTask -TaskName $taskNameDaily -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $taskNameDaily `
    -Action $action `
    -Trigger $triggerDaily `
    -Settings $settingsDaily `
    -Principal $principal `
    -Description "Campus Network Auto Login Daily at 06:10" | Out-Null
Write-Host "[OK] Registered Daily Task: $taskNameDaily (Every day at 06:10 AM)" -ForegroundColor Green

Write-Host "`n>>> All scheduled tasks registered successfully!" -ForegroundColor Cyan
