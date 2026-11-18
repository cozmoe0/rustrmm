#!/bin/bash
# Installs all available package updates non-interactively. Services may restart; a reboot may
# be required afterwards (reported at the end).
set -u
export DEBIAN_FRONTEND=noninteractive
security_only="${SecurityOnly:-false}"
if command -v apt-get >/dev/null 2>&1; then
    apt-get update -q
    if [ "$security_only" = "true" ] && command -v unattended-upgrade >/dev/null 2>&1; then
        unattended-upgrade -v
    else
        apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold dist-upgrade
    fi
    status=$?
elif command -v dnf >/dev/null 2>&1; then
    if [ "$security_only" = "true" ]; then dnf -y upgrade --security; else dnf -y upgrade; fi
    status=$?
elif command -v yum >/dev/null 2>&1; then
    if [ "$security_only" = "true" ]; then yum -y update --security; else yum -y update; fi
    status=$?
elif command -v zypper >/dev/null 2>&1; then
    if [ "$security_only" = "true" ]; then
        zypper --non-interactive patch --category security
    else
        zypper --non-interactive update
    fi
    status=$?
else
    echo "No supported package manager found."
    exit 2
fi
echo "Package manager exit code: $status"
if [ -f /var/run/reboot-required ] || { command -v needs-restarting >/dev/null 2>&1 && ! needs-restarting -r >/dev/null 2>&1; }; then
    echo "A restart is required to finish the updates."
fi
exit "$status"
