# Resets Winsock and the TCP/IP stack, flushes DNS and renews DHCP leases. Network connectivity
# drops briefly, and the reset completes after the next restart.
$netsh = Join-Path $env:SystemRoot 'System32\netsh.exe'
$ipconfig = Join-Path $env:SystemRoot 'System32\ipconfig.exe'

& $netsh winsock reset | ForEach-Object { $_.ToString().Trim() } | Where-Object { $_ }
& $netsh int ip reset | ForEach-Object { $_.ToString().Trim() } | Where-Object { $_ } | Select-Object -Last 3
& $netsh int ipv6 reset | Out-Null
& $ipconfig /flushdns | Out-Null
"DNS cache flushed."
& $ipconfig /release | Out-Null
& $ipconfig /renew | Out-Null
"DHCP leases renewed."
Get-NetIPConfiguration -ErrorAction SilentlyContinue |
    Where-Object { $_.IPv4Address } |
    ForEach-Object { "{0}: {1} gateway {2}" -f $_.InterfaceAlias, ($_.IPv4Address.IPAddress -join ', '), ($_.IPv4DefaultGateway.NextHop -join ', ') }
"Restart the computer to finish the Winsock and TCP/IP reset."
