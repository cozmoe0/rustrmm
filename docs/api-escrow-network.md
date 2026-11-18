# Secrets escrow, network discovery and SNMP (Phase 10)

This document covers BitLocker recovery-key escrow, LAPS-style local administrator password
rotation, FileVault/LUKS escrow where the operating system allows it, network discovery from a site
probe agent, and SNMP monitoring with templates, thresholds, graphs and traps.

Conventions are the same as in `api-automation.md`: routes under `/api/v1`, the session cookie,
`X-CSRF-Token`, the standard error envelope, and results scoped to the caller.

## Permissions

| Permission | Covers |
|---|---|
| `secrets.reveal` | Reveal escrowed secrets (also needs step-up and a typed reason) |
| `secrets.manage` | Escrow and LAPS policies, rotate now, delete escrow items |
| `network.view` | Discovery results, SNMP devices, metrics, traps |
| `network.manage` | Probe assignment, scans, SNMP credentials, templates, thresholds |

## Escrow cryptography

The server already holds an **escrow age X25519 key**, wrapped in a key file (see
`docs/security.md`). Agents receive the escrow *recipient*, the public key, at enrollment
(`AgentConfig.escrow_recipient`). Every secret is encrypted on the device to that recipient with
`age`, so the plaintext never crosses the wire and never sits in the database. To reveal a secret,
the server decrypts it in memory and returns it once over TLS. Every reveal is audited.

The **escrow protocol** has two messages:

- **`EscrowItem` message** (`"escrow_item"`, agent → server):
  `{ kind: "bitlocker" | "laps" | "filevault" | "luks", identifier, label, ciphertext_age: bytes, captured_at, metadata, source_hash }`.
  The `identifier` is the BitLocker recovery-key protector ID, the local account name, and so on.
  `metadata` holds `volume`, `mount_point`, `key_protector_id` or `account`, and no secrets.
- **`Command::RotateLocalAdmin`** (server → agent, signed):
  `{ account: "rmm-admin", create_if_missing: true, length: 20, complexity: "full", disable_other_admins: false }`.
  The agent sets a fresh random password (CSPRNG) and immediately sends an `EscrowItem` of kind
  `laps`. The command result never contains the password.

### BitLocker (Windows)

The agent reads protectors with `Win32_EncryptableVolume` (WMI, namespace
`root\cimv2\security\microsoftvolumeencryption`), using `GetKeyProtectors` and
`GetKeyProtectorNumericalPassword`. It escrows each `NumericalPassword` protector.

Collection runs at startup, after every inventory run whose security section shows a BitLocker
change, and on `Command::EscrowRefresh`. Items are de-duplicated by
`(device, kind, identifier, hash of the ciphertext's source)`. The agent keeps a local SHA-256 of
each sent plaintext so it never sends the same key twice.

### LAPS-style rotation (Windows, Linux, macOS)

The policy section `escrow` controls rotation and FileVault:

```jsonc
{ "escrow": {
    "laps": { "enabled": true, "account": "rmm-admin", "create_if_missing": true, "length": 20,
              "rotate_days": 30, "rotate_after_reveal_hours": 24 },
    "filevault": { "escrow": false } } }
```

| Platform | How the password is set |
|---|---|
| Windows | `NetUserSetInfo` / `NetUserAdd`, adding the account to Administrators by its SID |
| Linux | `chpasswd` from stdin, never on the command line; the account is added to `sudo` or `wheel` |
| macOS | `dscl . -passwd` from stdin, through `sysadminctl` where needed |

The server schedules rotations, and rotates automatically N hours after a reveal.

### FileVault and LUKS

These are attended flows and best effort. For FileVault, the agent reports
`fdesetup status` and escrows a personal recovery key only when an administrator runs
`fdesetup changerecovery -personal`, triggered by the user. For LUKS, the agent reports which
devices are encrypted (inventory only).

## Escrow API

```jsonc
// EscrowItem (list form; no secret)
{ "id": "…", "device_id": "…", "hostname": "…", "client_name": "…", "kind": "bitlocker",
  "identifier": "{2F1C…}", "label": "C: recovery key", "metadata": { "volume": "C:" },
  "captured_at": "…", "superseded_at": null, "last_revealed_at": "…" | null, "reveal_count": 2 }
```

| Route | Permission | Notes |
|---|---|---|
| `GET /escrow?client_id=&device_id=&kind=&q=&include_superseded=false` | `secrets.reveal` or `secrets.manage` | Metadata only. Returns `{ items: [EscrowItem] }` |
| `GET /devices/{id}/escrow` | Same as above | |
| `POST /escrow/{id}/reveal` | `secrets.reveal` + step-up | Body `{ reason }`, at least 10 characters. Returns `{ secret, kind, identifier, expires_in: 60 }` with `Cache-Control: no-store`. Audited as `secret.revealed` with the reason. Owners are optionally notified through the notification rules (event `secret.revealed`). For LAPS items, schedules a rotation after `rotate_after_reveal_hours` |
| `POST /devices/{id}/laps/rotate` | `secrets.manage` + step-up | Returns `{ cmd_id }` |
| `POST /devices/{id}/escrow/refresh` | `secrets.manage` | Asks the agent to re-collect |
| `DELETE /escrow/{id}` | `secrets.manage` + step-up | Audited |
| `GET /escrow/stats` | `secrets.manage` | `{ bitlocker: { encrypted_devices, escrowed, missing: [device…] }, laps: { enabled_devices, rotated_within_policy, overdue: [device…] } }` |

The console shows a revealed secret in a dialog with a countdown. It is never cached. Copying it
clears the clipboard after 60 seconds, best effort.

## Network discovery

### Probe

One agent per site can be designated the **probe**. It runs the scans and SNMP polling for that site.

- `PUT /sites/{id}/probe` with body `{ device_id | null }` (`network.manage`).
- Only online agents can be probes, and Windows or Linux agents are preferred.
- The probe needs the local capability `network` (`features::NETWORK`).

### Scans

A scan is described by:

```jsonc
{ "id", "site_id", "name": "Office LAN", "ranges": ["192.168.1.0/24"],   // each range at most a /20 (4096 hosts)
  "methods": { "icmp": true, "arp": true, "tcp_ports": [22, 80, 443, 445, 3389, 9100, 161], "snmp": true, "mdns": true, "netbios": true },
  "schedule": { "cron": "0 */6 * * *" } | null, "snmp_credential_ids": [],
  "last_run": { "at", "hosts_found", "duration_ms", "status" } | null }
```

| Route | Permission | Notes |
|---|---|---|
| `GET /network/scans` | `network.view` | |
| `POST` / `PUT` / `DELETE /network/scans[/{id}]` | `network.manage` | |
| `POST /network/scans/{id}/run` | `network.manage` | |

The signed **`Command::NetworkScan`** carries
`{ scan_id, ranges, methods, snmp: [{ version, community?, v3? }], concurrency: 64, timeout_ms: 800 }`.

- Each scan is rate limited, and ranges must be private (RFC 1918, CGNAT or link-local) unless the
  setting `allow_public_ranges` is on.
- The agent streams `ScanResults` messages (`"scan_results"`) in batches:
  `{ scan_id, hosts: [{ ip, mac?, vendor? (OUI), hostname?, open_ports: [], snmp: { sys_descr?, sys_name?, sys_object_id? }?, mdns?: [], netbios_name?, rtt_ms? }], done }`.

### Discovered assets

```jsonc
{ "id", "site_id", "ip", "mac", "vendor", "hostname", "type_guess": "printer" | "switch" | "router" | "ap" | "nas" | "camera" | "phone" | "windows" | "linux" | "mac" | "ups" | "unknown",
  "managed_device_id": "…" | null,        // matched by MAC or hostname to an enrolled agent
  "first_seen_at", "last_seen_at", "open_ports": [], "snmp_sys_descr": "…", "notes": "", "ignored": false }
```

| Route | Permission | Notes |
|---|---|---|
| `GET /network/assets?site_id=&type=&managed=true\|false&q=` | `network.view` | |
| `PATCH /network/assets/{id}` | `network.manage` | Body `{ notes?, ignored?, type? }` |
| `POST /network/assets/{id}/monitor` | `network.manage` | Creates an SNMP device from the asset |

The type guess combines the OUI vendor, `sysObjectID` and `sysDescr` keywords, and open ports
(9100 means printer, 554 means camera, 5000 or 5001 means NAS). An OUI vendor list is bundled as a
compact file.

## SNMP monitoring

- **Credential:**

  ```jsonc
  { id, name,
    version: "v2c" | "v3",
    community?,
    v3?: { username,
           auth: "none" | "sha" | "sha256",
           auth_password?,
           privacy: "none" | "aes128",
           privacy_password? } }
  ```

  Secrets are field-encrypted and write-only.
- **SNMP device:**

  ```jsonc
  { id, site_id, asset_id?, name, ip, port: 161, credential_id, template_ids: [],
    poll_interval_secs: 300, enabled, status: "pending" | "ok" | "unreachable" | "alerting",
    last_poll_at, sys_descr, uptime_secs }
  ```

- **Template:**

  ```jsonc
  { id, name, builtin, metrics: [
      { key, label, oid, table?: bool, index_label_oid?, max_oid?, unit, kind: "gauge" | "counter" | "text",
        thresholds?: { warn?, crit?, direction: "above" | "below" } } ] }
  ```

  The built-in templates are:

  | Template | Metrics |
  |---|---|
  | Generic | `sysUpTime` |
  | Interfaces (IF-MIB) | `ifHCInOctets` / `ifHCOutOctets` as rates, `ifOperStatus`, errors |
  | Host resources | CPU load, storage used % |
  | Printer-MIB | Toner and supply levels % (`prtMarkerSuppliesLevel` / `MaxCapacity`), printer status |
  | UPS-MIB | Battery status, charge %, runtime minutes, input voltage, load % |

- **Polling.** The probe agent polls every enabled SNMP device in its site.
  - **Configuration** comes from the server as `SnmpConfig` (`"snmp_config"`):
    `{ devices: [{ id, ip, port, credential (decrypted for the probe only, sent inside the signed config), oids: […] }] }`.
    The probe keeps it in memory only and never writes it to disk.
  - **Results** come back as `SnmpResults` (`"snmp_results"`):
    `{ samples: [{ device_id, at, values: [{ key, index?, value }] }], unreachable: [device_id] }`.
  - **Rates.** The server turns counter values into rates.
- **Alerts.** Threshold breaches and unreachability raise Phase 6 alerts with source `snmp`, where
  `check_id` is `snmp:<metric key>[:<index>]` and the alert names the SNMP device.
  `alerts.device_id` becomes nullable and gains a `snmp_device_id` column.
- **Traps.** An optional trap receiver runs on the probe agent on UDP 162, enabled per site. Traps
  arrive as `SnmpTrap` (`"snmp_trap"`) `{ from_ip, at, version, oid, varbinds }` and are stored and
  listed. A trap rule can raise an alert, matched by OID prefix.

SNMP routes:

| Route | Permission | Notes |
|---|---|---|
| `GET /network/snmp/credentials` | `network.view` | Secret fields come back as `"••••••"` |
| `POST` / `PUT` / `DELETE /network/snmp/credentials[/{id}]` | `network.manage` | |
| `GET /network/snmp/templates` | `network.view` | |
| `POST` / `PUT` / `DELETE /network/snmp/templates[/{id}]` | `network.manage` | Built-in templates are read-only |
| `GET /network/snmp/devices?site_id=` | `network.view` | |
| `POST` / `PUT` / `DELETE /network/snmp/devices[/{id}]` | `network.manage` | |
| `POST /network/snmp/devices/{id}/test` | `network.manage` | Polls once through the probe. Returns `{ ok, sys_descr?, error? }` |
| `GET /network/snmp/devices/{id}/metrics?range=1h\|24h\|7d\|30d` | `network.view` | `{ series: [{ key, index?, label, unit, points: [[t, v]] }] }` |
| `GET /network/snmp/traps?site_id=&limit=` | `network.view` | |
| `GET /network/topology?site_id=` | `network.view` | Optional, best effort. Returns `{ nodes, edges }` built from ARP/LLDP (`lldpRemTable`) where available |

SNMP metrics are stored in `snmp_metrics_raw`, with 15-minute and 1-hour rollups and the same
retention as device metrics.

## Data model (migration `0010_escrow_network.sql`)

| Table | Contents |
|---|---|
| `escrow_items` | `ciphertext` BLOB (age), metadata JSON, `superseded_at` |
| `escrow_reveals` | `item_id`, `user_id`, `reason`, `at`, `ip` |
| `laps_state` | `device_id`, `account`, `last_rotated_at`, `next_rotation_at`, `last_error` |
| `site_probes` | Probe assignment per site |
| `network_scans` | Scan definitions |
| `scan_runs` | One row per scan run |
| `network_assets` | Discovered assets |
| `snmp_credentials` | SNMP credentials (field-encrypted) |
| `snmp_templates` | SNMP templates |
| `snmp_devices` | Monitored SNMP devices |
| `snmp_metrics_raw`, `snmp_metrics_15m`, `snmp_metrics_1h` | SNMP samples and rollups |
| `snmp_traps` | Received traps |
| `trap_rules` | Trap-to-alert rules |

## Details and additions (Phase 10 implementation)

Everything above stays as written; this section fills the gaps the console and agents rely on.
New JSON fields are additive.

### Protocol

| Item | Detail |
|---|---|
| `EscrowItem` | `captured_at` is the agent clock in unix milliseconds (clamped to the last 7 days). `source_hash` is the lowercase hex SHA-256 of `"rustrmm/v1/escrow\0" ‖ kind ‖ 0 ‖ identifier ‖ 0 ‖ plaintext`; the server de-duplicates on `(device, kind, identifier, source_hash)` without decrypting. A new secret for the same `(device, kind, identifier)` supersedes the previous item (`superseded_at`). `ciphertext_age` must be a binary age file (at most 16 KiB) |
| `Command::RotateLocalAdmin` | kind `rotate_local_admin`, capability `escrow`. `complexity` is `full` (upper, lower, digits, symbols `!@#$%^&*-_=+?`) or `alphanumeric`; `length` is clamped to 14–64; every class appears at least once. The agent encrypts the new password to the recipient *before* changing it, so a password that could not be escrowed is never set. `disable_other_admins: true` is refused by this agent version. Result data: `{ account, created, group, length, rotated_at }` |
| `Command::EscrowRefresh` | kind `escrow_refresh`, capability `escrow`. Re-collects and re-sends every BitLocker key (the server de-duplicates); automatic collection (start-up, and whenever the inventory's `security` section changes) skips keys whose hash the agent already sent. Result data: `{ sent, unchanged, bitlocker_volumes, errors, notes }`. On macOS `notes` carries the `fdesetup status` line (the attended FileVault escrow flow is not implemented yet); on Linux LUKS is reported by inventory only |
| `Command::NetworkScan` | kind `network_scan`, capability `network`. Adds `run_id` (echoed in every `ScanResults`) and `allow_public` (the server's `allow_public_ranges`). The probe answers `running`, streams batches of up to 64 hosts, then `succeeded` with `{ hosts_found, targets, duration_ms, icmp }`; a failed scan sends a final `ScanResults` with `done: true` and `error`. One scan runs at a time per agent |
| `ScanResults` | Adds `run_id` and `error`. The agent leaves `vendor` out; the server fills it from its OUI table |
| `Command::SnmpConfig` | kind `snmp_config`, capability `network`: the `SnmpConfig` body inside a signed command (it carries decrypted credentials): `{ version: <sha256>, devices: [{ id, ip, port, credential: { version, community?, v3? }, oids: [{ key, oid, table }], poll_interval_secs }], trap_receiver: { enabled, port } }`. Pushed on connect and whenever a device, credential, template or the probe assignment changes (only when `version` differs); a device that stops being a probe receives an empty configuration. Besides template metrics, `oids` holds helper keys: `_uptime` (sysUpTime.0), `_sysDescr`, `label:<key>` (a table metric's `index_label_oid`) and `max:<key>` (its `max_oid`) |
| `SnmpResults` | Values carry `type` (`integer`, `counter32`, `counter64`, `gauge32`, `timeticks`, `string`, `oid`, `ip`, `opaque`); counters are unsigned integers, octet strings are text when printable UTF-8 and colon-separated hex otherwise. A device that answers nothing is listed in `unreachable` |
| `Command::SnmpTest` | kind `snmp_test`, capability `network`, body is one `SnmpTarget`. Result data `{ ok, sys_descr?, sys_name?, sys_object_id?, uptime_secs?, error? }` |
| `SnmpTrap` | `version` is `v1` or `v2c` (SNMPv3 traps are not decoded). SNMPv1 traps are translated per RFC 3584 (generic 0–5 → `1.3.6.1.6.3.1.1.5.<n+1>`, enterprise-specific → `<enterprise>.0.<specific>`); `sysUpTime.0` and `snmpTrapOID.0` are not repeated in `varbinds`. Informs are acknowledged. Any community is accepted; at most 50 traps per second are forwarded |
| Capabilities | `features::ESCROW = "escrow"`, `features::NETWORK = "network"`; agents announce both in `Hello.capabilities` |

The probe paces discovery: ICMP at 400 echo requests per second (raw socket when running as
SYSTEM/root, an ICMP datagram socket on Linux/macOS otherwise, TCP probes as the fallback), TCP
connects at 500 per second, `concurrency` clamped to 1–256 and `timeout_ms` to 100–10 000. ARP
and ICMP decide liveness on directly connected ranges; routed ranges are TCP-probed in full.

### Escrow API

- Escrow items also carry `client_id` and `site_id`. Items survive deletion of their device
  (`device_id` becomes `null`, `hostname` is kept).
- `GET /escrow` and `GET /devices/{id}/escrow` list items the caller holds `secrets.reveal` or
  `secrets.manage` on (at most 1000, newest first).
- `POST /escrow/{id}/reveal`: `422 validation_failed` (`details.path: "reason"`) for a reason
  shorter than 10 or longer than 500 characters, `403 step_up_required`, `429 rate_limited`
  after 20 reveals in 10 minutes per user. The response also sets `Pragma: no-cache`.
- `POST /devices/{id}/laps/rotate` and `POST /devices/{id}/escrow/refresh` answer
  `409 device_offline` when the agent is not connected; both return `{ cmd_id }`.
- `GET /escrow/stats`: `missing` and `overdue` entries are `{ id, hostname, client_id, client_name }`.
  A BitLocker device counts as encrypted when its security inventory reports
  `encryption.method = "bitlocker"` with `system_volume_encrypted = true`.
- Audit actions: `secret.escrowed` (agent actor), `secret.revealed` (with the reason),
  `secret.deleted`, `laps.rotate_requested`, `escrow.refresh_requested`. Secrets never reach the
  audit log, events or notifications.
- Notification rules accept the event `secret.revealed` (only the rule's client and site filters
  apply; quiet hours apply). The message names the item, device, user and reason.
- LAPS scheduling: a rotation is sent to online devices whose effective `escrow.laps.enabled` is
  true when none was recorded yet, when `next_rotation_at` has passed, or `rotate_days` after the
  last rotation; a command without a result is retried after 15 minutes, a failed one after an
  hour (`laps_state.last_error`). A reveal moves `next_rotation_at` to at most
  `rotate_after_reveal_hours` ahead (0 = no rotation after a reveal).
- The `escrow` policy section accepts `laps.complexity` (`full` | `alphanumeric`) besides the keys
  shown above. Ranges: `length` 14–64, `rotate_days` 1–365, `rotate_after_reveal_hours` 0–720,
  `account` 1–20 letters, digits, `-`, `_` or `.`. Unknown keys are refused (`422` with
  `details.path`). Creating, changing, deleting, assigning or unassigning a policy with an
  `escrow` section also needs `secrets.manage` over every target. Objects deep-merge like every
  other section.

### Probes and settings

| Route | Permission | Notes |
|---|---|---|
| `GET /sites/{id}/probe` | `network.view` | `{ site_id, site_name?, device_id \| null, hostname, os_family?, online, trap_receiver, trap_port, assigned_at }` |
| `PUT /sites/{id}/probe` | `network.manage` | Body `{ device_id \| null, trap_receiver?, trap_port? }`. The probe must be an active agent of that site (`422`) and online when newly assigned (`409 device_offline`). Trap receiver settings default to the previous ones (off, port 162). Returns the probe |
| `GET /network/probes` | `network.view` | `{ items: [probe] }` for the sites the caller can see |
| `GET /settings/network` | `network.view` | `{ allow_public_ranges: false }` |
| `PUT /settings/network` | global `network.manage` + step-up | Same body; audited as `settings.network_updated` |

### Scans and assets

- Scan objects also carry `site_name`, `next_run_at`, `created_at`, `updated_at`, and
  `last_run.error`. `schedule` is `{ cron, timezone }` (five-field cron; `timezone` defaults to the
  site's). Bodies: `{ site_id, name, ranges, methods?, schedule?, snmp_credential_ids? }`; a scan
  cannot move to another site. Limits: 1–16 IPv4 ranges (CIDR or single address, each at most a
  /20), 64 TCP ports, 10 credentials. Range errors return `422` with `details.path: "ranges[<i>]"`.
  Private means RFC 1918, 100.64.0.0/10 or 169.254.0.0/16 for every address of the range (loopback
  is not private).
- `POST /network/scans/{id}/run` returns `{ run_id, cmd_id }`; `409 no_probe`, `409 probe_offline`
  or `409 scan_running` (one run per scan at a time). Runs without a final batch fail after
  2 hours. Scheduled runs are skipped silently while the probe is offline.
- Assets are keyed by site and MAC address (an address change moves the asset), otherwise by
  site and IP. `managed_device_id` matches an enrolled agent of the same client by a MAC address
  in its network inventory, then by host name (mDNS, NetBIOS or `sysName`).
- Asset objects also carry `site_name`, `type_source` (`guess` | `manual`), `managed_hostname`,
  `snmp_sys_name`, `snmp_sys_object_id`, `mdns`, `netbios_name`, `rtt_ms` and `snmp_device_id`
  (when monitored). `type_guess` is the manual type when one is set; `PATCH { type: null }` (or
  `""`) clears it. `notes` holds at most 2000 characters.
- `POST /network/assets/{id}/monitor` body: `{ credential_id, template_ids?, name?, port?,
  poll_interval_secs? }`. Templates default by type (printer: Generic + Printer-MIB; ups: Generic +
  UPS-MIB; switch/router/ap: Generic + Interfaces; nas/windows/linux/mac: Generic + Host resources +
  Interfaces; otherwise Generic). Returns the SNMP device (`201`).
- The OUI vendor table is a hand-picked compact list (about 900 prefixes of common network,
  printer, camera, UPS, NAS, virtualisation, PC and phone vendors) because no permissively
  licensed OUI source was available offline; locally administered (randomised) MACs have no
  vendor.

### SNMP credentials, templates and devices

- Credentials and templates are installation-wide: listing needs `network.view`, writing needs
  `network.manage` held globally. Credential bodies: `{ name, version, community?, v3?: { username,
  auth, auth_password?, privacy, privacy_password? } }`; v3 passwords are 8–128 characters,
  privacy needs authentication, and leaving a secret out (or sending `"••••••"`) keeps it.
  Deleting a credential in use answers `409 credential_in_use`; scans simply stop using it.
  Credentials are stored field-encrypted (AAD `snmp_credentials/secret/<id>`).
- Template metrics may set `max_oid`: the value is then reported as a percentage of the value at
  that OID with the same row index (negative values, which Printer-MIB uses for "unknown", are
  skipped). Thresholds are inclusive (`above` breaches at value ≥ threshold, `below` at value ≤
  threshold); `crit` must be at or beyond `warn`. TimeTicks are stored in seconds; counters are
  stored as per-second rates.
- Built-in templates (ids `builtin-snmp-generic`, `builtin-snmp-if-mib`,
  `builtin-snmp-host-resources`, `builtin-snmp-printer`, `builtin-snmp-ups`) are refreshed at
  start-up; editing or deleting them answers `409 builtin_template`, deleting a template in use
  `409 template_in_use`. Metric keys: Generic `sysUpTime`, `sysDescr` (text); Interfaces
  `ifHCInOctets`, `ifHCOutOctets` (B/s), `ifOperStatus`, `ifInErrors`, `ifOutErrors` (labelled by
  `ifDescr`) and `lldpRemSysName` (text, for topology); Host resources `hrProcessorLoad` (85/95 %
  above), `hrStorageUsed` (% of `hrStorageSize`, 85/95 % above); Printer-MIB
  `prtMarkerSuppliesLevel` (% of `prtMarkerSuppliesMaxCapacity`, labelled by the supply
  description, 20/10 % below) and `hrPrinterStatus`; UPS-MIB `upsBatteryStatus` (3/4 above),
  `upsEstimatedChargeRemaining` (50/20 % below), `upsEstimatedMinutesRemaining` (15/5 below),
  `upsInputVoltage`, `upsOutputPercentLoad` (80/95 % above).
- SNMP devices start as `pending` until the first poll and also carry `site_name`, `last_error`,
  `created_at` and `updated_at`. Bodies: `{ site_id, asset_id?, name, ip, port?, credential_id,
  template_ids?, poll_interval_secs?, enabled? }` (no templates → Generic; poll interval
  30–86 400; the address must be private unless `allow_public_ranges`). A device cannot move to
  another site.
- Counter rates: a decrease is a wrap for 32-bit counters, and for 64-bit counters only within
  2^56 of the top; otherwise (or when `sysUpTime` went backwards) it is a reset and that interval
  yields no rate.
- `GET /network/snmp/devices/{id}/metrics` also returns `range` and `current: [{ key, index,
  label, unit, value, text, state }]` (latest values, including text metrics; `state` is the
  threshold state). Series labels append the row label, e.g. `Supply level (Black Toner)`; points
  are `[unix seconds, value]`. Ranges map to raw samples (1h, 24h), 15-minute (7d) and hourly (30d)
  rollups; retention is 7, 90 and 730 days.

### SNMP alerts

- Alerts raised by SNMP have `source: "snmp"`, `device_id: null`, `snmp_device_id`,
  `snmp_device_name`, and `hostname` set to the SNMP device's name. `check_type` is `threshold`,
  `unreachable` or `trap`. `check_id` is `snmp:<metric key>[:<index>]` for thresholds (severity =
  the breached level, escalating while open), `snmp:unreachable` (critical) and
  `snmp:trap:<oid prefix>` (plus `:<sender ip>` for senders that are not SNMP devices).
- Thresholds and reachability resolve automatically; trap alerts resolve manually and each
  matching trap adds an occurrence. Dedupe is one non-resolved alert per SNMP device and check.
- Maintenance windows that target the alert's site, its client or everything apply to SNMP alerts.
- Notification-rule and alert-ticket-rule `sources` filters accept `snmp`.

### Traps and trap rules

| Route | Permission | Notes |
|---|---|---|
| `GET /network/snmp/traps?site_id=&limit=` | `network.view` | Newest first, `limit` 1–1000 (default 100). Items `{ id, site_id, snmp_device_id, snmp_device_name, from_ip, at, version, oid, varbinds, rule_id, alert_id }` |
| `GET /network/snmp/trap-rules` | `network.view` | `{ items: [TrapRule] }` |
| `POST` / `PUT` / `DELETE /network/snmp/trap-rules[/{id}]` | global `network.manage` | Body `{ name, enabled?, oid_prefix, severity?: "info" \| "warning" \| "critical", site_ids?: [], title? }` |

`TrapRule` is `{ id, name, enabled, oid_prefix, severity, site_ids, title, created_at, updated_at }`.
The most specific enabled rule whose prefix matches the trap OID on an arc boundary, and whose
`site_ids` is empty or contains the trap's site, raises the alert. Traps are kept 90 days and are
accepted only from the site's probe while its trap receiver is enabled.

### Topology

`GET /network/topology?site_id=` (required) returns `{ nodes: [{ id, kind: "probe" | "asset" |
"snmp" | "neighbour", label, type, ip?, mac?, device_id?, asset_id?, snmp_device_id? }], edges:
[{ from, to, kind: "arp" | "lldp", local_port? }] }`. Node ids are `device:<id>`, `asset:<id>`,
`snmp:<id>` and `lldp:<name>`. Ignored assets are left out.

### Live events

`escrow.changed` `{ device_id, kind }`, `network.scan` `{ scan_id, run_id, status, hosts_found }`,
`network.assets` `{ site_id, scan_id }`, `snmp.device` `{ id, site_id, status }` and `snmp.trap`
`{ id, site_id, oid, from_ip }`, all scoped to the client.

### Data model notes

- The migration rebuilds `alerts` (source `snmp`, `snmp_device_id`, a second partial unique
  index on `(snmp_device_id, check_id)`), preserving rows, indexes and the foreign keys that
  reference it; it runs outside sqlx's transaction (`-- no-transaction`) with foreign keys off,
  inside its own transaction.
- `snmp_values` holds the latest value, text, raw counter and threshold state per metric row.
- `escrow_items` keeps `client_id`, `site_id` and `hostname`; `escrow_reveals` records
  `user_name`; `laps_state` records the pending rotation command; `scan_runs` records the probe,
  command and trigger (`manual` | `schedule`); `network_assets` keeps `type_override`;
  `site_probes` holds the trap receiver settings.
- The agent keeps hashes of escrowed secrets in `<data dir>/escrow.json` (never secrets); the SNMP
  configuration lives only in memory.
