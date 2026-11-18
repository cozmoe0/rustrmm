#!/bin/zsh
# Lists local user accounts and which of them are administrators.
admins=" $(/usr/bin/dscl . -read /Groups/admin GroupMembership 2>/dev/null | cut -d: -f2) "
echo "Local accounts (UID >= 500):"
/usr/bin/dscl . -list /Users UniqueID | while read -r user uid; do
    [ "$uid" -ge 500 ] 2>/dev/null || continue
    role="standard"
    [[ "$admins" == *" $user "* ]] && role="admin"
    name=$(/usr/bin/dscl . -read "/Users/$user" RealName 2>/dev/null | tail -n 1 | sed 's/^ *//')
    printf '  %-20s uid %-6s %-8s %s\n' "$user" "$uid" "$role" "$name"
done
echo "admin group members:${admins% }"
