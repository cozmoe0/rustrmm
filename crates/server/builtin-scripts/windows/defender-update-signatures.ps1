# Updates Microsoft Defender security intelligence and reports its age before and after.
$before = Get-MpComputerStatus -ErrorAction Stop
"Before: version {0}, {1:N1} days old." -f $before.AntivirusSignatureVersion, $before.AntivirusSignatureAge
try {
    Update-MpSignature -ErrorAction Stop
} catch {
    "Online update failed ($($_.Exception.Message)); trying the Microsoft Malware Protection Center source."
    Update-MpSignature -UpdateSource MMPC -ErrorAction Stop
}
$after = Get-MpComputerStatus
"After:  version {0}, last updated {1}." -f $after.AntivirusSignatureVersion, $after.AntivirusSignatureLastUpdated
if ($after.AntivirusSignatureAge -gt 3) {
    "Signatures are still more than three days old."
    exit 1
}
