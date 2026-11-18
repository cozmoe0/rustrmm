#!/bin/bash
# Checks the effective OpenSSH server configuration against common hardening settings.
# Exit code 1 when at least one finding is reported.
set -u
sshd=""
for candidate in /usr/sbin/sshd /usr/bin/sshd /sbin/sshd; do
    [ -x "$candidate" ] && sshd="$candidate" && break
done
if [ -z "$sshd" ]; then
    echo "OpenSSH server is not installed."
    exit 0
fi
config=$("$sshd" -T 2>/dev/null)
if [ -z "$config" ]; then
    echo "Could not read the effective sshd configuration (sshd -T failed)."
    exit 2
fi
value() { printf '%s\n' "$config" | awk -v k="$1" '$1==k { $1=""; sub(/^ /, ""); print; exit }'; }

findings=0
check() {
    # check <setting> <acceptable values separated by |> <advice>
    actual=$(value "$1")
    if printf '%s' "$actual" | grep -Eqx "$2"; then
        printf '  OK    %-24s %s\n' "$1" "$actual"
    else
        printf '  WARN  %-24s %s  (%s)\n' "$1" "${actual:-unset}" "$3"
        findings=$((findings + 1))
    fi
}
echo "sshd configuration audit ($("$sshd" -V 2>&1 | head -n 1)):"
check permitrootlogin 'no|prohibit-password|without-password' 'disallow password logins as root'
check passwordauthentication 'no' 'prefer keys over passwords'
check permitemptypasswords 'no' 'empty passwords must never be accepted'
check kbdinteractiveauthentication 'no' 'disable unless MFA needs it'
check x11forwarding 'no' 'disable unless required'
check maxauthtries '[1-4]' 'limit authentication attempts to 4 or fewer'
check logingracetime '([1-9]|[1-5][0-9]|60)' 'keep the login grace time at 60 seconds or less'
check ignorerhosts 'yes' 'rhosts files must be ignored'
check hostbasedauthentication 'no' 'host-based authentication should stay off'
check permituserenvironment 'no' 'users should not set the server environment'
echo
echo "$findings finding(s)."
[ "$findings" -gt 0 ] && exit 1
exit 0
