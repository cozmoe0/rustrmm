# Reports whether Windows is waiting for a restart and why. Exit code 1 means a restart is pending.
$reasons = @()
if (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending') {
    $reasons += 'Component servicing (Windows features or updates)'
}
if (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired') {
    $reasons += 'Windows Update'
}
$session = Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager' -ErrorAction SilentlyContinue
if ($session.PendingFileRenameOperations) {
    $reasons += 'Pending file rename operations'
}
$active = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\ComputerName\ActiveComputerName').ComputerName
$pending = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\ComputerName\ComputerName').ComputerName
if ($active -ne $pending) {
    $reasons += "Computer rename ($active -> $pending)"
}
try {
    $ccm = Invoke-CimMethod -Namespace 'root\ccm\ClientSDK' -ClassName CCM_ClientUtilities -MethodName DetermineIfRebootPending -ErrorAction Stop
    if ($ccm.RebootPending -or $ccm.IsHardRebootPending) { $reasons += 'Configuration Manager client' }
} catch {
    # No Configuration Manager client on this computer.
}

$boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
"Last boot: $($boot.ToString('yyyy-MM-dd HH:mm'))"
if ($reasons.Count -eq 0) {
    "No restart is pending."
    exit 0
}
"A restart is pending:"
$reasons | ForEach-Object { "  - $_" }
exit 1
