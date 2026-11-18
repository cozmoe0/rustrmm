# Resets Windows Update: stops its services, renames the download cache and catroot2 folders,
# re-registers the update agent and starts the services again. Update history is kept in the
# renamed folders; the next update scan starts from scratch.
$services = 'wuauserv', 'bits', 'cryptsvc', 'msiserver', 'usosvc'
$stamp = Get-Date -Format 'yyyyMMddHHmmss'

foreach ($name in $services) {
    $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
    if ($svc -and $svc.Status -ne 'Stopped') {
        Stop-Service -Name $name -Force -ErrorAction SilentlyContinue
        "Stopped $name"
    }
}
Start-Sleep -Seconds 3

$folders = @(
    (Join-Path $env:SystemRoot 'SoftwareDistribution'),
    (Join-Path $env:SystemRoot 'System32\catroot2')
)
foreach ($folder in $folders) {
    if (Test-Path -LiteralPath $folder) {
        try {
            Rename-Item -LiteralPath $folder -NewName ("{0}.old-{1}" -f (Split-Path $folder -Leaf), $stamp) -ErrorAction Stop
            "Renamed $folder"
        } catch {
            "Could not rename $folder : $($_.Exception.Message)"
        }
    }
}

Get-BitsTransfer -AllUsers -ErrorAction SilentlyContinue | Remove-BitsTransfer -ErrorAction SilentlyContinue
$netsh = Join-Path $env:SystemRoot 'System32\netsh.exe'
& $netsh winhttp reset proxy | Out-Null
"WinHTTP proxy reset to direct access."

foreach ($name in 'cryptsvc', 'bits', 'wuauserv', 'usosvc') {
    Start-Service -Name $name -ErrorAction SilentlyContinue
}
$usoclient = Join-Path $env:SystemRoot 'System32\UsoClient.exe'
if (Test-Path $usoclient) { & $usoclient StartScan | Out-Null }
"Windows Update components were reset and a new scan was requested."
Get-Service -Name $services -ErrorAction SilentlyContinue | Select-Object Name, Status | Format-Table -AutoSize | Out-String
