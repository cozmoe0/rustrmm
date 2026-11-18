# Deploying the Windows agent with Group Policy

RustRMM ships one generic, per-machine MSI (`RustRMMAgent-x64.msi`). It installs silently, starts
the `RustRMMAgent` service as LocalSystem and enrolls with a **deploy key**. Group Policy can
install it in two ways:

| | Option A — Software Installation | Option B — Startup script |
|---|---|---|
| How | GPO assigns the MSI to computers | A PowerShell startup script runs `msiexec` when the agent is missing |
| Deploy key | `deploy.key` next to the MSI (Software Installation cannot pass properties) | Same `deploy.key` next to the MSI (preferred), or the `DEPLOY_KEY` property as a fallback |
| Removal | Removing the GPO assignment can uninstall the agent | Uninstall separately (script, Intune, console) |
| Best for | Domain-wide rollouts, clean lifecycle | Mixed environments, staged rollouts, when Software Installation is disabled |

Both need a computer restart (or `gpupdate /force` followed by a restart) on each machine.

The agent finds `deploy.key` by asking Windows Installer for the package's install source
(`MsiGetProductInfo … InstallSource`), so nothing secret appears in `msiexec` command lines or
verbose logs. After enrolling, the agent deletes its local copies of the key. Installed agents
never need the key again: revoking it in the console only stops new enrollments.

## 0. Prepare the deploy key and the bundle

1. In the console open **Devices → Deploy agents**, pick the client and site, and create a deploy
   key for this rollout. Recommended settings for a GPO share (treat the key as semi-public):
   - an expiry that covers the rollout window (e.g. 14 days);
   - *maximum uses* close to the number of computers;
   - *allowed domains* set to your AD/DNS domain and *allowed networks* to your office/VPN ranges;
   - *require approval* once the rollout window has passed (new devices then wait in the approval
     queue).
2. Download **Group Policy bundle** (`RustRMM-GPO-<site>.zip`, `GET
   /api/v1/enrollment-tokens/{id}/installer/gpo-bundle`). It contains:

   ```text
   RustRMM\RustRMMAgent-x64.msi
   RustRMM\deploy.key            the deploy key (one line)
   RustRMM\Install-RustRMM.ps1   startup script for option B
   RustRMM\README.txt
   ```

3. Optional: if your organisation signs software, the MSI and the agent exe inside it should be
   Authenticode-signed (`docs/signing.md`); **Settings → Code signing** shows what the server
   distributes.

## 1. Create the share

On a file server:

1. Create a folder, e.g. `D:\Deploy\RustRMM`, and extract the `RustRMM` folder of the bundle into
   it.
2. Share it (e.g. as `RustRMM$`, hidden). **Share permissions:** `Everyone` → Read (NTFS decides).
3. **NTFS permissions** on the folder (Advanced → disable inheritance, convert to explicit):
   - `Domain Computers` → Read & execute
   - `Domain Admins` (or your deployment group) → Full control
   - `SYSTEM` → Full control
   - remove `Users` / `Authenticated Users` write access. Ordinary users do not need to read the
     deploy key; computers read it as their machine account at startup.
4. Note the UNC path: `\\fileserver.corp.example.com\RustRMM$\RustRMM`. Always use the UNC path
   (never a mapped drive letter) in the GPO.

Check from a member computer: `psexec -s cmd /c dir \\fileserver.corp.example.com\RustRMM$\RustRMM`
must list the files (the SYSTEM account authenticates as the computer).

## Option A — Software Installation

1. Open **Group Policy Management** (`gpmc.msc`).
2. Right-click the OU that contains the target computers → **Create a GPO in this domain, and
   Link it here…** → name it `RustRMM agent`.
3. Right-click the GPO → **Edit**.
4. Go to **Computer Configuration → Policies → Software Settings → Software installation**.
5. Right-click → **New → Package…**, browse to the **UNC path** of `RustRMMAgent-x64.msi`
   (`\\fileserver…\RustRMM$\RustRMM\RustRMMAgent-x64.msi`) and choose **Assigned**.
6. Optional — properties of the package:
   - **Deployment** tab → *Uninstall this application when it falls out of the scope of management*
     if leaving the OU should remove the agent.
   - Leave *Do not display this package in the Add/Remove Programs control panel* unticked so local
     admins can see what is installed.
7. Recommended in the same GPO (both under **Computer Configuration → Policies → Administrative
   Templates → System**):
   - **Logon → Always wait for the network at computer startup and logon** → Enabled (otherwise
     fast logon optimisation can delay the install for several restarts).
   - **Group Policy → Specify startup policy processing wait time** → e.g. 60 seconds on slow
     networks.
8. Close the editor. Computers install the agent at their next restart.

Keep `deploy.key` next to the MSI for as long as computers may still install from this share
(new machines joining the OU included). When the rollout window ends and the key expires,
replace `deploy.key` with a fresh key or remove it — the agent then waits for a key instead of
enrolling.

**Upgrades:** do not add new MSIs to the GPO for agent upgrades. Agents update themselves from the
server (signed manifests, staged rollouts, automatic rollback), and the MSI's ProductCode never
changes, so Group Policy never reinstalls or "repairs" an older version.

## Option B — Startup script

1. Create and link a GPO as in steps 1–3 of option A.
2. Go to **Computer Configuration → Policies → Windows Settings → Scripts (Startup/Shutdown)**.
3. Double-click **Startup** → **PowerShell Scripts** tab → **Add…** → **Browse…** and pick
   `Install-RustRMM.ps1` from the UNC path (or copy it into the GPO's own Scripts folder via
   **Show Files…**, keeping the MSI and `deploy.key` on the share).
4. Optionally set *For this GPO, run scripts in the following order* → *Run Windows PowerShell
   scripts first*.
5. Allow the script to run: **Computer Configuration → Policies → Administrative Templates →
   Windows Components → Windows PowerShell → Turn on Script Execution** → Enabled with *Allow
   local scripts and remote signed scripts* — or sign `Install-RustRMM.ps1` with your code-signing
   certificate and use *Allow only signed scripts*.
6. Apply the network wait policy from option A step 7.

What the script does at each startup:

- exits immediately when the `RustRMMAgent` service already exists (idempotent);
- otherwise runs `msiexec /i RustRMMAgent-x64.msi /qn /norestart /l*v %WINDIR%\Temp\RustRMM-install.log`;
- adds `DEPLOY_KEY=…` only when there is no `deploy.key` next to the MSI. With the sidecar file
  the key never appears on a command line or in the verbose log.

If you place the script in the GPO's Scripts folder instead of the share, keep `deploy.key` next
to the MSI anyway and change `$Msi` in the script to the UNC path.

## 2. Verify

On a target computer after a restart:

```powershell
Get-Service RustRMMAgent                      # Running
& "C:\Program Files\RustRMM\Agent\rustrmm-agent.exe" status
Get-WinEvent -LogName Application -MaxEvents 50 | Where-Object ProviderName -eq 'MsiInstaller'
gpresult /h $env:TEMP\gp.html; start $env:TEMP\gp.html    # the GPO was applied?
```

The device appears in the console under the deploy key's site (or in **Devices → Approvals** when
the key requires approval). Option B also leaves `C:\Windows\Temp\RustRMM-install.log`.

Common problems:

| Symptom | Cause / fix |
|---|---|
| Event 102/108 "The install of application RustRMM Agent from policy … failed" | The computer account cannot read the share (check NTFS for `Domain Computers`) or the package was added through a mapped drive |
| Installed but never appears in the console | `deploy.key` missing next to the MSI, expired, out of uses, or the computer's domain/network is not allowed — the server's refusal reason (`invalid_token`, `expired`, …) is in `C:\ProgramData\RustRMM\Agent\logs` |
| Appears as *pending* | The deploy key requires approval, or the same hardware enrolled before (possible clone/reinstall) |
| Needs several restarts | Fast logon optimisation: enable *Always wait for the network at computer startup and logon* |
| Behind an HTTP proxy | Not supported yet: allow direct outbound TCP from the computers to the agent URL |

## 3. Locking features per OU

The MSI property `DISABLE_FEATURES` writes a machine-local capability lock the server cannot
override, e.g. no remote shell or desktop on domain controllers:

- Option B: add `'DISABLE_FEATURES=shell,desktop,scripts'` to `$msiArgs` in a copy of the script
  used by a separate GPO linked to the Domain Controllers OU.
- Option A: Software Installation cannot pass properties; create a transform (`.mst`) that sets
  `DISABLE_FEATURES` with Orca and add it on the package's **Modifications** tab, or use option B
  for those machines.

Valid names: `shell`, `files`, `system`, `power`, `scripts`, `patching`, `software`, `desktop`,
`escrow`, `network`.

## 4. Antivirus and attack surface reduction

Defender's ASR rule *Block executable files from running unless they meet a prevalence, age, or
trusted list criterion* blocks new unsigned executables. Sign the agent (`docs/signing.md`), or
add an ASR exclusion for `C:\Program Files\RustRMM\Agent\rustrmm-agent.exe`. Third-party AV
products may need an exclusion for the same path and for `C:\ProgramData\RustRMM\Agent`.
