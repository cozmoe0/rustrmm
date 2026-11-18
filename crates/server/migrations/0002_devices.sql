-- Phase 2: enrollment, devices, inventory, metrics, timeline.

CREATE TABLE enrollment_tokens (
    id               TEXT PRIMARY KEY,
    site_id          TEXT NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
    name             TEXT NOT NULL,
    secret_hash      TEXT NOT NULL UNIQUE,      -- SHA-256 of the enrollment secret
    secret           BLOB NOT NULL,             -- field-encrypted secret (to rebuild deploy keys)
    expires_at       TEXT,
    max_uses         INTEGER,
    uses             INTEGER NOT NULL DEFAULT 0,
    require_approval INTEGER NOT NULL DEFAULT 0,
    allowed_domains  TEXT NOT NULL DEFAULT '[]', -- JSON array of AD/DNS domain suffixes
    allowed_cidrs    TEXT NOT NULL DEFAULT '[]', -- JSON array of source networks
    revoked_at       TEXT,
    created_by       TEXT,
    created_at       TEXT NOT NULL,
    last_used_at     TEXT
);
CREATE INDEX enrollment_tokens_site ON enrollment_tokens (site_id);

CREATE TABLE devices (
    id                 TEXT PRIMARY KEY,
    site_id            TEXT NOT NULL REFERENCES sites (id),
    status             TEXT NOT NULL CHECK (status IN ('pending', 'active', 'quarantined', 'revoked')),
    hostname           TEXT NOT NULL,
    display_name       TEXT,
    os_family          TEXT NOT NULL,
    os_name            TEXT NOT NULL DEFAULT '',
    os_version         TEXT NOT NULL DEFAULT '',
    arch               TEXT NOT NULL DEFAULT '',
    manufacturer       TEXT,
    model              TEXT,
    serial             TEXT,
    hardware_uuid      TEXT,
    fingerprint        TEXT,
    domain             TEXT,
    device_type        TEXT,                    -- workstation | laptop | server | virtual
    last_user          TEXT,
    agent_version      TEXT NOT NULL DEFAULT '',
    protocol           TEXT NOT NULL DEFAULT '',
    public_key         TEXT NOT NULL UNIQUE,
    enrollment_token_id TEXT,
    replaces_device_id TEXT,
    enrolled_at        TEXT NOT NULL,
    approved_at        TEXT,
    approved_by        TEXT,
    online             INTEGER NOT NULL DEFAULT 0,
    last_seen_at       TEXT,
    last_ip            TEXT,
    connected_at       TEXT,
    uptime_s           INTEGER,
    cpu_pct            REAL,
    mem_pct            REAL,
    disk_pct           REAL,
    health_score       INTEGER,
    tags               TEXT NOT NULL DEFAULT '[]',
    notes              TEXT NOT NULL DEFAULT '',
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL
);
CREATE INDEX devices_site ON devices (site_id);
CREATE INDEX devices_status ON devices (status);
CREATE INDEX devices_fingerprint ON devices (fingerprint);

CREATE TABLE device_inventory (
    device_id    TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    section      TEXT NOT NULL,
    data         TEXT NOT NULL,                 -- JSON document
    hash         TEXT NOT NULL,
    collected_at TEXT NOT NULL,
    PRIMARY KEY (device_id, section)
);

CREATE TABLE device_software (
    device_id    TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    version      TEXT NOT NULL DEFAULT '',
    publisher    TEXT NOT NULL DEFAULT '',
    install_date TEXT,
    source       TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (device_id, name, version)
);
CREATE INDEX device_software_name ON device_software (name COLLATE NOCASE);

CREATE TABLE device_metrics (
    device_id      TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    resolution     TEXT NOT NULL,              -- raw | 15m | 1h
    ts             INTEGER NOT NULL,           -- unix seconds (bucket start for rollups)
    cpu            REAL,
    mem            REAL,
    disk           REAL,
    net_rx         REAL,
    net_tx         REAL,
    disk_read      REAL,
    disk_write     REAL,
    samples        INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (device_id, resolution, ts)
) WITHOUT ROWID;

CREATE TABLE device_timeline (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    at        TEXT NOT NULL,
    kind      TEXT NOT NULL,
    severity  TEXT NOT NULL DEFAULT 'info',     -- info | notice | warning | critical
    summary   TEXT NOT NULL,
    details   TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX device_timeline_device ON device_timeline (device_id, id);
