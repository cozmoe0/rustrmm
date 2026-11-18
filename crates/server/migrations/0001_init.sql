-- RustRMM Phase 1 schema: settings, tenancy, identity, sessions, audit, backups.
-- Timestamps are always bound from Rust (chrono DateTime<Utc>) so their text format is uniform
-- and lexically sortable. Never compare against SQLite's datetime('now').

CREATE TABLE settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,              -- JSON document
    updated_at TEXT NOT NULL
);

-- ---------------------------------------------------------------- tenancy
CREATE TABLE clients (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    slug         TEXT NOT NULL UNIQUE,
    notes        TEXT NOT NULL DEFAULT '',
    accent_color TEXT,
    logo_blob    TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX clients_name_nocase ON clients (name COLLATE NOCASE);

CREATE TABLE sites (
    id         TEXT PRIMARY KEY,
    client_id  TEXT NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    timezone   TEXT NOT NULL DEFAULT 'UTC',
    address    TEXT NOT NULL DEFAULT '',
    notes      TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX sites_client_name ON sites (client_id, name COLLATE NOCASE);
CREATE INDEX sites_client ON sites (client_id);

-- ---------------------------------------------------------------- identity
CREATE TABLE users (
    id                  TEXT PRIMARY KEY,
    email               TEXT NOT NULL,
    name                TEXT NOT NULL,
    password_hash       TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    totp_secret         BLOB,               -- field-encrypted
    totp_enabled_at     TEXT,
    totp_last_step      INTEGER,            -- replay protection for TOTP codes
    failed_logins       INTEGER NOT NULL DEFAULT 0,
    locked_until        TEXT,
    last_login_at       TEXT,
    password_changed_at TEXT NOT NULL,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);
CREATE UNIQUE INDEX users_email ON users (email COLLATE NOCASE);

CREATE TABLE recovery_codes (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    code_hash  TEXT NOT NULL,               -- HMAC-SHA256 with the server pepper
    used_at    TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX recovery_codes_user ON recovery_codes (user_id);

CREATE TABLE webauthn_credentials (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    credential_id TEXT NOT NULL UNIQUE,     -- base64url credential id
    passkey       BLOB NOT NULL,            -- field-encrypted serialized passkey
    created_at    TEXT NOT NULL,
    last_used_at  TEXT
);
CREATE INDEX webauthn_credentials_user ON webauthn_credentials (user_id);

CREATE TABLE roles (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    builtin     INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX roles_name ON roles (name COLLATE NOCASE);

CREATE TABLE role_permissions (
    role_id    TEXT NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
    permission TEXT NOT NULL,
    PRIMARY KEY (role_id, permission)
);

CREATE TABLE role_assignments (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role_id    TEXT NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
    scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'client', 'site')),
    scope_id   TEXT,
    created_at TEXT NOT NULL,
    CHECK ((scope_type = 'global' AND scope_id IS NULL) OR (scope_type <> 'global' AND scope_id IS NOT NULL))
);
CREATE UNIQUE INDEX role_assignments_unique ON role_assignments (user_id, role_id, scope_type, IFNULL(scope_id, ''));
CREATE INDEX role_assignments_user ON role_assignments (user_id);

CREATE TRIGGER clients_delete_assignments AFTER DELETE ON clients
BEGIN
    DELETE FROM role_assignments WHERE scope_type = 'client' AND scope_id = OLD.id;
END;

CREATE TRIGGER sites_delete_assignments AFTER DELETE ON sites
BEGIN
    DELETE FROM role_assignments WHERE scope_type = 'site' AND scope_id = OLD.id;
END;

-- ---------------------------------------------------------------- sessions
CREATE TABLE sessions (
    id               TEXT PRIMARY KEY,      -- SHA-256 of the session token (never the token)
    user_id          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    csrf_token       TEXT NOT NULL,
    created_at       TEXT NOT NULL,
    last_seen_at     TEXT NOT NULL,
    idle_expires_at  TEXT NOT NULL,
    expires_at       TEXT NOT NULL,
    stepped_up_until TEXT,
    ip               TEXT,
    user_agent       TEXT,
    revoked_at       TEXT
);
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE auth_challenges (
    id         TEXT PRIMARY KEY,            -- SHA-256 of the challenge token
    user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,               -- mfa | mfa_setup | webauthn_register | step_up_webauthn
    state      BLOB,                        -- field-encrypted JSON
    session_id TEXT,
    attempts   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);
CREATE INDEX auth_challenges_user ON auth_challenges (user_id);

-- ---------------------------------------------------------------- audit (append-only, hash-chained)
CREATE TABLE audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    at          TEXT NOT NULL,
    actor_type  TEXT NOT NULL,
    actor_id    TEXT,
    actor_name  TEXT,
    action      TEXT NOT NULL,
    target_type TEXT,
    target_id   TEXT,
    target_name TEXT,
    client_id   TEXT,
    site_id     TEXT,
    ip          TEXT,
    user_agent  TEXT,
    details     TEXT NOT NULL DEFAULT '{}',
    prev_hash   TEXT NOT NULL,
    hash        TEXT NOT NULL
);
CREATE INDEX audit_log_at ON audit_log (at);
CREATE INDEX audit_log_action ON audit_log (action);
CREATE INDEX audit_log_actor ON audit_log (actor_id);
CREATE INDEX audit_log_client ON audit_log (client_id);

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN
    SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN
    SELECT RAISE(ABORT, 'audit_log is append-only');
END;

-- ---------------------------------------------------------------- backups
CREATE TABLE backups (
    id           TEXT PRIMARY KEY,
    started_at   TEXT NOT NULL,
    finished_at  TEXT,
    status       TEXT NOT NULL CHECK (status IN ('running', 'ok', 'failed')),
    trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('schedule', 'manual', 'pre_migration')),
    file_name    TEXT,
    size_bytes   INTEGER,
    sha256       TEXT,
    destinations TEXT NOT NULL DEFAULT '[]', -- JSON array of destination results
    error        TEXT
);
CREATE INDEX backups_started ON backups (started_at);
