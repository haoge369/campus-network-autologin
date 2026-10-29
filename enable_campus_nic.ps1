# Enable the campus physical NIC when the user disabled it either way:
#   1) "Network Connections"  -> right click -> Disable   (Enable-NetAdapter)
#   2) "Device Manager"       -> right click -> Disable device
#      (status "This device is disabled. (Code 22)", needs Enable-PnpDevice)
#   3) adapter uninstalled    -> rescan PnP so Windows reinstalls the driver
#
# Called by nic_ctl.js. Must run elevated, otherwise the enable calls fail with
# "Access is denied". The scheduled tasks run with Highest privileges, manual
# runs should go through run_now.vbs / run.bat ("run as administrator").
#
# Output is ASCII only, one KEY=VALUE pair per line, so the caller never depends
# on the Windows display language:
#   RESULT=already|enabled|notfound|error|diag
#   ADAPTER_B64=<base64(UTF-8) adapter name>
#   METHOD=none|pnp|netadapter|pnp+netadapter|rescan
#   STATUS=<status before the call>
#   STATUS_AFTER=<status after enabling>
#   PNP_STATUS / PNP_PROBLEM
#   ADAPTER_HINT_B64=<base64(UTF-8) matched description>
#   MESSAGE_B64=<base64(UTF-8) error message when RESULT=error>
#   DIAG_B64=<only with -Diag: base64(UTF-8) multi-line dump>
#
# Why base64: when this script runs without a console (started by wscript or by
# node with CREATE_NO_WINDOW) PowerShell encodes stdout with the OEM code page,
# which would garble non-ASCII adapter names such as the Chinese "Ethernet".
param(
    [string]$MatchHint = 'Realtek PCIe 2.5GbE',
    [switch]$Diag,
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'

function Write-KeyValue([string]$Key, [string]$Value) {
    if ($null -eq $Value) { $Value = '' }
    Write-Output ($Key + '=' + $Value)
}

function Write-TextValue([string]$Key, [string]$Value) {
    if ($null -eq $Value) { $Value = '' }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes([string]$Value)
    Write-KeyValue ($Key + '_B64') ([System.Convert]::ToBase64String($bytes))
}

function Get-MatchingAdapters {
    return @(Get-NetAdapter -IncludeHidden -ErrorAction SilentlyContinue | Where-Object {
        ($_.InterfaceDescription -like ('*' + $MatchHint + '*')) -or ($_.Name -eq $MatchHint)
    })
}

function Get-MatchingPnpDevices {
    return @(Get-PnpDevice -Class Net -ErrorAction SilentlyContinue | Where-Object {
        ($_.FriendlyName -like ('*' + $MatchHint + '*')) -or ($_.InstanceId -like ('*' + $MatchHint + '*'))
    })
}

function Get-AdapterByName([string]$Name) {
    if (-not $Name) { return $null }
    return Get-NetAdapter -Name $Name -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
# Diagnostic dump (node nic_ctl.js --diag)
# ---------------------------------------------------------------------------
if ($Diag) {
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.AppendLine('=== NetAdapter (IncludeHidden) ===')
    foreach ($a in @(Get-NetAdapter -IncludeHidden -ErrorAction SilentlyContinue)) {
        [void]$sb.AppendLine(('{0} | status={1} | admin={2} | ifIndex={3} | hidden={4} | {5}' -f `
            $a.Name, $a.Status, $a.AdminStatus, $a.ifIndex, $a.Hidden, $a.InterfaceDescription))
    }
    [void]$sb.AppendLine('=== PnP (class Net) ===')
    foreach ($d in @(Get-PnpDevice -Class Net -ErrorAction SilentlyContinue)) {
        [void]$sb.AppendLine(('{0} | problem={1} | present={2} | {3} | {4}' -f `
            $d.Status, $d.Problem, $d.Present, $d.FriendlyName, $d.InstanceId))
    }
    [void]$sb.AppendLine('=== IPv4 addresses ===')
    foreach ($ip in @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue)) {
        [void]$sb.AppendLine(('{0} | {1}/{2} | origin={3} | state={4}' -f `
            $ip.InterfaceAlias, $ip.IPAddress, $ip.PrefixLength, $ip.PrefixOrigin, $ip.AddressState))
    }
    Write-KeyValue 'RESULT' 'diag'
    Write-TextValue 'DIAG' $sb.ToString()
    exit 0
}

# ---------------------------------------------------------------------------
# Normal path
# ---------------------------------------------------------------------------
try {
    $adapters = Get-MatchingAdapters
    $pnp = Get-MatchingPnpDevices
    $adapter = $adapters | Select-Object -First 1
    $presentPnp = @($pnp | Where-Object { $_.Present })
    $pnpTarget = $presentPnp | Where-Object {
        ($_.Problem -eq 'CM_PROB_DISABLED') -or ($_.Status -eq 'Error')
    } | Select-Object -First 1

    $adapterName = ''
    $hintDescription = ''
    if ($adapter) {
        $adapterName = $adapter.Name
        $hintDescription = $adapter.InterfaceDescription
    } elseif ($presentPnp.Count -gt 0) {
        $hintDescription = ($presentPnp | Select-Object -First 1).FriendlyName
    }

    $instanceId = ''
    if ($pnpTarget) {
        $instanceId = $pnpTarget.InstanceId
    } elseif ($presentPnp.Count -gt 0) {
        $instanceId = ($presentPnp | Select-Object -First 1).InstanceId
    }

    $statusBefore = ''
    if ($adapter) { $statusBefore = [string]$adapter.Status }
    elseif ($pnpTarget) { $statusBefore = [string]$pnpTarget.Status }

    # Nothing present: the adapter may have been uninstalled in Device Manager.
    # A rescan makes Windows reinstall the driver automatically.
    if (-not $adapter -and $presentPnp.Count -eq 0) {
        if ($pnp.Count -gt 0) {
            try { & pnputil.exe /scan-devices | Out-Null } catch { }
            $deadline = (Get-Date).AddSeconds(20)
            do {
                Start-Sleep -Milliseconds 500
                $adapters = Get-MatchingAdapters
                $adapter = $adapters | Select-Object -First 1
            } while (-not $adapter -and (Get-Date) -lt $deadline)

            if ($adapter) {
                Write-TextValue 'ADAPTER' $adapter.Name
                Write-KeyValue 'STATUS' 'uninstalled'
                Write-KeyValue 'STATUS_AFTER' ([string]$adapter.Status)
                Write-KeyValue 'METHOD' 'rescan'
                Write-KeyValue 'RESULT' 'enabled'
                exit 0
            }
        }

        Write-KeyValue 'RESULT' 'notfound'
        exit 0
    }

    $disabledByPnp = $pnpTarget -ne $null
    $disabledByAdapter = ($adapter -ne $null) -and (
        ($adapter.Status -eq 'Disabled') -or ($adapter.AdminStatus -eq 'Down')
    )

    # -CheckOnly: only report the state, never modify anything. campus_login.js
    # uses this to decide whether an automatic run may re-enable the adapter
    # (for example: the user disabled it on purpose after a successful login).
    if ($CheckOnly) {
        Write-TextValue 'ADAPTER' $adapterName
        Write-TextValue 'ADAPTER_HINT' $hintDescription
        Write-KeyValue 'STATUS' $statusBefore
        if ($pnpTarget) { Write-KeyValue 'PNP_PROBLEM' ([string]$pnpTarget.Problem) }
        Write-KeyValue 'METHOD' 'checkonly'
        if ($disabledByPnp -or $disabledByAdapter) {
            Write-KeyValue 'RESULT' 'disabled'
        } else {
            Write-KeyValue 'RESULT' 'enabled'
        }
        exit 0
    }

    if (-not $disabledByPnp -and -not $disabledByAdapter) {
        Write-TextValue 'ADAPTER' $adapterName
        Write-TextValue 'ADAPTER_HINT' $hintDescription
        Write-KeyValue 'STATUS' $statusBefore
        Write-KeyValue 'METHOD' 'none'
        Write-KeyValue 'RESULT' 'already'
        exit 0
    }

    $methods = @()

    # 1) Device Manager style disable: the PnP device itself is stopped.
    if ($disabledByPnp) {
        Enable-PnpDevice -InstanceId $instanceId -Confirm:$false -ErrorAction Stop
        $methods += 'pnp'

        $deadline = (Get-Date).AddSeconds(15)
        do {
            Start-Sleep -Milliseconds 400
            $p = Get-PnpDevice -InstanceId $instanceId -ErrorAction SilentlyContinue
        } while ($p -and $p.Problem -ne 'CM_PROB_NONE' -and (Get-Date) -lt $deadline)
    }

    # 2) "Network Connections" style disable (AdminStatus Down).
    $adapter = Get-AdapterByName $adapterName
    if (-not $adapter) {
        $adapters = Get-MatchingAdapters
        $adapter = $adapters | Select-Object -First 1
        if ($adapter) { $adapterName = $adapter.Name }
    }

    if ($adapter -and (($adapter.Status -eq 'Disabled') -or ($adapter.AdminStatus -eq 'Down'))) {
        Enable-NetAdapter -Name $adapter.Name -Confirm:$false -ErrorAction Stop
        $methods += 'netadapter'
    }

    # Wait until the adapter leaves the Disabled state. The IP address itself is
    # polled later by nic_ctl.js / campus_login.js because DHCP needs seconds.
    $deadline = (Get-Date).AddSeconds(20)
    $after = $statusBefore
    do {
        Start-Sleep -Milliseconds 400
        $now = Get-AdapterByName $adapterName
        if ($now) {
            $after = [string]$now.Status
            if ($after -ne 'Disabled' -and $now.AdminStatus -eq 'Up') { break }
        }
    } while ((Get-Date) -lt $deadline)

    Write-TextValue 'ADAPTER' $adapterName
    Write-TextValue 'ADAPTER_HINT' $hintDescription
    Write-KeyValue 'STATUS' $statusBefore
    Write-KeyValue 'STATUS_AFTER' $after
    Write-TextValue 'METHOD' ($methods -join '+')
    if ($pnpTarget) {
        Write-KeyValue 'PNP_STATUS' ([string]$pnpTarget.Status)
        Write-KeyValue 'PNP_PROBLEM' ([string]$pnpTarget.Problem)
    }
    Write-KeyValue 'RESULT' 'enabled'
    exit 0
}
catch {
    Write-KeyValue 'RESULT' 'error'
    Write-TextValue 'MESSAGE' $($_.Exception.Message)
    exit 0
}
