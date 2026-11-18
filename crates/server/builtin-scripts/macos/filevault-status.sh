#!/bin/zsh
# Reports FileVault encryption status and the users allowed to unlock the disk. Exit code 1 when
# FileVault is off.
fdesetup_status=$(/usr/bin/fdesetup status 2>&1)
echo "$fdesetup_status"
echo "Users able to unlock the disk:"
/usr/bin/fdesetup list 2>/dev/null | cut -d, -f1 | sed 's/^/  /'
if /usr/bin/fdesetup haspersonalrecoverykey 2>/dev/null | grep -q true; then
    echo "A personal recovery key is set."
fi
[[ "$fdesetup_status" == *"FileVault is On"* ]] && exit 0
exit 1
