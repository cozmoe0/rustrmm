# Stops the Print Spooler, optionally deletes stuck jobs from the queue, and starts it again.
$clear = $true
if ($env:ClearQueue -eq 'false') { $clear = $false }
$queue = Join-Path $env:SystemRoot 'System32\spool\PRINTERS'

Stop-Service -Name Spooler -Force -ErrorAction Stop
(Get-Service -Name Spooler).WaitForStatus('Stopped', (New-TimeSpan -Seconds 30))
"Print Spooler stopped."

if ($clear) {
    $jobs = @(Get-ChildItem -LiteralPath $queue -File -ErrorAction SilentlyContinue)
    $jobs | Remove-Item -Force -ErrorAction SilentlyContinue
    "Removed $($jobs.Count) spooled file(s) from the print queue."
}

Start-Service -Name Spooler -ErrorAction Stop
(Get-Service -Name Spooler).WaitForStatus('Running', (New-TimeSpan -Seconds 30))
"Print Spooler is running again."
Get-Printer -ErrorAction SilentlyContinue | Select-Object Name, PrinterStatus, JobCount | Format-Table -AutoSize | Out-String -Width 200
