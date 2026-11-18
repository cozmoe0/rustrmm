# Spike: Windows agent MSI and cross-build pipeline without WiX

Throwaway spike, 2026-11-17. Question: can RustRMM build its Windows agent installer on Linux
with `wixl` (msitools) instead of WiX (v3 is end-of-life, v6+ charges organisations above
$10k revenue), and does the Rust cross-build half of the release pipeline work?

## Verdict

**Yes, with caveats.** `wixl` 0.106 builds a working per-machine, silent-capable service MSI
from a WiX v3-schema `.wxs`. It only covers a subset of WiX, and some attributes are
**silently ignored**. Two of those gaps are patched after the build with `msibuild` (also part
of msitools). Every emitted table row the product depends on is then asserted. The Rust
cross-builds to static musl Linux binaries (x86_64 and aarch64) work from Windows with
cargo-zigbuild.

On a real Windows 11 install the MSI did everything asked of it: silent install, service,
property and sidecar deploy key, Add/Remove Programs, clean uninstall (76 of 78 checks).

**The two failed checks are a security finding.** `MsiHiddenProperties` does not hide a value
written through the Registry table: the verbose log records
`Executing op: RegAddValue(Name=DeployKey,Value=<the key>)`. See design finding 5.

| Item | Status |
|---|---|
| Agent service exe (`windows-service`, `MsiGetProductInfoW`, `deploy.key`, `DEPLOY_KEY`) | Built (MSVC 255 KB; also `x86_64-pc-windows-gnu` via zig, 1.0 MB). `--console` runs on Windows. |
| `.wxs` compiled by wixl in WSL2 Kali | Builds cleanly. 18 table assertions pass per variant (19 for the hardened one). Windows' own `msi.dll` opens both MSIs and reads every table (`scripts/inspect-msi.ps1`). |
| `cargo zigbuild` x86_64/aarch64 `-unknown-linux-musl` from Windows | Both build as static ELF (no `PT_INTERP`). The x86_64 binary runs in WSL. The aarch64 binary was not run (no qemu). |
| `cargo-xwin` inside WSL | **Not run.** It downloads the MSVC CRT and Windows SDK, which means accepting Microsoft's licence. That is your call, not mine. Commands are in the cargo-xwin section below. |
| Elevated install tests | **Run** on Windows 11 10.0.26200, elevated through a UAC prompt you approved. 76 of 78 checks pass; the 2 failures are the log leak above. See [Install tests](#install-tests-elevated). |

## Layout

```
spikes/msi-crossbuild/
  agent/              standalone crate: the Windows service (empty [workspace] table)
  hello-cross/        standalone crate: hello world for the zigbuild check
  wix/agent.wxs       WiX v3-schema source, compiled by wixl
  scripts/build-msi.sh    Linux: wixl + msibuild fix-ups + table assertions (both MSI variants)
  scripts/build.ps1       Windows: cargo build (MSVC) then build-msi.sh inside WSL
  scripts/inspect-msi.ps1 Windows: read the MSI with msi.dll via COM (no elevation)
  scripts/test-install.ps1 Windows, elevated: install/uninstall tests A, B, B2, E, C
  scripts/dump-msi.sh     Linux: dump every table with msiinfo
  scripts/probe-wixl.sh   Linux: probe which WiX constructs wixl accepts and what it emits
  out/                build output and test results (git-ignored)
```

## Environment

- Windows 11 Enterprise 10.0.26200, Rust 1.98.1 (repo pin), VS 2022 Build Tools (MSVC).
- zig 0.17.1 (winget) and cargo-zigbuild 0.24.1. Both were already installed. Rustup targets
  added: `x86_64-unknown-linux-musl`, `aarch64-unknown-linux-musl`, `x86_64-pc-windows-gnu`.
- WSL2 `kali-linux` (Kali 2026.2), `msitools`/`wixl` **0.106+repack-3** (kali-last-snapshot).

### Installing wixl

On Debian and Kali, **`apt install msitools` does not include wixl**. wixl ships in its own
`wixl` package, with `wixl-data` as a dependency. Fedora's `msitools` package does include it.
The correct command is:

```bash
sudo apt install msitools wixl
```

`sudo` in the Kali distro needs a password. Rather than block on that, the spike fetched the
`.deb` files with an unprivileged apt (custom `Dir::State`/`Dir::Cache`) and unpacked them with
`dpkg-deb -x` into `~/rustrmm-spike-tools/msitools-root` (28 MB) inside the distro. The build
scripts use `wixl` from `PATH` when it is installed and fall back to that tree otherwise. If
you want a normal system install, run the command above in Kali.

msitools is LGPL-2.1+. The `ui` extension data is MS-RL and is not used here. wixl embeds no
code of its own in the output MSI.

## The working `.wxs`

[`wix/agent.wxs`](wix/agent.wxs), reproduced here:

```xml
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">
  <Product Id="{7C26286F-1047-4CA2-B343-2797FAD7228C}"
           UpgradeCode="{5840E1F2-DD29-4DB7-BF38-2B9425C17909}"
           Name="RustRMM Spike Agent"
           Version="$(var.Version)"
           Manufacturer="RustRMM"
           Language="1033"
           Codepage="1252">

    <!-- Per-machine (wixl emits ALLUSERS=1); x64 comes from `wixl -a x64` (Template x64;1033). -->
    <Package InstallerVersion="500"
             Compressed="yes"
             InstallScope="perMachine"
             Description="RustRMM Spike Agent"
             Comments="Throwaway MSI spike built with wixl" />

    <Media Id="1" Cabinet="agent.cab" EmbedCab="yes" />

    <!-- Safety net for a future ProductCode change; never fires while the code stays fixed. -->
    <MajorUpgrade DowngradeErrorMessage="A newer version of [ProductName] is already installed." />

    <!-- Add/Remove Programs: uninstall only. -->
    <Property Id="ARPNOREPAIR" Value="yes" />
    <Property Id="ARPNOMODIFY" Value="yes" />

    <!-- WiX would write <Property Id="DEPLOY_KEY" Hidden="yes" Secure="yes"/>; wixl ignores both
         attributes, so hide it explicitly and let build-msi.sh add it to SecureCustomProperties. -->
    <Property Id="MsiHiddenProperties" Value="DEPLOY_KEY" />

    <Directory Id="TARGETDIR" Name="SourceDir">
      <Directory Id="ProgramFiles64Folder">
        <Directory Id="INSTALLDIR" Name="RustRMM Spike">

          <Component Id="AgentService" Guid="{AC90B185-387F-4BD7-AE81-823C1A4A5A71}" Win64="yes">
            <File Id="AgentExe" Name="rustrmm-spike-agent.exe" Source="$(var.AgentExe)" KeyPath="yes" />
            <ServiceInstall Id="AgentServiceInstall" Name="RustRMMSpikeAgent"
                            DisplayName="RustRMM Spike Agent" Description="Throwaway MSI spike service"
                            Type="ownProcess" Start="auto" ErrorControl="normal" Account="LocalSystem" />
            <ServiceControl Id="AgentServiceControl" Name="RustRMMSpikeAgent"
                            Start="install" Stop="both" Remove="uninstall" Wait="yes" />
            <!-- Diagnostic: full path of the .msi being installed, available before StartServices. -->
            <RegistryValue Id="RegSourcePackage" Root="HKLM" Key="SOFTWARE\RustRMMSpike"
                           Name="SourcePackage" Type="string" Value="[OriginalDatabase]" />
          </Component>

          <!-- Only installed when DEPLOY_KEY was passed; the agent deletes the value after use. -->
          <Component Id="DeployKeyValue" Guid="{D5021A14-301D-4FA3-ACC0-35D3461544F3}" Win64="yes">
            <Condition>DEPLOY_KEY</Condition>
            <RegistryValue Id="RegDeployKey" Root="HKLM" Key="SOFTWARE\RustRMMSpike"
                           Name="DeployKey" Type="string" Value="[DEPLOY_KEY]" KeyPath="yes" />
          </Component>

        </Directory>
      </Directory>
    </Directory>

    <Feature Id="Main" Level="1" Title="RustRMM Spike Agent">
      <ComponentRef Id="AgentService" />
      <ComponentRef Id="DeployKeyValue" />
    </Feature>
  </Product>
</Wix>
```

What wixl emitted (from `msiinfo export`, confirmed through `msi.dll`):

- `Property`: `ALLUSERS=1`, `ARPNOREPAIR`, `ARPNOMODIFY`, `MsiHiddenProperties=DEPLOY_KEY`.
  After the fix-up, `SecureCustomProperties=DEPLOY_KEY;WIX_DOWNGRADE_DETECTED;WIX_UPGRADE_DETECTED`.
- `Component`: `AgentService` attributes 256 (64-bit). `DeployKeyValue` attributes 260
  (64-bit plus registry key path) with condition `DEPLOY_KEY`.
- `ServiceInstall`: type 16 (own process), start 2 (auto), `LocalSystem`. After the fix-up,
  ErrorControl is 32769 (normal | vital).
- `ServiceControl`: Event 163 (start on install, stop on install and uninstall, delete on
  uninstall), Wait 1.
- `Upgrade`: two rows, `WIX_UPGRADE_DETECTED` (older, exclusive) and `WIX_DOWNGRADE_DETECTED`
  (newer, detect only). `LaunchCondition` is `NOT WIX_DOWNGRADE_DETECTED`.
  `RemoveExistingProducts` sits at 1401 (after InstallValidate, matching WiX's default).
- Summary information: Template `x64;1033`, page count 500, word count 2 (compressed,
  elevation required). wixl assigns a fresh random PackageCode on every build.
- Standard actions are scheduled only for the tables in use. `StopServices`, `DeleteServices`,
  `InstallServices` and `StartServices` carry the condition `VersionNT`.

## Exact build commands

On Linux (a Docker image in the real pipeline; WSL for this spike):

```bash
sudo apt install msitools wixl          # Debian/Kali. Fedora: dnf install msitools
# The exe comes from the Windows MSVC build here; on Linux it would come from cargo-xwin or zigbuild
bash scripts/build-msi.sh agent/target/release/rustrmm-spike-agent.exe 0.1.0
```

`build-msi.sh` runs these steps, once per variant:

```bash
wixl -a x64 -D Version=0.1.0 -D AgentExe=/path/rustrmm-spike-agent.exe \
     -o out/RustRMMSpikeAgent.msi wix/agent.wxs
msibuild out/RustRMMSpikeAgent.msi \
  -q "UPDATE Property SET Value='DEPLOY_KEY;WIX_DOWNGRADE_DETECTED;WIX_UPGRADE_DETECTED' WHERE Property='SecureCustomProperties'" \
  -q "UPDATE ServiceInstall SET ErrorControl=32769 WHERE ServiceInstall='AgentServiceInstall'"
# then: msiinfo export <table> | regex assertions; the build fails on any mismatch
```

The hardened variant also gets this:

```bash
msibuild out/RustRMMSpikeAgent-hardened.msi \
  -q 'CREATE TABLE `MsiLockPermissionsEx` (`MsiLockPermissionsEx` CHAR(72) NOT NULL, `LockObject` CHAR(72) NOT NULL, `Table` CHAR(32) NOT NULL, `SDDLText` LONGCHAR NOT NULL, `Condition` CHAR(255) PRIMARY KEY `MsiLockPermissionsEx`)' \
  -q "INSERT INTO \`MsiLockPermissionsEx\` (\`MsiLockPermissionsEx\`, \`LockObject\`, \`Table\`, \`SDDLText\`) VALUES ('LockSourcePackage', 'RegSourcePackage', 'Registry', 'D:P(A;CI;KA;;;SY)(A;CI;KA;;;BA)')" \
  -q "INSERT INTO \`MsiLockPermissionsEx\` (...) VALUES ('LockDeployKey', 'RegDeployKey', 'Registry', 'D:P(A;CI;KA;;;SY)(A;CI;KA;;;BA)')"
```

On Windows (the spike's actual path: MSVC exe, then wixl in WSL, then an msi.dll read-back):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build.ps1      # -Distro kali-linux -Version 0.1.0
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\inspect-msi.ps1 -Msi out\RustRMMSpikeAgent-hardened.msi
```

Cross-build check, from Windows:

```powershell
rustup target add x86_64-unknown-linux-musl aarch64-unknown-linux-musl
cargo install cargo-zigbuild            # 0.24.1 was already installed
cargo zigbuild --release --target x86_64-unknown-linux-musl  --manifest-path hello-cross\Cargo.toml
cargo zigbuild --release --target aarch64-unknown-linux-musl --manifest-path hello-cross\Cargo.toml
# Optional: the Windows agent itself, no MSVC SDK involved
rustup target add x86_64-pc-windows-gnu
cargo zigbuild --release --target x86_64-pc-windows-gnu --manifest-path agent\Cargo.toml
```

Results: x86_64 musl is a static `ELF64 x86-64 EXEC` (386 KB, stripped) and prints
`hello from x86_64 (linux)` in WSL. aarch64 musl is a static `ELF64 AArch64 EXEC` (370 KB). The
windows-gnu agent build links (windows-sys 0.61 raw-dylib works with zig as linker) and its
`--console` pass behaves the same as the MSVC build.

## wixl 0.106 limitations hit

wixl handles unsupported input in three ways: a hard error ("unhandled child"), a
`GLib-GObject-CRITICAL ... has no property named X` warning followed by success, or **silence**.
Silence is the dangerous case, so the build asserts the emitted rows instead of trusting the
`.wxs`. `scripts/probe-wixl.sh` reproduces every row below.

| WiX v3 construct | wixl 0.106 behaviour | What the spike does |
|---|---|---|
| `Property/@Secure` | **Silently ignored**, even on properties with values | `msibuild` UPDATE of `SecureCustomProperties` |
| `ServiceInstall/@Vital` | **Silently ignored** (ErrorControl stays 1) | `msibuild` UPDATE `ErrorControl=32769` |
| Explicit `SecureCustomProperties` together with `MajorUpgrade` | Build fails with a bare `libmsi_query_execute` (duplicate row; wixl writes its own) | Patch after the build instead |
| `Property/@Hidden`, `Property/@Admin` | Warning, ignored | Explicit `<Property Id="MsiHiddenProperties" Value="DEPLOY_KEY"/>` (works) |
| `Package/@Platform`, `Package/@InstallPrivileges` | Warning, ignored | `wixl -a x64`. Word count is already 2 (elevation required) |
| `Permission`, `PermissionEx` (on RegistryKey, RegistryValue, CreateFolder) | Hard error | `msibuild` creates and fills `MsiLockPermissionsEx` (hardened variant). msi.dll reads it back |
| `ServiceConfig` (delayed auto-start), `ServiceConfigFailureActions` | Hard error | The agent should set these itself (`ChangeServiceConfig2W`) |
| `SetProperty` | Hard error | `<CustomAction Id=.. Property=.. Value=../>` (type 51) works |
| `<Condition>` with a CDATA body | Hard error ("unhandled child Condition node (null)") | Plain text with `&gt;`/`&lt;` works |
| `<?ifdef?>` / `<?ifndef?>` | Preprocessor breaks ("Premature end of data", "invalid variable") | Pass every `$(var.X)` with `-D`. `<?define?>` works |
| Extensions (`util:*`, for example CloseApplication, RemoveFolderEx, ServiceConfig, XmlFile) | Hard error. Only the `ui` extension ships | None. Keep that logic in the agent |
| PE version resources | Not read: `File.Version` stays empty and `MsiFileHash` is emitted (checked with `whoami.exe`) | `File/@DefaultVersion` works if needed |
| `-a arm64` / `aarch64` | `arch of type 'arm64' is not supported` (x86 and x64 work) | Untested route: build with `-a x64`, then `msibuild -s "<subject>" "<author>" "Arm64;1033" "{new-guid}"`. This keeps every other summary field and sets a new PackageCode |
| `CustomAction/@HideTarget` | **Silently ignored**: a deferred no-impersonate DLL action comes out as type 3073 instead of 11265 | `msibuild` UPDATE of the Type column, if the DLL route in finding 5 is taken |
| `<Custom Before="InstallFinalize">` with a condition | **Silently mis-sequenced** to 1, 2, … (before InstallInitialize, so a deferred action would fail to run). Without the condition it lands at 6401 | Use `Sequence="…"` or `After="…"` (both correct with conditions) and assert the InstallExecuteSequence rows |

Verified working: Product, Package, Media, MediaTemplate, Directory (including
ProgramFiles64Folder), `Component/@Win64`, component `<Condition>`, File, ServiceInstall
(Type, Start, ErrorControl, Account, Description, Arguments), ServiceDependency, ServiceControl
(Start, Stop, Remove, Wait), RegistryValue (`@Id`, `@KeyPath`), RegistrySearch (`Win64`),
MajorUpgrade, plain Property, CustomAction type 51, deferred no-impersonate exe custom
actions (type 3090), `Binary` plus DLL custom actions (`BinaryKey`/`DllEntry`), RemoveFolder,
LaunchCondition (plain text), `<?define?>`, `-D`, `InstallScope="perMachine"` (emits
ALLUSERS=1), and a new PackageCode per build.

## Design findings

1. **Race (confirmed): the service starts before the product is registered.** `StartServices`
   (5900) runs before `RegisterProduct` (6100) and `PublishProduct` (6400) in the same execution
   script. Timeline from test B's install log and agent log:

   | Time | Event |
   |---|---|
   | 21.110 | msiexec runs `ServiceControl(Action=1)` to start the service |
   | 21.155 | The agent's first `MsiGetProductInfoW(InstallSource)` returns 1605; `MsiEnumRelatedProductsW` returns `[]` |
   | 21.661 | msiexec runs `ProductRegister(InstallSource=…\stage-b\)` |
   | 26.167 | The agent's second attempt, after its 5 s retry interval, succeeds |

   - The real gap is about 0.5 s. The agent should retry with backoff starting around 250 ms
     instead of the spike's fixed 5 s.
   - The registry path does not have this problem, because `WriteRegistryValues` (5000) runs
     before `StartServices`. Test A resolved on its first attempt.
   - Alternative: `[OriginalDatabase]`, written to the registry as `SourcePackage`, was
     readable at 21.155, before registration, so it avoids the race entirely. For GPO, though,
     the MSI source list behind `InstallSource` is the authoritative location.
   - Alternative: `MsiEnumRelatedProductsW(UpgradeCode)` returned the ProductCode once the
     product was registered. The agent can use it to find its ProductCode without hard-coding
     it, which survives a deliberate ProductCode change.
2. **Starting the service must never fail.** In a silent install, a service that fails to start
   (error 1920) rolls back the whole install. Under GPO that becomes a failed install on every
   boot. The agent reports `Running` immediately and handles every error internally.
3. **Fixed ProductCode.** While the product is installed, running a different build with the
   same ProductCode is refused with 1638 (confirmed by test B2). That is the intended behaviour:
   updates go through the agent's binary swap. MajorUpgrade stays in the package as an escape
   hatch for a deliberate ProductCode change.
   - Repair is hidden in Add/Remove Programs, but `msiexec /f` or a GPO "redeploy" still runs
     it. Because wixl leaves the file unversioned, repair compares hashes and puts the MSI's
     older exe back over a self-updated one.
   - Fix: give the agent a VERSIONINFO resource and set `File/@DefaultVersion` from the same
     version. Default `REINSTALLMODE=omus` then skips a newer file on disk.
4. **The deploy key in the registry is readable by every local user (confirmed).**
   - Test A measured the default DACL as
     `D:AI(A;CIID;KR;;;BU)(A;CIID;KA;;;BA)(A;CIID;KA;;;SY)(A;CIIOID;KA;;;CO)(A;CIID;KR;;;AC)…`.
     Users and all app containers can read it.
   - The spike deletes the value as soon as it has used it (confirmed in test A).
   - The hardened variant's injected `MsiLockPermissionsEx` works: test C measured
     `D:P(A;CI;KA;;;SY)(A;CI;KA;;;BA)`, a protected DACL holding SYSTEM and Administrators
     only, and the agent running as LocalSystem still read the key.
   - It uses SDDL with well-known SIDs, so it does not depend on the OS language (the legacy
     `LockPermissions` table does).
5. **The deploy key leaks into verbose MSI logs (confirmed; the 2 failed checks).**
   - `MsiHiddenProperties` masks `DEPLOY_KEY` in the command line, in `PROPERTY CHANGE` and in
     the property dump.
   - It does **not** mask the Registry-table write. Both tests A and C logged
     `Executing op: RegAddValue(Name=DeployKey,Value=PROPbc56…,)` (a dummy key).
   - Verbose logs exist only when `/l*v`, the `Logging` policy or `MsiLogging` asks for them,
     and SYSTEM's logs in `C:\Windows\Temp` are not readable by Users. But deployment tools
     often turn verbose logging on and collect the logs centrally.

   Options, best first:
   1. Prefer the sidecar `deploy.key`. Test B wrote nothing secret to any log. Tools that can
      ship a folder (GPO, SCCM, an Intune Win32 app) can carry the file.
   2. If the property must stay, do not route it through the Registry table. Use a deferred,
      no-impersonate DLL custom action that receives the key as `CustomActionData` and writes
      it somewhere only SYSTEM can read:
      - add the action's name to `MsiHiddenProperties`;
      - set `msidbCustomActionTypeHideTarget` (0x2000). wixl ignores `HideTarget`, so patch
        type 3073 to 11265 with `msibuild`;
      - schedule it with explicit `Sequence=` (see the limitations table).

      This route was not tested at install time.
   3. Whatever the route, treat the key as a low-value enrolment token (finding 6), so a leaked
      log costs at most one revocable token.
6. **A sidecar `deploy.key` on a GPO share is effectively semi-public.** Every domain computer,
   and usually every user, can read it. Treat deploy keys as tenant-scoped, revocable,
   rate-limited enrolment tokens that the server exchanges for a per-device credential.
   - Use a base32 or base64url alphabet. The Registry table treats values beginning with `#`
     specially, and an alphabet without `#`, `[` or `]` sidesteps formatting surprises.
   - The spike logs only a 4-character prefix and the length.
7. **Uninstall is clean, and Restart Manager stays out of the way.**
   - Every uninstall exited 0 in about 2 s and removed the service, the install directory, the
     ARP entry and the now-empty `HKLM\SOFTWARE\RustRMMSpike` key. No `RemoveFolders` or
     `ForceDeleteOnUninstall` was needed.
   - In test E, msiexec sent the stop at 54.384 and the retrying agent logged it at 54.385.
     msiexec's own one-second status poll accounts for the rest of the wait.
   - The log shows Restart Manager noticing the authored `ServiceControl` and leaving the
     service alone (`Detected that the service RustRMMSpikeAgent will be stopped due to a
     service control action authored in the package`), so `MSIRESTARTMANAGERCONTROL` is not
     needed.
   - Windows Installer quoted the service ImagePath (`"C:\Program Files\RustRMM Spike\…"`), so
     there is no unquoted-path issue.
8. **Agent data survives uninstall.** `ProgramData\RustRMMSpike` is not managed by the MSI.
   wixl has no `util:RemoveFolderEx`. Either leave the data in place or have a deferred exe
   custom action (`agent.exe --uninstall-cleanup`, type 3090, which wixl supports) delete it.
   A directory created by LocalSystem under ProgramData inherits a DACL that Users can read,
   so the real agent must protect its data directory.

## cargo-xwin from inside WSL (not run)

This needs Rust in WSL (user-space rustup is fine), `clang` and `lld` (apt, so sudo), and
`cargo install cargo-xwin`. Its first build downloads the MSVC CRT and Windows SDK (several
hundred MB), which implicitly accepts Microsoft's licence. That decision, including whether a
CI image may cache those files, belongs to you or a legal review, so the spike stopped here.
To try it yourself in Kali:

```bash
sudo apt install clang lld
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
. ~/.cargo/env && rustup target add x86_64-pc-windows-msvc && cargo install --locked cargo-xwin
cd /mnt/c/Users/Kyle/Development/Projects/Personal/rustrmm/spikes/msi-crossbuild/agent
cargo xwin build --release --target x86_64-pc-windows-msvc    # downloads the CRT+SDK = licence acceptance
```

There is a licence-free alternative that the spike did verify:
`cargo zigbuild --target x86_64-pc-windows-gnu` links the agent with zig's bundled mingw-w64.
Trade-offs:

- The binary is larger. Set `strip`; 1.0 MB versus 255 KB was not compared like for like.
- It uses the mingw CRT instead of MSVC's.
- C dependencies (ring, aws-lc-rs) are compiled by `zig cc`.
- The ARM64 equivalent would be `aarch64-pc-windows-gnullvm` (untested).

## Install tests (elevated)

**Status: run on 2026-11-17** on Windows 11 Enterprise 10.0.26200, launched through a UAC
prompt. **76 of 78 checks pass.** The only failures are "verbose MSI log does not contain the
deploy key" in A and C (design finding 5).

| Test | Outcome |
|---|---|
| A: property + sidecar | Install exit 0. Key taken from the registry on the first attempt; the property beat the sidecar. Agent deleted the value. `SourcePackage` held the staged MSI path; nothing went to WOW6432Node. Service Auto/LocalSystem/Running with a quoted ImagePath. ARP: `RustRMM Spike Agent 0.1.0`, `NoRepair=1`, `NoModify=1`, `UninstallString=MsiExec.exe /X{7C26…}`. **Key leaked in the `/l*v` log through RegAddValue.** Clean uninstall in 2 s. |
| B: sidecar only (GPO path) | Install exit 0. Key taken from `stage-b\deploy.key` through `MsiGetProductInfoW(InstallSource)` after one 1605 retry (finding 1). No `DeployKey` value written. Same service and ARP results as A. Clean uninstall. |
| B2: same ProductCode, other build | Exit **1638**; the installed product was untouched. |
| E: no key | Install exit 0. The agent kept retrying (it got InstallSource but no `deploy.key`) while the service stayed Running. Uninstall stopped it at once; clean uninstall. |
| C: hardened MSI + property | Install exit 0. DACL protected, SYSTEM + Administrators only. The agent (LocalSystem) still read the key. **Same log leak as A.** Clean uninstall. |

To rerun, from an **elevated** Windows PowerShell:

```powershell
cd C:\Users\Kyle\Development\Projects\Personal\rustrmm\spikes\msi-crossbuild
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\test-install.ps1
```

Or from a normal PowerShell, which raises the UAC prompt itself:

```powershell
Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','C:\Users\Kyle\Development\Projects\Personal\rustrmm\spikes\msi-crossbuild\scripts\test-install.ps1'
```

The script takes about 2 minutes and leaves the machine clean. Its report goes to
`out\test-results\results.txt`, next to every msiexec `/l*v` log and the agent's `msi.log` and
`msi-agent.conf` for each test. `C:\ProgramData\RustRMMSpike` is shared with the other spikes
(`frames\`, `logs\`, `conpty-service.log`), so the script deletes only its own two files there.
Its checks:

- **A (property + sidecar):** install exits 0. The key comes from the registry, so the property
  wins, and the agent deletes the value. Nothing is written under WOW6432Node. The service is
  auto-start, LocalSystem, running, with a quoted path in `C:\Program Files`. Add/Remove
  Programs shows the entry with `NoRepair=1` and `NoModify=1`. The key is absent from the
  verbose log. Uninstall exits 0 and removes the service, directory, ARP entry and registry key.
- **B (sidecar only, the GPO case):** the key comes from `deploy.key` next to the MSI, found
  through `MsiGetProductInfoW(InstallSource)`. The test reports how many 1605 retries happened
  first. **B2:** a different build with the same ProductCode exits 1638.
- **E (no key):** install still succeeds and the agent keeps retrying. Uninstall stops it within
  60 s and the agent logs the stop.
- **C (hardened):** the `HKLM\SOFTWARE\RustRMMSpike` DACL is protected and holds only S-1-5-18
  and S-1-5-32-544. The agent, running as LocalSystem, still reads the key.

Manual equivalents for (a) and (b), also elevated:

```powershell
# (a) property; it must win over a sidecar file
# (the folder is shared with other spikes: delete only this spike's two files)
Remove-Item C:\ProgramData\RustRMMSpike\msi.log, C:\ProgramData\RustRMMSpike\msi-agent.conf -ErrorAction SilentlyContinue
msiexec /i out\RustRMMSpikeAgent.msi DEPLOY_KEY=PROPTESTKEY0001 /qn /l*v out\a-install.log
Get-Content C:\ProgramData\RustRMMSpike\msi.log, C:\ProgramData\RustRMMSpike\msi-agent.conf
Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{7C26286F-1047-4CA2-B343-2797FAD7228C}' |
  Select-Object DisplayName, DisplayVersion, NoRepair, NoModify, InstallSource
msiexec /x '{7C26286F-1047-4CA2-B343-2797FAD7228C}' /qn /l*v out\a-uninstall.log

# (b) sidecar deploy.key next to the MSI, no property (the GPO path)
New-Item -ItemType Directory out\share -Force | Out-Null
Copy-Item out\RustRMMSpikeAgent.msi out\share\
Set-Content out\share\deploy.key FILETESTKEY0002 -NoNewline -Encoding ASCII
Remove-Item C:\ProgramData\RustRMMSpike\msi.log, C:\ProgramData\RustRMMSpike\msi-agent.conf -ErrorAction SilentlyContinue
msiexec /i out\share\RustRMMSpikeAgent.msi /qn /l*v out\b-install.log
Start-Sleep 15; Get-Content C:\ProgramData\RustRMMSpike\msi.log
msiexec /x '{7C26286F-1047-4CA2-B343-2797FAD7228C}' /qn /l*v out\b-uninstall.log
```

## Recommendations for `packaging/windows/`

1. **Adopt wixl, but keep the `.wxs` to the verified subset.** Pin the msitools version in the
   Docker image (Debian packages `msitools` and `wixl`). Keep `scripts/probe-wixl.sh` around
   to re-check any wixl upgrade.
2. **Treat the pipeline as wixl → msibuild fix-ups → assertions:**
   - wixl.
   - `msibuild -q` SQL fix-ups for `SecureCustomProperties`, Vital, `MsiLockPermissionsEx`,
     and the ARM64 template if needed.
   - Golden-table assertions: diff the `msiinfo export` output against committed expected IDT.
     The `expect` calls in `build-msi.sh` are the minimal form of this. Include
     `InstallExecuteSequence`, because wixl can silently mis-sequence a conditional
     `<Custom Before=…>`.
3. **Deploy-key delivery (security, decide before shipping):**
   - Make the sidecar `deploy.key` the primary channel; test B showed it leaves no secret in any
     log.
   - Do not write a `DEPLOY_KEY` property through the Registry table: it leaks into verbose logs
     despite `MsiHiddenProperties` (finding 5). If the property is kept for push tools, move it
     to a hidden-target deferred DLL custom action, and run `test-install.ps1`'s log check
     against it.
   - Keep the `MsiLockPermissionsEx` lock (or an equivalent SYSTEM-only location) for wherever
     the key lands.
4. **Signing order:** Authenticode-sign the exe before wixl, because it is embedded in the cab,
   and sign the MSI last, because any later `msibuild` edit would break the signature. On
   Linux, `osslsigncode` handles both PE and MSI. Not tested in this spike.
5. **Smoke-test on real Windows in CI.** Run `test-install.ps1` on a GitHub-hosted Windows
   runner or VM. ICE validation needs the Windows SDK's msival2/Orca, so run it there too
   rather than on the Linux builder.
6. **Move into the agent what wixl cannot express:**
   - Failure actions and delayed auto-start (`ChangeServiceConfig2W`; windows-service exposes
     `update_failure_actions` and `set_delayed_auto_start`).
   - A protected DACL on the data directory.
   - Consume-and-delete of the registry deploy key.
   - The `InstallSource` retry loop, with backoff starting around 250 ms (the measured gap was
     about 0.5 s).
   - Finding the ProductCode through the UpgradeCode.
7. **Keep one source of truth for identity.** The spike duplicates the ProductCode and
   UpgradeCode in `agent.wxs` and `main.rs`. Generate both, for example from xtask, or by
   passing `-D ProductCode=… -D UpgradeCode=…` and reading the same constants at compile time.
   Stamp the version with `-D Version=` from Cargo metadata, add a VERSIONINFO resource to the
   exe, and set `File/@DefaultVersion` (finding 3). Cross-compiling the resource needs a
   resource compiler on Linux: `llvm-rc` (with cargo-xwin) or `zig rc`/`windres`.
8. **Choose the Windows exe toolchain deliberately.** Option one is `x86_64-pc-windows-msvc`
   through cargo-xwin, which means accepting the Microsoft CRT/SDK licence in CI. Option two is
   `x86_64-pc-windows-gnu` through cargo-zigbuild, which builds today with no licence question.
   Pick one before building the release Docker image.
9. **Validate GPO in a lab domain before relying on it.** Check computer-account read on the
   share, a UNC `InstallSource`, the agent's retry when the share or network is unreachable at
   boot, and whether it is acceptable that GPO redeploy can downgrade the exe (finding 3). None
   of this could be tested on a standalone workstation.
10. **ARM64 Windows:** wixl cannot target it. Try the `msibuild -s … "Arm64;1033"` retarget on
   real ARM64 hardware, with an `aarch64-pc-windows-msvc` or `-gnullvm` exe, before promising
   native ARM64 support. Otherwise ship x64 under emulation.
