# Reports free space on every fixed drive and records the lowest value in the device custom
# fields "disk_free_gb" and "disk_free_pct" (when those fields exist and allow script writes).
$drives = Get-CimInstance Win32_LogicalDisk -Filter 'DriveType = 3'
if (-not $drives) { "No fixed drives found."; exit 1 }
$lowestGb = $null
$lowestPct = $null
foreach ($d in $drives | Sort-Object DeviceID) {
    if (-not $d.Size) { continue }
    $freeGb = [math]::Round($d.FreeSpace / 1GB, 1)
    $pct = [math]::Round($d.FreeSpace / $d.Size * 100, 1)
    "{0}  {1,8:N1} GB free of {2,8:N1} GB  ({3,5:N1}% free)  {4}" -f $d.DeviceID, $freeGb, ($d.Size / 1GB), $pct, $d.VolumeName
    if ($null -eq $lowestPct -or $pct -lt $lowestPct) { $lowestPct = $pct; $lowestGb = $freeGb }
}
$culture = [System.Globalization.CultureInfo]::InvariantCulture
"::rustrmm::set-field disk_free_gb=$($lowestGb.ToString($culture))"
"::rustrmm::set-field disk_free_pct=$($lowestPct.ToString($culture))"
