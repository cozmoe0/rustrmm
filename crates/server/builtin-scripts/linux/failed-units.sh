#!/bin/bash
# Lists failed systemd units with the last log lines of each. Exit code 1 when any unit failed.
set -u
if ! command -v systemctl >/dev/null 2>&1; then
    echo "systemd is not in use on this system."
    exit 0
fi
failed=$(systemctl list-units --state=failed --no-legend --plain 2>/dev/null | awk '{print $1}')
if [ -z "$failed" ]; then
    echo "No failed units. System state: $(systemctl is-system-running 2>/dev/null)"
    exit 0
fi
echo "Failed units:"
for unit in $failed; do
    echo
    echo "== $unit: $(systemctl show -p Description --value "$unit")"
    systemctl show -p Result -p ExecMainStatus -p ActiveEnterTimestamp "$unit" | sed 's/^/   /'
    journalctl -u "$unit" -n 5 --no-pager -o short-iso 2>/dev/null | sed 's/^/   /'
done
exit 1
