-- Phase 11: reports, dashboards, OIDC single sign-on, API tokens, webhooks and branding
-- (additive; see docs/api-platform.md).

-- ---------------------------------------------------------------- reports
CREATE TABLE report_schedules (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL,
    parameters  TEXT NOT NULL DEFAULT '{}',          -- JSON report parameters
    format      TEXT NOT NULL CHECK (format IN ('pdf', 'csv')),
    cron        TEXT NOT NULL,
    timezone    TEXT NOT NULL DEFAULT 'UTC',
    recipients  TEXT NOT NULL DEFAULT '[]',          -- JSON array of e-mail addresses
    per_client  INTEGER NOT NULL DEFAULT 0,
    enabled     INTEGER NOT NULL DEFAULT 1,
    next_run_at TEXT,
    last_run_at TEXT,
    last_status TEXT,
    last_error  TEXT,
    created_by  TEXT REFERENCES users (id) ON DELETE SET NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE INDEX report_schedules_due ON report_schedules (enabled, next_run_at);

CREATE TABLE report_runs (
    id           TEXT PRIMARY KEY,
    type         TEXT NOT NULL,
    title        TEXT NOT NULL DEFAULT '',
    parameters   TEXT NOT NULL DEFAULT '{}',
    format       TEXT NOT NULL CHECK (format IN ('json', 'csv', 'pdf')),
    status       TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
    trigger_kind TEXT NOT NULL DEFAULT 'manual' CHECK (trigger_kind IN ('manual', 'schedule')),
    schedule_id  TEXT REFERENCES report_schedules (id) ON DELETE SET NULL,
    client_id    TEXT,                                -- the client a per-client run was for
    user_id      TEXT REFERENCES users (id) ON DELETE SET NULL,
    user_name    TEXT NOT NULL DEFAULT '',
    file_name    TEXT,
    content_type TEXT,
    size_bytes   INTEGER,
    output       BLOB,                                -- the rendered file (purged after 30 days)
    error        TEXT,
    emailed_to   TEXT NOT NULL DEFAULT '[]',
    created_at   TEXT NOT NULL,
    started_at   TEXT,
    finished_at  TEXT
);
CREATE INDEX report_runs_created ON report_runs (created_at);
CREATE INDEX report_runs_user ON report_runs (user_id, created_at);

-- Daily per-client health snapshot (feeds the executive summary's health trend).
CREATE TABLE client_health_daily (
    client_id  TEXT NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
    day        TEXT NOT NULL,                         -- YYYY-MM-DD (UTC)
    devices    INTEGER NOT NULL,
    online     INTEGER NOT NULL,
    avg_health REAL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (client_id, day)
);

-- ---------------------------------------------------------------- dashboards
CREATE TABLE dashboards (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    owner_id   TEXT REFERENCES users (id) ON DELETE CASCADE,
    shared     INTEGER NOT NULL DEFAULT 0,
    layout     TEXT NOT NULL DEFAULT '[]',            -- JSON [{ widget, x, y, w, h, config }]
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX dashboards_owner ON dashboards (owner_id);

CREATE TABLE dashboard_defaults (
    user_id      TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    dashboard_id TEXT NOT NULL REFERENCES dashboards (id) ON DELETE CASCADE,
    updated_at   TEXT NOT NULL
);

-- ---------------------------------------------------------------- OIDC single sign-on
CREATE TABLE oidc_providers (
    id                     TEXT PRIMARY KEY,
    name                   TEXT NOT NULL,
    issuer_url             TEXT NOT NULL,
    client_id              TEXT NOT NULL,
    client_secret          BLOB,                      -- field-encrypted, write-only
    scopes                 TEXT NOT NULL DEFAULT '["openid","email","profile"]',
    group_claim            TEXT NOT NULL DEFAULT 'groups',
    role_mappings          TEXT NOT NULL DEFAULT '[]',
    auto_provision         INTEGER NOT NULL DEFAULT 0,
    require_local_mfa      INTEGER NOT NULL DEFAULT 0,
    trust_unverified_email INTEGER NOT NULL DEFAULT 0,
    enabled                INTEGER NOT NULL DEFAULT 1,
    button_label           TEXT NOT NULL DEFAULT '',
    created_at             TEXT NOT NULL,
    updated_at             TEXT NOT NULL
);
CREATE UNIQUE INDEX oidc_providers_name ON oidc_providers (name COLLATE NOCASE);

CREATE TABLE user_identities (
    user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    provider_id   TEXT NOT NULL REFERENCES oidc_providers (id) ON DELETE CASCADE,
    subject       TEXT NOT NULL,
    email         TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL,
    last_login_at TEXT,
    PRIMARY KEY (provider_id, subject)
);
CREATE INDEX user_identities_user ON user_identities (user_id);

-- Role assignments written by an SSO provider's role mappings (replaced at every sign-in);
-- NULL for assignments made in the console.
ALTER TABLE role_assignments ADD COLUMN managed_by TEXT;

-- ---------------------------------------------------------------- API tokens
CREATE TABLE api_tokens (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    prefix        TEXT NOT NULL,
    token_hash    TEXT NOT NULL UNIQUE,               -- SHA-256 of the token (never the token)
    permissions   TEXT NOT NULL DEFAULT '[]',
    client_ids    TEXT,                               -- JSON array, NULL = the creator's full scope
    allowed_cidrs TEXT,                               -- JSON array, NULL = any address
    expires_at    TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    last_used_at  TEXT,
    last_used_ip  TEXT,
    last_audit_at TEXT,                               -- api_token.used sampling (once per hour)
    revoked_at    TEXT
);
CREATE INDEX api_tokens_user ON api_tokens (user_id);

-- ---------------------------------------------------------------- webhooks
CREATE TABLE webhooks (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL DEFAULT '',
    url              TEXT NOT NULL,
    secret           BLOB NOT NULL,                   -- field-encrypted, write-only
    events           TEXT NOT NULL DEFAULT '[]',
    client_ids       TEXT,                            -- JSON array, NULL = every client
    enabled          INTEGER NOT NULL DEFAULT 1,
    created_by       TEXT REFERENCES users (id) ON DELETE SET NULL,
    last_delivery_at TEXT,
    last_status      TEXT,
    last_error       TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
);

CREATE TABLE webhook_deliveries (
    id              TEXT PRIMARY KEY,
    webhook_id      TEXT NOT NULL REFERENCES webhooks (id) ON DELETE CASCADE,
    event_id        TEXT NOT NULL,                    -- the payload `id` (kept on redelivery)
    event           TEXT NOT NULL,
    client_id       TEXT,
    payload         TEXT NOT NULL,                    -- exact JSON body that is signed
    status          TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'delivered', 'failed')),
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    last_attempt_at TEXT,
    response_status INTEGER,
    error           TEXT,
    redelivery_of   TEXT,
    created_at      TEXT NOT NULL,
    delivered_at    TEXT
);
CREATE INDEX webhook_deliveries_hook ON webhook_deliveries (webhook_id, created_at);
CREATE INDEX webhook_deliveries_due ON webhook_deliveries (status, next_attempt_at);

-- ---------------------------------------------------------------- branding
CREATE TABLE branding_files (
    id            TEXT PRIMARY KEY,
    content_type  TEXT NOT NULL CHECK (content_type IN ('image/svg+xml', 'image/png')),
    data          BLOB NOT NULL,                      -- sanitised SVG or PNG bytes
    sha256        TEXT NOT NULL,
    size_bytes    INTEGER NOT NULL,
    width         INTEGER,
    height        INTEGER,
    original_name TEXT NOT NULL DEFAULT '',
    uploaded_by   TEXT REFERENCES users (id) ON DELETE SET NULL,
    created_at    TEXT NOT NULL
);
