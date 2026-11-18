# Schedules a restart after a delay and warns signed-in users. Cancel it with "shutdown /a".
$minutes = 5
if ($env:DelayMinutes) { $minutes = [int]$env:DelayMinutes }
if ($minutes -lt 0 -or $minutes -gt 1440) { "DelayMinutes must be between 0 and 1440."; exit 2 }
$message = "$env:Message".Trim()
if (-not $message) { $message = "Your IT team will restart this computer in $minutes minute(s). Please save your work." }
$seconds = $minutes * 60
$shutdown = Join-Path $env:SystemRoot 'System32\shutdown.exe'
& $shutdown /r /t $seconds /c $message /d p:4:1
if ($LASTEXITCODE -ne 0) {
    "Scheduling the restart failed (exit code $LASTEXITCODE). Another shutdown may already be pending."
    exit 1
}
"Restart scheduled for {0:yyyy-MM-dd HH:mm}." -f (Get-Date).AddSeconds($seconds)
