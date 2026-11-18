#!/bin/bash
# Shrinks the systemd journal to a maximum size and age.
set -u
max_size="${MaxSize:-500M}"
max_age="${MaxAgeDays:-30}"
case "$max_size" in
    *[!0-9KMGkmg]* | "") echo "MaxSize must look like 500M or 2G."; exit 2 ;;
esac
case "$max_age" in
    *[!0-9]* | "") echo "MaxAgeDays must be a whole number."; exit 2 ;;
esac
if ! command -v journalctl >/dev/null 2>&1; then
    echo "This system does not use the systemd journal."
    exit 0
fi
echo "Before: $(journalctl --disk-usage 2>/dev/null)"
journalctl --rotate >/dev/null 2>&1
journalctl --vacuum-size="$max_size" --vacuum-time="${max_age}d" 2>&1 | tail -n 3
echo "After:  $(journalctl --disk-usage 2>/dev/null)"
