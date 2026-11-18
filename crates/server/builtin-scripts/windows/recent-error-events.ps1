# Summarises critical and error events from the System and Application logs, grouped by source
# and event id, with the most recent message of each group.
$hours = 24
if ($env:Hours) { $hours = [int]$env:Hours }
$top = 25
if ($env:Top) { $top = [int]$env:Top }
$since = (Get-Date).AddHours(-$hours)

$events = foreach ($log in 'System', 'Application') {
    Get-WinEvent -FilterHashtable @{ LogName = $log; Level = 1, 2; StartTime = $since } -ErrorAction SilentlyContinue
}
$events = @($events)
"$($events.Count) critical/error events in the last $hours hours."
if ($events.Count -eq 0) { exit 0 }

$events | Group-Object { "$($_.LogName)|$($_.ProviderName)|$($_.Id)" } |
    Sort-Object Count -Descending |
    Select-Object -First $top |
    ForEach-Object {
        $latest = $_.Group | Sort-Object TimeCreated -Descending | Select-Object -First 1
        $message = ("$($latest.Message)" -split "`r?`n")[0]
        if ($message.Length -gt 160) { $message = $message.Substring(0, 160) + '...' }
        "[{0}x] {1} / {2} ({3}) last {4:yyyy-MM-dd HH:mm}: {5}" -f $_.Count, $latest.LogName, $latest.ProviderName, $latest.Id, $latest.TimeCreated, $message
    }
