#!/bin/sh
# Lists the largest files under a directory on the same file system (default: /).
set -u
path="${SearchPath:-/}"
min_mb="${MinSizeMB:-500}"
top="${Top:-25}"
case "$min_mb$top" in
    *[!0-9]*) echo "MinSizeMB and Top must be whole numbers."; exit 2 ;;
esac
if [ ! -d "$path" ]; then
    echo "Directory '$path' does not exist."
    exit 2
fi
echo "Largest files under $path (at least $min_mb MB):"
# -xdev stays on one file system; sizes are in kilobytes.
find "$path" -xdev -type f -size +"$((min_mb * 1024))"k -exec du -k {} + 2>/dev/null |
    sort -rn | head -n "$top" |
    awk '{ size=$1; $1=""; sub(/^ /, ""); printf "%10.0f MB  %s\n", size / 1024, $0 }'
