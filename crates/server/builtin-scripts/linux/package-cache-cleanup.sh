#!/bin/bash
# Cleans the package manager's download cache and removes packages that are no longer needed.
set -u
before=$(df -Pk / | awk 'NR==2 {print $4}')

if command -v apt-get >/dev/null 2>&1; then
    echo "Using apt"
    DEBIAN_FRONTEND=noninteractive apt-get -y autoremove --purge
    apt-get -y autoclean
    apt-get -y clean
elif command -v dnf >/dev/null 2>&1; then
    echo "Using dnf"
    dnf -y autoremove
    dnf clean all
elif command -v yum >/dev/null 2>&1; then
    echo "Using yum"
    yum -y autoremove
    yum clean all
elif command -v zypper >/dev/null 2>&1; then
    echo "Using zypper"
    zypper --non-interactive clean --all
elif command -v pacman >/dev/null 2>&1; then
    echo "Using pacman"
    pacman -Sc --noconfirm
elif command -v apk >/dev/null 2>&1; then
    echo "Using apk"
    apk cache clean 2>/dev/null || rm -rf /var/cache/apk/*
else
    echo "No supported package manager found."
    exit 1
fi

after=$(df -Pk / | awk 'NR==2 {print $4}')
freed=$(( (after - before) / 1024 ))
echo "Done. Free space on / changed by ${freed} MB."
