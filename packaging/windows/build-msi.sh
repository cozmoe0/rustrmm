#!/usr/bin/env bash
# Build the RustRMM agent MSI with wixl + msibuild (msitools). Runs on Linux: the release Docker
# image, CI, or WSL on a Windows workstation.
#
#   packaging/windows/build-msi.sh <path/to/rustrmm-agent.exe> <version> [out.msi]
#
# Pipeline: wixl → msibuild fix-ups (what wixl silently ignores) → assertions on every table row
# the product depends on. Requires `apt install msitools wixl` (Debian/Ubuntu/Kali ship wixl as
# a separate package). Falls back to an unprivileged extraction under $WIXL_ROOT.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
exe="${1:?usage: build-msi.sh <rustrmm-agent.exe> <version> [out.msi]}"
version="${2:?version required, e.g. 0.1.0}"
out="${3:-$here/../../dist/agents/windows-x86_64/RustRMMAgent-x64.msi}"
mkdir -p "$(dirname "$out")"

# shellcheck disable=SC1091
source <(tr -d '\r' < "$here/product-codes.env")

if command -v wixl >/dev/null 2>&1; then
  WIXL=(wixl); MSIBUILD=(msibuild); MSIINFO=(msiinfo)
else
  root="${WIXL_ROOT:-$HOME/rustrmm-spike-tools/msitools-root}"
  [ -x "$root/usr/bin/wixl" ] || { echo "wixl not found: apt install msitools wixl (or set WIXL_ROOT)" >&2; exit 1; }
  export LD_LIBRARY_PATH="$root/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  WIXL=("$root/usr/bin/wixl" --wxidir "$root/usr/share/wixl-0.106/include" --extdir "$root/usr/share/wixl-0.106/ext")
  MSIBUILD=("$root/usr/bin/msibuild"); MSIINFO=("$root/usr/bin/msiinfo")
fi

expect() {
  local table=$1 pattern=$2
  if ! "${MSIINFO[@]}" export "$out" "$table" | tail -n +4 | tr -d '\r' | grep -qP "$pattern"; then
    echo "ASSERTION FAILED: table $table has no row matching /$pattern/" >&2
    "${MSIINFO[@]}" export "$out" "$table" | tail -n +4 >&2
    exit 1
  fi
}

"${WIXL[@]}" -a x64 \
  -D "Version=$version" -D "AgentExe=$exe" -D "ProductCode=$PRODUCT_CODE" -D "UpgradeCode=$UPGRADE_CODE" \
  -o "$out" "$here/RustRMMAgent.wxs"

# wixl ignores Property/@Secure and ServiceInstall vital flags; lock the registry values to
# SYSTEM + Administrators with a locale-independent SDDL (protected DACL).
sddl='D:P(A;CI;KA;;;SY)(A;CI;KA;;;BA)'
"${MSIBUILD[@]}" "$out" \
  -q "UPDATE Property SET Value='DEPLOY_KEY;DISABLE_FEATURES;WIX_DOWNGRADE_DETECTED;WIX_UPGRADE_DETECTED' WHERE Property='SecureCustomProperties'" \
  -q "UPDATE ServiceInstall SET ErrorControl=32769 WHERE ServiceInstall='AgentServiceInstall'" \
  -q "UPDATE File SET Version='$version.0' WHERE File='AgentExe'" \
  -q 'CREATE TABLE `MsiLockPermissionsEx` (`MsiLockPermissionsEx` CHAR(72) NOT NULL, `LockObject` CHAR(72) NOT NULL, `Table` CHAR(32) NOT NULL, `SDDLText` LONGCHAR NOT NULL, `Condition` CHAR(255) PRIMARY KEY `MsiLockPermissionsEx`)' \
  -q "INSERT INTO \`MsiLockPermissionsEx\` (\`MsiLockPermissionsEx\`, \`LockObject\`, \`Table\`, \`SDDLText\`) VALUES ('LockDeployKey', 'RegDeployKey', 'Registry', '$sddl')" \
  -q "INSERT INTO \`MsiLockPermissionsEx\` (\`MsiLockPermissionsEx\`, \`LockObject\`, \`Table\`, \`SDDLText\`) VALUES ('LockDisableFeatures', 'RegDisableFeatures', 'Registry', '$sddl')"

esc() { printf '%s' "$1" | sed 's/[{}.]/\\&/g'; }
expect Property  "^ProductCode\t$(esc "$PRODUCT_CODE")$"
expect Property  "^UpgradeCode\t$(esc "$UPGRADE_CODE")$"
expect Property  "^ProductVersion\t$(esc "$version")$"
expect Property  '^ALLUSERS\t1$'
expect Property  '^ARPNOREPAIR\tyes$'
expect Property  '^ARPNOMODIFY\tyes$'
expect Property  '^MsiHiddenProperties\tDEPLOY_KEY$'
expect Property  '^SecureCustomProperties\tDEPLOY_KEY;DISABLE_FEATURES;'
expect Directory '^INSTALLDIR\tVendorDir\tAgent$'
expect Component '^AgentService\t\{[^}]+\}\tINSTALLDIR\t256\t\tAgentExe$'
expect Component '^DeployKeyValue\t\{[^}]+\}\tINSTALLDIR\t260\tDEPLOY_KEY\tRegDeployKey$'
expect ServiceInstall '^AgentServiceInstall\tRustRMMAgent\tRustRMM Agent\t16\t2\t32769\t\t\tLocalSystem\t\tservice\t'
expect ServiceControl '^AgentServiceControl\tRustRMMAgent\t163\t\t1\tAgentService$'
expect Registry '^RegDeployKey\t2\tSOFTWARE\\RustRMM\\Agent\tDeployKey\t\[DEPLOY_KEY\]\tDeployKeyValue$'
expect MsiLockPermissionsEx '^LockDeployKey\tRegDeployKey\tRegistry\tD:P\(A;CI;KA;;;SY\)\(A;CI;KA;;;BA\)\t$'
expect LaunchCondition '^NOT WIX_DOWNGRADE_DETECTED\t'

echo "built $out ($(stat -c %s "$out") bytes) — all assertions passed"
