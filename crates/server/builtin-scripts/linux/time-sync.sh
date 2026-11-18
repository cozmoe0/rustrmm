#!/bin/bash
# Shows clock synchronisation status and asks the time service to step the clock now.
set -u
if command -v timedatectl >/dev/null 2>&1; then
    timedatectl status 2>/dev/null | sed 's/^ */  /'
fi
if command -v chronyc >/dev/null 2>&1; then
    echo "chrony:"
    chronyc -a makestep >/dev/null 2>&1 && echo "  clock stepped"
    chronyc tracking 2>/dev/null | grep -E '^(Reference ID|System time|Leap status)' | sed 's/^/  /'
elif systemctl is-active --quiet systemd-timesyncd 2>/dev/null; then
    echo "systemd-timesyncd:"
    systemctl restart systemd-timesyncd && echo "  restarted to force a new synchronisation"
    sleep 3
    timedatectl timesync-status 2>/dev/null | grep -E 'Server|Offset|Packet' | sed 's/^ */  /'
elif command -v ntpq >/dev/null 2>&1; then
    echo "ntpd peers:"
    ntpq -pn 2>/dev/null | sed 's/^/  /'
else
    echo "No time synchronisation service found."
    exit 1
fi
synced=$(timedatectl show -p NTPSynchronized --value 2>/dev/null || echo unknown)
echo "Synchronised: $synced"
[ "$synced" = "no" ] && exit 1
exit 0
