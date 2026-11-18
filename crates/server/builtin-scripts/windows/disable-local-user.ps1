# Disables a local user account so it can no longer sign in, and signs out its sessions.
# The account and its profile are kept and can be enabled again.
$name = "$env:AccountName".Trim()
if (-not $name) { "AccountName is required."; exit 2 }
$user = Get-LocalUser -Name $name -ErrorAction SilentlyContinue
if (-not $user) { "No local account named '$name'."; exit 1 }
if ($user.SID.Value -match '-500$') { "Refusing to disable the built-in Administrator account from a script."; exit 2 }

$admins = Get-LocalGroupMember -SID 'S-1-5-32-544' -ErrorAction SilentlyContinue |
    Where-Object { $_.PrincipalSource -eq 'Local' -and $_.ObjectClass -eq 'User' }
$enabledAdmins = @($admins | ForEach-Object { Get-LocalUser -SID $_.SID -ErrorAction SilentlyContinue } | Where-Object { $_.Enabled })
if ($enabledAdmins.Count -eq 1 -and $enabledAdmins[0].SID -eq $user.SID) {
    "Refusing to disable the last enabled local administrator."
    exit 2
}

if (-not $user.Enabled) { "$name is already disabled."; exit 0 }
Disable-LocalUser -Name $name -ErrorAction Stop
"Disabled local account $name."

$quser = Join-Path $env:SystemRoot 'System32\quser.exe'
$logoff = Join-Path $env:SystemRoot 'System32\logoff.exe'
& $quser 2>$null | Select-Object -Skip 1 | ForEach-Object {
    $fields = ($_.Trim() -replace '^>', '') -split '\s+'
    if ($fields[0] -ieq $name) {
        $id = $fields | Where-Object { $_ -match '^\d+$' } | Select-Object -First 1
        if ($id) { & $logoff $id; "Signed out session $id." }
    }
}
