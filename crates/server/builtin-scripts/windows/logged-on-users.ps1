# Shows interactive and remote desktop sessions with their state and idle time.
$quser = Join-Path $env:SystemRoot 'System32\quser.exe'
$output = & $quser 2>&1
if ($LASTEXITCODE -ne 0 -or -not $output) {
    "Nobody is signed in."
    exit 0
}
$output | ForEach-Object { $_.ToString() }
$console = (Get-CimInstance Win32_ComputerSystem).UserName
if ($console) { "Console user: $console" }
