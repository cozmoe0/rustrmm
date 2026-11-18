# Repairs the Windows component store with DISM, then verifies protected system files with SFC.
# Both tools can take a long time; the result of each step is summarised at the end.
$dism = Join-Path $env:SystemRoot 'System32\dism.exe'
$sfc = Join-Path $env:SystemRoot 'System32\sfc.exe'

"Step 1/2: DISM /RestoreHealth"
$dismOut = & $dism /Online /Cleanup-Image /RestoreHealth /NoRestart 2>&1
$dismCode = $LASTEXITCODE
$dismOut | ForEach-Object { $_.ToString().Trim() } | Where-Object { $_ -and $_ -notmatch '^\[=*' } | Select-Object -Last 5

"Step 2/2: SFC /scannow"
# SFC writes UTF-16 to a redirected stdout; decode it explicitly.
$previous = [Console]::OutputEncoding
[Console]::OutputEncoding = [System.Text.Encoding]::Unicode
$sfcOut = & $sfc /scannow 2>&1
$sfcCode = $LASTEXITCODE
[Console]::OutputEncoding = $previous
$sfcOut | ForEach-Object { $_.ToString().Trim() } | Where-Object { $_ -and $_ -notmatch '^Verification' } | Select-Object -Last 4

"DISM exit code: $dismCode, SFC exit code: $sfcCode"
if ($dismCode -ne 0 -or $sfcCode -ne 0) {
    "At least one repair step reported a problem; see %windir%\Logs\CBS\CBS.log."
    exit 1
}
"System files are healthy."
