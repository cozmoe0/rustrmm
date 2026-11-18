#!/bin/bash
# Flushes the local DNS cache of whichever resolver service is in use.
set -u
flushed=0
if command -v resolvectl >/dev/null 2>&1 && systemctl is-active --quiet systemd-resolved; then
    resolvectl flush-caches && echo "systemd-resolved cache flushed." && flushed=1
fi
if systemctl is-active --quiet nscd 2>/dev/null; then
    nscd -i hosts 2>/dev/null && echo "nscd hosts cache invalidated." && flushed=1
fi
if systemctl is-active --quiet dnsmasq 2>/dev/null; then
    systemctl kill -s HUP dnsmasq && echo "dnsmasq cache cleared." && flushed=1
fi
if systemctl is-active --quiet unbound 2>/dev/null && command -v unbound-control >/dev/null 2>&1; then
    unbound-control flush_zone . >/dev/null && echo "unbound cache flushed." && flushed=1
fi
[ "$flushed" -eq 0 ] && echo "No caching resolver is running; nothing to flush."
exit 0
