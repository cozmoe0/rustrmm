# Removes temporary files older than a number of days from the Windows temp folder and every
# user profile's temp folder. Files in use are skipped.
$days = 7
if ($env:OlderThanDays) { $days = [int]$env:OlderThanDays }
$cutoff = (Get-Date).AddDays(-$days)

$folders = @("$env:SystemRoot\Temp")
Get-ChildItem -Path "$env:SystemDrive\Users" -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    $folders += Join-Path $_.FullName 'AppData\Local\Temp'
}

$totalFiles = 0
$totalBytes = 0
foreach ($folder in $folders) {
    if (-not (Test-Path -LiteralPath $folder)) { continue }
    $files = Get-ChildItem -LiteralPath $folder -Recurse -File -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -lt $cutoff }
    $removed = 0
    $bytes = 0
    foreach ($file in $files) {
        try {
            $size = $file.Length
            Remove-Item -LiteralPath $file.FullName -Force -ErrorAction Stop
            $removed++
            $bytes += $size
        } catch {
            # In use or protected: leave it.
        }
    }
    # Remove folders left empty.
    Get-ChildItem -LiteralPath $folder -Recurse -Directory -Force -ErrorAction SilentlyContinue |
        Sort-Object { $_.FullName.Length } -Descending |
        Where-Object { -not (Get-ChildItem -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue) } |
        Remove-Item -Force -ErrorAction SilentlyContinue
    if ($removed -gt 0) {
        "{0}: removed {1} files ({2:N1} MB)" -f $folder, $removed, ($bytes / 1MB)
    }
    $totalFiles += $removed
    $totalBytes += $bytes
}
"Removed {0} files older than {1} days, freeing {2:N1} MB." -f $totalFiles, $days, ($totalBytes / 1MB)
