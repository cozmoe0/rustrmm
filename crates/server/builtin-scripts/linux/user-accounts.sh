#!/bin/bash
# Lists accounts that can log in, members of the administrative groups and recent logins.
set -u
echo "Accounts with a login shell:"
awk -F: '$7 !~ /(nologin|false|sync|shutdown|halt)$/ { printf "  %-20s uid %-6s %s\n", $1, $3, $7 }' /etc/passwd
echo
for group in sudo wheel admin; do
    members=$(getent group "$group" 2>/dev/null | cut -d: -f4)
    [ -n "$(getent group "$group" 2>/dev/null)" ] && echo "Members of $group: ${members:-none}"
done
echo
echo "Accounts with UID 0:"
awk -F: '$3 == 0 { print "  " $1 }' /etc/passwd
echo
if command -v lastlog >/dev/null 2>&1; then
    echo "Most recent logins:"
    lastlog 2>/dev/null | awk 'NR>1 && $0 !~ /Never logged in/' | head -n 15 | sed 's/^/  /'
elif command -v last >/dev/null 2>&1; then
    echo "Most recent logins:"
    last -n 15 2>/dev/null | sed 's/^/  /'
fi
