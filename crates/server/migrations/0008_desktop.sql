-- Phase 8: remote desktop sessions.
--
-- SQLite cannot alter a CHECK constraint, so `remote_sessions` is rebuilt with `desktop` added to
-- the allowed kinds. Rows and indexes are preserved; no other table references this one.
-- For desktop sessions `detail` holds JSON:
--   { session_id, view_only, quality, consent: not_required | granted | denied | timeout | null }

CREATE TABLE remote_sessions_new (
    id                TEXT PRIMARY KEY,
    device_id         TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    user_id           TEXT REFERENCES users (id) ON DELETE SET NULL,
    user_name         TEXT NOT NULL,
    kind              TEXT NOT NULL CHECK (kind IN ('shell', 'download', 'upload', 'desktop')),
    detail            TEXT NOT NULL DEFAULT '',  -- shell/desktop JSON or file path
    status            TEXT NOT NULL CHECK (status IN ('pending', 'active', 'ended', 'failed')),
    started_at        TEXT NOT NULL,
    connected_at      TEXT,
    ended_at          TEXT,
    end_reason        TEXT,
    bytes_to_device   INTEGER NOT NULL DEFAULT 0,
    bytes_from_device INTEGER NOT NULL DEFAULT 0,
    recording         TEXT,                      -- path relative to <data>/recordings
    recording_bytes   INTEGER,
    client_ip         TEXT
);

INSERT INTO remote_sessions_new (
    id, device_id, user_id, user_name, kind, detail, status, started_at, connected_at, ended_at,
    end_reason, bytes_to_device, bytes_from_device, recording, recording_bytes, client_ip
)
SELECT
    id, device_id, user_id, user_name, kind, detail, status, started_at, connected_at, ended_at,
    end_reason, bytes_to_device, bytes_from_device, recording, recording_bytes, client_ip
FROM remote_sessions;

DROP TABLE remote_sessions;
ALTER TABLE remote_sessions_new RENAME TO remote_sessions;

CREATE INDEX remote_sessions_device ON remote_sessions (device_id, started_at);
CREATE INDEX remote_sessions_started ON remote_sessions (started_at);
