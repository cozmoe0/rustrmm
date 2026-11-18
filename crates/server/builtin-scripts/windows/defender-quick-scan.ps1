# Updates Microsoft Defender signatures, then runs a quick scan and reports any detections.
$status = Get-MpComputerStatus -ErrorAction Stop
if (-not $status.AntivirusEnabled) {
    "Microsoft Defender Antivirus is not active on this computer (another product may be in use)."
    exit 1
}
try {
    Update-MpSignature -ErrorAction Stop
    "Signatures updated."
} catch {
    "Signature update failed, scanning with the current signatures: $($_.Exception.Message)"
}
$started = Get-Date
Start-MpScan -ScanType QuickScan -ErrorAction Stop
$elapsed = (Get-Date) - $started
"Quick scan finished in {0:N0} seconds." -f $elapsed.TotalSeconds

$recent = @(Get-MpThreatDetection -ErrorAction SilentlyContinue | Where-Object { $_.InitialDetectionTime -ge $started })
if ($recent.Count -gt 0) {
    "Threats detected during this scan: $($recent.Count)"
    $recent | ForEach-Object {
        $threat = Get-MpThreat -ThreatID $_.ThreatID -ErrorAction SilentlyContinue
        "  - {0} ({1}) action: {2}" -f $threat.ThreatName, ($_.Resources -join '; '), $_.ActionSuccess
    }
    exit 1
}
$status = Get-MpComputerStatus
"No threats found. Signature version {0}, updated {1}." -f $status.AntivirusSignatureVersion, $status.AntivirusSignatureLastUpdated
