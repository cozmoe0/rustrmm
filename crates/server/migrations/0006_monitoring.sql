-- Phase 6: monitoring, alerts, notifications and maintenance windows (additive only).

CREATE TABLE check_states (
    device_id     TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    check_id      TEXT NOT NULL,
    type          TEXT NOT NULL,
    name          TEXT NOT NULL DEFAULT '',
    state         TEXT NOT NULL CHECK (state IN ('ok', 'warning', 'critical', 'unknown')),
    message       TEXT NOT NULL DEFAULT '',
    value         REAL,
    since         TEXT NOT NULL,              -- when the current state began
    last_at       TEXT NOT NULL,              -- latest result
    streak        INTEGER NOT NULL DEFAULT 1, -- consecutive evaluations in this state (agent count)
    last_ok_at    TEXT,
    interval_secs INTEGER NOT NULL DEFAULT 0,
    policy_id     TEXT,
    PRIMARY KEY (device_id, check_id)
);

CREATE TABLE alerts (
    id                   TEXT PRIMARY KEY,
    device_id            TEXT REFERENCES devices (id) ON DELETE CASCADE,
    client_id            TEXT NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
    site_id              TEXT,
    source               TEXT NOT NULL CHECK (source IN ('check', 'server')),
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
    condition_cleared_at TEXT,                -- set once the condition clears after a manual resolve
    snoozed_until        TEXT,
    assigned_to          TEXT REFERENCES users (id) ON DELETE SET NULL,
    in_maintenance       INTEGER NOT NULL DEFAULT 0,
    ticket_id            TEXT,
    remediation          TEXT,                -- JSON { status, job_id, attempts }
    policy_id            TEXT,
    updated_at           TEXT NOT NULL
);
-- Dedupe: at most one non-resolved alert per device and check.
CREATE UNIQUE INDEX alerts_one_open ON alerts (device_id, check_id) WHERE status <> 'resolved';
CREATE INDEX alerts_status ON alerts (status, severity, last_occurrence_at);
CREATE INDEX alerts_client ON alerts (client_id, status);
CREATE INDEX alerts_device ON alerts (device_id, check_id, opened_at);
CREATE INDEX alerts_resolved ON alerts (resolved_at);

CREATE TABLE alert_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    alert_id   TEXT NOT NULL REFERENCES alerts (id) ON DELETE CASCADE,
    at         TEXT NOT NULL,
    kind       TEXT NOT NULL,
    actor_id   TEXT,
    actor_name TEXT,
    message    TEXT NOT NULL DEFAULT '',
    details    TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX alert_events_alert ON alert_events (alert_id, id);

CREATE TABLE notification_channels (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    kind         TEXT NOT NULL CHECK (kind IN ('email', 'slack', 'teams', 'discord', 'ntfy', 'webhook')),
    enabled      INTEGER NOT NULL DEFAULT 1,
    config       BLOB NOT NULL,               -- field-encrypted JSON, AAD notification_channels/config/<id>
    last_used_at TEXT,
    last_error   TEXT,
    created_by   TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);

CREATE TABLE notification_rules (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 1,
    filters     TEXT NOT NULL DEFAULT '{}',
    events      TEXT NOT NULL DEFAULT '[]',
    channel_ids TEXT NOT NULL DEFAULT '[]',
    quiet_hours TEXT,
    escalation  TEXT,
    created_by  TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

-- Escalations already sent (once per alert and rule).
CREATE TABLE notification_escalations (
    alert_id TEXT NOT NULL REFERENCES alerts (id) ON DELETE CASCADE,
    rule_id  TEXT NOT NULL REFERENCES notification_rules (id) ON DELETE CASCADE,
    at       TEXT NOT NULL,
    PRIMARY KEY (alert_id, rule_id)
);

-- One row per delivery attempt; pending rows are the retry queue.
CREATE TABLE notification_log (
    id              TEXT PRIMARY KEY,
    delivery_id     TEXT NOT NULL,
    alert_id        TEXT REFERENCES alerts (id) ON DELETE SET NULL,
    channel_id      TEXT,
    channel_name    TEXT NOT NULL DEFAULT '',
    channel_kind    TEXT NOT NULL DEFAULT '',
    rule_id         TEXT,
    event           TEXT NOT NULL,
    attempt         INTEGER NOT NULL DEFAULT 1,
    status          TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'suppressed')),
    http_status     INTEGER,
    error           TEXT,
    payload         TEXT NOT NULL DEFAULT '{}', -- rendered message (alert facts only, no secrets)
    created_at      TEXT NOT NULL,
    next_attempt_at TEXT,
    finished_at     TEXT
);
CREATE INDEX notification_log_due ON notification_log (status, next_attempt_at);
CREATE INDEX notification_log_alert ON notification_log (alert_id, created_at);
CREATE INDEX notification_log_channel ON notification_log (channel_id, created_at);
CREATE INDEX notification_log_created ON notification_log (created_at);

CREATE TABLE maintenance_windows (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    enabled         INTEGER NOT NULL DEFAULT 1,
    targets         TEXT NOT NULL DEFAULT '[]',
    schedule        TEXT NOT NULL,
    suppress        TEXT NOT NULL DEFAULT 'notifications' CHECK (suppress IN ('notifications', 'alerts')),
    created_by      TEXT,
    created_by_name TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
