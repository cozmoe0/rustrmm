-- Phase 4: remote sessions (shell, file transfer) with optional recordings.

CREATE TABLE remote_sessions (
    id                TEXT PRIMARY KEY,
    device_id         TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    user_id           TEXT REFERENCES users (id) ON DELETE SET NULL,
    user_name         TEXT NOT NULL,
    kind              TEXT NOT NULL CHECK (kind IN ('shell', 'download', 'upload')),
    detail            TEXT NOT NULL DEFAULT '',  -- shell name or file path
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
CREATE INDEX remote_sessions_device ON remote_sessions (device_id, started_at);
CREATE INDEX remote_sessions_started ON remote_sessions (started_at);
