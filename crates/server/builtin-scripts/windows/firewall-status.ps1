# Shows the state of each Windows Firewall profile and the inbound rules that allow traffic from
# any address. Exit code 1 when a profile is switched off.
$off = 0
Get-NetFirewallProfile | ForEach-Object {
    "{0,-8} enabled: {1,-5} inbound: {2,-13} outbound: {3}" -f $_.Name, $_.Enabled, $_.DefaultInboundAction, $_.DefaultOutboundAction
    if (-not $_.Enabled) { $off++ }
}
""
"Enabled inbound allow rules open to any remote address (first 30):"
Get-NetFirewallRule -Direction Inbound -Action Allow -Enabled True -ErrorAction SilentlyContinue |
    Where-Object { ($_ | Get-NetFirewallAddressFilter).RemoteAddress -contains 'Any' } |
    Select-Object -First 30 |
    ForEach-Object {
        $port = ($_ | Get-NetFirewallPortFilter)
        "  {0} [{1} {2}] profile {3}" -f $_.DisplayName, $port.Protocol, ($port.LocalPort -join ','), $_.Profile
    }
if ($off -gt 0) { "$off firewall profile(s) are disabled."; exit 1 }
