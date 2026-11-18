# Shows uptime, the last boot and the reasons recorded for recent shutdowns and restarts.
$os = Get-CimInstance Win32_OperatingSystem
$uptime = (Get-Date) - $os.LastBootUpTime
"Last boot: {0:yyyy-MM-dd HH:mm} (up {1} days {2} hours {3} minutes)" -f $os.LastBootUpTime, $uptime.Days, $uptime.Hours, $uptime.Minutes
""
"Recent shutdown and restart events:"
Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = 1074, 6008, 41 } -MaxEvents 10 -ErrorAction SilentlyContinue |
    ForEach-Object {
        $text = switch ($_.Id) {
            1074 { "{0} requested by {1}: {2}" -f $_.Properties[4].Value, $_.Properties[6].Value, $_.Properties[2].Value }
            6008 { 'Unexpected shutdown (the previous shutdown was not clean)' }
            41 { 'The system restarted without shutting down cleanly (power loss or crash)' }
        }
        "  {0:yyyy-MM-dd HH:mm}  {1}" -f $_.TimeCreated, $text
    }
