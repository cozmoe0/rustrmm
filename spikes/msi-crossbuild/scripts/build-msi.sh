#!/usr/bin/env bash
# Build the spike MSIs with wixl + msibuild. Runs on Linux (WSL here; a Docker image in the
# real pipeline).
#
#   scripts/build-msi.sh [path/to/rustrmm-spike-agent.exe] [version]
#
# Outputs (in out/):
#   RustRMMSpikeAgent.msi           the spike installer
#   RustRMMSpikeAgent-hardened.msi  same, plus an MsiLockPermissionsEx table that locks
#                                   HKLM\SOFTWARE\RustRMMSpike to SYSTEM + Administrators
#
# Uses wixl/msibuild/msiinfo from PATH (Debian/Kali: apt install msitools wixl). Falls back to
# an unprivileged extraction under $WIXL_ROOT (default ~/rustrmm-spike-tools/msitools-root).
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
exe="${1:-$here/agent/target/release/rustrmm-spike-agent.exe}"
version="${2:-0.1.0}"
out="$here/out"
mkdir -p "$out"

if command -v wixl >/dev/null 2>&1; then
  WIXL=(wixl); MSIBUILD=(msibuild); MSIINFO=(msiinfo)
else
  root="${WIXL_ROOT:-$HOME/rustrmm-spike-tools/msitools-root}"
  export LD_LIBRARY_PATH="$root/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  WIXL=("$root/usr/bin/wixl" --wxidir "$root/usr/share/wixl-0.106/include" --extdir "$root/usr/share/wixl-0.106/ext")
  MSIBUILD=("$root/usr/bin/msibuild"); MSIINFO=("$root/usr/bin/msiinfo")
fi

# Fail if an emitted table row does not match. wixl silently ignores some attributes, so every
# property we depend on is asserted on the built package rather than trusted from the .wxs.
expect() {
  local msi=$1 table=$2 pattern=$3
  # msiinfo export writes IDT (CRLF line endings); strip CR so $ anchors work.
  if ! "${MSIINFO[@]}" export "$msi" "$table" | tail -n +4 | tr -d '\r' | grep -qP "$pattern"; then
    echo "ASSERTION FAILED: $(basename "$msi") table $table has no row matching /$pattern/" >&2
    "${MSIINFO[@]}" export "$msi" "$table" | tail -n +4 >&2
    exit 1
  fi
}

build() {
  local msi=$1
  # wixl assigns a fresh random PackageCode on every run, so each variant is its own package.
  "${WIXL[@]}" -a x64 -D "Version=$version" -D "AgentExe=$exe" -o "$msi" "$here/wix/agent.wxs"

  # Patch what wixl 0.106 cannot express.
  "${MSIBUILD[@]}" "$msi" \
    -q "UPDATE Property SET Value='DEPLOY_KEY;WIX_DOWNGRADE_DETECTED;WIX_UPGRADE_DETECTED' WHERE Property='SecureCustomProperties'" \
    -q "UPDATE ServiceInstall SET ErrorControl=32769 WHERE ServiceInstall='AgentServiceInstall'"

  expect "$msi" Property  '^ProductCode\t\{7C26286F-1047-4CA2-B343-2797FAD7228C\}$'
  expect "$msi" Property  '^UpgradeCode\t\{5840E1F2-DD29-4DB7-BF38-2B9425C17909\}$'
  expect "$msi" Property  "^ProductVersion\t${version//./\\.}$"
  expect "$msi" Property  '^ALLUSERS\t1$'
  expect "$msi" Property  '^ARPNOREPAIR\tyes$'
  expect "$msi" Property  '^ARPNOMODIFY\tyes$'
  expect "$msi" Property  '^MsiHiddenProperties\tDEPLOY_KEY$'
  expect "$msi" Property  '^SecureCustomProperties\tDEPLOY_KEY;WIX_DOWNGRADE_DETECTED;WIX_UPGRADE_DETECTED$'
  # 256 = msidbComponentAttributes64bit; 260 = 64bit | RegistryKeyPath
  expect "$msi" Component '^AgentService\t\{[^}]+\}\tINSTALLDIR\t256\t\tAgentExe$'
  expect "$msi" Component '^DeployKeyValue\t\{[^}]+\}\tINSTALLDIR\t260\tDEPLOY_KEY\tRegDeployKey$'
  expect "$msi" Directory '^INSTALLDIR\tProgramFiles64Folder\tRustRMM Spike$'
  # own process (16), auto start (2), ErrorControl normal|vital (32769), LocalSystem
  expect "$msi" ServiceInstall '^AgentServiceInstall\tRustRMMSpikeAgent\tRustRMM Spike Agent\t16\t2\t32769\t\t\tLocalSystem\t'
  # 163 = start on install (1) | stop on install (2) | stop on uninstall (32) | delete on uninstall (128); Wait=1
  expect "$msi" ServiceControl '^AgentServiceControl\tRustRMMSpikeAgent\t163\t\t1\tAgentService$'
  expect "$msi" Registry  '^RegDeployKey\t2\tSOFTWARE\\RustRMMSpike\tDeployKey\t\[DEPLOY_KEY\]\tDeployKeyValue$'
  expect "$msi" Upgrade   '\tWIX_UPGRADE_DETECTED$'
  expect "$msi" Upgrade   '\tWIX_DOWNGRADE_DETECTED$'
  expect "$msi" LaunchCondition '^NOT WIX_DOWNGRADE_DETECTED\t'
  expect "$msi" InstallExecuteSequence '^RemoveExistingProducts\t\t1401$'
}

echo "wixl $("${WIXL[0]}" --version) | exe: $exe | version: $version"

msi="$out/RustRMMSpikeAgent.msi"
build "$msi"

hardened="$out/RustRMMSpikeAgent-hardened.msi"
build "$hardened"
# Protected DACL (no inheritance): SYSTEM + BUILTIN\Administrators full control. SDDL uses
# well-known SIDs, so it is locale independent (the legacy LockPermissions table is not).
sddl='D:P(A;CI;KA;;;SY)(A;CI;KA;;;BA)'
"${MSIBUILD[@]}" "$hardened" \
  -q 'CREATE TABLE `MsiLockPermissionsEx` (`MsiLockPermissionsEx` CHAR(72) NOT NULL, `LockObject` CHAR(72) NOT NULL, `Table` CHAR(32) NOT NULL, `SDDLText` LONGCHAR NOT NULL, `Condition` CHAR(255) PRIMARY KEY `MsiLockPermissionsEx`)' \
  -q "INSERT INTO \`MsiLockPermissionsEx\` (\`MsiLockPermissionsEx\`, \`LockObject\`, \`Table\`, \`SDDLText\`) VALUES ('LockSourcePackage', 'RegSourcePackage', 'Registry', '$sddl')" \
  -q "INSERT INTO \`MsiLockPermissionsEx\` (\`MsiLockPermissionsEx\`, \`LockObject\`, \`Table\`, \`SDDLText\`) VALUES ('LockDeployKey', 'RegDeployKey', 'Registry', '$sddl')"
expect "$hardened" MsiLockPermissionsEx '^LockDeployKey\tRegDeployKey\tRegistry\tD:P\(A;CI;KA;;;SY\)\(A;CI;KA;;;BA\)\t$'

for f in "$msi" "$hardened"; do
  echo "--- $(basename "$f") ($(stat -c %s "$f") bytes)"
  "${MSIINFO[@]}" suminfo "$f" | grep -E 'Template|Revision|Application'
done
echo "all assertions passed"
