# Reports, SSO, public API and hardening (Phase 11)

This document covers the report library with PDF output and scheduled email, customisable
dashboards, OIDC single sign-on, API tokens, the public API documentation, outbound webhooks,
white-label branding, the Noise IK end-to-end channel, the code-signing tooling, and a final
hardening pass.

The conventions are the same as in `api-automation.md`:

- Routes live under `/api/v1`.
- The console uses the session cookie and `X-CSRF-Token`; API tokens use the `Authorization` header.
- Errors use the standard envelope.
- Results are scoped to the caller.

Implementation status: everything in this document is implemented — reports, dashboards, OIDC
SSO, API tokens, OpenAPI, webhooks and branding (part A); the Noise IK channel, code-signing
tooling and hardening pass (part B).

## Permissions

| Permission | Covers |
|---|---|
| `reports.view` | Run and view reports, report runs and shared dashboards |
| `reports.manage` | Report schedules, everyone's report runs (installation-wide), shared dashboards |
| `api.manage` | Webhooks; everyone's API tokens (`?all=true`, revoke any). Your own tokens need only a signed-in user |
| `settings.manage` | SSO providers and SSO enforcement (with step-up), branding, product logos, code signing status |

Besides `reports.view`, each report needs the view permission of its data (listed by
`GET /reports/types` as `permission`), and every row is filtered by the caller's client/site
scope for that permission. Each dashboard widget likewise needs the view permission of its data.

## Reports

Built-in report types each take parameters `{ client_id? | "all", site_id?, from?, to? }` (period
defaults: the 30 days before now). Type-specific parameters: `software_inventory` takes
`products: [name]`, `alert_history` takes `severity`, `audit` takes `action` (prefix) and `actor`
(id or part of the name).

| `type` | Data permission | Contents |
|---|---|---|
| `executive_summary` | `devices.view` | KPIs (devices, online %, average health, patch compliance, alerts, open critical, MTTA/MTTR in minutes, tickets opened/resolved, SLA met %, open tickets), health score trend (line chart from the daily snapshot), OS mix (donut), alerts by severity, patching KPIs, security posture table, top issues, a per-client table when several clients are included, and rule-based recommendations |
| `hardware_inventory` | `devices.view` | Device table with manufacturer, model, serial, CPU, RAM (GB), disk total (bytes), OS, age in years (BIOS date, else enrollment) and device custom fields whose key or name contains "warranty" |
| `software_inventory` | `software.view` | Products (normalised name and publisher) with version count, latest version and device count; a licence-count table per client for the requested `products` |
| `patch_compliance` | `patches.view` | KPIs, compliance per client and site, and devices missing critical/important patches with the age of the oldest missing patch and failed installs |
| `alert_history` | `alerts.view` | KPIs (counts per severity, MTTA, MTTR), alerts per day (bar chart by severity), and the alert table with duration (minutes) and resolution |
| `security_posture` | `devices.view` | A device × check matrix (`Pass`/`Fail`/`null` for antivirus, firewall, disk encryption, ≤ 2 local admins, UAC, SMBv1 off, no auto-logon) with the failing items, plus per-check pass rates |
| `agent_status` | `devices.view` | Versions with device counts and the current release, offline devices with days offline, devices pending approval |
| `tickets_time` | `tickets.view` | Opened, resolved, SLA met; per client (opened, resolved, within SLA, breached, hours, billable hours); time per user |
| `audit` | `audit.view` | Entries for the period (max 20,000) and the most frequent actions. Installation-wide entries need `audit.view` globally |

Recommendations (`executive_summary`, section `Recommendations`) come from fixed rules: patch
compliance below 90 %, missing critical updates, antivirus missing/disabled/out of date,
unencrypted system drives, firewall disabled, more than two local admins on over 10 % of
devices, open critical alerts, SLA met below 90 %, devices offline for more than a week, disks
above 90 %, restarts pending, outdated agents. With no finding the list says no action is needed.

| Route | Permission | Notes |
|---|---|---|
| `GET /reports/types` | `reports.view` | `{ items: [{ type, name, description, permission, parameters: [{ name, type: "string" \| "datetime" \| "array", required, description }] }] }` (only types whose data permission you hold) |
| `POST /reports/run` | `reports.view` + data permission | Body `{ type, parameters, format: "json" \| "csv" \| "pdf", async?: bool }`. JSON returns `{ report: Report, run_id }`. CSV and PDF stream a file (`Content-Disposition: attachment`, header `X-Report-Run-Id`). Runs over more than 500 active devices in scope, or with `async: true`, return `202 { run_id, status: "queued" }`; poll `GET /report-runs/{id}` and download |
| `GET /report-runs?limit=&schedule_id=` | `reports.view` | `{ items: [ReportRun] }`: your runs; `reports.manage` held installation-wide sees everyone's and scheduled runs |
| `GET /report-runs/{id}` | `reports.view` | `ReportRun` |
| `GET /report-runs/{id}/download` | `reports.view` | The file. `409 not_ready` while queued/running; `404` once the file expired (30 days) |
| `GET` / `POST` / `PUT` / `DELETE /report-schedules[/{id}]` | `reports.manage` | A schedule is `{ id, name, type, parameters, format: "pdf" \| "csv", cron, timezone, recipients: [email], per_client: bool, enabled, next_run_at, last_run_at, last_status: "ok" \| "failed" \| null, last_error, created_by, created_at, updated_at }`. With `per_client`, each client gets its own branded report, sent to that client's primary contacts (`is_primary` with an e-mail) plus `recipients` |
| `POST /report-schedules/{id}/run-now` | `reports.manage` | Generates and e-mails the schedule now: `{ run_ids }` |

`ReportRun` is `{ id, type, title, format, status: "queued" | "running" | "completed" | "failed",
trigger: "manual" | "schedule", schedule_id, client_id, user_id, user_name, file_name, size_bytes,
error, emailed_to: [email], created_at, started_at, finished_at, downloadable, parameters }`.

Schedule rules: `cron` is five fields evaluated in `timezone`; `from`/`to` are refused (a
scheduled run always covers the 30 days before it runs); `recipients` are lower-cased, at most
50, and required unless `per_client`; a schedule scoped to one client needs `reports.manage` over
that client, otherwise installation-wide. A schedule runs with its creator's current scope and
fails (with `last_error`) if the creator is disabled or deleted. SMTP must be configured
(`/settings/smtp`). Generation is cut off after 120 seconds. Outputs are kept 30 days, run
records 180 days. Runs interrupted by a restart are marked failed.

Audit: `report.run`, `report_schedule.created|updated|deleted|run_now`.

A `Section` is a JSON structure that both the console and the PDF renderer understand
(discriminated by `kind`):

```jsonc
{ "kind": "kpis",  "title": "…", "items": [{ "label", "value": number | string | null, "unit"?: "%" | "min" | "h" | "GB" | "years" | …, "tone"?: "good" | "warn" | "bad" | "neutral" }] }
{ "kind": "table", "title": "…", "columns": [{ "key", "label", "align"?: "left" | "right",
                                               "format"?: "text" | "number" | "percent" | "date" | "datetime" | "bytes" | "duration" }],
                   "rows": [[cell, …]],          // arrays aligned with columns; duration = minutes
                   "total_rows"?: n }            // only when rows were truncated
{ "kind": "chart", "title": "…", "chart": "bar" | "line" | "donut", "labels": ["…"],
                   "series": [{ "name", "values": [number] }], "unit"?: "…" }
{ "kind": "text",  "title": "…", "body": "plain text" }
{ "kind": "list",  "title": "…", "items": ["…"] }
```

`Report` is `{ type, title, subtitle, generated_at, period: { from, to }, client: { id, name } | null,
sections: [Section] }`.

CSV output contains every section in order: a one-cell title row, then the rows, sections
separated by a blank line (KPIs become `Metric,Value,Unit`; charts one column per series). It
starts with a UTF-8 BOM, and cells starting with `=`, `+`, `-`, `@`, tab or CR (except numbers)
are prefixed with `'`.

**PDF rendering.** The PDF is written with the pure-Rust `pdf-writer` crate (no font files: the
standard Helvetica fonts with WinAnsi encoding, so characters outside Latin-1 print as `?`) by a
small layout engine over the same section model: an accent band and header on every page with
the MSP logo (else the product name) and the client logo, a title block, KPI tiles, tables with
repeated headers and zebra rows (at most 2,000 rows; the CSV has all), bar/line charts and
share bars for donuts, text and bulleted lists, and "Page n of m" footers. Logos are embedded
when they are PNG (8-bit, non-interlaced; RGB, grey, palette or with alpha); SVG logos are used
in the console and e-mail but not in PDFs.

*Why not typst:* embedding typst 0.15.1 (with `typst-pdf` and `typst-assets`) adds about 300
crates and, under this repository's `deny.toml`, two open vulnerability advisories (`quick-xml`)
and six unmaintained-crate advisories (`yaml-rust`, `unsafe-libyaml`, `paste`, `ttf-parser`,
`rustybuzz`, `bincode`) that `cargo deny check` would fail on. Its bundled fonts are also only
serif and monospace (Libertinus, New Computer Modern, DejaVu Sans Mono). The section model is
renderer-independent, so typst (with Mona Sans/Monaspace embedded) can replace `reports/pdf.rs`
later without API changes. Data gathering runs on the async runtime and rendering on the
blocking pool, under a 120-second timeout.

The executive summary trend uses `client_health_daily`, a per-client snapshot (devices, online,
average health score) recorded hourly for the current day and whenever an executive summary runs.

## Dashboards

- **Dashboard.** `{ id, name, owner_id, owner_name, shared: bool, layout: [{ widget, x, y, w, h,
  config }], is_default, editable, created_at, updated_at }`. The grid has 12 columns:
  `0 ≤ x`, `1 ≤ w`, `x + w ≤ 12`, `0 ≤ y ≤ 1000`, `1 ≤ h ≤ 24`; at most 40 widgets; `config` is an
  object of at most 4 KB.
- **Widgets:** `fleet_health`, `alerts_by_severity`, `alerts_list`, `patch_compliance`,
  `tickets_open`, `sla_breaches`, `devices_offline`, `os_mix`, `agent_versions`, `top_disk_usage`,
  `recent_jobs` and `custom_field_breakdown`. Every widget has a server aggregation at
  `GET /dashboards/widgets/{widget}?config=<URL-encoded JSON>`; `config` takes `client_id`,
  `site_id`, `limit` (1–100, default 10), `field` (custom field key, `custom_field_breakdown`)
  and `days` (1–90, `recent_jobs`). The answer is `{ widget, generated_at, data }`:

  | Widget | Permission | `data` |
  |---|---|---|
  | `fleet_health` | `devices.view` | `{ devices, online, offline, avg_health, buckets: { healthy (≥ 80), warning (50–79), critical (< 50) } }` |
  | `alerts_by_severity` | `alerts.view` | `{ total, open: { critical, warning, info }, acknowledged }` (unresolved alerts) |
  | `alerts_list` | `alerts.view` | `{ total, items: [Alert] }` (unresolved, by severity then newest) |
  | `patch_compliance` | `patches.view` | `{ devices, compliant, non_compliant, compliance_pct, missing_critical, missing_important, pending_reboot, failed }` |
  | `tickets_open` | `tickets.view` | `{ total, by_status: {…}, by_priority: {…} }` |
  | `sla_breaches` | `tickets.view` | `{ total, items: [{ id, number, subject, client_id, status, priority, first_response_breached, resolution_breached, resolution_due }] }` |
  | `devices_offline` | `devices.view` | `{ total, items: [{ device_id, hostname, client_id, client_name, last_seen_at }] }` (longest offline first) |
  | `os_mix` | `devices.view` | `{ items: [{ os, family, count }] }` |
  | `agent_versions` | `devices.view` | `{ latest, outdated, items: [{ version, count }] }` |
  | `top_disk_usage` | `devices.view` | `{ items: [{ device_id, hostname, client_name, disk_pct }] }` |
  | `recent_jobs` | `scripts.view` | `{ items: [{ run_id, job_id, name, status, started_at, finished_at, counts }] }` |
  | `custom_field_breakdown` | `devices.view` | `{ field, field_name, items: [{ value, count }] }` (`(not set)` included) |

- **Routes.**

  | Route | Permission | Notes |
  |---|---|---|
  | `GET /dashboards` | signed in | `{ items: [Dashboard], widgets: [name] }`: your own plus shared ones (shared need `reports.view` to see) |
  | `GET /dashboards/default` | signed in | Your Home dashboard, or the built-in layout `{ id: "builtin-home", editable: false, … }` |
  | `GET /dashboards/{id}` | signed in | |
  | `POST /dashboards` | signed in; `shared: true` needs `reports.manage` | Body `{ name, shared?, layout, is_default? }` → `201 Dashboard` |
  | `PUT /dashboards/{id}` | owner, or `reports.manage` for shared | Same body. `is_default: true/false` alone (with unchanged content) sets/clears your Home dashboard on any dashboard you can see |
  | `DELETE /dashboards/{id}` | owner, or `reports.manage` for shared | |

  Shared dashboard changes are audited (`dashboard.created|updated|deleted`).
- **Home.** The console's Home page shows `GET /dashboards/default`.

## OIDC single sign-on

- **Provider** (`client_secret` is write-only and field-encrypted):

  ```jsonc
  { id, name, issuer_url, client_id,
    has_client_secret: bool,              // response only
    scopes: ["openid", "email", "profile"],
    group_claim: "groups",                // top-level claim or dotted path, e.g. "realm_access.roles"
    role_mappings: [{ group, role_id, scope_type: "global" | "client", scope_id? }],
    auto_provision: bool, require_local_mfa: bool,
    trust_unverified_email: bool,         // accept `email` without `email_verified: true` (e.g. Entra ID)
    enabled, button_label: "Sign in with Microsoft",
    redirect_uri,                         // response only: register this at the identity provider
    created_at, updated_at }
  ```

  The request body is the same without the response-only fields; `client_secret` is accepted on
  create and update (omit to keep, `""` to clear). `issuer_url` must be https (http only for
  loopback test issuers); `openid` is always included in `scopes`; the Owner role cannot be
  mapped (owners are managed locally); mappings name existing roles and clients.
- **Flow.** The server performs the authorization code flow with PKCE (S256) and verifies the ID
  token with JWKS from discovery:
  - `GET /auth/oidc/{provider_id}/start?return_to=/path` stores state, nonce, PKCE verifier and
    `return_to` in a short-lived (10 minutes) encrypted `__Host-rustrmm_oidc` cookie (Secure,
    HttpOnly, SameSite=Lax because the callback is a cross-site navigation) and redirects (`303`)
    to the provider.
  - `GET /auth/oidc/{provider_id}/callback` checks the state, exchanges the code
    (`client_secret_basic` when the provider supports it, else `client_secret_post`), verifies the
    ID token signature (RS256/384/512, PS256/384/512, ES256/384, EdDSA; `none`/HMAC refused) against
    the JWKS (refetched once on an unknown key), `iss` (discovery issuer), `aud`/`azp`, `exp`/`iat`/
    `nbf` (2 minutes skew) and `nonce`, then finds the user by linked identity
    (`user_identities`), else by e-mail (verified, or `trust_unverified_email`), else creates one
    when `auto_provision` (with an unusable random password). Role mappings are re-applied at
    every sign-in: assignments the provider manages (`role_assignments.managed_by`) are replaced,
    console-made assignments are untouched.
  - On success the callback sets the session cookie and redirects to `return_to` (default `/`).
    When local MFA is needed it redirects to
    `/login#sso_challenge=<token>&mfa=required&methods=totp,webauthn,recovery_code` (or
    `…&mfa=setup` when the user has no factor yet); the login page completes it with the existing
    `/auth/mfa/totp`, `/auth/mfa/webauthn/*`, `/auth/mfa/recovery` or `/auth/mfa/setup/totp/*`
    routes using that `challenge_token`. Failures redirect to `/login#sso_error=<code>` with codes
    `rate_limited`, `unknown_provider`, `provider_unavailable`, `flow_expired`, `state_mismatch`,
    `idp_error`, `token_exchange_failed`, `invalid_token`, `no_email`, `email_not_verified`,
    `not_provisioned`, `account_disabled`, `internal`.
- **MFA.** SSO users skip local MFA only if the provider asserts MFA: `amr` contains `mfa`, or a
  second factor (`otp`, `sms`, `hwk`, `swk`, `fido`, `face`, `fpt`, `iris`, `retina`, `sc`) next to
  `pwd` or another factor, or `acr` contains `mfa`/`2fa`/`multi-factor` or is `phr`/`phrh`.
  Otherwise local MFA still applies; `require_local_mfa: true` always requires it. A session
  created without local MFA is not stepped up (step-up still needs TOTP or a passkey).
- **Break glass.** Global owners always keep password plus MFA login. `settings.sso.enforce` makes
  `POST /auth/login` answer `403 sso_required` for everyone else (after a correct password).
- **Routes:**
  - `GET`, `POST`, `PUT` and `DELETE /settings/sso/providers[/{id}]` (`settings.manage`
    installation-wide + step-up, including reads). `DELETE` also removes linked identities and the
    provider's managed role assignments.
  - `GET /settings/sso` (`settings.view`) and `PUT /settings/sso` (`settings.manage` + step-up)
    read and write `{ enforce: bool }`; enforcing needs at least one enabled provider.
  - `GET /auth/providers` (public, no auth) returns `{ items: [{ id, button_label }], enforced }`
    for the login page.
- **Audit.** `sso.provider_created|updated|deleted`, `sso.settings_updated`, `user.provisioned`,
  `user.identity_linked`, `auth.sso_verified` (SSO passed, local MFA pending), `auth.login` with
  `{ method: "oidc", provider }`, and `auth.login_failed` with `{ method: "oidc", reason }`.

## API tokens

- **Format.** `rrmm_pat_<base64url 32 bytes>` (52 characters). Only the SHA-256 is stored, and the
  token is shown once at creation.
- **Fields.**

  ```jsonc
  { id, name, prefix: "rrmm_pat_Ab3d…",
    permissions: [],                    // non-empty subset of the creator's permissions
    client_ids: [] | null,              // null = creator's full scope
    expires_at,                         // default 90 days, at most 1 year
    expired: bool,
    allowed_cidrs: [] | null,           // IPs or CIDRs; null = any address
    last_used_at, last_used_ip, created_at,
    user?: { id, name, email } }        // only in ?all=true listings
  ```

- **Effective scope.** On every request: the creator's *current* scope narrowed to the token's
  permissions and clients (a global grant becomes a grant over each listed client). Owner status
  never carries over; a disabled creator invalidates their tokens.
- **Use.** Send `Authorization: Bearer rrmm_pat_…`. No CSRF token or `Origin` is needed. Step-up
  actions are refused with `403 step_up_required`. Shells, desktops, the live event stream,
  step-up, `/me/*` and creating tokens are refused with `403 token_not_allowed`. Unknown, expired
  or revoked tokens get `401 invalid_token`; a source address outside `allowed_cidrs` gets
  `403` (`details.reason: "ip_not_allowed"`). `GET /auth/me` with a token shows the token's
  effective permissions.
- **Routes.**

  | Route | Permission | Notes |
  |---|---|---|
  | `GET /api-tokens` | signed in | `{ items: [ApiToken] }`: your active (unrevoked) tokens |
  | `GET /api-tokens?all=true` | `api.manage` (installation-wide) | Everyone's tokens with `user` |
  | `POST /api-tokens` | console session + step-up | Body `{ name, permissions, client_ids?, expires_at?, allowed_cidrs? }` → `201 { token, item: ApiToken }` |
  | `DELETE /api-tokens/{id}` | owner of the token, or `api.manage` installation-wide | Revokes → `204` |

- **Audit.** `api_token.created`, `api_token.revoked`, and `api_token.used` (actor type
  `api_token`; sampled, first use per hour). Actions done with a token are audited with the user
  as actor and the name `"<user> (API token <name>)"`.
- **Rate limit.** 600 requests per minute per token (`429 rate_limited`).

## OpenAPI and documentation

- **Generation.** Handlers carry `utoipa` (6.0) `#[utoipa::path]` annotations: every Phase 11 route
  with typed request/response schemas, the core resources (authentication, clients and sites,
  users, devices, remote tools, alerts and monitoring, tickets, scripts and jobs, patching,
  escrow, network, audit, releases, deployment) with path parameters, request bodies and response
  codes. Every other routed endpoint is added from the router with method, path, path
  parameters, a tag and a summary, so the document always lists every route.
  `GET /api/openapi.json` (public) serves an OpenAPI 3.1.0 document; `operationId` is
  `<method>_<path segments>` (e.g. `get_devices_id_patches`), and the security schemes are
  `session` (cookie) and `bearer`.
- **Docs UI.** `GET /api/docs` (public) is a self-hosted static page; its script is served from
  `/api/docs/app.js` (`script-src 'self'`) and renders the spec (tags, operations, parameters,
  schemas, filter box). No third-party assets.
- **Console types.** Generate TypeScript types from the spec with
  `npx openapi-typescript https://localhost:8443/api/openapi.json -o src/api/schema.d.ts` (or
  from a saved `openapi.json`); the `npm run gen:api` script and the CI freshness check belong to
  the web workspace.

## Webhooks

- **Webhook.**

  ```jsonc
  { id, name, url,
    secret,                             // write-only; generated (and returned once) when omitted
    has_secret: true,                   // response only
    events: ["device.enrolled", "device.offline", "alert.opened", "alert.resolved",
             "job.completed", "ticket.created", "ticket.updated",
             "patch_run.completed", "secret.revealed"],
    client_ids: [] | null,              // null = every client (needs api.manage installation-wide)
    enabled,
    last_delivery: { at, status: "delivered" | "failed" | "retrying", error } | null,
    created_at, updated_at }
  ```

  `secret` is 16–256 characters; `url` is http(s) without credentials. Webhooks with
  `client_ids` receive only events of those clients (events without a client go to unscoped
  webhooks only); creating or seeing one needs `api.manage` over every listed client.
- **Delivery.** JSON `{ id, event, created_at, data }` (`id` stays the same on redelivery), headers
  `X-RustRMM-Event`, `X-RustRMM-Delivery` (delivery row id) and
  `X-RustRMM-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<body>">`. Receivers should check the
  timestamp and compare the MAC in constant time. Any 2xx counts as delivered; otherwise the
  delivery retries after 30 s, 2 min, 10 min, 30 min, 1 h, 2 h, 4 h, then every 8 h until 24 hours
  after it was created, then fails. Deliveries use the SSRF guard from Phase 6 (loopback, private
  and similar targets need the monitoring `webhook_allowlist`). History is kept 30 days.
- **Event data** (no secrets): `device.enrolled` `{ device_id, hostname, status, client_id,
  client_name, site_id, site_name, os_family }`; `device.offline` `{ device_id, hostname,
  client_id, site_id, last_seen_at, reason: "disconnected" | "connection_lost", offline_minutes }`
  (debounced, see below);
  `alert.opened` / `alert.resolved` `{ alert: Alert }`; `job.completed` `{ job_id, run_id, name,
  status, counts }`; `ticket.created` `{ ticket: Ticket }`; `ticket.updated` `{ ticket_id,
  changes }`; `patch_run.completed` `{ run_id, status, finished_at, counts }` (one per client, with
  that client's counts); `secret.revealed` `{ item_id, kind, identifier, device_id, hostname,
  client_id, site_id, revealed_by: { id, name }, reason, at }`. Test deliveries use
  `event: "webhook.test"`.
- **`device.offline` is debounced.** It is not sent when a connection drops. The server-side offline
  check (every minute) sends it once a device has been offline for its offline threshold — the
  effective monitoring policy's `server.offline_minutes`, or `default_offline_minutes` from the
  monitoring settings (15 by default); when that check is disabled (`0`), 15 minutes — and only once
  per offline period: reconnecting re-arms it. Reconnect flaps and server restarts therefore send
  nothing. `reason` says how the last connection ended (`disconnected` = the agent closed it,
  `connection_lost` = the connection broke or the server restarted); `offline_minutes` is the
  threshold that applied. Devices that were already offline when the server was upgraded are not
  reported again.
- **Routes** (all `api.manage`):
  - `GET /webhooks` → `{ items: [Webhook], events: [name] }`; `GET`, `POST` (`201`, includes
    `secret` only when generated), `PUT` and `DELETE /webhooks/{id}`.
  - `GET /webhooks/{id}/deliveries?limit=&status=` returns `{ items: [{ id, webhook_id, event_id,
    event, status: "pending" | "sending" | "delivered" | "failed", attempts, next_attempt_at,
    last_attempt_at, response_status, error, redelivery_of, created_at, delivered_at, payload }] }`.
  - `POST /webhooks/{id}/test` sends a `webhook.test` delivery synchronously (not retried) and
    returns the delivery.
  - `POST /webhook-deliveries/{id}/redeliver` queues the same payload again → `202` delivery.
- **Audit.** `webhook.created|updated|deleted|tested|redelivered`.

## Branding (white label)

- **Settings.** `GET /settings/branding` (`settings.view`) and `PUT` (`settings.manage`) take
  `{ product_name (1–60), logo_light_file_id, logo_dark_file_id, accent_color: "#rrggbb" | null }`.
  Logos are uploaded through `POST /files/branding` (`settings.manage`, or `clients.manage`
  anywhere for client logos): `multipart/form-data` with one `file` field, PNG (≤ 4096×4096) or
  SVG, at most 512 KB → `201 { id, content_type: "image/svg+xml" | "image/png", size_bytes,
  width, height, url, sanitized, created_at }`. SVGs are rebuilt from an allowlist: scripts, event
  handlers, `foreignObject`, `<style>`, images, links, animation, DTDs and every non-local
  reference (`href` other than `#id`, `url(…)` other than `url(#id)`) are dropped; `sanitized`
  says whether anything was removed.
- **Files.** `GET /branding/files/{id}` (public) serves a logo with
  `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox` and
  `nosniff`.
- **Per client.** `PUT /clients/{id}/logo` (`clients.manage` over the client) with
  `{ file_id | null }` → `{ logo_url }`. Client objects carry `logo_url`. The client logo appears
  on that client's report PDFs (PNG).
- **Where it applies.** The login page and console header (via `GET /branding`), report PDFs
  (accent colour, MSP logo, client logo, product name in the footer) and e-mail (report, alert
  notification and ticket e-mails get a header band in the accent colour with the light logo or
  the product name, and a "Sent by" footer).
- **Console theme.** `GET /branding` (public) returns `{ product_name, accent_color,
  logo_light_url, logo_dark_url }` (dark falls back to light). The accent colour overrides the
  copper token, and the console checks AA contrast before applying it.
- **Audit.** `settings.branding_updated`, `branding.file_uploaded`, `client.logo_updated`.

## Noise IK end-to-end channel

TLS protects agent connections hop by hop, so a TLS-terminating reverse proxy (`tls_mode = proxy`)
or a corporate TLS-inspection box could read commands, shell output and desktop frames. Agents and
servers that both support it therefore wrap every frame after the identity handshake in a
`Noise_IK_25519_ChaChaPoly_BLAKE2s` channel (the `snow` crate with its pure-Rust resolver: X25519,
ChaCha20-Poly1305, BLAKE2s; no OpenSSL). Implementation: `crates/proto/src/noise.rs`.

- **Negotiation.** The agent lists the `noise` capability in `Hello` when it has a static key. The
  server then adds `noise: { public_key, signature }` to `Challenge`: its static X25519 key
  (`<data>/keys/noise.key`, wrapped like the other keys), signed by the server identity key over
  the key, both handshake nonces and the device id. After `Proof` the agent sends `noise_init
  { signature, payload }` — the first IK message, which carries the agent's static key encrypted,
  plus a device-key signature over that static key and the same nonces — and the server answers
  `noise_accept { payload }`. Everything after that, starting with `Welcome`, is wrapped. The
  handshake prologue binds both nonces and the device id, so a channel cannot be moved to another
  connection.
- **Keys and pinning.** The agent generates its static key at enrollment and stores it next to the
  device key (`noise.key`, DPAPI machine scope on Windows, `0600` on Unix); agents enrolled before
  this release create one on their first start and register it on their next connection (vouched
  for by the device key). The server records it in `devices.noise_public_key` and adds
  `agent.noise_key` to the device timeline when it changes. The agent pins the server's key
  (`server-noise.pub`) after the first successful handshake. From then on it refuses a server whose
  offered key differs (`PinMismatch`) or that stops offering the channel (`Downgrade`), and logs
  the refusal; a failed handshake on the server side answers `rejected { code: "noise_failed" }`
  and adds `agent.noise_failed` to the device timeline.
- **When it is used.** Whenever both sides support it, in every TLS mode. `--agent-noise` /
  `RUSTRMM_AGENT_NOISE` is `auto` (agents without the capability stay on TLS only) except in
  `proxy` TLS mode, where it defaults to `required`: older agents are refused with
  `rejected { code: "noise_required" }` until they are updated (set `auto` explicitly to allow them
  during a migration).
- **Tunnels.** Tunnel sockets (shell, file transfer, remote desktop) run their own IK handshake with
  the same static keys as their control connection (prologue bound to the tunnel id), as two raw
  binary WebSocket messages right after the upgrade. The server only hands the socket to the
  waiting console session when the agent presents the static key of its live control connection.
  Tunnels of a TLS-only connection stay TLS-only.
- **Framing.** One WebSocket binary message carries one logical message (a protocol frame, or a
  tunnel's binary/text message), split into Noise transport messages of at most 65 535 bytes;
  every chunk is full-size except the last, so no length prefixes are needed. The first plaintext
  byte holds the data kind (binary/text) and a rekey flag. Control frames (ping, pong, close) are
  not wrapped. A data message that does not decrypt ends the connection.
- **Sizes.** The overhead is one header byte plus a 16-byte tag per 64 KiB chunk (≈ 0.03 %). The
  WebSocket limits include it: control connection `sealed_len(16 MiB + 64 KiB)`, tunnels
  `sealed_len(8 MiB)` towards the server and `sealed_len(4 MiB)` towards the agent.
- **Rekeying.** Each side rekeys its sending key (Noise `REKEY`) after 1 GiB of plaintext or one
  hour, whichever comes first, flagging the last message under the old key so the receiver follows.
- **Simulator.** `rustrmm-sim` speaks the channel by default (keys kept in `sim-state/`);
  `--no-noise` simulates older agents.

## Code signing tooling

`cargo xtask sign --provider none|pfx|pkcs11|azure|apple-devid|apple-selfsigned [paths…]` and
`cargo xtask dist` are driven by `signing.toml` (git-ignored; see `signing.toml.example`) or by
`RUSTRMM_SIGN_*` environment variables in CI. When nothing is configured, the build skips signing
with a warning and never fails; `--require` / `--require-signing` turns missing tooling into an
error for release pipelines.

| Platform | Tooling |
|---|---|
| Windows | `osslsigncode` (PFX or PKCS#11) or `signtool` (PFX, certificate store, Azure Trusted Signing dlib). The exe is signed before it is packed into the MSI, then the MSI itself is signed, both with RFC 3161 timestamps. The release Docker build does the same with `packaging/windows/sign.sh` and BuildKit secrets |
| macOS | `codesign` (hardened runtime, secure timestamp) plus `notarytool submit --wait` for Developer ID; a stable self-signed identity keeps TCC grants across updates |
| Linux | Optional minisign signatures (`<file>.minisig`, listed in the bundle manifest) |

`docs/signing.md` is the step-by-step guide.

### Settings → Code signing

`GET /settings/signing-status` (`settings.manage` installation-wide) inspects the files of the
newest imported agent release (highest version in **Agent releases**), or of the agent
distribution directory when no release has been imported yet. Parsing is pure Rust and best
effort; certificate chains are not validated (that is the endpoint's job).

```jsonc
{
  "source": "release" | "distribution" | "none",
  "version": "0.2.0" | null,                  // release version (null for distribution/none)
  "imported_at": "2026-11-18T10:00:00Z" | null,
  "platforms": [{
    "platform": "windows-x86_64",             // windows-x86_64 | linux-x86_64 | linux-aarch64 | macos-universal | …
    "status": "signed" | "partially_signed" | "unsigned" | "invalid" | "unknown",
    "files": [{
      "file": "rustrmm-agent.exe",
      "format": "pe" | "msi" | "macho" | "elf" | "other",
      "status": "signed" | "unsigned" | "invalid" | "unknown",
      "method": "authenticode" | "apple" | "adhoc" | "minisign" | null,
      "signer": {                             // null when unsigned or not embedded
        "subject": "C=US, O=Contoso Ltd, CN=Contoso Ltd",   // or "minisign key 0102030405060708"
        "issuer": "C=US, O=DigiCert, Inc., CN=…" | null,
        "serial": "0b50cf246b263efd85a729315158f3ff" | null, // hex
        "thumbprint_sha1": "607A3EDAA64933E94422FC8F0C80388E0590986C" | null,
        "not_before": "2024-04-08T00:00:00Z" | null,
        "not_after": "2027-04-10T23:59:59Z" | null
      } | null,
      "timestamped": true | false | null,     // Authenticode/Apple: countersignature or RFC 3161 token present
      "digest_valid": true | false | null,    // PE only: the Authenticode digest matches the file
      "detail": "…" | null                    // human-readable note (e.g. "Ad-hoc signature (no signing identity)")
    }]
  }]
}
```

- **PE (exe):** the security directory's `WIN_CERTIFICATE` (PKCS#7 `SignedData`) gives the signer
  certificate (matched by issuer and serial); the `SpcIndirectDataContent` digest (SHA-256 or SHA-1)
  is compared with a fresh Authenticode hash of the file — a mismatch makes the file `invalid`
  ("modified after it was signed").
- **MSI:** the `\u0005DigitalSignature` stream of the compound file; the digest is not recomputed
  (`digest_valid: null`).
- **Mach-O:** the CMS blob in the `LC_CODE_SIGNATURE` super blob gives the Developer ID signer
  (`method: "apple"`); a signature without CMS is `unsigned` with `method: "adhoc"`. Notarization
  cannot be checked offline (`detail` says so).
- **ELF:** a detached `<file>.minisig` next to the binary makes it `signed` with
  `method: "minisign"`; the key id and trusted comment are reported, the signature itself is not
  verified (the server does not know your public key).
- Platform `status`: `signed` when every file is signed, `partially_signed` when some are,
  `invalid` when any signature does not match its file, `unsigned` when none are, otherwise
  `unknown`. Signature sidecars (`.minisig`, `.sig`) and `manifest.json` are not listed.

## Hardening pass

- **Authorization matrix** (`crates/server/tests/authz_matrix.rs`). Every `/api/v1` route is read
  from the router source (`openapi::router_routes`), so a new route without an expectation fails
  the test, as does an expectation for a route that no longer exists. Each route is called as
  Owner, Administrator, Technician, Help Desk, Auditor, a Technician scoped to one client and a
  user without any role, plus anonymously, by the owner without a recent step-up and by an API
  token with every permission. Expectations (`Public`, `Authenticated`, `Global(perm)`,
  `Scoped(perm)`, `Author`, `Ticket`) live in one table; the built-in roles' permission sets are
  asserted too. Request bodies are synthesised from the server's own deserialisation errors so the
  permission checks are reached. Step-up routes and session-only routes (shells, desktops, the live
  stream, `/me/*`, step-up, token creation) are listed explicitly; API tokens never get past them.
  A second test checks that a client-scoped technician's lists only contain that client's devices,
  clients, sites, tickets and alerts and that every device/client/site/ticket/alert route refuses
  another client's ids. Run with `AUTHZ_DISCOVER=1` to print the observed matrix.
- **Fuzzing** (`fuzz/`, cargo-fuzz, nightly): targets `frame_decode` (agent frames, every typed
  body, the Noise handshake and transport parsers), `command_payload`, `deploy_key`,
  `tunnel_control`, `desktop_message` and `rule_engine` (dynamic group rules). The bodies live in
  the `rustrmm-fuzzing` workspace crate, whose stable tests push 3 000 random and seed-mutated
  inputs through every target on each `cargo test`.
- **Security headers** (`crates/server/tests/hardening.rs`): CSP (`script-src 'self'`,
  `frame-ancestors 'none'`; sandboxed for attachments and branding files), HSTS (one year),
  `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`,
  `Permissions-Policy`, COOP and CORP on the SPA, client routes, JSON responses and errors, static
  404s, downloads (audit export, installers), ticket attachments, `/api/docs`, its script,
  `/api/openapi.json`, public branding JSON and files, and `/healthz`.
- **Rate limits** (same test file): login (10/min per address), MFA (20/min), enrollment (120/min),
  support requests (5/hour per device) and API tokens (600/min per token) answer
  `429 rate_limited`.
- **Supply chain.** `cargo deny check` passes (advisories, licences, bans, sources); every ignored
  advisory carries a written justification in `deny.toml`, workspace crates are `publish = false`
  and skipped by the licence check, and `aws-lc-rs`, `aws-lc-sys` and `openssl-sys` are banned
  (rustls and S3 backups use ring). `npm audit --omit=dev` runs in CI. The release workflow
  (`.github/workflows/release.yml`) attaches CycloneDX SBOMs for every Rust crate
  (`cargo-cyclonedx`) and for the console (`@cyclonedx/cyclonedx-npm`) plus `SHA256SUMS`, and the
  image gets BuildKit SBOM/provenance attestations. GitHub Actions are pinned by full commit SHA.
- **Webhook noise.** `device.offline` is debounced (see Webhooks).
- **Contract changes from the pass:** `GET /system/health` now needs `settings.view`
  installation-wide (it exposes installation-wide counts); `POST /alerts/{id}/snooze` checks
  `alerts.manage` before validating its body.
- **Documentation:**
  - `docs/deployment.md` (Docker on Linux and Windows, native, TLS modes incl. proxy, two-listener
    exposure, firewall).
  - `docs/gpo.md` (both GPO options step by step).
  - `docs/signing.md`.
  - `docs/backup-restore.md`.
  - `docs/hardening.md` (checklist for operators).

## Data model (migration `0011_platform.sql`)

| Table | Purpose |
|---|---|
| `report_runs` | Report runs (`output` holds the file for 30 days) |
| `report_schedules` | Report schedules (`next_run_at`, `last_status`, `last_error`) |
| `client_health_daily` | Daily per-client devices/online/average health (executive summary trend) |
| `dashboards` | Dashboards |
| `dashboard_defaults` | Each user's Home dashboard |
| `oidc_providers` | SSO providers (`client_secret` is field-encrypted) |
| `user_identities` | `user_id`, `provider_id`, `subject`, `email`, `last_login_at` |
| `role_assignments.managed_by` | New column: the SSO provider that manages an assignment (NULL = made in the console) |
| `api_tokens` | API tokens (`token_hash` = SHA-256; `last_audit_at` for use sampling) |
| `webhooks` | Webhooks (`secret` is field-encrypted) |
| `webhook_deliveries` | Webhook delivery history (exact signed `payload`) |
| `branding_files` | Uploaded branding logos (sanitised bytes in the database) |

Settings keys: `branding` (`BrandingSettings`), `sso` (`{ enforce }`). `clients.logo_blob` holds
the client's branding file id.

Migration `0012_hardening.sql` adds `devices.noise_public_key` (the agent's Noise static key,
`x25519:<base64>`), `devices.offline_reason` and `devices.offline_notified_at` (debounced
`device.offline`).
