-- Phase 3: signed commands, agent releases and staged rollouts.

CREATE TABLE commands (
    id          TEXT PRIMARY KEY,
    device_id   TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,
    status      TEXT NOT NULL,              -- sent | accepted | running | succeeded | failed | rejected | expired
    summary     TEXT NOT NULL DEFAULT '',
    created_by  TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    result      TEXT                        -- JSON CommandResult
);
CREATE INDEX commands_device ON commands (device_id, created_at);

CREATE TABLE agent_releases (
    id          TEXT PRIMARY KEY,
    version     TEXT NOT NULL UNIQUE,
    manifest    BLOB NOT NULL,              -- exact JSON bytes that were signed
    signature   BLOB NOT NULL,              -- release-key signature
    imported_at TEXT NOT NULL,
    notes       TEXT NOT NULL DEFAULT ''
);

CREATE TABLE rollouts (
    id                    TEXT PRIMARY KEY,
    release_id            TEXT NOT NULL REFERENCES agent_releases (id) ON DELETE CASCADE,
    scope                 TEXT NOT NULL,     -- JSON {type, id?, ids?}
    percent               INTEGER NOT NULL DEFAULT 100,
    status                TEXT NOT NULL CHECK (status IN ('active', 'paused', 'completed', 'cancelled')),
    failure_threshold_pct INTEGER NOT NULL DEFAULT 20,
    created_by            TEXT,
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL
);

CREATE TABLE rollout_targets (
    rollout_id  TEXT NOT NULL REFERENCES rollouts (id) ON DELETE CASCADE,
    device_id   TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    status      TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'succeeded', 'failed', 'skipped')),
    attempts    INTEGER NOT NULL DEFAULT 0,
    command_id  TEXT,
    last_error  TEXT,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (rollout_id, device_id)
);
CREATE INDEX rollout_targets_device ON rollout_targets (device_id, status);
