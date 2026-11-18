# Lists TCP ports in the listening state and UDP endpoints, with the owning process.
$names = @{}
Get-Process | ForEach-Object { $names[$_.Id] = $_.ProcessName }

"TCP listeners:"
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Sort-Object LocalPort, LocalAddress -Unique |
    ForEach-Object {
        "  {0,-40} {1,6}  {2} (PID {3})" -f $_.LocalAddress, $_.LocalPort, $names[[int]$_.OwningProcess], $_.OwningProcess
    }
""
"UDP endpoints:"
Get-NetUDPEndpoint -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -notmatch '^(::1|127\.)' } |
    Sort-Object LocalPort, LocalAddress -Unique |
    ForEach-Object {
        "  {0,-40} {1,6}  {2} (PID {3})" -f $_.LocalAddress, $_.LocalPort, $names[[int]$_.OwningProcess], $_.OwningProcess
    }
