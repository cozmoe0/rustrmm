# Makes sure the Windows Time service runs, forces a resynchronisation and shows the offset.
$w32tm = Join-Path $env:SystemRoot 'System32\w32tm.exe'
$svc = Get-Service -Name W32Time -ErrorAction Stop
if ($svc.StartType -eq 'Disabled') {
    Set-Service -Name W32Time -StartupType Manual
    "Windows Time was disabled; set to manual start."
}
if ($svc.Status -ne 'Running') {
    Start-Service -Name W32Time
    "Started the Windows Time service."
}
& $w32tm /resync /force 2>&1 | ForEach-Object { $_.ToString().Trim() } | Where-Object { $_ }
$code = $LASTEXITCODE
& $w32tm /query /status 2>&1 | ForEach-Object { $_.ToString().Trim() } |
    Where-Object { $_ -match '^(Source|Last Successful Sync Time|Stratum|Poll Interval)' }
if ($code -ne 0) {
    "Resynchronisation failed (exit code $code)."
    exit 1
}
