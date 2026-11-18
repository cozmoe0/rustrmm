#!/usr/bin/env bash
# Dump every table of an MSI with msiinfo, for checking what wixl actually emitted.
#   scripts/dump-msi.sh [file.msi]
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
msi="${1:-$here/out/RustRMMSpikeAgent.msi}"
if command -v msiinfo >/dev/null 2>&1; then
  MSIINFO=(msiinfo)
else
  root="${WIXL_ROOT:-$HOME/rustrmm-spike-tools/msitools-root}"
  export LD_LIBRARY_PATH="$root/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  MSIINFO=("$root/usr/bin/msiinfo")
fi
for t in $("${MSIINFO[@]}" tables "$msi" | sort); do
  echo "===== $t"
  case "$t" in
    _Validation|_Columns|_Tables|_Streams|_StringData|_StringPool) continue ;;
  esac
  "${MSIINFO[@]}" export "$msi" "$t" | tail -n +4
done
