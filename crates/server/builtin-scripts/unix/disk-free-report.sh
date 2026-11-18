#!/bin/sh
# Reports free space on local file systems and records the lowest value in the device custom
# fields "disk_free_gb" and "disk_free_pct" (when those fields exist and allow script writes).
set -u
report=$(df -Pk -l 2>/dev/null | awk 'NR>1 && $2 > 0 && $1 !~ /^(tmpfs|devtmpfs|overlay|squashfs|map|devfs|none|udev)/ && $6 !~ /^\/(dev|run|proc|sys|snap)|^\/System\/Volumes\/(VM|Preboot|Update|xarts|iSCPreboot|Hardware)/ {
    free_gb = $4 / 1048576; pct = $4 / $2 * 100
    printf "%-28s %8.1f GB free of %8.1f GB (%5.1f%% free)\n", $6, free_gb, $2 / 1048576, pct
    if (min == "" || pct < min) { min = pct; min_gb = free_gb }
} END { if (min != "") printf "LOWEST %.1f %.1f\n", min_gb, min }')
if [ -z "$report" ]; then
    echo "No local file systems found."
    exit 1
fi
printf '%s\n' "$report" | grep -v '^LOWEST'
lowest=$(printf '%s\n' "$report" | awk '/^LOWEST/ { print $2 " " $3 }')
set -- $lowest
echo "::rustrmm::set-field disk_free_gb=$1"
echo "::rustrmm::set-field disk_free_pct=$2"
