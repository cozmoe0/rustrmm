#!/bin/zsh
# Removes files older than a number of days from the shared temporary folders and each user's
# cache folder. Files that are open or protected are skipped.
days=${OlderThanDays:-7}
if [[ "$days" != <-> ]]; then
    echo "OlderThanDays must be a whole number."
    exit 2
fi
before=$(df -k / | awk 'NR==2 {print $4}')
folders=(/private/var/tmp /private/tmp)
for home in /Users/*(N/); do
    [[ -d "$home/Library/Caches" ]] && folders+=("$home/Library/Caches")
done
for folder in $folders; do
    count=$(find "$folder" -xdev -type f -mtime +"$days" 2>/dev/null | wc -l | tr -d ' ')
    find "$folder" -xdev -type f -mtime +"$days" -delete 2>/dev/null
    find "$folder" -xdev -mindepth 1 -type d -empty -delete 2>/dev/null
    [[ "$count" -gt 0 ]] && echo "$folder: removed $count file(s)"
done
after=$(df -k / | awk 'NR==2 {print $4}')
echo "Freed about $(( (after - before) / 1024 )) MB."
