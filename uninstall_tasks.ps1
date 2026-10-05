# Campus Network Auto Login Task Uninstall Script
$tasks = @("CampusLogin_AutoStartup", "CampusLogin_Daily0610")

foreach ($t in $tasks) {
    try {
        Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction Stop
        Write-Host "[OK] Removed Task: $t" -ForegroundColor Green
    } catch {
        Write-Host "[-] Task not found or already removed: $t" -ForegroundColor Gray
    }
}
Write-Host "`nUninstall complete." -ForegroundColor Cyan
