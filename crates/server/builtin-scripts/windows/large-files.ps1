# Lists the largest files under a folder (default: the system drive), skipping links and
# folders that cannot be read.
$path = "$env:SystemDrive\"
if ($env:SearchPath) { $path = $env:SearchPath }
$minMB = 500
if ($env:MinSizeMB) { $minMB = [double]$env:MinSizeMB }
$top = 25
if ($env:Top) { $top = [int]$env:Top }
if (-not (Test-Path -LiteralPath $path)) { "Path '$path' does not exist."; exit 2 }

$minBytes = $minMB * 1MB
$found = Get-ChildItem -LiteralPath $path -Recurse -File -Force -ErrorAction SilentlyContinue -Attributes !ReparsePoint |
    Where-Object { $_.Length -ge $minBytes } |
    Sort-Object Length -Descending |
    Select-Object -First $top
if (-not $found) { "No files of $minMB MB or more under $path."; exit 0 }
"Largest files under $path (at least $minMB MB):"
$found | ForEach-Object {
    "{0,10:N0} MB  {1:yyyy-MM-dd}  {2}" -f ($_.Length / 1MB), $_.LastWriteTime, $_.FullName
}
