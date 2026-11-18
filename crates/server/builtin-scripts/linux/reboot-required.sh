#!/bin/bash
# Reports whether a restart is needed (new kernel, core libraries or package notices).
# Exit code 1 when a restart is pending.
set -u
reasons=""
if [ -f /var/run/reboot-required ]; then
    reasons="$reasons\n  - packages request it"
    [ -f /var/run/reboot-required.pkgs ] && reasons="$reasons: $(tr '\n' ' ' < /var/run/reboot-required.pkgs)"
fi
if command -v needs-restarting >/dev/null 2>&1 && ! needs-restarting -r >/dev/null 2>&1; then
    reasons="$reasons\n  - needs-restarting reports core updates"
fi
running=$(uname -r)
newest=$(ls -1 /lib/modules 2>/dev/null | sort -V | tail -n 1)
if [ -n "$newest" ] && [ "$newest" != "$running" ]; then
    reasons="$reasons\n  - running kernel $running, newest installed $newest"
fi
echo "Up since $(uptime -s 2>/dev/null || echo unknown)"
if [ -z "$reasons" ]; then
    echo "No restart is pending."
    exit 0
fi
printf 'A restart is pending:%b\n' "$reasons"
exit 1
