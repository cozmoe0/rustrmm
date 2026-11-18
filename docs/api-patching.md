# Patching and software API (Phase 7)

This document is the contract for operating-system patching (Windows Update, Linux package managers
and macOS report-only), patch approvals and rings, maintenance-window installs, reboot handling,
compliance reporting, the software explorer, the software library and software deployments.

The conventions match `api-automation.md`:

- Routes live under `/api/v1`.
- Requests use the session cookie and `X-CSRF-Token`.
- Errors use the standard envelope.
- Results are filtered by the caller's scope.

Patch behaviour is configured through the **`patching` section of the policy document**.

## Permissions

| Permission | Covers |
|---|---|
| `patches.view` | Patch status, catalog, compliance, patch runs |
| `patches.approve` | Approve, decline and defer patches; approval rules; start a patch run now |
| `software.view` | Software explorer, library (read), deployments (read) |
| `software.library` | Manage library packages and uploads |
| `software.deploy` | Install and uninstall packages on devices |

Library packages are installation-wide objects (like scripts), so creating, editing and deleting
them needs `software.library` held **globally**; uploads need `software.library` at any scope.
Creating a policy with a `patching` section, changing or removing that section, deleting such a
policy, and assigning or unassigning it also need `patches.approve` over every assignment target
(in addition to `policies.manage`), because auto-approval rules approve patches.

## Policy section `patching`

```jsonc
{
  "patching": {
    "enabled": true,
    "scan_interval_hours": 12,                  // 1–168
    "window": { "cron": "0 2 * * 3", "duration_minutes": 180, "timezone": "UTC" },   // installs only inside the window
    "ring": "broad",                            // pilot | broad | late  (used by delay_days per ring)
    "auto_approve": [                           // evaluated for every newly seen patch
      { "platform": "windows", "classifications": ["SecurityUpdates", "CriticalUpdates"], "severities": [],
        "delay_days": { "pilot": 0, "broad": 7, "late": 21 } },
      { "platform": "linux", "classifications": ["security"], "delay_days": { "pilot": 0, "broad": 3, "late": 10 } }
    ],
    "windows": { "include_drivers": false, "include_feature_updates": false, "include_preview": false },
    "linux": { "mode": "security" },            // security | all  (what "approved" bulk means for distro packages)
    "macos": { "install": false },              // report-only by default (Apple Silicon needs user consent without MDM)
    "reboot": {
      "mode": "prompt",                         // never | prompt | force
      "prompt_deferrals": 3,                    // the user may postpone this many times (60 min each)
      "force_at_window_end": true,              // force when the window closes and a reboot is still pending
      "message": "Your IT team installed updates. Please restart to finish."
    },
    "third_party": { "winget": false }          // also offer winget upgrades as patches (Windows)
  }
}
```

### Validation, defaults and merging

- The section merges like other policy objects: objects deep-merge key by key, other values
  replace. `auto_approve` is a list, so the last layer that sets it supplies the whole list.
- Unknown keys are refused (`422`, `details.path`, e.g. `patching.auto_approve[0].platform`).
- Defaults: `enabled` **false** (a device is patched only when its effective policy sets it),
  `scan_interval_hours` 12 (1–168), `ring` `broad`, `linux.mode` `security`, `macos.install`
  false, `windows.*` false, `third_party.winget` false, `reboot.mode` `prompt`,
  `reboot.prompt_deferrals` 3 (0–10), `reboot.force_at_window_end` true, `reboot.message` the text
  above (at most 500 characters).
- `window.cron` is required when `window` is set; `duration_minutes` 15–1440 (default 180);
  `timezone` an IANA name (default `UTC`). Without a window, nothing installs automatically.
- `auto_approve`: at most 50 rules. `platform` is `windows`, `linux`, `macos` or `winget`.
  `classifications` must come from that platform's list (see the patch model; `macos` and
  `winget` use `os | security | app`); `severities` are `Critical`, `Important`, `Moderate`,
  `Low`. An empty list matches anything; a patch without a severity matches only rules whose
  `severities` is empty. `delay_days` keys are `pilot`, `broad`, `late` (0–365, unset = 0).
- `effective-policy` origins carry `patching.window.cron` (this policy identifies the *policy
  window* of patch runs) and `patching.auto_approve` (the policy whose rules apply).

## Patch model

A **patch** is a catalog entry keyed by `platform` + `key`:

| Platform | `key` |
|---|---|
| Windows | WUA `UpdateID` (revisions collapse to the newest) |
| Linux | `<manager>:<package>:<version>` |
| macOS | the softwareupdate label |
| `winget` | `winget:<id>:<version>` (third-party upgrades on Windows; classification `app`) |

```jsonc
// Patch
{ "id": "…", "platform": "windows", "key": "…", "kb": "KB5039212" | null,
  "title": "2026-11 Cumulative Update for Windows 11 Version 25H2 for x64-based Systems (KB…)",
  "classification": "SecurityUpdates",      // Windows: SecurityUpdates | CriticalUpdates | UpdateRollups | Updates | Definitions | Drivers | FeaturePacks | Upgrades | ServicePacks | Tools
                                            // Linux: security | bugfix | enhancement | other   macOS: os | security | app
  "severity": "Critical" | "Important" | "Moderate" | "Low" | null,
  "size_bytes": 812000000, "reboot_required": true, "release_date": "…", "first_seen_at": "…",
  "description": "…", "support_url": "…" | null, "cves": ["CVE-2026-…"],
  "approval": { "status": "approved", "source": "rule" | "manual", "approved_at": "…", "by_name": "…" }
             | { "status": "declined", … } | { "status": "deferred", "until": "…" } | { "status": "none" },
  "devices": { "missing": 41, "installed": 120, "failed": 2, "pending_reboot": 5 } }
```

Approvals can be global or scoped to a client. A client-level decision overrides the global one for
that client's devices.

Approval details:

- There is at most one decision per patch and scope. Precedence for a device in client C: a
  manual decision for C, then a manual global decision, then a rule approval for C. Rule
  approvals never override a manual decision.
- An expired deferral counts as no decision at its level (the next level applies).
- `approval` objects are `{ status, source, at, by_name, client_id }` (`client_id` is `null` for a
  global decision), plus `approved_at` for approvals and `until` for deferrals. In
  `GET /patches` the decision shown is the one that applies to `client_id` when given, otherwise
  the global one; in device views it is the one that applies to the device's client.

**Per-device patch state.** For each device and patch the state is one of `missing`, `downloaded`,
`installing`, `installed`, `failed`, `pending_reboot` or `superseded`. Each state also records
`detected_at`, `installed_at`, `last_error` and `attempts`.

`devices` counts in a Patch cover the active devices the caller can see: `missing` includes
`downloaded` and `installing`, `installed` includes `superseded`.

## Agent protocol additions

| Message | Direction | Shape |
|---|---|---|
| `Command::PatchScan` | server → agent (signed) | `{ include_drivers, include_feature_updates, include_preview, third_party_winget }` |
| `PatchReport` (`"patch_report"`) | agent → server | `{ scanned_at, source: "wsus" \| "windows_update" \| "apt" \| "dnf" \| "zypper" \| "pacman" \| "apk" \| "softwareupdate", available: [AgentPatch], installed_recent: [AgentPatch], pending_reboot, reboot_reasons, last_install_at, error? }` |
| `Command::PatchInstall` | server → agent (signed) | `{ run_id, keys: [key], reboot: { mode, deferrals, message, deadline_unix }, window_end_unix }` |
| `CommandResult` data for `PatchInstall` | agent → server | `{ results: [{ key, status: "installed" \| "failed" \| "pending_reboot", hresult?, error? }], reboot_required, rebooting: bool, deferrals_used }` |

Both commands need the local capability `patching` (`features::PATCHING`); `SoftwareAction`
needs `software` (`features::SOFTWARE`).

Protocol details:

- `scanned_at` and `last_install_at` are agent-clock **unix milliseconds** (the server clamps
  them to "now"). `PatchReport` also carries `cmd_id` (the scan it answers; empty when
  unsolicited). When `error` is set the lists are empty and the server does not reconcile.
- `AgentPatch` is `{ key, platform?, kb?, title, classification, severity?, size_bytes?,
  reboot_required, release_date?, description, support_url?, cves, package?, version? }`;
  `release_date` is RFC 3339 (or `YYYY-MM-DD`). `platform` is set only to `"winget"` for winget
  upgrades (the catalog platform is otherwise the device's operating system). Entries of
  `installed_recent` add `installed_at` (RFC 3339), `result` (`succeeded` | `failed`) and
  `hresult`.
- The `PatchScan` command result is `succeeded` with `{ available, source, duration_ms }` (or
  `failed` with the error); the report itself arrives as the `patch_report` message.
- `PatchInstall.run_id` names the patch run (immediate installs create a run too).
  `reboot.deadline_unix` is the window end when `force_at_window_end` is set, otherwise `null`;
  `window_end_unix` is `null` outside a window.
- The agent reports `running` when it accepts an install. When a restart has to be negotiated
  it reports `running` again with the per-key `results` and `phase: "awaiting_reboot"` (the
  server applies the states at once), then the final `succeeded` result after the negotiation.
  Keys missing from the final `results`, and all keys of a `failed` or `rejected` command,
  count as failed.
- Results and reports of long-running work are queued in the agent's memory and delivered
  after a reconnect (not after an agent restart). Scans, installs and software actions run one
  at a time per device.

**Windows.** The agent uses the Windows Update Agent COM API (`Microsoft.Update.Session`):

- Search criteria: `IsInstalled=0 and IsHidden=0`, adjusted by policy (`Type='Software'` unless drivers are included).
- Download and install happen on a dedicated MTA thread, with progress logged.
- WSUS settings are honoured automatically.

It also reports installed history, using the last 100 entries of `QueryHistory`.

Windows details:

- Only installation entries of the history are reported. The source is `wsus` when the
  `WindowsUpdate\AU\UseWUServer` policy is 1 and `WUServer` is set, otherwise `windows_update`.
- Classifications are mapped from the `UpdateClassification` category id (locale independent);
  updates without one are `Drivers` (driver updates) or `Updates`. `MsrcSeverity` gives the
  severity. `Upgrades` are left out unless `include_feature_updates`, titles containing
  "Preview" unless `include_preview`, drivers unless `include_drivers`.
- Installs search again and install exactly the requested update ids (EULAs are accepted).
  Download and install are synchronous batch calls on the MTA thread; progress is logged per
  phase and per update. An id that is no longer offered fails with "no longer offered by Windows
  Update (installed or superseded)"; the next scan reconciles it.
- winget upgrades (`third_party.winget`) come from `winget upgrade` and install with
  `winget upgrade --id <id> --exact --silent --accept-package-agreements --accept-source-agreements`.

**Linux.** Commands run with absolute paths and a non-interactive environment (`DEBIAN_FRONTEND=noninteractive`):

| Manager | Scan | Install |
|---|---|---|
| apt | `apt-get update` then `apt list --upgradable` (security by origin `-security`) | `apt-get install --only-upgrade -y <pkgs>` |
| dnf (dnf 4 and dnf5) | `dnf -q check-update` + `dnf -q updateinfo list` (dnf5 aliases of `check-upgrade` and `advisory list`) | `dnf -y upgrade <pkgs>` |
| zypper | `zypper -n lu` / `lp` | `zypper -n up <pkgs>` |
| pacman | `checkupdates` | `pacman -S --noconfirm <pkgs>` |
| apk | `apk update` then `apk version -l '<'` | `apk upgrade <pkgs>` |

Linux details:

- The environment is cleared and set to `PATH=/usr/local/sbin:…:/bin`, `LC_ALL=C`,
  `DEBIAN_FRONTEND=noninteractive`, `APT_LISTCHANGES_FRONTEND=none` and `NEEDRESTART_MODE=a`.
  apt installs also pass `-o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold`.
- dnf lists **all** advisory types (`updateinfo list`, not only `--security`) so bugfix and
  enhancement updates are classified too; `Important/Sec.` style entries give the severity.
  dnf5's output is parsed too: its repository-loading lines and section headers
  (`Upgrades`, `Obsoleting packages`) are skipped, and its `advisory list` table
  (`Name Type Severity Package Issued`) gives the type and the severity column; the package is
  the first NEVRA with a known architecture on the line.
  apt marks suites ending in `-security` as `security` and `-updates`/`-proposed` as `bugfix`.
  zypper packages named in a needed patch's summary ("Security update for openssl-3") take that
  patch's category and severity. pacman and apk updates are `other`.
- The package of a dnf patch is `name.arch`. Installs upgrade the package to its newest candidate;
  zypper exit codes 102 (reboot needed) and 103 count as success. A restart is pending when
  `/var/run/reboot-required` exists or `needs-restarting -r` says so.
- Report-only scans (the agent self-test) skip the list refresh (`apt-get update`, `apk update`;
  `dnf -C`, `zypper --no-refresh`) so they need no root.

**macOS.** `softwareupdate --list --no-scan` after a background `--background` refresh. Installs run
only when `macos.install` is true (`softwareupdate -i <label>`).
The `--background` refresh is asynchronous, so a scan lists the previous catalogue result. Labels
starting with "macOS" are `os`, security responses and XProtect data are `security`, the rest
`app`; "Action: restart" sets `reboot_required`.

**Reboot prompts.** The prompt is handled entirely by the agent service:

- **Windows:** `WTSSendMessageW` with `MB_YESNO` and a timeout. "No" means defer, and the prompt
  comes back 60 minutes later. When deferrals run out, or the window ends with `force_at_window_end`
  set, the agent runs `shutdown /r /t 300 /c <message>`.
- **Linux:** `wall` plus `shutdown -r +5`.
- **No user signed in:** the agent reboots immediately when the mode allows it.

Reboot details: the prompt waits 10 minutes for an answer, and no answer counts as a
postponement. "Immediately" means a 30-second delay (60 seconds after "Yes") so the final
result reaches the server first. Unix has no interactive prompt, so `prompt` behaves like
`force` there (macOS also uses `shutdown -r +5`). The final result's `rebooting` says whether a
restart was scheduled and `deferrals_used` how often the user postponed.

## Server behaviour

- **Scans.** The scheduler sends `PatchScan` every `scan_interval_hours` to online devices whose
  effective policy enables patching, and after every successful install.
- **Report ingestion.** Each `PatchReport` upserts catalog entries and per-device states. Patches
  missing from a new report while previously missing become `installed` (or `superseded`).
- **Auto-approval.** Rules are evaluated when a patch is first seen. Delay days count from
  `release_date` (or `first_seen_at` when there is no release date) and vary by the device's ring.
  A patch is *effective-approved* for a device when it is approved and `now ≥ release + delay(ring)`.
- **Installs.** When a device's window opens, the server sends `PatchInstall` with every
  effective-approved missing patch for that device. Offline devices are handled at their next
  connect, if that is still inside the window.
- **Patch run.** Each window opening creates a patch run per policy window. Its per-device results
  are visible like job results.
- **Compliance.** A device is *compliant* when it has no effective-approved patch missing for more
  than 7 days, and no failed install that is still missing.
- **Events.** `patches.changed` with `{ device_id? }` and `patch_run.updated` with `{ run_id, counts }`.
- **Audit.** `patch.approved`, `patch.declined`, `patch.deferred`, `patch_rule.*` and `patch_run.started` are recorded.

How the server applies these rules:

- **Scheduler.** It runs every 30 seconds. Scheduled scans are not written to command history;
  scans from `POST /devices/{id}/patches/scan` are. A device is also scanned when it connects
  with a scan due, with a restart pending or with an install in flight, and after an install
  that installed something without restarting.
- **Ingestion.** A patch still listed keeps `missing` (and `failed` stays `failed`); an
  `installed`, `superseded` or `pending_reboot` patch that is listed again (`pending_reboot`
  only once the report no longer has a pending restart) becomes `missing`. A previously missing
  patch that disappears becomes `installed` when the history lists it or an install was in
  flight; otherwise Windows updates become `superseded`, package patches become `superseded`
  when a newer version of the same package is listed, and `installed` otherwise.
  `pending_reboot` turns `installed` when the report shows no pending restart.
- **Auto-approval.** Rules run when a patch is seen for the first time **in a client** (the
  first device of that client to report it), with the reporting device's effective rules. The
  first matching rule records a client-scoped approval (`source: "rule"`) carrying that rule's
  `delay_days` and policy. Later policy changes do not re-evaluate patches already seen.
- **Effective approval and installs.** Manual approvals have no ring delay. Linux `security`
  mode only installs rule-approved patches classified `security` (manual approvals always
  count); macOS patches install only with `macos.install`, winget patches only with
  `third_party.winget`. A failed patch is retried in later windows up to 3 attempts.
- **Patch runs.** One run per policy window (the policy that set `window.cron`) and window
  start. Devices with nothing effective-approved missing are not part of the run. Offline devices
  wait as `pending` and become `skipped` when their window ends; an install that reports nothing
  for 6 hours after its window ended fails. Result statuses: `pending`, `running`, `succeeded`,
  `failed`, `pending_reboot` (installed, restart postponed), `skipped`, `cancelled`. A run is
  `completed` once nothing is pending or running.
- **Immediate installs** create a run with `policy_id: null`, `policy_name: "Immediate install"`
  and `trigger: "manual"`.
- **Alerts.** A failed patch-run result raises the server-side alert `patching.install_failed`
  (`source: "server"`, `check_type: "patching"`, warning); the device's next successful result
  resolves it. Results also write `patch.installed` / `patch.install_failed` to the timeline.
- **Compliance.** Only devices that reported at least one successful scan count. "Missing for
  more than 7 days" is measured from the later of the detection and the moment the patch became
  effective-approved.
- **Events.** `patches.changed` is published per client (`device_id` set for device changes).
  `patch_run.updated` is published per client with that client's counts
  `{ total, succeeded, failed, pending_reboot, pending, skipped }` (`pending` includes running).
- **Audit.** One `patch.approved` / `patch.declined` / `patch.deferred` / `patch.approval_cleared`
  entry per request (`{ ids (first 100), count, client_id, until }`), `patch.install_requested`
  for immediate installs and `patch_run.started` (system actor) per window run. Rules live in
  policies, so they are audited as `policy.*`; no separate `patch_rule.*` entries exist.

## Patch routes

| Route | Permission | Notes |
|---|---|---|
| `GET /patches?platform=&classification=&severity=&approval=&status=missing\|any&client_id=&q=&cursor=&limit=100` | `patches.view` | `{ items: [Patch], next_cursor }` |
| `GET /patches/{id}` | `patches.view` | `{ patch: Patch, devices: [{ device_id, hostname, client_name, state, detected_at, installed_at, last_error }] }` |
| `POST /patches/approve` | `patches.approve` | Body `{ ids: [], client_id?: null, decision: "approved" \| "declined" \| "deferred" \| "none", until? }` (at most 1000 ids) |
| `GET /patch-approval-rules` | `patches.view` | Read-only view of the auto-approve rules from all policies, with the policy name |
| `GET /devices/{id}/patches?state=` | `patches.view` | `{ scanned_at, source, pending_reboot, reboot_reasons, items: [{ patch: Patch, state, detected_at, installed_at, last_error, effective_approved }] }` |
| `POST /devices/{id}/patches/scan` | `patches.view` | Asks the device to scan now; returns `{ cmd_id }` |
| `POST /devices/{id}/patches/install` | `patches.approve` + step-up | Body `{ patch_ids: [] \| "approved", reboot: { mode, deferrals, message } }`; immediate install outside the window |
| `GET /patch-runs?limit=` | `patches.view` | `{ items: [{ id, policy_id, policy_name, window_start, window_end, status, total, succeeded, failed, pending_reboot, pending }] }` |
| `GET /patch-runs/{id}` | `patches.view` | `{ run, results: [{ device_id, hostname, status, installed: n, failed: n, rebooted: bool, error }] }` |
| `GET /patching/compliance?group_by=client\|site\|os&client_id=&site_id=` | `patches.view` | `{ totals: { devices, compliant, non_compliant, missing_critical, missing_important, pending_reboot, failed }, rows: [{ key, label, devices, compliant, compliance_pct, missing_by_severity: {…}, oldest_missing_days }] }` |

| `POST /patching/policies/{id}/run-now` | `patches.approve` + step-up | Body `{ duration_minutes?, client_id?, site_id? }` (all optional). Opens a manual patch run now for the devices whose install window comes from this policy (`window_policy`), within your scope and the optional client/site: online devices get their effective-approved missing patches at once, offline devices wait as `pending` until the run's window ends (`duration_minutes`, default the policy window's duration, 15–1440). Returns `{ run_id, devices, online, window_end }`; `404` unknown policy; `409 no_devices` when no device in scope uses the policy's window |
| `GET /devices?patch_state=` | `devices.view` + `patches.view` | The device list filtered by patch state: `compliant`, `non_compliant`, `pending_reboot`, `failed`, `missing_critical` or `not_scanned` (no scan yet); other values `422` |

Notes on the patch routes:

- `GET /patches`: `status` defaults to `missing` (missing or failed on at least one visible
  device); `any` lists every catalog entry with a visible device (global viewers without
  `client_id` also see entries no device reports any more). `severity=none` selects patches
  without a severity; `q` searches the title, KB and key. `next_cursor` is opaque; `limit` is
  1–500. Sorted by missing devices, then newest first.
- `GET /patches/{id}` shows the global decision; its `devices` are the visible devices.
- Rule approvals in the all-clients catalog: every Patch carries `rule_approved_clients` (the
  visible clients with an active rule approval). In the all-clients view (`GET /patches` without
  `client_id`, and `GET /patches/{id}`), a patch with no global decision but with client rule
  approvals shows `approval: { status: "approved", source: "rule", scope: "clients", clients: n,
  at, approved_at, by_name: "Auto-approval rule", client_id: null }` (`at` is the earliest rule
  approval), and `approval=approved` matches it.
- Compliance `client_id`/`site_id` narrow the devices before grouping; an unknown or invisible
  client answers `404`. Manual window runs are audited as `patch_run.started` with the user as
  actor and `trigger: "manual"`; their results and completion behave like window runs.
- `POST /patches/approve` returns `{ updated }`. A global decision needs `patches.approve` held
  globally, a client decision `patches.approve` over that client. `decision: "none"` removes the
  decision at that scope (including a rule approval). `deferred` needs a future `until`.
- `GET /devices/{id}/patches?state=missing` returns `missing`, `downloaded`, `installing` and
  `failed` patches; any other `state` value filters exactly. `effective_approved` uses the
  device's ring.
- `POST /devices/{id}/patches/scan` and `/install` answer `409 device_offline` for offline
  devices. `install` returns `{ cmd_id, run_id, count }`; listed `patch_ids` must all be missing
  (or failed) on the device; `"approved"` sends every effective-approved missing patch (the retry
  limit does not apply). `reboot` fields default to the device's policy and there is no
  deadline. `409 nothing_to_install` when nothing qualifies.
- Patch runs also carry `trigger` (`window` | `manual`) and `skipped`; their counts and results
  cover the devices the caller can see (runs without a visible device are hidden from scoped
  users).
- Compliance totals: `missing_critical` and `missing_important` count missing (device, patch)
  pairs (states `missing`, `downloaded`, `installing`, `failed`) of that severity;
  `pending_reboot` and `failed` count devices. Rows are sorted by label (client name,
  "Client / Site", or Windows/Linux/macOS); `missing_by_severity` has the keys `Critical`,
  `Important`, `Moderate`, `Low` and `Unspecified`; `compliance_pct` has one decimal (100 for no
  devices); `oldest_missing_days` is the age of the oldest missing pair (`null` when none).

## Software explorer

This is built from the existing `device_software` inventory data.

| Route | Permission | Notes |
|---|---|---|
| `GET /software?q=&publisher=&client_id=&cursor=&limit=100` | `software.view` | `{ items: [{ name, publisher, versions: n, devices: n, latest_version }], next_cursor }`, grouped by normalised name and publisher |
| `GET /software/product?name=&publisher=` | `software.view` | `{ name, publisher, versions: [{ version, devices }], devices: [{ device_id, hostname, client_name, version, install_date }] }` |

Normalisation: trailing version numbers, architecture markers (`x64`, `(64-bit)`, …) and `-`
separators are removed from the name (`7-Zip 24.08 (x64)` → `7-Zip`), and names and publishers
are compared case-insensitively with collapsed spaces and trailing dots removed. Publishers also
drop commas, trademark signs and trailing legal-form suffixes (`Inc`, `Corp`, `Corporation`,
`LLC`, `Ltd`, `GmbH`, `AG`, `S.A.`, `B.V.`, `plc`, …, keeping the first word), so `Microsoft
Corporation` and `Microsoft Corp.` group together. `name` and `publisher` are the most common
display forms, `q` and `publisher` match substrings of the normalised values,
`next_cursor` is opaque and `limit` 1–500. Items are sorted by device count, then name; product
versions newest first.

## Software library and deployments

```jsonc
// Package
{ "id": "…", "name": "7-Zip", "publisher": "Igor Pavlov", "description": "…", "platforms": ["windows"],
  "source": { "type": "winget", "id": "7zip.7zip" }
          | { "type": "choco", "id": "7zip" }
          | { "type": "brew", "id": "p7zip", "cask": false }
          | { "type": "apt" | "dnf" | "zypper" | "pacman" | "apk", "id": "p7zip-full" }
          | { "type": "file", "file_id": "…", "file_name": "7z2409-x64.msi", "sha256": "…", "size_bytes": …,
              "installer": "msi" | "exe" | "pkg" | "deb" | "rpm" | "sh",
              "install_args": "/qn /norestart", "uninstall_args": "…" },
  "detection": { "type": "software_name", "pattern": "7-Zip*", "min_version": "24.0" }
             | { "type": "file", "path": "C:\\Program Files\\7-Zip\\7z.exe", "min_version"? }
             | { "type": "registry", "key": "HKLM\\SOFTWARE\\…", "value"?, "equals"? }
             | { "type": "none" },
  "created_by_name": "…", "updated_at": "…",
  "installed_on": 37 }
```

**Uploads.**

- `POST /software/files` (`software.library`) takes a raw body, `X-File-Name`, `Content-Length`
  and `X-CSRF-Token`, up to 4 GiB.
- Files are stored content-addressed in `/data/files/<sha256>`.
- The response is `{ file_id, sha256, size_bytes, file_name }`.
- The body streams to `<data dir>/tmp` while the SHA-256 is computed, and must be exactly
  `Content-Length` bytes (empty files are refused). `X-File-Name` may be percent-encoded; only its
  last path component is kept. Identical content is stored once; uploading the same content with
  the same name returns the existing `file_id`. Audit: `software.file_uploaded`.

**Agent downloads.** Agents fetch files from `/agent/v1/files/{sha256}?token=…` using a single-use,
device-bound token valid for 1 hour, issued inside the signed command. The agent verifies SHA-256
before running anything.

The route exists on the agent listener only (and on the console listener in single-listener
mode). The request must carry `X-RustRMM-Device-Id` matching the token's device, which must be
connected. The token is consumed by the first request; invalid, expired or used tokens get
`403 forbidden`. One `Range: bytes=…` range is honoured (`206`), but resuming needs a new
command. Only the token's SHA-256 is stored, and tokens are purged a day after they expire.

| Route | Permission | Notes |
|---|---|---|
| `GET /software/packages` | `software.view` | `{ items: [Package] }` |
| `GET /software/packages/{id}` | `software.view` | `Package` |
| `POST` / `PUT` / `DELETE /software/packages[/{id}]` | `software.library` (global) | |
| `POST /software/deployments` | `software.deploy` | Body `{ package_id, action: "install" \| "uninstall", target: { type: "devices" \| "group" \| "site" \| "client", ids }, schedule: { type: "now" } \| { type: "once", at } \| { type: "window" }, confirm_count? }`; subject to the Phase 5 mass-action guard |
| `GET /software/deployments?limit=` | `software.view` | `{ items: [{ id, package, action, target_label, status, total, succeeded, failed, pending, created_by_name, created_at }] }` |
| `GET /software/deployments/{id}` | `software.view` | `{ deployment, results: [{ device_id, hostname, status, exit_code, detected_after, error, output_preview }] }` |
| `POST /software/deployments/{id}/cancel` | `software.deploy` | |
| `GET /devices/{id}/software-deployments` | `software.view` | `{ items: [{ deployment_id, package: { id, name }, action, status, exit_code, detected_after, error, created_at, finished_at }] }` (newest 200) |

Library and deployment details:

- Packages also carry `created_at`. `platforms` defaults to the platforms the source supports and
  must be a subset of them (`winget`/`choco`: windows; `brew`: macos; distribution managers:
  linux; files: `msi`/`exe` windows, `pkg` macos, `deb`/`rpm` linux, `sh` linux and macos).
  For `file` sources only `file_id`, `installer`, `install_args` and `uninstall_args` are taken
  from the request; `file_name`, `sha256` and `size_bytes` come from the upload. Arguments are one
  line of at most 1000 characters. Package-manager ids may not start with `-`.
- `installed_on` counts visible devices: inventory matches for `software_name` detection,
  otherwise devices with a successful install deployment of the package.
- `DELETE` answers `409 package_in_use` while a deployment of the package is scheduled or
  running; past deployments keep their history (`package.id` becomes `null`).
  Audit: `software.package_created`, `software.package_updated`, `software.package_deleted`.
- Deployments: the mass-action guard is the Phase 5 threshold (step-up plus `confirm_count`
  equal to the resolved device count, else `409 confirmation_required` with `details.count`);
  four-eyes approval does not apply. Uninstalling a `file` package needs an `msi`, or an `exe`/`sh`
  with `uninstall_args`. Devices whose platform the package does not support are `skipped`.
- Schedules: `now` dispatches immediately; `once` starts at `at` (status `scheduled` until then);
  `window` runs each device inside its effective patch window (devices without a window are
  skipped). Offline devices are waited for 24 hours (`now`/`once`) or 14 days (`window`), then
  skipped. At most 50 actions run at once per deployment; each has a 3600-second timeout and
  fails when no result arrives 30 minutes after that.
- Result statuses: `pending`, `running`, `succeeded`, `failed`, `skipped` (already in the desired
  state, unsupported platform, offline or no window; `error` says which), `cancelled`. A result
  succeeds when the exit code is a success code and the after-detection (if any) confirms it.
  Deployment statuses: `scheduled`, `running`, `completed`, `cancelled`. List items also carry
  `skipped` and `cancelled` (`pending` includes running); the detail's `deployment` adds
  `target: { type, ids }`, `schedule` and `finished_at`. Cancel returns the detail and answers
  `409 invalid_status` unless the deployment is scheduled or running; running actions finish.
- Events: `software_deployment.updated` with `{ deployment_id, status, counts }` (deployment's
  client). Timeline: `software.installed`, `software.uninstalled`, `software.skipped`,
  `software.failed`. Audit: `software.deployment_created`, `software.deployment_cancelled`.

The agent command is `Command::SoftwareAction { action, source, detection, download?: { url, sha256, size }, timeout_secs }`.

It also carries `deployment_id`. `download.url` is a path that the agent resolves against the
server it is connected to; any other origin or path is refused. The command result is
`succeeded` once something ran (or was skipped), with
`{ exit_code, detected_before, detected_after, skipped, reboot_required, output, duration_ms }`
(`output` is the first 4 KiB of stdout and stderr; detection values are `null` for
`detection: none`), or `failed` with a message when the action could not run.

**Detection** runs before the install (a success counts as "already installed" and the device is
skipped) and after it (to verify the result).

| Source | How the agent runs it |
|---|---|
| winget | Resolves `winget.exe` from `C:\Program Files\WindowsApps\Microsoft.DesktopAppInstaller_*` (the newest), with `--silent --accept-package-agreements --accept-source-agreements --scope machine` |
| choco | Only if `C:\ProgramData\chocolatey\bin\choco.exe` exists |
| brew | Runs as the console user via `sudo -u`, never as root |
| Distribution package managers | Same tooling as patching |
| File | `msiexec /i <file> <args>`, the exe with its args, `installer -pkg <file> -target /`, `dpkg -i`, `rpm -U` or `sh` |

Agent details: winget uninstalls use `uninstall --id <id> --exact --silent
--accept-source-agreements --scope machine`; Chocolatey runs `install|uninstall <id> -y
--no-progress`; Homebrew runs `sudo -u <console user> -H <brew> install|uninstall [--cask] <id>`
and fails when nobody (or root) is signed in. MSI uninstalls use `msiexec /x <file>`, and MSI
arguments default to `/qn /norestart`. On Windows the argument string is passed verbatim. The file
is downloaded into `<data dir>/software/<cmd_id>/` (restricted like the script directory) under a
sanitised name and deleted afterwards. Installers run contained like scripts (job object or
process group) with the script environment.

Detection rules: `software_name` uses `*`/`?` wildcards, case-insensitive, against the software
inventory, with a numeric `min_version`. `file` expands `%VAR%` and, on Windows, compares
`min_version` with the file's fixed version resource (elsewhere, presence only). `registry` reads
the 64-bit view; `equals` compares as text (DWORD and QWORD values as decimal); it is always
false off Windows.

Exit codes 0, 3010 and 1641 count as success; 3010 and 1641 also set `reboot_required`.

## Data model (migration `0007_patching_software.sql`)

| Table | Contents |
|---|---|
| `patch_catalog` | Patch catalog entries |
| `device_patches` | Per-device patch state |
| `patch_approvals` | `patch_id`, `client_id NULL`, `decision`, `until`, `source`, `by`, `at` |
| `patch_runs` | Patch runs |
| `patch_run_results` | Per-device patch run results |
| `software_files` | Uploaded files |
| `software_packages` | Library packages |
| `software_deployments` | Deployments |
| `software_deployment_results` | Per-device deployment results |
| `file_download_tokens` | Single-use, device-bound download tokens |
| `device_patch_status` | Latest scan per device: `scanned_at`, `source`, `pending_reboot`, `reboot_reasons`, `last_install_at`, `error`, `last_scan_requested_at` |

`patch_approvals` also stores `policy_id` and `delay_days` for rule approvals, with one row per
patch and scope. `patch_run_results` stores the keys sent, counts, `rebooted`, the command id and
the device's window end. `file_download_tokens` stores only the SHA-256 of each token.
