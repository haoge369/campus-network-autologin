# Encrypt the plaintext password in config.json with Windows DPAPI (CurrentUser)
# and tighten the ACL of config.json to the current user only.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\protect_password.ps1
#   powershell -ExecutionPolicy Bypass -File .\protect_password.ps1 -ConfigPath D:\path\to\config.json
#
# What it does:
#   1. Backs up the current config.json to config.json.plain.bak
#   2. Replaces "password" with "passwordEnc" (DPAPI, CurrentUser scope, base64)
#   3. Self-checks that the encrypted value decrypts back to the original
#   4. Restricts config.json ACL to the current user (read/write)
#
# Notes:
#   * DPAPI CurrentUser means only the SAME Windows user can decrypt it.
#     After a user change / OS reinstall, re-run this script.
#   * config.json.plain.bak contains the plaintext password: delete it once
#     you have verified that `node campus_login.js --status` still works, and
#     never commit or share it. (It is covered by .gitignore.)
#   * Keep this file saved as UTF-8 WITH BOM: Windows PowerShell 5.1 reads
#     BOM-less non-ASCII scripts as ANSI, which corrupts parsing.
param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot 'config.json')
)

$ErrorActionPreference = 'Stop'

# DPAPI 的 ProtectedData / DataProtectionScope 在独立程序集里，Windows PowerShell
# 5.1 默认没有加载，必须先显式载入，否则会报 "Unable to find type"。
Add-Type -AssemblyName System.Security

function Write-Step([string]$Message) {
    Write-Host "[*] $Message"
}

function Protect-ConfigAcl([string]$Path) {
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) {
        [void]$acl.RemoveAccessRule($rule)
    }
    $identity = "$($env:USERDOMAIN)\$($env:USERNAME)"
    $newRule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        $identity,
        [System.Security.AccessControl.FileSystemRights]'Read,Write',
        [System.Security.AccessControl.AccessControlType]::Allow
    )
    $acl.AddAccessRule($newRule)
    Set-Acl -LiteralPath $Path -AclObject $acl
    Write-Step "ACL restricted to $identity"
}

try {
    if (-not (Test-Path -LiteralPath $ConfigPath)) {
        throw "config.json not found: $ConfigPath"
    }

    Write-Step "Reading $ConfigPath"
    $rawText = [System.IO.File]::ReadAllText($ConfigPath, [System.Text.Encoding]::UTF8)
    $config = $rawText | ConvertFrom-Json

    if ($config.passwordEnc -and -not $config.password) {
        Write-Host '[OK] config.json already uses passwordEnc, only ACL will be checked.'
        Protect-ConfigAcl $ConfigPath
        exit 0
    }
    if (-not $config.password) {
        throw 'config.json has neither "password" nor "passwordEnc"'
    }

    $plain = [string]$config.password
    if ([string]::IsNullOrEmpty($plain)) {
        throw 'config.json "password" is empty'
    }

    $backup = "$ConfigPath.plain.bak"
    Copy-Item -LiteralPath $ConfigPath -Destination $backup -Force
    Write-Step "Backup written to $backup"

    $bytes = [System.Text.Encoding]::UTF8.GetBytes($plain)
    $protected = [System.Security.Cryptography.ProtectedData]::Protect(
        $bytes,
        $null,
        [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    $encryptedBase64 = [Convert]::ToBase64String($protected)

    # Self-check before touching the file
    $roundTrip = [System.Text.Encoding]::UTF8.GetString(
        [System.Security.Cryptography.ProtectedData]::Unprotect(
            [Convert]::FromBase64String($encryptedBase64),
            $null,
            [System.Security.Cryptography.DataProtectionScope]::CurrentUser
        )
    )
    if ($roundTrip -cne $plain) {
        throw 'DPAPI self-check failed: decrypted value does not match the original'
    }

    $config | Add-Member -NotePropertyName 'passwordEnc' -NotePropertyValue $encryptedBase64 -Force
    $config.PSObject.Properties.Remove('password')

    $json = $config | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText($ConfigPath, $json, (New-Object System.Text.UTF8Encoding($false)))
    Write-Step 'Replaced "password" with "passwordEnc"'

    Protect-ConfigAcl $ConfigPath

    Write-Host '[OK] Password encrypted with DPAPI (CurrentUser) and config.json locked down.'
    Write-Host ''
    Write-Host 'NEXT:' -ForegroundColor Yellow
    Write-Host '  1. Run:  node campus_login.js --status    (should print JSON and exit 0 when online)'
    Write-Host '  2. Run:  node campus_login.js             (regular run should still see itself online)'
    Write-Host '  3. Delete config.json.plain.bak once verified.'
    exit 0
}
catch {
    Write-Host "[ERROR] $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
