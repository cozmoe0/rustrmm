#!/usr/bin/env bash
# Probe which WiX v3 constructs wixl accepts and what it actually emits.
# Each probe builds a tiny MSI from a template and dumps the tables that construct should
# populate. "Built" does NOT mean "supported": wixl ignores some attributes silently, so
# read the emitted rows.
#   scripts/probe-wixl.sh            # all probes
#   scripts/probe-wixl.sh perm-reg   # one probe
set -uo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

if command -v wixl >/dev/null 2>&1; then
  WIXL=(wixl); MSIINFO=(msiinfo); MSIBUILD=(msibuild)
else
  root="${WIXL_ROOT:-$HOME/rustrmm-spike-tools/msitools-root}"
  export LD_LIBRARY_PATH="$root/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  WIXL=("$root/usr/bin/wixl" --wxidir "$root/usr/share/wixl-0.106/include" --extdir "$root/usr/share/wixl-0.106/ext")
  MSIINFO=("$root/usr/bin/msiinfo"); MSIBUILD=("$root/usr/bin/msibuild")
fi
printf 'MZ-not-a-real-exe' > "$work/probe.exe"
# A real PE with a VERSIONINFO resource, to see whether wixl fills File.Version.
if [[ -n "${PROBE_PE:-}" ]]; then cp "$PROBE_PE" "$work/versioned.exe"; else cp "$work/probe.exe" "$work/versioned.exe"; fi

# name | head (before <Wix>) | package attrs | media | product-level XML | component-level XML | tables
PROBES=(
"hidden-secure-props||||<Property Id='MsiHiddenProperties' Value='DEPLOY_KEY'/><Property Id='SecureCustomProperties' Value='DEPLOY_KEY'/><MajorUpgrade DowngradeErrorMessage='newer'/>||Property"
"hidden-with-majorupgrade||||<Property Id='MsiHiddenProperties' Value='DEPLOY_KEY'/><MajorUpgrade DowngradeErrorMessage='newer'/>||Property"
"secure-explicit-no-majorupgrade||||<Property Id='SecureCustomProperties' Value='DEPLOY_KEY'/>||Property"
"launch-condition-text||||<Condition Message='Needs 64-bit Windows 10+'>VersionNT64 &gt;= 603</Condition>||LaunchCondition"
"preproc-inside-product||||<?ifndef Foo?><?define Foo = \"bar\"?><?endif?><Property Id='FOO' Value='\$(var.Foo)'/>||Property"
"file-version|||||<File Id='F2' Name='versioned.exe' Source='versioned.exe'/>|File MsiFileHash"
"file-defaultversion|||||<File Id='F2' Name='versioned.exe' Source='versioned.exe' DefaultVersion='1.2.3.4'/>|File MsiFileHash"
"hidden-alone||||<Property Id='MsiHiddenProperties' Value='DEPLOY_KEY'/>||Property"
"hidden-after-majorupgrade||||<MajorUpgrade DowngradeErrorMessage='newer'/><Property Id='MsiHiddenProperties' Value='DEPLOY_KEY'/>||Property"
"msi-prefixed-props||||<Property Id='MsiFoo' Value='1'/><Property Id='MSIFASTINSTALL' Value='1'/><Property Id='MsiLogging' Value='voicewarmupx'/><Property Id='XHiddenProperties' Value='1'/>||Property"
"plain-before-majorupgrade||||<Property Id='ZZZ' Value='1'/><MajorUpgrade DowngradeErrorMessage='newer'/>||Property"
"preproc-define||||<?define Foo = \"bar\"?><Property Id='FOO' Value='\$(var.Foo)'/>||Property"
"preproc-ifdef||||<?ifdef Foo?><Property Id='HASFOO' Value='1'/><?else?><Property Id='NOFOO' Value='1'/><?endif?>||Property"
"property-attrs||||<Property Id='A' Value='1' Secure='yes' Hidden='yes' Admin='yes'/>||Property"
"perm-reg|||||<RegistryKey Root='HKLM' Key='SOFTWARE\\Probe'><Permission User='SYSTEM' GenericAll='yes'/><RegistryValue Name='v' Type='string' Value='x'/></RegistryKey>|Registry LockPermissions"
"permex-reg|||||<RegistryValue Root='HKLM' Key='SOFTWARE\\Probe' Name='v' Type='string' Value='x'><PermissionEx Sddl='D:PAI(A;;KA;;;SY)(A;;KA;;;BA)'/></RegistryValue>|Registry MsiLockPermissionsEx"
"perm-folder|||||<CreateFolder Directory='DATADIR'><PermissionEx Sddl='D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'/></CreateFolder>|CreateFolder MsiLockPermissionsEx"
"service-vital|||||<ServiceInstall Id='S' Name='Probe' Type='ownProcess' Start='auto' ErrorControl='normal' Vital='yes' Arguments='--svc' Account='LocalSystem'/>|ServiceInstall"
"service-dependency|||||<ServiceInstall Id='S' Name='Probe' Type='ownProcess' Start='auto' ErrorControl='normal'><ServiceDependency Id='Tcpip'/></ServiceInstall>|ServiceInstall"
"service-config|||||<ServiceInstall Id='S' Name='Probe' Type='ownProcess' Start='auto' ErrorControl='normal'><ServiceConfig DelayedAutoStart='yes' OnInstall='yes'/></ServiceInstall>|ServiceInstall MsiServiceConfig"
"service-failure-actions|||||<ServiceInstall Id='S' Name='Probe' Type='ownProcess' Start='auto' ErrorControl='normal'><ServiceConfigFailureActions OnInstall='yes' ResetPeriod='86400'><Failure Action='restartService' Delay='60000'/></ServiceConfigFailureActions></ServiceInstall>|ServiceInstall MsiServiceConfigFailureActions"
"remove-folder|||||<RemoveFolder Id='RF' On='uninstall'/>|RemoveFile InstallExecuteSequence"
"custom-action-setprop||||<CustomAction Id='SetX' Property='X' Value='1'/><InstallExecuteSequence><Custom Action='SetX' After='CostFinalize'>NOT Installed</Custom></InstallExecuteSequence>||CustomAction InstallExecuteSequence"
"custom-action-exe-deferred||||<CustomAction Id='RunAgent' FileKey='F1' ExeCommand='--uninstall-cleanup' Execute='deferred' Impersonate='no' Return='check'/><InstallExecuteSequence><Custom Action='RunAgent' Before='RemoveFiles'>REMOVE=\"ALL\"</Custom></InstallExecuteSequence>||CustomAction InstallExecuteSequence"
"set-property||||<SetProperty Id='X' Value='1' After='CostFinalize'/>||CustomAction InstallExecuteSequence"
"seq-before-installfinalize||||<CustomAction Id='SetX' Property='X' Value='1'/><InstallExecuteSequence><Custom Action='SetX' Before='InstallFinalize'/></InstallExecuteSequence>||InstallExecuteSequence"
"seq-chain-explicit||||<CustomAction Id='SetY' Property='Y' Value='1'/><CustomAction Id='SetX' Property='X' Value='1'/><InstallExecuteSequence><Custom Action='SetY' Sequence='6590'/><Custom Action='SetX' Sequence='6591'/></InstallExecuteSequence>||InstallExecuteSequence"
"seq-chain-after||||<CustomAction Id='SetY' Property='Y' Value='1'/><CustomAction Id='SetX' Property='X' Value='1'/><InstallExecuteSequence><Custom Action='SetY' After='PublishProduct'/><Custom Action='SetX' After='SetY'/></InstallExecuteSequence>||InstallExecuteSequence"
"seq-chain-before||||<CustomAction Id='SetY' Property='Y' Value='1'/><CustomAction Id='SetX' Property='X' Value='1'/><InstallExecuteSequence><Custom Action='SetY' Before='SetX'/><Custom Action='SetX' Before='InstallFinalize'/></InstallExecuteSequence>||InstallExecuteSequence"
"seq-chain-before-cond||||<CustomAction Id='SetY' Property='Y' Value='1'/><CustomAction Id='SetX' Property='X' Value='1'/><InstallExecuteSequence><Custom Action='SetY' Before='SetX'>DEPLOY_KEY</Custom><Custom Action='SetX' Before='InstallFinalize'>DEPLOY_KEY</Custom></InstallExecuteSequence>||InstallExecuteSequence"
"seq-single-before-cond||||<CustomAction Id='SetX' Property='X' Value='1'/><InstallExecuteSequence><Custom Action='SetX' Before='InstallFinalize'>DEPLOY_KEY</Custom></InstallExecuteSequence>||InstallExecuteSequence"
"seq-explicit-cond||||<CustomAction Id='SetY' Property='Y' Value='1'/><CustomAction Id='SetX' Property='X' Value='1'/><InstallExecuteSequence><Custom Action='SetY' Sequence='6590'>DEPLOY_KEY</Custom><Custom Action='SetX' Sequence='6591'>DEPLOY_KEY</Custom></InstallExecuteSequence>||InstallExecuteSequence"
"seq-after-cond||||<CustomAction Id='SetX' Property='X' Value='1'/><InstallExecuteSequence><Custom Action='SetX' After='PublishProduct'>DEPLOY_KEY</Custom></InstallExecuteSequence>||InstallExecuteSequence"
"custom-action-dll-hidetarget||||<Binary Id='CADll' SourceFile='probe.exe'/><Property Id='MsiHiddenProperties' Value='DEPLOY_KEY;WriteDeployKey'/><CustomAction Id='SetWriteDeployKey' Property='WriteDeployKey' Value='[DEPLOY_KEY]'/><CustomAction Id='WriteDeployKey' BinaryKey='CADll' DllEntry='WriteDeployKey' Execute='deferred' Impersonate='no' HideTarget='yes' Return='check'/><InstallExecuteSequence><Custom Action='SetWriteDeployKey' Before='WriteDeployKey'>DEPLOY_KEY</Custom><Custom Action='WriteDeployKey' Before='InstallFinalize'>DEPLOY_KEY</Custom></InstallExecuteSequence>||Binary CustomAction InstallExecuteSequence"
"launch-condition||||<Condition Message='Needs 64-bit Windows 10+'><![CDATA[VersionNT64 >= 603]]></Condition>||LaunchCondition"
"registry-search||||<Property Id='EXISTING'><RegistrySearch Id='rs' Root='HKLM' Key='SOFTWARE\\Probe' Name='v' Type='raw' Win64='yes'/></Property>||AppSearch RegLocator"
"media-template|||<MediaTemplate EmbedCab='yes'/>|||Media"
"package-platform||Platform='x64' InstallPrivileges='elevated'||||_SummaryInformation"
"preproc-ifndef|<?ifndef Foo?><?define Foo = \"bar\"?><?endif?>|||<Property Id='FOO' Value='\$(var.Foo)'/>||Property"
"util-extension||||<util:CloseApplication xmlns:util='http://schemas.microsoft.com/wix/UtilExtension' Id='c' Target='x.exe'/>||CustomAction"
)

run_probe() {
  IFS='|' read -r name head pkg media product component tables <<<"$1"
  [[ -n "${only:-}" && "$name" != "$only" ]] && return
  [[ -z "$media" ]] && media="<Media Id='1' Cabinet='p.cab' EmbedCab='yes'/>"
  cat > "$work/$name.wxs" <<EOF
<?xml version="1.0" encoding="utf-8"?>
$head
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">
  <Product Id="{0B6A1E52-5C1B-4E43-9A57-6A5D3B1C2E01}" UpgradeCode="{0B6A1E52-5C1B-4E43-9A57-6A5D3B1C2E02}"
           Name="Probe" Version="1.0.0" Manufacturer="Probe" Language="1033">
    <Package InstallerVersion="500" Compressed="yes" InstallScope="perMachine" $pkg/>
    $media
    $product
    <Directory Id="TARGETDIR" Name="SourceDir">
      <Directory Id="ProgramFiles64Folder">
        <Directory Id="INSTALLDIR" Name="Probe">
          <Directory Id="DATADIR" Name="data"/>
          <Component Id="C1" Guid="{0B6A1E52-5C1B-4E43-9A57-6A5D3B1C2E03}" Win64="yes">
            <File Id="F1" Name="probe.exe" Source="probe.exe" KeyPath="yes"/>
            $component
          </Component>
        </Directory>
      </Directory>
    </Directory>
    <Feature Id="Main" Level="1"><ComponentRef Id="C1"/></Feature>
  </Product>
</Wix>
EOF
  echo "################ $name"
  if (cd "$work" && "${WIXL[@]}" -a x64 -o "$name.msi" "$name.wxs") >"$work/$name.log" 2>&1; then
    echo "BUILD: ok"
  else
    echo "BUILD: FAILED"
  fi
  grep -vE '^\s*$' "$work/$name.log" | sed 's/^/  wixl: /' | head -6
  [[ -f "$work/$name.msi" ]] || return
  local present
  present=$("${MSIINFO[@]}" tables "$work/$name.msi")
  for t in $tables; do
    if [[ "$t" == _SummaryInformation ]]; then
      "${MSIINFO[@]}" suminfo "$work/$name.msi" | grep -E 'Template|Source|Security' | sed 's/^/  suminfo: /'
    elif grep -qx "$t" <<<"$present"; then
      echo "  [$t]"; "${MSIINFO[@]}" export "$work/$name.msi" "$t" | tail -n +4 | sed 's/^/    /'
    else
      echo "  [$t] (table not emitted)"
    fi
  done
}

only="${1:-}"
echo "wixl $("${WIXL[0]}" --version)"
for p in "${PROBES[@]}"; do run_probe "$p"; done

echo "################ msibuild-sql-postprocess"
cp "$work/service-vital.msi" "$work/pp.msi" 2>/dev/null && {
  "${MSIBUILD[@]}" "$work/pp.msi" -q "UPDATE ServiceInstall SET ErrorControl=32769 WHERE ServiceInstall='S'" \
    -q "INSERT INTO Property (Property, Value) VALUES ('MsiHiddenProperties', 'DEPLOY_KEY')" && echo "SQL: ok"
  "${MSIINFO[@]}" export "$work/pp.msi" ServiceInstall | tail -n +4 | sed 's/^/    /'
  "${MSIINFO[@]}" export "$work/pp.msi" Property | tail -n +4 | grep -i hidden | sed 's/^/    /'
}
