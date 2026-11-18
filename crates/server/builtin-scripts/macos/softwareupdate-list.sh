#!/bin/zsh
# Lists macOS software updates that are available (nothing is installed). Exit code 1 when
# updates are available.
output=$(/usr/sbin/softwareupdate --list 2>&1)
print -r -- "$output" | grep -v '^Software Update Tool' | grep -v '^Finding available software' | sed '/^$/d'
if print -r -- "$output" | grep -q 'No new software available'; then
    exit 0
fi
count=$(print -r -- "$output" | grep -c '^\* Label:')
echo "$count update(s) available."
[ "$count" -gt 0 ] && exit 1
exit 0
