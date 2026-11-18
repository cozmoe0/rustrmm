#!/bin/zsh
# Makes sure network time is on and steps the clock against the configured time server.
server=$(/usr/sbin/systemsetup -getnetworktimeserver 2>/dev/null | awk -F': ' '{print $2}')
server=${server:-time.apple.com}
using=$(/usr/sbin/systemsetup -getusingnetworktime 2>/dev/null)
echo "${using:-Network time: unknown} (server $server)"
if [[ "$using" == *"Off"* ]]; then
    /usr/sbin/systemsetup -setusingnetworktime on >/dev/null 2>&1 && echo "Network time switched on."
fi
if ! /usr/bin/sntp -sS "$server" 2>&1 | tail -n 2; then
    echo "Synchronisation with $server failed."
    exit 1
fi
echo "Clock now: $(date)"
