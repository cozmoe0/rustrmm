# Asks the Windows Update agent for applicable updates that are not installed yet.
# Exit code 1 when updates are pending.
$session = New-Object -ComObject Microsoft.Update.Session
$searcher = $session.CreateUpdateSearcher()
try {
    $result = $searcher.Search("IsInstalled=0 and IsHidden=0")
} catch {
    "Update search failed: $($_.Exception.Message)"
    exit 2
}
$count = $result.Updates.Count
if ($count -eq 0) { "No pending updates."; exit 0 }
"$count pending update(s):"
for ($i = 0; $i -lt $count; $i++) {
    $u = $result.Updates.Item($i)
    $kb = ($u.KBArticleIDs | ForEach-Object { "KB$_" }) -join ','
    $severity = if ($u.MsrcSeverity) { $u.MsrcSeverity } else { '-' }
    $size = [math]::Round($u.MaxDownloadSize / 1MB, 1)
    "  [{0,-9}] {1} {2} ({3} MB){4}" -f $severity, $kb, $u.Title, $size, $(if ($u.RebootRequired) { ' - restart required' } else { '' })
}
exit 1
