#!/bin/sh
# Terminates every process with the given exact name: TERM first, KILL after 5 seconds for any
# that remain. Unsaved work in those processes is lost.
set -u
name="${ProcessName:-}"
if [ -z "$name" ]; then
    echo "ProcessName is required."
    exit 2
fi
case "$name" in
    -* | */*) echo "'$name' is not a process name."; exit 2 ;;
esac
case "$name" in
    init | systemd | launchd | kernel_task | sshd | rustrmm-agent)
        echo "Refusing to terminate the protected process '$name'."
        exit 2
        ;;
esac
pids=$(pgrep -x -- "$name")
if [ -z "$pids" ]; then
    echo "No process named '$name' is running."
    exit 0
fi
echo "Terminating $name: $(echo $pids)"
pkill -TERM -x -- "$name"
sleep 5
if pgrep -x -- "$name" >/dev/null; then
    echo "Still running after 5 seconds; sending KILL."
    pkill -KILL -x -- "$name"
    sleep 1
fi
if pgrep -x -- "$name" >/dev/null; then
    echo "Some processes could not be terminated."
    exit 1
fi
echo "All '$name' processes have ended."
