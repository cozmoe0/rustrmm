#!/bin/bash
# Lists listening TCP ports and bound UDP sockets with the owning process.
set -u
if command -v ss >/dev/null 2>&1; then
    echo "TCP listeners:"
    ss -H -ltnp 2>/dev/null | awk '{ proc=$6; sub(/^users:\(\("/, "", proc); sub(/".*/, "", proc); printf "  %-45s %s\n", $4, proc }' | sort -u
    echo
    echo "UDP sockets:"
    ss -H -lunp 2>/dev/null | awk '{ proc=$6; sub(/^users:\(\("/, "", proc); sub(/".*/, "", proc); printf "  %-45s %s\n", $4, proc }' | sort -u
elif command -v lsof >/dev/null 2>&1; then
    echo "TCP listeners:"
    lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1 { printf "  %-45s %s (PID %s)\n", $9, $1, $2 }' | sort -u
    echo
    echo "UDP sockets:"
    lsof -nP -iUDP 2>/dev/null | awk 'NR>1 { printf "  %-45s %s (PID %s)\n", $9, $1, $2 }' | sort -u
elif command -v netstat >/dev/null 2>&1; then
    netstat -an | grep -Ei 'listen|udp'
else
    echo "Neither ss, lsof nor netstat is available."
    exit 1
fi
