# Campus Network Auto Login Task Setup Script
$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbsPath = Join-Path $scriptDir "run_silent.vbs"
$wscriptExe = "C:\Windows\System32\wscript.exe"

Write-Host ">>> Configuring Windows Scheduled Tasks for Campus Login..." -ForegroundColor Cyan
Write-Host "Target: $vbsPath"

# 1. Logon Trigger Task (Startup)
$taskNameStartup = "CampusLogin_AutoStartup"
$action = New-ScheduledTaskAction -Execute $wscriptExe -Argument "`"$vbsPath`"" -WorkingDirectory $scriptDir

$triggerLogon = New-ScheduledTaskTrigger -AtLogOn
$triggerLogon.Delay = "PT15S"

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest

Unregister-ScheduledTask -TaskName $taskNameStartup -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $taskNameStartup -Action $action -Trigger $triggerLogon -Settings $settings -Principal $principal -Description "Campus Network Auto Login on Startup" | Out-Null
Write-Host "[OK] Registered Startup Task: $taskNameStartup" -ForegroundColor Green

# 2. Daily 06:10 Task
$taskNameDaily = "CampusLogin_Daily0610"
$triggerDaily = New-ScheduledTaskTrigger -Daily -At "06:10"

$settingsDaily = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -WakeToRun -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

Unregister-ScheduledTask -TaskName $taskNameDaily -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $taskNameDaily -Action $action -Trigger $triggerDaily -Settings $settingsDaily -Principal $principal -Description "Campus Network Auto Login Daily at 06:10" | Out-Null
Write-Host "[OK] Registered Daily Task: $taskNameDaily (Every day at 06:10 AM)" -ForegroundColor Green

Write-Host "`n>>> All scheduled tasks registered successfully!" -ForegroundColor Cyan
