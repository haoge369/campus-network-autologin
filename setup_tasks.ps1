# Campus Network Auto Login Task Setup Script
# Registers two scheduled tasks (both run elevated, no visible window):
#   CampusLogin_AutoStartup : once at logon (+15s). The script itself enforces
#                             "one auto run per boot" (--auto), so Windows only
#                             logs in automatically one time after each boot.
#                             No 5-minute repetition any more: after the first
#                             run the user may disable the NIC and it must stay
#                             disabled.
#   CampusLogin_Daily0610    : every day at 06:10 (wake the computer)
# Requires administrator rights.
$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbsPath = Join-Path $scriptDir "run_silent.vbs"
$wscriptExe = "C:\Windows\System32\wscript.exe"

Write-Host ">>> Configuring Windows Scheduled Tasks for Campus Login..." -ForegroundColor Cyan
Write-Host "Target: $vbsPath"

$action = New-ScheduledTaskAction -Execute $wscriptExe -Argument "`"$vbsPath`"" -WorkingDirectory $scriptDir
# The daily task must still run even if the logon task already ran this boot,
# so run_silent.vbs gets --daily (ignores oncePerBoot but keeps the NIC guard).
$actionDaily = New-ScheduledTaskAction -Execute $wscriptExe -Argument "`"$vbsPath`" --daily" -WorkingDirectory $scriptDir
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest

# 1. Logon Trigger Task: one auto login per boot, 15s after the user signs in.
$taskNameStartup = "CampusLogin_AutoStartup"

$triggerLogon = New-ScheduledTaskTrigger -AtLogOn
$triggerLogon.Delay = "PT15S"

# ExecutionTimeLimit is generous because the script may wait up to 60s for DHCP
# (and retry internally). MultipleInstances IgnoreNew prevents overlapping runs;
# the script also has its own lock file.
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -MultipleInstances IgnoreNew

Unregister-ScheduledTask -TaskName $taskNameStartup -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $taskNameStartup `
    -Action $action `
    -Trigger $triggerLogon `
    -Settings $settings `
    -Principal $principal `
    -Description "Campus Network Auto Login once per boot (logon +15s, one auto run only)" | Out-Null
Write-Host "[OK] Registered Startup Task: $taskNameStartup (logon +15s, one run per boot)" -ForegroundColor Green

# 2. Daily 06:10 Task
$taskNameDaily = "CampusLogin_Daily0610"
$triggerDaily = New-ScheduledTaskTrigger -Daily -At "06:10"

$settingsDaily = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -WakeToRun `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -MultipleInstances IgnoreNew

Unregister-ScheduledTask -TaskName $taskNameDaily -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $taskNameDaily `
    -Action $actionDaily `
    -Trigger $triggerDaily `
    -Settings $settingsDaily `
    -Principal $principal `
    -Description "Campus Network Auto Login Daily at 06:10" | Out-Null
Write-Host "[OK] Registered Daily Task: $taskNameDaily (Every day at 06:10 AM)" -ForegroundColor Green

Write-Host "`n>>> All scheduled tasks registered successfully!" -ForegroundColor Cyan
