-- no-transaction
-- Phase 10: secrets escrow, network discovery and SNMP monitoring (additive).
--
-- `alerts` is rebuilt because SQLite cannot change a CHECK constraint: `source` gains 'snmp' and
-- alerts can name an SNMP device (`snmp_device_id`) instead of an agent device. Rows, indexes and
-- the foreign keys that point at `alerts` are preserved. Following SQLite's documented procedure,
-- foreign keys are switched off for the rebuild (otherwise dropping the old table would cascade
-- into alert_events), so this migration runs outside sqlx's transaction and manages its own.

PRAGMA foreign_keys = OFF;
BEGIN;

-- ---------------------------------------------------------------- secrets escrow
-- Ciphertexts are age files encrypted on the device to the escrow recipient; the server holds
-- the identity in its key ring (never in the database). The device's client, site and host name
-- are kept so items stay scoped (and revealable) after the device is deleted.
CREATE TABLE escrow_items (
    id               TEXT PRIMARY KEY,
    device_id        TEXT REFERENCES devices (id) ON DELETE SET NULL,
    client_id        TEXT NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
    site_id          TEXT,
    hostname         TEXT NOT NULL DEFAULT '',
    kind             TEXT NOT NULL CHECK (kind IN ('bitlocker', 'laps', 'filevault', 'luks')),
    identifier       TEXT NOT NULL,
    label            TEXT NOT NULL DEFAULT '',
    ciphertext       BLOB NOT NULL,
    source_hash      TEXT NOT NULL DEFAULT '',     -- SHA-256 of the domain-separated plaintext (de-duplication)
    metadata         TEXT NOT NULL DEFAULT '{}',   -- volume, mount_point, key_protector_id, account (no secrets)
    captured_at      TEXT NOT NULL,
    received_at      TEXT NOT NULL,
    superseded_at    TEXT,
    last_revealed_at TEXT,
    reveal_count     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX escrow_items_device ON escrow_items (device_id, kind, identifier);
CREATE INDEX escrow_items_client ON escrow_items (client_id, kind, superseded_at);

CREATE TABLE escrow_reveals (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id   TEXT NOT NULL REFERENCES escrow_items (id) ON DELETE CASCADE,
    user_id   TEXT REFERENCES users (id) ON DELETE SET NULL,
    user_name TEXT NOT NULL DEFAULT '',
    reason    TEXT NOT NULL,
    at        TEXT NOT NULL,
    ip        TEXT
);
CREATE INDEX escrow_reveals_item ON escrow_reveals (item_id, at);

CREATE TABLE laps_state (
    device_id        TEXT PRIMARY KEY REFERENCES devices (id) ON DELETE CASCADE,
    account          TEXT NOT NULL,
    last_rotated_at  TEXT,
    next_rotation_at TEXT,
    last_error       TEXT,
    pending_cmd_id   TEXT,                         -- rotation sent, result not yet received
    pending_since    TEXT,
    updated_at       TEXT NOT NULL
);

-- ---------------------------------------------------------------- network discovery
CREATE TABLE site_probes (
    site_id       TEXT PRIMARY KEY REFERENCES sites (id) ON DELETE CASCADE,
    device_id     TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    trap_receiver INTEGER NOT NULL DEFAULT 0,
    trap_port     INTEGER NOT NULL DEFAULT 162,
    assigned_by   TEXT,
    assigned_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX site_probes_device ON site_probes (device_id);

CREATE TABLE network_scans (
    id                  TEXT PRIMARY KEY,
    site_id             TEXT NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
    name                TEXT NOT NULL,
    ranges              TEXT NOT NULL DEFAULT '[]',
    methods             TEXT NOT NULL DEFAULT '{}',
    schedule            TEXT,                      -- JSON { cron, timezone } or NULL
    snmp_credential_ids TEXT NOT NULL DEFAULT '[]',
    next_run_at         TEXT,
    created_by          TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);
CREATE INDEX network_scans_due ON network_scans (next_run_at);

CREATE TABLE scan_runs (
    id           TEXT PRIMARY KEY,
    scan_id      TEXT NOT NULL REFERENCES network_scans (id) ON DELETE CASCADE,
    site_id      TEXT NOT NULL,
    device_id    TEXT,                             -- the probe that ran it
    cmd_id       TEXT,
    trigger_kind TEXT NOT NULL DEFAULT 'manual' CHECK (trigger_kind IN ('manual', 'schedule')),
    status       TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
    hosts_found  INTEGER NOT NULL DEFAULT 0,
    started_at   TEXT NOT NULL,
    finished_at  TEXT,
    duration_ms  INTEGER,
    error        TEXT
);
CREATE INDEX scan_runs_scan ON scan_runs (scan_id, started_at);
CREATE INDEX scan_runs_status ON scan_runs (status, started_at);

CREATE TABLE network_assets (
    id                 TEXT PRIMARY KEY,
    site_id            TEXT NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
    ip                 TEXT NOT NULL,
    mac                TEXT,
    vendor             TEXT,
    hostname           TEXT,
    type_guess         TEXT NOT NULL DEFAULT 'unknown',
    type_override      TEXT,                       -- set with PATCH { type }
    managed_device_id  TEXT REFERENCES devices (id) ON DELETE SET NULL,
    open_ports         TEXT NOT NULL DEFAULT '[]',
    snmp_sys_descr     TEXT,
    snmp_sys_name      TEXT,
    snmp_sys_object_id TEXT,
    mdns               TEXT NOT NULL DEFAULT '[]',
    netbios_name       TEXT,
    rtt_ms             REAL,
    notes              TEXT NOT NULL DEFAULT '',
    ignored            INTEGER NOT NULL DEFAULT 0,
    first_seen_at      TEXT NOT NULL,
    last_seen_at       TEXT NOT NULL,
    last_scan_id       TEXT
);
CREATE UNIQUE INDEX network_assets_site_ip ON network_assets (site_id, ip);
CREATE INDEX network_assets_site_mac ON network_assets (site_id, mac);

-- ---------------------------------------------------------------- SNMP monitoring
CREATE TABLE snmp_credentials (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    version    TEXT NOT NULL CHECK (version IN ('v2c', 'v3')),
    username   TEXT,
    auth       TEXT NOT NULL DEFAULT 'none' CHECK (auth IN ('none', 'sha', 'sha256')),
    privacy    TEXT NOT NULL DEFAULT 'none' CHECK (privacy IN ('none', 'aes128')),
    secret     BLOB,                               -- field-encrypted JSON, AAD snmp_credentials/secret/<id>
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE snmp_templates (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    builtin    INTEGER NOT NULL DEFAULT 0,
    metrics    TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE snmp_devices (
    id                 TEXT PRIMARY KEY,
    site_id            TEXT NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
    asset_id           TEXT REFERENCES network_assets (id) ON DELETE SET NULL,
    name               TEXT NOT NULL,
    ip                 TEXT NOT NULL,
    port               INTEGER NOT NULL DEFAULT 161,
    credential_id      TEXT NOT NULL REFERENCES snmp_credentials (id),
    template_ids       TEXT NOT NULL DEFAULT '[]',
    poll_interval_secs INTEGER NOT NULL DEFAULT 300,
    enabled            INTEGER NOT NULL DEFAULT 1,
    status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ok', 'unreachable', 'alerting')),
    last_poll_at       TEXT,
    sys_descr          TEXT,
    uptime_secs        INTEGER,
    last_error         TEXT,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL
);
CREATE INDEX snmp_devices_site ON snmp_devices (site_id);
CREATE INDEX snmp_devices_asset ON snmp_devices (asset_id);

-- Latest value per metric row: rates for counters, text values and row labels, the raw counter
-- the next rate is computed from, and the threshold state.
CREATE TABLE snmp_values (
    snmp_device_id TEXT NOT NULL REFERENCES snmp_devices (id) ON DELETE CASCADE,
    key            TEXT NOT NULL,
    idx            TEXT NOT NULL DEFAULT '',
    value          REAL,
    text           TEXT,
    raw            TEXT,                           -- last raw counter (decimal u64)
    raw_at         INTEGER,                        -- unix ms of the raw counter
    state          TEXT NOT NULL DEFAULT 'ok' CHECK (state IN ('ok', 'warning', 'critical')),
    updated_at     TEXT NOT NULL,
    PRIMARY KEY (snmp_device_id, key, idx)
) WITHOUT ROWID;

CREATE TABLE snmp_metrics_raw (
    snmp_device_id TEXT NOT NULL REFERENCES snmp_devices (id) ON DELETE CASCADE,
    key            TEXT NOT NULL,
    idx            TEXT NOT NULL DEFAULT '',
    ts             INTEGER NOT NULL,               -- unix seconds
    value          REAL NOT NULL,
    PRIMARY KEY (snmp_device_id, key, idx, ts)
) WITHOUT ROWID;
CREATE INDEX snmp_metrics_raw_ts ON snmp_metrics_raw (ts);

CREATE TABLE snmp_metrics_15m (
    snmp_device_id TEXT NOT NULL REFERENCES snmp_devices (id) ON DELETE CASCADE,
    key            TEXT NOT NULL,
    idx            TEXT NOT NULL DEFAULT '',
    ts             INTEGER NOT NULL,
    value          REAL NOT NULL,                  -- average
    min            REAL,
    max            REAL,
    samples        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (snmp_device_id, key, idx, ts)
) WITHOUT ROWID;
CREATE INDEX snmp_metrics_15m_ts ON snmp_metrics_15m (ts);

CREATE TABLE snmp_metrics_1h (
    snmp_device_id TEXT NOT NULL REFERENCES snmp_devices (id) ON DELETE CASCADE,
    key            TEXT NOT NULL,
    idx            TEXT NOT NULL DEFAULT '',
    ts             INTEGER NOT NULL,
    value          REAL NOT NULL,
    min            REAL,
    max            REAL,
    samples        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (snmp_device_id, key, idx, ts)
) WITHOUT ROWID;
CREATE INDEX snmp_metrics_1h_ts ON snmp_metrics_1h (ts);

CREATE TABLE snmp_traps (
    id              TEXT PRIMARY KEY,
    site_id         TEXT NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
    probe_device_id TEXT,
    snmp_device_id  TEXT REFERENCES snmp_devices (id) ON DELETE SET NULL,
    from_ip         TEXT NOT NULL,
    at              TEXT NOT NULL,
    version         TEXT NOT NULL,
    oid             TEXT NOT NULL,
    varbinds        TEXT NOT NULL DEFAULT '[]',
    rule_id         TEXT,
    alert_id        TEXT,
    received_at     TEXT NOT NULL
);
CREATE INDEX snmp_traps_site ON snmp_traps (site_id, at);
CREATE INDEX snmp_traps_at ON snmp_traps (at);

CREATE TABLE trap_rules (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    enabled    INTEGER NOT NULL DEFAULT 1,
    oid_prefix TEXT NOT NULL,
    severity   TEXT NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical')),
    site_ids   TEXT NOT NULL DEFAULT '[]',         -- empty = every site
    title      TEXT NOT NULL DEFAULT '',
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- ---------------------------------------------------------------- alerts: source 'snmp', snmp_device_id
CREATE TABLE alerts_new (
    id                   TEXT PRIMARY KEY,
    device_id            TEXT REFERENCES devices (id) ON DELETE CASCADE,
    snmp_device_id       TEXT REFERENCES snmp_devices (id) ON DELETE CASCADE,
    client_id            TEXT NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
    site_id              TEXT,
    source               TEXT NOT NULL CHECK (source IN ('check', 'server', 'snmp')),
    check_id             TEXT NOT NULL,
    check_type           TEXT NOT NULL,
    severity             TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
    title                TEXT NOT NULL,
    message              TEXT NOT NULL DEFAULT '',
    status               TEXT NOT NULL CHECK (status IN ('open', 'acknowledged', 'resolved')),
    opened_at            TEXT NOT NULL,
    last_occurrence_at   TEXT NOT NULL,
    occurrences          INTEGER NOT NULL DEFAULT 1,
    acknowledged_at      TEXT,
    acknowledged_by      TEXT,
    acknowledged_by_name TEXT,
    resolved_at          TEXT,
    resolved_by          TEXT,
    resolved_by_name     TEXT,
    resolution           TEXT CHECK (resolution IS NULL OR resolution IN ('auto', 'manual')),
    condition_cleared_at TEXT,
    snoozed_until        TEXT,
    assigned_to          TEXT REFERENCES users (id) ON DELETE SET NULL,
    in_maintenance       INTEGER NOT NULL DEFAULT 0,
    ticket_id            TEXT,
    remediation          TEXT,
    policy_id            TEXT,
    updated_at           TEXT NOT NULL
);
INSERT INTO alerts_new (id, device_id, snmp_device_id, client_id, site_id, source, check_id, check_type, severity, title, message,
                        status, opened_at, last_occurrence_at, occurrences, acknowledged_at, acknowledged_by, acknowledged_by_name,
                        resolved_at, resolved_by, resolved_by_name, resolution, condition_cleared_at, snoozed_until, assigned_to,
                        in_maintenance, ticket_id, remediation, policy_id, updated_at)
SELECT id, device_id, NULL, client_id, site_id, source, check_id, check_type, severity, title, message,
       status, opened_at, last_occurrence_at, occurrences, acknowledged_at, acknowledged_by, acknowledged_by_name,
       resolved_at, resolved_by, resolved_by_name, resolution, condition_cleared_at, snoozed_until, assigned_to,
       in_maintenance, ticket_id, remediation, policy_id, updated_at
FROM alerts;
DROP TABLE alerts;
ALTER TABLE alerts_new RENAME TO alerts;
-- Dedupe: at most one non-resolved alert per device and check, and per SNMP device and check.
CREATE UNIQUE INDEX alerts_one_open ON alerts (device_id, check_id) WHERE status <> 'resolved';
CREATE UNIQUE INDEX alerts_one_open_snmp ON alerts (snmp_device_id, check_id)
    WHERE status <> 'resolved' AND snmp_device_id IS NOT NULL;
CREATE INDEX alerts_status ON alerts (status, severity, last_occurrence_at);
CREATE INDEX alerts_client ON alerts (client_id, status);
CREATE INDEX alerts_device ON alerts (device_id, check_id, opened_at);
CREATE INDEX alerts_snmp_device ON alerts (snmp_device_id, check_id, opened_at);
CREATE INDEX alerts_resolved ON alerts (resolved_at);

COMMIT;
PRAGMA foreign_keys = ON;
