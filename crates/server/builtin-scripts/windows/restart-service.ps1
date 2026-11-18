# Restarts one Windows service (and services that depend on it) and waits until it runs.
$name = "$env:ServiceName".Trim()
if (-not $name) { "ServiceName is required."; exit 2 }
$service = Get-Service -Name $name -ErrorAction SilentlyContinue
if (-not $service) { $service = Get-Service -DisplayName $name -ErrorAction SilentlyContinue }
if (-not $service) { "No service named '$name' exists on this computer."; exit 1 }
if ($service.StartType -eq 'Disabled') { "$($service.DisplayName) is disabled; not restarting it."; exit 1 }

"Restarting $($service.DisplayName) ($($service.Name)), currently $($service.Status)."
try {
    Restart-Service -InputObject $service -Force -ErrorAction Stop
    $service.WaitForStatus('Running', (New-TimeSpan -Seconds 60))
} catch {
    "Restart failed: $($_.Exception.Message)"
    exit 1
}
$service.Refresh()
"$($service.DisplayName) is $($service.Status)."
