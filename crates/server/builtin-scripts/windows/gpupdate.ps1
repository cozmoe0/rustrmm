# Re-applies computer Group Policy and reports whether the machine is joined to a domain.
$system = Get-CimInstance Win32_ComputerSystem
if (-not $system.PartOfDomain) {
    "This computer is not joined to a domain; only local policy will be refreshed."
}
$gpupdate = Join-Path $env:SystemRoot 'System32\gpupdate.exe'
$output = & $gpupdate /target:computer /force /wait:300 2>&1
$output | ForEach-Object { $_.ToString().Trim() } | Where-Object { $_ }
if ($LASTEXITCODE -ne 0) {
    "gpupdate finished with exit code $LASTEXITCODE."
    exit $LASTEXITCODE
}
"Group Policy refreshed at $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')."
