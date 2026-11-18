# Monitoring, alerts and notifications API (Phase 6)

This is the contract for the agent check engine, server-side checks, the alert lifecycle,
notification channels and rules, maintenance windows and auto-remediation.

It follows the conventions of the other API documents: routes under `/api/v1`, the session cookie,
`X-CSRF-Token` on every request except GET, the error envelope `{"error": {"code", "message", "details?"}}`,
and every list filtered by the caller's client and site scope. Checks are configured through the
**`monitoring` section of the policy document** (see `api-automation.md`), so they inherit
global → client → site → group → device like every other policy setting.

## Permissions

| Permission | Covers |
|---|---|
| `alerts.view` | alerts, check states, maintenance windows (read) |
| `alerts.manage` | acknowledge, resolve, snooze, assign, notes, bulk actions |
| `monitors.manage` | the `monitoring` policy section (also needs `policies.manage`), maintenance windows, monitoring settings |
| `notifications.manage` | channels, rules, SMTP settings, test sends |

Channels, rules, the delivery log and SMTP settings are installation-wide, so they need
`notifications.manage` held **globally**; so does `PUT /settings/monitoring` (`monitors.manage`).
Alert routes check the permission on the alert's site (or client); maintenance windows check
`monitors.manage` on every target. Creating a policy with a `monitoring` section, changing or
removing that section, deleting such a policy, and assigning or unassigning it all need
`monitors.manage` in addition to `policies.manage`, over every assignment target.

## Policy section: `monitoring`

```jsonc
{
  "monitoring": {
    "checks": [                        // merged by "id" like tasks; a later layer may override fields or set "enabled": false
      { "id": "disk-c", "type": "disk", "name": "Low disk space", "enabled": true,
        "interval_secs": 300,            // 30–86400
        "severity": "warning",           // info | warning | critical; types with two thresholds use warn/crit inside config
        "config": { "volume": "*", "warn_free_pct": 15, "crit_free_pct": 5 },
        "remediation": { "script_id": "…", "parameters": {}, "max_attempts": 1 }   // optional
      }
    ],
    "server": {                        // server-side checks for the devices this policy applies to
      "offline_minutes": 15,            // 0 disables the offline alert
      "offline_severity": "critical",
      "agent_outdated": true,           // alert when the agent is two or more releases behind the newest imported release
      "disk_forecast_days": 14,         // alert when linear regression over 7 days of metrics predicts a full volume within N days; 0 disables
      "security_changes": true          // alert on new local administrators, antivirus turned off, firewall turned off, BitLocker turned off
    }
  }
}
```

### Merging and validation

- A check in a layer **with** `type` defines the whole check: its `config` is validated against
  the catalog with required fields, ranges and cross-field rules (for example `crit_pct ≥ warn_pct`,
  a disk check needs at least one threshold, `tcp_port` needs `port`).
- A check **without** `type` is a partial override of a check an earlier layer defined, for example
  `{ "id": "disk-c", "enabled": false }` or `{ "id": "cpu", "config": { "warn_pct": 80 } }`. Its
  fields replace the earlier ones and `config` and `remediation` deep-merge key by key. A layer
  that sets a *different* `type` redefines the check from scratch.
- The merged check is validated again when it is used; an invalid merged check is skipped.
- Check fields: `id` (1–64 letters, digits, `-`, `_`; unique per document), `type`, `name`
  (default: the type's label), `enabled` (default `true`), `interval_secs` (default 300),
  `severity` (default `warning`), `config`, `remediation` (`script_id` required,
  `max_attempts` 1–10, default 1) and the optional **`platforms`** (`["windows", "linux", "macos"]`
  subset; omitted = every platform). At most 100 checks per document.
- A device only receives checks whose type supports its operating system (the catalog's
  `platforms`) and whose `platforms`, when set, include it.
- `effective-policy` origins carry `monitoring.checks.<id>` (the last policy that touched the check)
  and `monitoring.server.<key>`.
- Unset `server` keys default to: `offline_minutes` = the monitoring setting
  `default_offline_minutes`, `offline_severity` `critical`, `agent_outdated` `true`,
  `disk_forecast_days` 14, `security_changes` `true`.
- `script_id` of `script` checks and remediations must name a runnable script (the approved version
  when approval is required), and `parameters` are validated like policy tasks: secret parameters
  cannot be stored in a policy and come from secret variables of the same name.

### Check types

The server validates each `config`, and `GET /monitoring/check-types` returns the same catalog for
building forms.

| `type` | `config` | States |
|---|---|---|
| `cpu` | `{ warn_pct: 85, crit_pct: 95, window_minutes: 5 }` | Uses the average over the window |
| `memory` | `{ warn_pct: 85, crit_pct: 95, window_minutes: 5 }` | |
| `disk` | `{ volume: "*" \| "C:" \| "/", warn_free_pct?, crit_free_pct?, warn_free_gb?, crit_free_gb? }` | `*` covers every fixed volume, and the worst one wins |
| `service` | `{ name, expected: "running" \| "stopped", auto_restart: false, restart_attempts: 2 }` | With `auto_restart` the agent tries to restart the service before reporting critical |
| `process` | `{ name, expected: "running" \| "not_running", max_cpu_pct?, max_memory_mb? }` | |
| `event_log` | `{ log: "System", source?, event_ids?: [41, 6008], min_level: 2, window_minutes: 15, threshold: 1 }` | Windows logs; on Linux, `log` is a systemd unit, with priority mapping as in `api-remote.md` |
| `script` | `{ script_id, parameters, timeout_secs: 60 }` | Exit code 0 is ok, 1 warning, 2 critical, anything else critical. The last stdout line becomes the message |
| `ping` | `{ target, count: 3, max_loss_pct: 50, max_rtt_ms? }` | Run from the device |
| `tcp_port` | `{ host, port, timeout_ms: 3000 }` | |
| `http` | `{ url, method: "GET", expect_status: 200, keyword?, max_latency_ms?, cert_warn_days?: 14, verify_tls: true }` | Only http(s) URLs are allowed |
| `certificate` | `{ source: "store" \| "file", store?: "LocalMachine\\My", path?, warn_days: 30, crit_days: 7 }` | Expiring local certificates |
| `pending_reboot` | `{ warn_after_hours: 72 }` | |
| `antivirus` | `{ max_signature_age_hours: 72 }` | Critical when real-time protection is off |
| `firewall` | `{}` | Critical when any profile is disabled |
| `uptime` | `{ warn_days: 30, crit_days: 60 }` | |
| `file` | `{ path, condition: "exists" \| "missing" \| "older_than" \| "larger_than", minutes?, size_mb? }` | |
| `windows_update` | `{ warn_days_since_install: 35, alert_on_failures: true }` | Windows only |
| `battery` | `{ min_health_pct: 60 }` | Devices with a battery only |

Each check produces a **state**: `ok`, `warning`, `critical` or `unknown` (the check could not run).
It also produces a short **message**, an optional numeric **value**, and the time it was checked.

**Alert severity.** The catalog marks each type `graded` or not:

- Graded types (`cpu`, `memory`, `disk`, `script`, `http`, `certificate`, `antivirus`, `firewall`,
  `uptime`) let the agent choose `warning` or `critical`, and the alert severity follows the state.
  `http` is critical when down, on a wrong status or a missing keyword, and warning on slow answers
  or a certificate inside `cert_warn_days`; `antivirus` is warning on old signatures.
- For every other type a failing check reports `critical` and the alert takes the check's
  configured `severity`.
- `unknown` maps to `info`.

`GET /monitoring/check-types` items therefore also carry `graded: bool`. Platform support:
`event_log` runs on Windows and Linux; `antivirus` and `windows_update` on Windows only;
`certificate` with `source: "store"` on Windows only (`file` everywhere). On a platform where a
probe cannot run, the agent reports `unknown` with an explanatory message. `battery` reports `ok`
("no battery present") on devices without one, so the check is safe in fleet-wide policies.
Certificates in a store that expired more than 30 days ago are ignored.

## Agent protocol additions

| Message | Direction | Shape |
|---|---|---|
| `MonitoringConfig` (`"monitoring_config"`) | server → agent | `{ version: <hash>, checks: [CheckDefinition], unknown_threshold }`. **Delivered inside a signed command** (`command` frame, `Command::MonitoringConfig`, kind `monitoring_config`, no local capability), because `script` checks carry code and must get the same signature, device, connection, sequence and expiry checks as `run_script`. Sent on connect and whenever the effective configuration changes; not written to command history. The agent persists it, so checks keep running while offline; transitions are queued and sent on reconnect |
| `CheckResults` (`"check_results"`) | agent → server | `{ results: [{ check_id, state, message, value?, at, streak }], full: bool }`. Sent on every state transition (debounced: a new state must hold for 2 consecutive evaluations unless it is `critical`), plus a full snapshot every 15 minutes with `full: true` |
| `RunScript` (from Phase 5) | server → agent | Reused for `script` checks only through the server; the agent runs script checks locally from the config, with the same executor and safety rules |

Interpreting `CheckDefinition` (`id`, `type`, `interval_secs`, `config`):

- Thresholds evaluate locally on the agent; `severity` is applied server-side.
- `script` checks embed `{ language, content, content_sha256, env, mask }`. The server resolves the
  script version and variables when it builds the config, and the agent verifies the hash.
- The local capability lock applies: `script` checks need `scripts`.

Details:

- `version` is the lowercase hex SHA-256 of the MessagePack encoding of `(checks, unknown_threshold)`.
  The agent replaces its stored configuration when a new one arrives; a check whose definition
  changed restarts its debounce.
- `CheckDefinition` is `{ id, type, name, interval_secs, config, script? }`. The server fills in
  catalog defaults, so `config` is complete. When the server cannot resolve a `script` check's
  script (missing, not approved, wrong platform, invalid parameters), it sends the check without
  `script` and with `config.unavailable` set to the reason; the agent reports `unknown` with that
  message. Script parameters travel only in `script.env`, never in `config`.
- `unknown_threshold` comes from the monitoring setting (default 3).
- `at` is the agent clock in **unix milliseconds** (the server clamps it to the last 7 days and
  "now"). `streak` is the number of consecutive evaluations that produced the reported state.
- Debounce: the first `ok` after the agent starts (or after a new check appears) is reported at
  once; a first `warning` or `unknown` waits for a second evaluation like any other change.
- An `unknown` state is re-sent, without a transition, when its streak reaches
  `unknown_threshold`, so the server can raise the `info` alert promptly.
- While offline the agent queues up to 1000 results (oldest dropped first) in its data directory.
  On reconnect it sends the queue, then a full snapshot.
- The server pushes the configuration on every connect, and to connected devices when a policy, an
  assignment, a group, a variable, a script (new or approved version) or `unknown_threshold`
  changes, but only when the version differs from the one last sent.
- A full snapshot also reconciles: states of checks that are no longer configured are deleted and
  their open alerts resolve automatically.
- Probes run on their own tasks (blocking work on the blocking pool), one evaluation per check at
  a time; a probe that hangs is abandoned as `unknown` after its interval or 10 minutes, whichever
  is longer. Service `auto_restart` uses the Phase 4 service control and needs the local `system`
  capability; `http` checks with `verify_tls: false` use a separate client that accepts any
  certificate, only for that check.

## Alerts

```jsonc
// Alert
{ "id": "…", "device_id": "…" | null, "hostname": "…" | null, "client_id": "…", "client_name": "…", "site_id": "…" | null,
  "source": "check",                 // check | server | snmp (Phase 10, see api-escrow-network.md)
  "check_id": "disk-c",              // check id, or a server check key: offline | agent_outdated | disk_forecast | security.local_admin_added | …
  "check_type": "disk",
  "severity": "warning",             // info | warning | critical; can escalate while open
  "title": "Low disk space on C: (8% free)", "message": "…",
  "status": "open",                  // open | acknowledged | resolved
  "opened_at": "…", "last_occurrence_at": "…", "occurrences": 3,
  "acknowledged_at": "…" | null, "acknowledged_by_name": "…" | null,
  "resolved_at": "…" | null, "resolved_by_name": "…" | null, "resolution": "auto" | "manual" | null,
  "snoozed_until": "…" | null, "assigned_to": { "id", "name" } | null,
  "in_maintenance": false, "ticket_id": null,
  "remediation": { "status": "succeeded", "job_id": "…", "attempts": 1 } | null,
  "snmp_device_id": "…" | null, "snmp_device_name": "…" | null }   // SNMP alerts name the SNMP device instead of a device
```

Alert lifecycle:

- **Dedupe.** There is at most one non-resolved alert per (device, `check_id`), or per (SNMP
  device, `check_id`) for `source: "snmp"` alerts. A repeat occurrence
  bumps `occurrences` and `last_occurrence_at`, and can raise `severity`.
- **Auto-resolve.** When the check reports `ok`, or the server condition clears, the alert resolves
  with `resolution: "auto"`. A manually resolved alert reopens if the condition is still bad at the
  next evaluation.
- **Acknowledged.** The alert stays open but escalation stops.
- **Snooze.** Notifications are suppressed until `snoozed_until`, and the alert still auto-resolves.
- **Maintenance.** During a matching maintenance window, alerts are still recorded with
  `in_maintenance: true`, but they send no notifications and run no remediation.
- **Remediation.** When the triggering check has `remediation` (and no maintenance window applies),
  opening the alert runs the script as a Phase 5 job (trigger `policy`), up to `max_attempts` per alert.
  The outcome is written to the alert events.
- **Unknown state.** `unknown` raises an `info` alert only after 3 consecutive unknown results.

How the server applies these rules:

- **Occurrences.** Only a state *transition* into a failing state counts as a new occurrence; the
  same state repeated in a snapshot does not. A transition to a higher severity raises `severity`
  (event `severity_changed`, notification event `severity_changed`); severity never drops while
  the alert is open.
- **Reopen.** When a failing result arrives with no open alert, the device and check's most recent
  alert is reopened (event `reopened`) if it was resolved manually and its condition has not
  cleared since; otherwise a new alert opens. A reopen notifies like `opened` and counts as an
  opening for remediation.
- **Unknown.** The `unknown` threshold is the monitoring setting `unknown_threshold`, judged by the
  agent's `streak`. An `unknown` result never changes an alert that is already open.
- **Maintenance.** With `suppress: "alerts"` no alert opens at all (the check state is still
  stored). Notifications are also held back while the device is in any active window, and while
  an alert is snoozed. An alert opened during maintenance records the event `maintenance`.
- Opened alerts also appear on the device timeline (`alert.opened`).
- Server-side alerts use `source: "server"` and `check_type` set to the first segment of the
  check id (`offline`, `agent_outdated`, `disk_forecast`, `security`).

Alert routes:

| Route | Permission | Notes |
|---|---|---|
| `GET /alerts?status=open,acknowledged&severity=&client_id=&site_id=&device_id=&source=&check_type=&assigned=me\|none\|<user_id>&q=&cursor=&limit=50` | `alerts.view` | `{ items: [Alert], next_cursor, counts: { open, acknowledged, critical, warning, info } }`, sorted by severity, then most recent occurrence |
| `GET /alerts/summary` | `alerts.view` | `{ open, acknowledged, critical, warning, info, by_client: [{ client_id, client_name, critical, warning }] }`, used by Fleet Pulse and dashboards |
| `GET /alerts/{id}` | `alerts.view` | `{ alert: Alert, events: [{ id, at, kind, actor_name, message, details }], check: CheckState \| null }`; event kinds: `opened`, `occurred`, `severity_changed`, `acknowledged`, `unacknowledged`, `snoozed`, `assigned`, `note`, `notified`, `notification_failed`, `remediation_started`, `remediation_finished`, `resolved`, `reopened`, `maintenance`, `ticket_created` (see below) |
| `POST /alerts/{id}/acknowledge` | `alerts.manage` | Body `{ note? }` |
| `POST /alerts/{id}/unacknowledge` | `alerts.manage` | |
| `POST /alerts/{id}/resolve` | `alerts.manage` | Body `{ note? }` |
| `POST /alerts/{id}/snooze` | `alerts.manage` | Body `{ minutes }` (15–10080) or `{ until }` |
| `POST /alerts/{id}/assign` | `alerts.manage` | Body `{ user_id \| null }` |
| `POST /alerts/{id}/notes` | `alerts.manage` | Body `{ text }` |
| `POST /alerts/bulk` | `alerts.manage` | Body `{ ids: [], action: "acknowledge" \| "resolve" \| "snooze" \| "assign", minutes?, user_id?, note? }`; at most 500 ids |
| `GET /devices/{id}/checks` | `alerts.view` | `{ items: [{ check_id, type, name, state, message, value, since, last_at, interval_secs, policy_id, policy_name }] }` |
| `GET /devices/{id}/alerts?status=` | `alerts.view` | Same as `/alerts` filtered to the device |

The alert event `ticket_created` (Phase 9) is recorded when a ticket is created from the alert, by
an alert-to-ticket rule, by `POST /alerts/{id}/ticket`, or when a ticket links the alert. Its
`details` are `{ ticket_id, number, rule_id }` (`rule_id` is `null` for manual creation and
links), and the alert's `ticket_id` is set at the same time (see `api-tickets.md`).
| `GET /monitoring/check-types` | `alerts.view` | `{ items: [{ type, label, description, platforms, graded, config_schema: [{ key, label, type: "number" \| "text" \| "boolean" \| "select" \| "string_list" \| "number_list" \| "script", required, default, min?, max?, options?, unit? }] }] }` |

Notes on the alert routes:

- `status` takes a comma-separated list; the default is `open,acknowledged`, and `all` lists every
  status. `severity`, `client_id`, `site_id`, `device_id`, `source` and `check_type` also take
  comma-separated lists. `q` searches the title, message, host name and check id.
- `next_cursor` is opaque (pass it back as `cursor`); `limit` is 1–200.
- `counts` ignore the `status` and `severity` filters and count only non-resolved alerts that match
  the other filters.
- The single-alert actions return `{ alert: Alert }`, and `409 invalid_status` when the action does
  not apply (acknowledging an alert that is not open, unacknowledging one that is not acknowledged,
  resolving or snoozing a resolved alert).
- Snoozing is limited to the next 7 days (`minutes` 15–10080, or `until`).
- `assign` needs an active user; `null` unassigns.
- `bulk` accepts `until` as well as `minutes`. It returns
  `{ updated, skipped, updated_ids, skipped_ids }`; alerts outside the caller's scope or in the
  wrong status are skipped.
- `GET /devices/{id}/checks` lists every check configured for the device, with `state: null`
  (and empty `message`, `since` and `last_at`) until the agent reports it.
- The `script` config field (`script_id`) is accompanied by an optional object `parameters`, which
  is not part of `config_schema`; the console builds it from the chosen script's parameters.

## Notification channels

```jsonc
// NotificationChannel. Secret fields (webhook URLs, tokens, passwords) are write-only and come back as "••••••".
{ "id": "…", "name": "Ops Slack", "kind": "slack",   // email | slack | teams | discord | ntfy | webhook
  "enabled": true,
  "config": {
    // email:   { to: ["ops@example.com"], cc?: [] }   (uses the global SMTP settings)
    // slack:   { webhook_url }
    // teams:   { webhook_url }                        (Power Automate "Workflows" webhook, Adaptive Card payload)
    // discord: { webhook_url }
    // ntfy:    { server_url: "https://ntfy.sh", topic, token? }
    // webhook: { url, secret?, headers?: { "X-Foo": "bar" } }   (JSON body signed: X-RustRMM-Signature: sha256=<hex HMAC of body>)
  },
  "last_used_at": "…" | null, "last_error": "…" | null }
```

| Route | Permission | Notes |
|---|---|---|
| `GET /notification-channels` | `notifications.manage` | |
| `POST /notification-channels` | `notifications.manage` | |
| `PUT /notification-channels/{id}` | `notifications.manage` | Leave secret fields out to keep them unchanged |
| `DELETE /notification-channels/{id}` | `notifications.manage` | |
| `POST /notification-channels/{id}/test` | `notifications.manage` | Sends a sample alert; returns `{ ok, status?, error? }` |
| `GET /settings/smtp` | `notifications.manage` | `{ host, port, security: "starttls" \| "tls" \| "none", username, password: "••••••" \| null, from_address, from_name }` |
| `PUT /settings/smtp` | `notifications.manage` + step-up | Leave `password` out to keep it unchanged |
| `POST /settings/smtp/test` | `notifications.manage` | Body `{ to }` |

Channel notes:

- Write-only secret fields per kind: Slack, Teams and Discord `webhook_url`; ntfy `token`; webhook
  `secret` and every `headers` value. The generic webhook `url` is not secret. To keep a header
  value unchanged on `PUT`, send it as `"••••••"`; leaving `headers` out keeps them all.
- `kind` cannot change after creation. Channel objects also carry `created_at` and `updated_at`.
- `email` accepts `to`/`cc` as a list or a comma/semicolon-separated string (1–20 `to`).
- ntfy `server_url` defaults to `https://ntfy.sh`; messages are published as JSON to
  `{server_url}/` with `topic`, `title`, `message`, `priority` (critical 5, warning 4, info 3,
  resolved 2), `tags` and `click`.
- Webhook requests are `POST` with `Content-Type: application/json`, the body
  `{ "event", "alert": { event, alert_id, title, severity, status, source, check_id, check_type, message,
  hostname, client_name, site_name, opened_at, last_occurrence_at, resolved_at, occurrences, link,
  sent_at }, "sent_at" }`, the header `X-RustRMM-Event`, `X-RustRMM-Signature` when `secret` is set,
  and the configured headers. `Host`, `Content-Length`, `Content-Type`, hop-by-hop headers and
  `X-RustRMM-Signature` cannot be configured.
- `POST /notification-channels/{id}/test` delivers once without retries and is logged with
  `event: "test"`.
- Deleting a channel removes it from every rule.

Delivery rules:

- **SSRF guard.** Outbound webhook URLs must be `https`, or `http` when the allowlist permits it.
  The resolved addresses must not be loopback, private, link-local, CGNAT or multicast, unless the
  host is in the monitoring setting `webhook_allowlist`. The check runs at delivery time, and
  redirects are not followed.
- **Retries.** Deliveries retry 3 times with backoff (10 s, 60 s, 300 s), and every attempt is
  written to `notification_log`.
- **Storage.** Channel configs are stored field-encrypted.

More detail:

- `webhook_allowlist` entries are host names, IP addresses or CIDR ranges (`10.20.0.0/16`). A host
  is allowlisted when its name is listed or every resolved address is inside a listed address or
  range. IPv4-mapped, IPv4-compatible and NAT64 IPv6 addresses are judged by the IPv4 address they
  carry; CGNAT (100.64.0.0/10), benchmarking, documentation, reserved and unspecified ranges are
  refused as well.
- URLs with credentials are refused. Proxy settings from the environment are ignored.
- The connection is pinned to the addresses that were checked, so a second lookup cannot swap them.
- Timeouts are 5 s to connect and 15 s in total.
- The same guard covers Slack, Teams, Discord, ntfy and webhook URLs. E-mail goes to the configured
  SMTP server, which may be internal.
- Each attempt is one `notification_log` row with `status`: `pending` (scheduled), `sent`,
  `failed` or `suppressed` (held back by quiet hours). An attempt that fails schedules the next
  one; after the fourth attempt the delivery stays `failed`, the channel's `last_error` is set, and
  the alert records `notification_failed`. A successful attempt records `notified`.
- `GET /notification-log` items are `{ id, delivery_id, at, alert_id, channel_id, channel_name,
  channel_kind, rule_id, event, attempt, status, http_status, error, next_attempt_at, finished_at }`,
  newest first (`limit` 1–1000, default 100).

## Notification rules

```jsonc
// NotificationRule
{ "id": "…", "name": "Critical to on-call", "enabled": true,
  "filters": { "client_ids": [], "site_ids": [], "severities": ["critical"], "sources": ["check", "server"],
               "check_types": [], "check_ids": [] },   // empty array = any
  "events": ["opened", "escalated", "resolved"],     // opened | severity_changed | resolved | escalated | secret.revealed (Phase 10)
  "channel_ids": ["…"],
  "quiet_hours": { "enabled": true, "start": "22:00", "end": "07:00", "timezone": "Europe/London",
                   "days": [0,1,2,3,4,5,6], "except_critical": true },
  "escalation": { "enabled": true, "after_minutes": 30, "channel_ids": ["…"] }   // fires when still open and not acknowledged
}
```

Routes are `GET`, `POST`, `PUT` and `DELETE /notification-rules[/{id}]`, all with
`notifications.manage`. `GET /notification-log?alert_id=&channel_id=&limit=` (`notifications.manage`)
returns the delivery history.

Rule semantics:

- A rule fires for an alert event when it is enabled, lists the event and every non-empty filter
  matches. `site_ids` never match alerts without a site.
- `events` defaults to `["opened", "resolved"]` when empty. Each channel is notified at most once
  per alert event, even when several rules select it.
- `quiet_hours`: `start`/`end` are `HH:MM` in `timezone` (IANA, default `UTC`). `days` uses
  0 = Sunday … 6 = Saturday, and an empty list means every day. A window that crosses midnight
  belongs to the day it starts on. `start` equal to `end` means the whole day. Held-back
  notifications are logged as `suppressed` and not sent later; `except_critical` lets critical
  alerts through.
- `escalation`: once per alert and rule, an alert still `open` (not acknowledged, not snoozed, its
  device not in maintenance) `after_minutes` after it opened notifies `escalation.channel_ids`, and
  the rule's own `channel_ids` too when `events` contains `escalated`. The notification event is
  `escalated`, and quiet hours apply. The timer runs every 15 s, and a reopened alert can escalate
  again.
- Rule objects also carry `created_at` and `updated_at`.

Message content: title, severity, device, client/site, message, timestamps and a link to the alert
(`{console_url}/alerts/{id}`). The bodies are formatted for each channel (a Slack block kit
section, a Teams Adaptive Card, a Discord embed, an ntfy priority mapped from severity, and HTML
plus text email). Bodies never include secrets or script content.

## Maintenance windows

```jsonc
{ "id": "…", "name": "Patch night", "enabled": true,
  "targets": [{ "type": "client" | "site" | "group" | "device", "id": "…" }],   // or [{ "type": "global" }]
  "schedule": { "type": "once", "start": "…", "end": "…" }
           |  { "type": "recurring", "cron": "0 22 * * 3", "duration_minutes": 180, "timezone": "UTC" },
  "suppress": "notifications",       // notifications (alerts recorded, not sent) | alerts (no new alerts at all)
  "created_by_name": "…", "active_now": false, "next_start": "…" | null }
```

| Route | Permission | Notes |
|---|---|---|
| `GET /maintenance-windows` | `alerts.view` | |
| `POST` / `PUT` / `DELETE /maintenance-windows[/{id}]` | `monitors.manage` | |
| `GET /devices/{id}/maintenance` | `alerts.view` | `{ active: [MaintenanceWindow], upcoming: [MaintenanceWindow] }` |

Maintenance notes:

- `targets` in responses also carry `name`. Windows also carry `created_at` and `updated_at`.
- A recurring window is active when an occurrence of `cron` in `timezone` falls within the last
  `duration_minutes` (1–10080), so windows may cross midnight. A one-off window is active from
  `start` (inclusive) to `end` (exclusive) and lasts at most 31 days.
- `suppress` defaults to `notifications` and `enabled` defaults to `true`. `active_now` and
  `next_start` are `false`/`null` for disabled windows.
- `GET /maintenance-windows` lists windows with at least one target the caller can see. Creating,
  editing or deleting needs `monitors.manage` over every target (global targets and
  installation-wide groups need a global grant).
- `upcoming` lists windows that start within the next 30 days, soonest first.

## Monitoring settings

`GET` and `PUT /settings/monitoring` (`GET` needs `settings.view`, `PUT` needs `monitors.manage`):

```jsonc
{ "default_offline_minutes": 15,     // used when no policy sets server.offline_minutes
  "unknown_threshold": 3,
  "retention_days": 180,             // resolved alerts and events older than this are purged
  "webhook_allowlist": [] }
```

`webhook_allowlist` entries are normalised (trimmed, lower-case, de-duplicated). Ranges:
`default_offline_minutes` 0–10080, `unknown_threshold` 1–100, `retention_days` 7–3650.
Retention also purges delivery history.

`PUT /settings/smtp` accepts `{ host, port?, security?, username, password?, from_address, from_name }`.
`security` defaults to `starttls`, and `port` to 587 (465 for `tls`). Sending `password` as `null`
or `""` clears it; omitting it, or sending `"••••••"`, keeps it. The password is field-encrypted
(AAD `settings/smtp/password`). The client refuses to send credentials without TLS.
`POST /settings/smtp/test` returns `{ ok, error? }`, and `409 smtp_not_configured` when no host or
sender is set. Mail is multipart text and HTML, sent with `Auto-Submitted: auto-generated`.

On first start the server creates a **"Baseline monitoring"** policy, assigned globally, with
sensible checks for all three platforms. Built-in scripts can be used for remediation.

The baseline policy has the id `builtin-baseline-monitoring` and a global assignment with priority
−100, so other global policies override it. It is created once (the setting
`monitoring_baseline_seeded` records that); after that, administrators may edit or delete it and it
is not recreated. It contains:

| id | type | platforms | config |
|---|---|---|---|
| `cpu-high` | cpu | all | 90 / 98 %, 15 min window |
| `memory-high` | memory | all | 90 / 97 %, 15 min window |
| `disk-space-windows` | disk | windows | `*`, 10 / 5 % free; remediation: built-in "Clear temporary files" (`OlderThanDays` 7, 1 attempt) |
| `disk-space` | disk | linux, macos | `*`, 10 / 5 % free |
| `uptime` | uptime | all | 30 / 60 days |
| `pending-reboot` | pending_reboot | windows, linux | 72 h |
| `antivirus` | antivirus | (windows) | 72 h signatures |
| `firewall` | firewall | windows | |
| `windows-update` | windows_update | (windows) | 35 days, failures |

Its `server` section enables everything: offline after 15 minutes (critical), outdated agents,
a 14-day disk forecast and security changes.

## Server-side checks

| Check id | When | Severity | Clears |
|---|---|---|---|
| `offline` | The device has not been seen for `offline_minutes` (checked every minute) | `offline_severity` | When it reconnects, or when the check is disabled |
| `agent_outdated` | Two or more imported releases are newer than the agent (hourly) | warning | When fewer than two are newer |
| `disk_forecast` | A least-squares fit over 7 days of 15-minute metrics predicts the fullest volume reaches 100 % within `disk_forecast_days`; needs 12+ points over 24 h or more (hourly) | warning | When the forecast is clear |
| `security.local_admin_added` | The security inventory lists a new local administrator | warning | Manual only; repeats add occurrences |
| `security.antivirus_off` | Antivirus protection went from on to off | critical | When it is on again |
| `security.firewall_off` | The firewall went from on to off | warning | When it is on again |
| `security.encryption_off` | BitLocker, FileVault or LUKS on the system volume went from on to off | warning | When it is on again |

## Remediation

Opening (or reopening) an alert for a check with `remediation` creates a job named
`Remediation: <script> on <host>`. The job targets the device, has schedule `now`, a 60-minute
offline wait and concurrency 1, and `created_by_name` is `Monitoring`. Its run has trigger
`policy`. The job is not linked to a policy (`policy_id` is `null`), so it can be inspected and
deleted like any job, and the mass-action guard does not apply. The script's current version runs,
or the approved one when approval is required. Parameters are validated like policy tasks.

The alert's `remediation` is `{ status: "running" | "succeeded" | "failed", job_id, attempts }`,
with events `remediation_started` and `remediation_finished`. A result counts as succeeded only
with exit code 0. Results that end without an agent answer (offline, skipped) are picked up within
15 s. No remediation runs during maintenance, for server-side checks or for `unknown` alerts.

## Audit

`alerts.acknowledged`, `alerts.unacknowledged`, `alerts.resolved`, `alerts.snoozed`,
`alerts.assigned`, `alerts.note_added`, `alerts.bulk`, `notifications.channel_created`,
`notifications.channel_updated`, `notifications.channel_deleted`, `notifications.channel_tested`,
`notifications.rule_created`, `notifications.rule_updated`, `notifications.rule_deleted`,
`notifications.smtp_updated`, `notifications.smtp_tested`, `maintenance.created`,
`maintenance.updated`, `maintenance.deleted` and `settings.monitoring_updated`. Channel secrets and
the SMTP password never reach the audit log; updates record which secret fields changed.
Remediation jobs record `job.run_started` with the system as actor.

## Live events

| Event | Payload |
|---|---|
| `alert.opened` | `{ alert }` |
| `alert.updated` | `{ alert }` |
| `alerts.summary` | `{ client_id, open, critical, warning }`, throttled to once per 2 s **per client** |
| `device.checks` | `{ device_id }` |

`fleet.summary` gains `alerts: { critical, warning }`.

Events carry their alert's client, so subscribers only receive alerts they may see.
`alerts.summary` counts one client's non-resolved alerts; it is published per client so counts
never leak across tenants. A console that needs totals refetches `GET /alerts/summary`.
`GET /fleet/summary` returns `alerts: { critical, warning }` (open and acknowledged alerts in the
caller's scope, honouring `client_id`/`site_id`) and fills the existing `critical_alerts` and
`warning_alerts` fields with the same numbers. The `fleet.summary` event stays data-less (refetch).

## Data model (migration `0006_monitoring.sql`)

| Table | Holds |
|---|---|
| `check_states` | per device and check: `device_id`, `check_id`, `type`, `name`, `state`, `message`, `value`, `since`, `last_at`, `policy_id` (plus `streak`, `last_ok_at`, `interval_secs`) |
| `alerts` | alerts (plus `condition_cleared_at` for the reopen rule; a partial unique index enforces one non-resolved alert per device and check) |
| `alert_events` | each alert's event history |
| `notification_channels` | channels, with field-encrypted config (AAD `notification_channels/config/<id>`) |
| `notification_rules` | rules |
| `notification_escalations` | escalations already sent (alert, rule) |
| `notification_log` | delivery attempts (also the retry queue) |
| `maintenance_windows` | maintenance windows |

SMTP and monitoring settings live in `settings` (keys `smtp`, `monitoring`, and the marker
`monitoring_baseline_seeded`). The agent keeps its configuration, debounce state and result queue
in `<data dir>/monitoring.json`. Like the device key, that file is readable only by
SYSTEM/Administrators or root, because script checks embed variable values.
