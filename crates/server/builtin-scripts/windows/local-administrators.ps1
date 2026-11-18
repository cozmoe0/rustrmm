# Lists the members of the local Administrators group (found by its well-known SID, so it works
# on every display language), including domain and Entra ID entries.
$group = Get-LocalGroup -SID 'S-1-5-32-544'
"Members of $($group.Name):"
try {
    Get-LocalGroupMember -Group $group -ErrorAction Stop |
        Sort-Object ObjectClass, Name |
        ForEach-Object { "  {0,-10} {1,-12} {2}" -f $_.ObjectClass, $_.PrincipalSource, $_.Name }
} catch {
    # Get-LocalGroupMember fails on orphaned SIDs; fall back to ADSI.
    $adsi = [ADSI]"WinNT://$env:COMPUTERNAME/$($group.Name),group"
    $adsi.psbase.Invoke('Members') | ForEach-Object {
        "  " + $_.GetType().InvokeMember('AdsPath', 'GetProperty', $null, $_, $null).Replace('WinNT://', '')
    }
}
