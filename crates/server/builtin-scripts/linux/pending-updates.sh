#!/bin/bash
# Lists packages with available updates (security updates first where the package manager can
# tell). Exit code 1 when updates are pending.
set -u
count=0
if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq >/dev/null 2>&1
    list=$(apt list --upgradable 2>/dev/null | grep -v '^Listing')
    security=$(printf '%s\n' "$list" | grep -c -- '-security' || true)
    count=$(printf '%s\n' "$list" | grep -c . || true)
    echo "$count upgradable package(s), $security from security repositories."
    printf '%s\n' "$list" | sed 's/^/  /'
elif command -v dnf >/dev/null 2>&1; then
    echo "Security updates:"
    dnf -q updateinfo list --security 2>/dev/null | sed 's/^/  /'
    list=$(dnf -q check-update 2>/dev/null | awk 'NF==3')
    count=$(printf '%s\n' "$list" | grep -c . || true)
    echo "$count package(s) can be updated:"
    printf '%s\n' "$list" | sed 's/^/  /'
elif command -v zypper >/dev/null 2>&1; then
    zypper --non-interactive refresh >/dev/null 2>&1
    list=$(zypper --non-interactive list-updates 2>/dev/null | awk -F'|' 'NR>4 && NF>4 {print $3 " " $5}')
    count=$(printf '%s\n' "$list" | grep -c . || true)
    echo "$count package(s) can be updated:"
    printf '%s\n' "$list" | sed 's/^/  /'
    zypper --non-interactive list-patches --category security 2>/dev/null | tail -n +5 | sed 's/^/  /'
else
    echo "No supported package manager found."
    exit 2
fi
[ -f /var/run/reboot-required ] && echo "A restart is required to finish earlier updates."
[ "$count" -gt 0 ] && exit 1
exit 0
