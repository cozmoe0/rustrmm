#!/bin/bash
# Restarts a systemd service and shows its status afterwards.
set -u
name="${ServiceName:-}"
if [ -z "$name" ]; then
    echo "ServiceName is required."
    exit 2
fi
case "$name" in
    -* | *[!A-Za-z0-9@._:-]*) echo "'$name' is not a valid unit name."; exit 2 ;;
esac
case "$name" in
    *.*) unit="$name" ;;
    *) unit="$name.service" ;;
esac
if ! systemctl cat "$unit" >/dev/null 2>&1; then
    echo "No unit named $unit."
    exit 1
fi
echo "Restarting $unit (was $(systemctl is-active "$unit"))."
if ! systemctl restart "$unit"; then
    echo "Restart failed."
    journalctl -u "$unit" -n 15 --no-pager 2>/dev/null
    exit 1
fi
sleep 2
systemctl --no-pager --lines=5 status "$unit"
systemctl is-active --quiet "$unit"
