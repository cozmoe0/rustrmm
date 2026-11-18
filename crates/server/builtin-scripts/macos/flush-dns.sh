#!/bin/zsh
# Flushes the macOS DNS cache and restarts the mDNSResponder cache.
/usr/bin/dscacheutil -flushcache
/usr/bin/killall -HUP mDNSResponder 2>/dev/null
echo "DNS cache flushed on macOS $(/usr/bin/sw_vers -productVersion)."
