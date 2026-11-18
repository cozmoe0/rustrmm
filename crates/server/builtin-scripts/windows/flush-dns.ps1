# Clears the DNS client cache and re-registers the computer's DNS records.
$before = @(Get-DnsClientCache -ErrorAction SilentlyContinue).Count
Clear-DnsClientCache
"DNS client cache cleared ($before entries removed)."
try {
    Register-DnsClient -ErrorAction Stop
    "DNS registration refreshed."
} catch {
    "DNS registration could not be refreshed: $($_.Exception.Message)"
}
