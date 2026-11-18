# Terminates every process with the given name (with or without .exe). Unsaved work in those
# processes is lost.
$name = "$env:ProcessName".Trim()
if (-not $name) { "ProcessName is required."; exit 2 }
$name = [System.IO.Path]::GetFileNameWithoutExtension($name)
$protected = 'System', 'Idle', 'csrss', 'wininit', 'winlogon', 'lsass', 'services', 'smss', 'rustrmm-agent'
if ($protected -contains $name) { "Refusing to terminate the protected process '$name'."; exit 2 }

$targets = @(Get-Process -Name $name -ErrorAction SilentlyContinue)
if ($targets.Count -eq 0) { "No process named '$name' is running."; exit 0 }
$failed = 0
foreach ($p in $targets) {
    try {
        Stop-Process -Id $p.Id -Force -ErrorAction Stop
        "Terminated $($p.ProcessName) (PID $($p.Id))"
    } catch {
        $failed++
        "Could not terminate PID $($p.Id): $($_.Exception.Message)"
    }
}
if ($failed -gt 0) { exit 1 }
