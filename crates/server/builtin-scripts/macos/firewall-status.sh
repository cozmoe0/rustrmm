#!/bin/zsh
# Reports the macOS application firewall state, stealth mode and allowed applications. Exit code
# 1 when the firewall is off.
fw=/usr/libexec/ApplicationFirewall/socketfilterfw
state=$($fw --getglobalstate 2>&1)
echo "$state"
$fw --getstealthmode 2>&1
$fw --getblockall 2>&1
echo "Applications with explicit rules:"
$fw --listapps 2>/dev/null | grep -E '^[0-9]+ :|Allow|Block' | sed 's/^/  /' | head -n 40
[[ "$state" == *"enabled"* ]] && exit 0
exit 1
