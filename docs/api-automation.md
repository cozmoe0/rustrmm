# Automation and policies API (Phase 5)

This is the contract for scripts, variables, jobs, custom fields, device groups, policies, approvals
and the mass-action guard. The server, the agent and the console all build against it.

All routes live under `/api/v1`. They use the console session cookie and require `X-CSRF-Token` on
every request other than GET. Errors use the standard envelope `{"error": {"code", "message", "details?"}}`.
Every list is filtered by the caller's client and site scope.

## Permissions

| Permission | Covers |
|---|---|
| `scripts.view` | script library, variables (without secret values), jobs, runs and results |
| `scripts.manage` | creating and editing scripts and variables |
| `scripts.run` | starting, cancelling and re-running jobs; quick runs on a device |
| `scripts.approve` | approving script versions and pending jobs (four-eyes) |
| `policies.manage` | policies and their assignments |
| `devices.manage` | device groups; custom field values on devices |
| `clients.manage` | custom field values on clients and sites |
| `settings.manage` | custom field definitions; automation settings |

Scripts are installation-wide library objects, so creating, editing, duplicating and archiving them
needs `scripts.manage` held globally, and approving a script version needs global `scripts.approve`.
Variables need `scripts.manage` on their own scope (global, the client, or the site). Custom field
definitions need global `settings.manage`.

## Scripts

A script is a named, versioned piece of code. Saving changed content or parameters creates a new
version, and versions are immutable. Every version records the SHA-256 of its content.

```jsonc
// Script (GET /scripts/{id})
{
  "id": "…", "name": "Clear temporary files", "description": "…", "category": "Maintenance",
  "language": "powershell",          // powershell | pwsh | cmd | bash | sh | zsh | python
  "platforms": ["windows"],          // subset of windows | linux | macos
  "timeout_secs": 600,               // 10–86400
  "risk": "normal",                  // normal | high  (high: always needs confirmation; four-eyes when enabled)
  "builtin": true,                   // shipped with RustRMM (read-only; duplicate to customise)
  "current_version": 3,
  "approved_version": 3,             // null when never approved
  "content": "…",                    // current version
  "content_sha256": "…",
  "parameters": [ /* ScriptParameter */ ],
  "versions": [ { "version": 3, "notes": "…", "content_sha256": "…", "created_by_name": "…",
                  "created_at": "…", "approved_by_name": "…" | null, "approved_at": "…" | null } ],
  "created_by_name": "…", "created_at": "…", "updated_at": "…",
  "archived": false,
  "last_run": { "job_id": "…", "run_id": "…", "at": "…", "succeeded": 12, "failed": 1 } | null
}

// ScriptParameter
{ "name": "ServiceName",             // [A-Za-z_][A-Za-z0-9_]{0,63}; must not be a reserved environment name
  "label": "Service name", "description": "…",
  "type": "string",                  // string | number | boolean | select | secret
  "required": true, "default": "Spooler" | null,
  "options": ["a", "b"] }            // select only
```

Script routes:

| Route | Permission | Notes |
|---|---|---|
| `GET /scripts?search=&category=&language=&platform=&include_archived=false` | `scripts.view` | `{ items: [ScriptSummary] }`; a summary is a Script without `content`, `parameters` and `versions` |
| `POST /scripts` | `scripts.manage` | Body `{ name, description, category, language, platforms, timeout_secs, risk, content, parameters, notes? }`; returns the Script |
| `GET /scripts/{id}` | `scripts.view` | |
| `PUT /scripts/{id}` | `scripts.manage` | Same body; a new version only when content or parameters changed; built-in scripts return `409 builtin_readonly` |
| `POST /scripts/{id}/duplicate` | `scripts.manage` | Copy named "… (copy)", `builtin: false`, version 1 |
| `DELETE /scripts/{id}` | `scripts.manage` + step-up | Archives the script (it keeps history and running jobs) |
| `GET /scripts/{id}/versions/{version}` | `scripts.view` | `{ version, content, parameters, content_sha256, notes, … }` |
| `POST /scripts/{id}/versions/{version}/approve` | `scripts.approve` + step-up | Sets `approved_version`. Approving a version you created returns `403 self_approval` unless the automation setting `allow_self_approval` is on |
| `GET /script-categories` | `scripts.view` | `{ items: [{ name, count }] }` |

Built-in scripts are seeded at startup (about 40 of them, written for RustRMM) and are approved
automatically. Seeding is idempotent and keyed by a stable built-in id. An upgrade adds new built-ins
and updates unchanged ones in place, as a new version.

## Variables

Variables are named values that reach scripts as environment variables. They are scoped
`global`, `client` or `site`; for the same name the most specific scope wins (site, then client,
then global). Secret variables are stored field-encrypted and are **never** returned, not even to
administrators. They can only be overwritten. Their values are masked in script output.

| Route | Permission | Notes |
|---|---|---|
| `GET /variables?scope=&scope_id=` | `scripts.view` | `{ items: [{ id, scope, scope_id, scope_name, name, value, secret, description, updated_at, updated_by_name }] }`; `value` is `null` for secrets |
| `POST /variables` | `scripts.manage` | `{ scope, scope_id?, name, value, secret, description }`; `name` matches `[A-Za-z_][A-Za-z0-9_]{0,63}` and must be unique per scope |
| `PUT /variables/{id}` | `scripts.manage` | Same body; leave `value` out to keep a secret unchanged |
| `DELETE /variables/{id}` | `scripts.manage` | |

**Reserved names** (rejected for both parameters and variables, case-insensitive): `PATH`,
`SYSTEMROOT`, `WINDIR`, `COMSPEC`, `PATHEXT`, `TEMP`, `TMP`, `HOME`, `USERPROFILE`, `SHELL`,
`LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_INSERT_LIBRARIES`, `PSMODULEPATH`, plus anything that starts
with `RUSTRMM_`.

## Jobs

A job runs one script version on a set of devices: once now, once at a time, or on a cron schedule.
Each execution is a **run**, and each device in a run gets a **result**.

```jsonc
// POST /jobs   (scripts.run)
{
  "name": "Weekly temp cleanup",       // optional; defaults to the script name
  "script_id": "…",                    // runs the script's current version (or approved_version when approval is required)
  "parameters": { "ServiceName": "Spooler" },
  "target": { "type": "devices", "ids": ["…"] },   // devices | group | site | client
  "schedule": { "type": "now" },       // now | { "type": "once", "at": ISO-8601 } | { "type": "cron", "cron": "0 3 * * 1", "timezone": "Europe/London" }
  "offline_wait_minutes": 60,          // 0 = online devices only; offline devices run when they reconnect within this window
  "concurrency": 25,                   // devices executing at the same time (1–500)
  "timeout_secs": null,                // overrides the script's timeout
  "confirm_count": 120                 // required by the mass-action guard (see below)
}
```

```jsonc
// Job (GET /jobs/{id})
{
  "id": "…", "name": "…", "script": { "id", "name", "language", "risk" }, "script_version": 3,
  "content_sha256": "…", "parameters": { /* secret parameter values are replaced by "••••••" */ },
  "target": { "type": "group", "ids": ["…"], "label": "Windows servers (dynamic)" },
                                       // "policy" (read-only) for policy task jobs: ids = [policy_id]
  "policy_id": "…" | null,             // set on policy task jobs
  "schedule": { … }, "next_run_at": "…" | null,
  "status": "scheduled",               // pending_approval | scheduled | running | completed | cancelled | rejected
  "offline_wait_minutes": 60, "concurrency": 25, "timeout_secs": 600,
  "created_by_name": "…", "created_at": "…", "approved_by_name": "…" | null,
  "runs": [ /* latest 20 JobRun */ ]
}

// JobRun
{ "id": "…", "job_id": "…", "status": "running",   // running | completed | cancelled
  "trigger": "schedule",                            // manual | schedule | policy | rerun
  "total": 40, "pending": 3, "waiting_offline": 2, "running": 5, "succeeded": 28, "failed": 2,
  "skipped": 0, "cancelled": 0,                     // failed includes timed_out
  "started_at": "…", "finished_at": "…" | null }

// JobResult (one per device per run)
{ "device_id": "…", "hostname": "…", "os_family": "windows", "client_name": "…",
  "status": "succeeded",               // pending | waiting_offline | running | succeeded | failed | timed_out | skipped | cancelled
  "exit_code": 0, "started_at": "…", "finished_at": "…", "duration_ms": 1830,
  "error": null,                       // agent/transport error ("device offline beyond wait window", local policy refusal, …)
  "stdout_preview": "first 200 chars…" }
```

Job routes:

| Route | Permission | Notes |
|---|---|---|
| `POST /jobs` | `scripts.run` | Returns the Job. Validates parameters (required, type, select options) and that the script's platforms match each target device; non-matching devices become `skipped` |
| `GET /jobs?status=&script_id=&device_id=&limit=50&cursor=` | `scripts.view` | `{ items: [JobSummary], next_cursor }`; a summary has `runs` replaced by `last_run` |
| `GET /jobs/{id}` | `scripts.view` | |
| `POST /jobs/{id}/run-now` | `scripts.run` | Starts an immediate run of a scheduled or cron job |
| `POST /jobs/{id}/cancel` | `scripts.run` | Stops the schedule and cancels results that have not started; running scripts finish. A pending approval is closed |
| `DELETE /jobs/{id}` | `scripts.run` | Only when no run is active (`409 job_active`); keeps runs for history (soft delete). Policy task jobs return `409 managed_by_policy` |
| `GET /job-runs/{id}` | `scripts.view` | `{ run: JobRun, job: JobSummary, results: [JobResult] }` |
| `GET /job-runs/{id}/results/{device_id}` | `scripts.view` | `{ …JobResult, job_id, run_id, stdout, stderr, truncated, directives: [{ field, value, applied, reason? }] }`; `reason` explains a refused directive |
| `POST /job-runs/{id}/rerun` | `scripts.run` | Body `{ only: "failed" | "all" }` (default `failed`; failed includes timed out); creates a new run with trigger `rerun` and returns `{ job_id, run_id }`. Step-up is needed above the threshold or for a high-risk script |
| `POST /job-runs/{id}/cancel` | `scripts.run` | |
| `GET /devices/{id}/script-runs?limit=50` | `scripts.view` | That device's results across jobs, newest first, each with `{ job_id, job_name, run_id, script_name, … }` |
| `POST /devices/{id}/run-script` | `scripts.run` | Quick run. Body `{ script_id, parameters, timeout_secs?, confirm_count? }`; creates a job targeting this device with schedule `now` and returns `{ job_id, run_id, status }`. `confirm_count` (1) is needed for a high-risk script; `run_id` is `null` while the job waits for approval |
| `POST /devices/{id}/run-script` with `{ adhoc: { language, content }, timeout_secs? }` | `scripts.run` + `scripts.manage` + step-up | Runs unsaved code (at most 256 KiB, in a language the device's OS can run). The audit entry `script.adhoc_run` records the language, the content hash and the first 200 characters; output works the same way |

### Execution rules (server)

- A scheduler tick every 15 s:
  - starts due `once` and `cron` jobs;
  - dispatches `pending` results to online devices, up to `concurrency` per run;
  - turns `waiting_offline` into `skipped` once the wait window has passed;
  - marks runs `completed` when no result is left open.
- When a device connects, its `waiting_offline` results are dispatched immediately.
- A missed cron tick while the server was down runs once at start-up, not once per missed tick.
- Results are sent as signed `run_script` commands; the TTL is the timeout plus 60 s. The script's
  content hash in the command must equal the job's `content_sha256`.
- Output is capped at the automation setting `max_output_kb`, 256 KiB per stream by default. The
  server caps and masks the output again before storing it (secret variables and secret
  parameters), and command history keeps only the outcome, not the output.
- A cron occurrence that arrives while the job's previous run is still active is skipped.
- A running result fails when its device disconnects, when no result arrives within the timeout
  plus 120 s, or when the server restarts while it runs.
- **Directives:** a stdout line `::rustrmm::set-field key=value` sets the device custom field `key` when that field
  exists, has scope `device` and has `script_writable` set. Each applied directive is written to the device
  timeline, and applied or refused directives are listed on the result.
- **Live events:**
  - `job.updated` carries `{ job_id, run_id, status, counts }` and is throttled to at most one per second per run.
  - `job.result` carries `{ job_id, run_id, device_id, status }`.
- **Audit:** `job.created`, `job.approved`, `job.rejected`, `job.cancelled`, `job.run_started`, `script.created`,
  `script.updated`, `script.approved`, `script.archived`, `script.adhoc_run` and the `variable.*` actions are recorded.
  Script content is never written to the audit log, only its hash; ad-hoc runs also record the language and the first 200 characters.

### Mass-action guard and four-eyes

Automation settings live in the `settings` table under the key `automation`:

```jsonc
// GET / PUT /settings/automation   (GET: settings.view, PUT: settings.manage + step-up)
{ "mass_action_threshold": 25,        // devices; above this a job needs confirmation and step-up
  "four_eyes_jobs": false,            // jobs above the threshold, or using a high-risk script, need a second person's approval
  "require_script_approval": false,   // only approved script versions may run
  "allow_self_approval": false,
  "max_output_kb": 256,
  "default_offline_wait_minutes": 60 }
```

How a job is checked:

- When the resolved target count is above the threshold, or the script is `high` risk:
  - Without a valid step-up, the request fails with `403 step_up_required`.
  - Unless `confirm_count` equals the resolved count, it fails with `409 confirmation_required`, `details: { count }`.
    The console asks the user to type the number.
- With `four_eyes_jobs` on and either condition true, the job is created with status `pending_approval` and an
  approval request is opened. Nothing runs until another user holding `scripts.approve` approves it.
- With `require_script_approval` on, a job runs `approved_version`. If there is none, the request fails with
  `409 script_not_approved`.

## Approvals

| Route | Permission | Notes |
|---|---|---|
| `GET /approvals?status=pending` | `scripts.approve` (or the requester, for their own) | `{ items: [{ id, kind: "job", subject: JobSummary, requested_by_name, requested_at, status, decided_by_name, decided_at, comment }] }` |
| `POST /approvals/{id}/approve` | `scripts.approve` + step-up | Body `{ comment? }`; the requester cannot approve their own request; a scheduled job's schedule starts after approval |
| `POST /approvals/{id}/reject` | `scripts.approve` | Body `{ comment }`; the job becomes `rejected` |

Pending approvals expire after 7 days (the approval becomes `expired` and the job `cancelled`). They
show in the console's notification area through the `approvals.changed` event, which carries
`{ id, status }`. `GET /approvals` without `status` (or with `status=all`) lists every state. A
requester who is also an approver still cannot decide on their own request (`403 self_approval`).

## Custom fields

A custom field defines an extra typed value on devices, clients or sites. Scripts can write device
fields through the directive above. Values show on the device page, in the device grid (as
optional columns) and in dynamic group rules (`custom.<key>`).

```jsonc
// CustomField
{ "id": "…", "key": "asset_tag",       // [a-z][a-z0-9_]{0,47}, unique
  "name": "Asset tag", "description": "…",
  "type": "text",                     // text | number | boolean | date | select
  "options": [],                      // select only
  "scope": "device",                  // device | client | site
  "script_writable": true, "created_at": "…" }
```

| Route | Permission | Notes |
|---|---|---|
| `GET /custom-fields?scope=` | any signed-in user | `{ items: [CustomField] }` |
| `POST /custom-fields` | `settings.manage` | |
| `PUT /custom-fields/{id}` | `settings.manage` | `key` and `scope` cannot change; `type` only while no values are stored. Only device fields can be `script_writable` |
| `DELETE /custom-fields/{id}` | `settings.manage` + step-up | Also deletes the stored values |
| `GET /devices/{id}/custom-fields` | `devices.view` | `{ items: [{ field: CustomField, value, updated_at, updated_by }] }`; `updated_by` is a user name or `"script"` |
| `PUT /devices/{id}/custom-fields` | `devices.manage` | Body `{ "values": { "asset_tag": "A-123", "warranty_end": null } }`; `null` clears a value; values are validated against the field type |
| `GET` and `PUT /clients/{id}/custom-fields`, `/sites/{id}/custom-fields` | `clients.view` / `clients.manage` | Same shapes |

`GET /devices/{id}` and the device list also include `custom_fields: { key: value }`.

## Device groups

A **static** group lists its devices explicitly. A **dynamic** group is a saved rule that the server
evaluates when it is used: when listing members, resolving job targets or applying policies.

```jsonc
// Group
{ "id": "…", "name": "Windows servers", "description": "…",
  "kind": "dynamic",                  // static | dynamic
  "client_id": null,                  // null = installation-wide (needs global devices.manage); otherwise scoped to that client
  "client_name": null,
  "rules": { "match": "all", "conditions": [ … ] },   // dynamic only
  "member_count": 14, "created_by_name": "…", "updated_at": "…" }
```

A rule document has the form `{ "match": "all" | "any", "conditions": [Condition | RuleDocument] }`.
It can nest at most 3 levels and hold at most 50 conditions. A condition has three parts: a field,
an operator and a value.

```jsonc
// Condition
{ "field": "os_family", "op": "eq", "value": "windows" }
```

| Field | Type |
|---|---|
| `hostname`, `os_name`, `os_version`, `agent_version`, `device_type`, `last_user`, `domain`, `manufacturer`, `model`, `serial`, `public_ip` | text |
| `os_family` | `windows` \| `linux` \| `macos` |
| `client_id`, `site_id` | id |
| `tag` | text, matched against the device's tags |
| `online`, `pending_reboot` | boolean |
| `health_score`, `ram_gb`, `disk_free_pct` (the lowest of the fixed volumes), `uptime_days`, `last_seen_minutes` | number |
| `custom.<key>` | the custom field's type |

`public_ip` is the address the agent last connected from. `disk_free_pct` comes from the latest
heartbeat. Text comparisons ignore case; `matches` is case-sensitive unless the pattern starts with
`(?i)`. A missing value never equals, contains or compares with anything (so `neq`, `not_in` and
`not_contains` are true for it). Rule errors return `422` with `details.path` (`conditions[1].conditions[0]`).

| Operators | Applies to |
|---|---|
| `eq`, `neq`, `in`, `not_in`, `exists`, `not_exists` | all fields |
| `contains`, `not_contains`, `starts_with`, `ends_with`, `matches` | text; `matches` is a regular expression of at most 200 characters, run with the linear-time `regex` crate |
| `gt`, `gte`, `lt`, `lte` | number, date |

| Route | Permission | Notes |
|---|---|---|
| `GET /groups?client_id=` | `devices.view` | `{ items: [Group] }` |
| `POST /groups` | `devices.manage` | Body `{ name, description, kind, client_id?, rules? }` |
| `PUT /groups/{id}` | `devices.manage` | Same body; `client_id` cannot change. Turning a static group dynamic drops its member list |
| `DELETE /groups/{id}` | `devices.manage` | Refused with `409 group_in_use` while a policy assignment or a scheduled job targets it |
| `GET /groups/{id}/members` | `devices.view` | `{ items: [DeviceSummary] }` (same shape as `GET /devices` items) |
| `POST /groups/{id}/members` | `devices.manage` | Static groups only. Body `{ device_ids: [] }` |
| `DELETE /groups/{id}/members` | `devices.manage` | Static groups only. Body `{ device_ids: [] }` |
| `POST /groups/preview` | `devices.view` | Body `{ rules, client_id? }`; returns `{ count, items: [first 25 DeviceSummary] }` for the rule builder |
| `GET /devices?group_id=…` | `devices.view` | The device list filtered to a group |
| `GET /devices/{id}/groups` | `devices.view` | `{ items: [Group] }` |

## Policies

A policy is a versioned JSON document assigned to targets. The **effective policy** of a device is
built in a fixed order, and later layers win:

1. Global assignments.
2. The device's client.
3. Its site.
4. Each group it belongs to, in ascending `priority`.
5. Assignments to the device itself.

Objects deep-merge: a later layer overrides only the keys it sets. Arrays of tasks are concatenated
and de-duplicated by `id`. Later phases add sections (`monitoring` in Phase 6, `patching` in Phase 7).

```jsonc
// Policy document, Phase 5 sections. Every key is optional.
{
  "agent": {                          // pushed to agents as the "settings" message
    "heartbeat_secs": 30,             // 10–300
    "metrics_secs": 60,               // 10–600
    "inventory_minutes": 240          // 15–1440
  },
  "remote_access": {                  // enforced by the server's remote-tools API (403 "disabled by policy")
    "shell": true, "files": true, "system": true, "power": true
  },
  "tasks": [                          // scheduled scripts that run on every device the policy applies to
    { "id": "weekly-cleanup", "name": "Weekly cleanup", "script_id": "…", "parameters": {},
      "cron": "0 3 * * 0", "timezone": "UTC", "enabled": true,
      "offline_wait_minutes": 720 }
  ]
}
```

| Route | Permission | Notes |
|---|---|---|
| `GET /policies` | `devices.view` | `{ items: [{ id, name, description, version, document, assignments: [{ id, target_type, target_id, target_name, priority }], updated_at, updated_by_name }] }` |
| `POST /policies` | `policies.manage` | Body `{ name, description, document }`; the document is validated (unknown sections are refused) and errors return `422` with `details.path` |
| `GET /policies/{id}` | `devices.view` | |
| `PUT /policies/{id}` | `policies.manage` | Increments `version` |
| `DELETE /policies/{id}` | `policies.manage` + step-up | |
| `POST /policies/{id}/assignments` | `policies.manage` | Body `{ target_type: "global" \| "client" \| "site" \| "group" \| "device", target_id?, priority? }` (priority −1000…1000, default 0); scope rules apply (a client-scoped user cannot assign globally). Returns the Policy (`201`) |
| `DELETE /policy-assignments/{id}` | `policies.manage` | |
| `GET /devices/{id}/effective-policy` | `devices.view` | `{ document, sources: [{ policy_id, policy_name, version, target_type, target_name, priority }], origins: { "agent.heartbeat_secs": "<policy_id>", … } }`; `origins` maps each leaf path to the policy that set it |

When a policy or an assignment changes, the server sends the new `agent` settings to every
affected online device, and applies them on each connect. Each enabled task becomes a policy job
(`trigger: "policy"`) that runs on its cron schedule against the devices whose effective policy
contains the task at that moment.

- Editing or deleting a policy needs `policies.manage` over every target it is assigned to.
- Task defaults: `timezone` `"UTC"`, `enabled` `true`, `offline_wait_minutes` `60`.
- A task runs the script's current version (the approved version when approval is required),
  resolved again at every run.
- Policy documents are stored in plain text, so secret parameters cannot be set in a task. A
  required secret parameter may be left out when a secret variable with the same name provides it.
- Policy task jobs are not subject to the mass-action guard: `policies.manage` is the gate.
- When remote access is disabled, the remote-tools API answers `403 disabled_by_policy` with
  `details: { feature, policy_id, policy_name }`.

## Agent protocol additions

```rust
// rustrmm_proto::commands::Command
RunScript(RunScript)

pub struct RunScript {
    pub language: String,               // powershell | pwsh | cmd | bash | sh | zsh | python
    pub content: String,
    pub content_sha256: String,         // agent verifies before running
    pub env: Vec<(String, String)>,     // variables, then parameters (parameters win)
    pub mask: Vec<String>,              // secret values to mask in output (≥ 4 chars)
    pub timeout_secs: u32,
    pub max_output_bytes: u32,          // per stream
}
```

This needs the local capability `scripts` (`features::SCRIPTS`). On success the result `data` is
`{ exit_code, stdout, stderr, duration_ms, timed_out, truncated }`, and the command status is
`succeeded` whenever the script ran, whatever its exit code.

How the agent runs a script:

1. **Write it.** The script goes to a fresh file in `<data dir>/scripts/<cmd_id>/`, a directory only
   SYSTEM, Administrators or root can access, with the extension `.ps1`, `.cmd`, `.sh` or `.py`.
   The agent deletes it afterwards.
2. **Pick the interpreter by absolute path.** Never through `PATH`:

| Language | Interpreter |
|---|---|
| `powershell` | `System32\WindowsPowerShell\v1.0\powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File` |
| `pwsh` | `C:\Program Files\PowerShell\7\pwsh.exe` with the same flags |
| `cmd` | `System32\cmd.exe /d /c` |
| `bash`, `sh`, `zsh` | `/bin` or `/usr/bin` |
| `python` | `/usr/bin/python3`, `/usr/local/bin/python3` or the Windows `py.exe` launcher in `%SystemRoot%` |

3. **Set the environment.** The child gets a fresh, minimal environment: the platform defaults,
   `RUSTRMM_DEVICE_ID`, `RUSTRMM_JOB=1`, then the variables and parameters. Nothing from the
   agent's own environment is passed through.
4. **Contain it.** On Windows the process tree runs in a kill-on-close job object; on Unix it runs
   in its own process group. On timeout the whole tree is killed and `timed_out` is set.
5. **Capture output.** stdout and stderr are capped, decoded as UTF-8 with replacement characters,
   and every `mask` value is replaced with `••••••` before the output leaves the device. When a
   stream is cut at the cap, a trailing fragment that starts a secret is removed too.

Further details:

- The agent reports `running` as soon as it accepts the command, then the final result.
  `exit_code` is `null` when a Unix process was killed by a signal.
- The script file is the verified content apart from line endings (LF for Unix interpreters and
  Python, CRLF for cmd) and a UTF-8 byte-order mark for PowerShell, which Windows PowerShell 5.1
  needs to read non-ASCII text correctly.
- Processes the script leaves behind are killed when it exits, as on timeout.
- At most four scripts run at the same time on a device; later ones wait for a slot.
- Reserved or malformed environment names are dropped by the agent as well.

## Device timeline and audit

Script results appear on the device timeline as `script.succeeded` or `script.failed`, with the job
name and exit code. Directive writes appear as `custom_field.changed`.
