# Lists BitLocker protection, encryption progress and key protector types for every volume.
# Exit code 1 when the operating system volume is not protected.
$volumes = Get-BitLockerVolume -ErrorAction Stop
$volumes | Sort-Object MountPoint | ForEach-Object {
    $protectors = ($_.KeyProtector | ForEach-Object { $_.KeyProtectorType }) -join ', '
    if (-not $protectors) { $protectors = 'none' }
    "{0,-6} {1,-16} protection {2,-4} {3,5}% encrypted  method {4}  protectors: {5}" -f `
        $_.MountPoint, $_.VolumeType, $_.ProtectionStatus, $_.EncryptionPercentage, $_.EncryptionMethod, $protectors
}
$os = $volumes | Where-Object { $_.VolumeType -eq 'OperatingSystem' }
if (-not $os -or $os.ProtectionStatus -ne 'On') {
    "The operating system volume is NOT protected by BitLocker."
    exit 1
}
"The operating system volume is protected."
