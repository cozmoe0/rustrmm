# Lists installed programs from the machine-wide uninstall keys (64- and 32-bit), optionally
# filtered by name.
$filter = "$env:NameContains".Trim()
$keys = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
$apps = Get-ItemProperty -Path $keys -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -and -not $_.SystemComponent -and -not $_.ParentKeyName } |
    Where-Object { -not $filter -or $_.DisplayName -like "*$filter*" } |
    Sort-Object DisplayName, DisplayVersion -Unique
"$(@($apps).Count) program(s)" + $(if ($filter) { " matching '$filter'" } else { '' }) + ':'
$apps | ForEach-Object {
    $date = $_.InstallDate
    if ($date -match '^\d{8}$') { $date = '{0}-{1}-{2}' -f $date.Substring(0, 4), $date.Substring(4, 2), $date.Substring(6, 2) }
    "  {0} {1} | {2} | {3}" -f $_.DisplayName, $_.DisplayVersion, $_.Publisher, $date
}
