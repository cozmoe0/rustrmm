#!/bin/zsh
# Reports Gatekeeper, System Integrity Protection and XProtect status. Exit code 1 when
# Gatekeeper or SIP is disabled.
problems=0
gatekeeper=$(/usr/sbin/spctl --status 2>&1)
echo "Gatekeeper: $gatekeeper"
[[ "$gatekeeper" == *"enabled"* ]] || problems=$((problems + 1))
sip=$(/usr/bin/csrutil status 2>&1)
echo "SIP: ${sip#System Integrity Protection status: }"
[[ "$sip" == *"enabled"* ]] || problems=$((problems + 1))
xprotect=$(/usr/bin/defaults read /Library/Apple/System/Library/CoreServices/XProtect.bundle/Contents/Info CFBundleShortVersionString 2>/dev/null)
echo "XProtect version: ${xprotect:-unknown}"
echo "macOS $(/usr/bin/sw_vers -productVersion) build $(/usr/bin/sw_vers -buildVersion)"
[ "$problems" -gt 0 ] && exit 1
exit 0
