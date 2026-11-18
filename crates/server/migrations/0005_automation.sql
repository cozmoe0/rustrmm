-- Phase 5: scripts, variables, jobs, approvals, custom fields, device groups and policies.
-- Additive only: no existing table is changed.

-- ---------------------------------------------------------------- scripts
CREATE TABLE scripts (
    id               TEXT PRIMARY KEY,
    builtin_id       TEXT UNIQUE,              -- stable id of a shipped script (NULL = user script)
    name             TEXT NOT NULL,
    description      TEXT NOT NULL DEFAULT '',
    category         TEXT NOT NULL DEFAULT '',
    language         TEXT NOT NULL,
    platforms        TEXT NOT NULL DEFAULT '[]', -- JSON array
    timeout_secs     INTEGER NOT NULL DEFAULT 600,
    risk             TEXT NOT NULL DEFAULT 'normal' CHECK (risk IN ('normal', 'high')),
    current_version  INTEGER NOT NULL DEFAULT 1,
    approved_version INTEGER,
    archived_at      TEXT,
    created_by       TEXT,
    created_by_name  TEXT NOT NULL DEFAULT '',
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
);
CREATE INDEX scripts_name ON scripts (name COLLATE NOCASE);

CREATE TABLE script_versions (
    script_id        TEXT NOT NULL REFERENCES scripts (id) ON DELETE CASCADE,
    version          INTEGER NOT NULL,
    content          TEXT NOT NULL,
    content_sha256   TEXT NOT NULL,
    parameters       TEXT NOT NULL DEFAULT '[]', -- JSON array of ScriptParameter
    notes            TEXT NOT NULL DEFAULT '',
    created_by       TEXT,
    created_by_name  TEXT NOT NULL DEFAULT '',
    created_at       TEXT NOT NULL,
    approved_by      TEXT,
    approved_by_name TEXT,
    approved_at      TEXT,
    PRIMARY KEY (script_id, version)
);

-- ---------------------------------------------------------------- variables
CREATE TABLE variables (
    id              TEXT PRIMARY KEY,
    scope           TEXT NOT NULL CHECK (scope IN ('global', 'client', 'site')),
    scope_id        TEXT,
    name            TEXT NOT NULL,
    value           TEXT,                       -- plain value (NULL for secrets)
    secret_value    BLOB,                       -- field-encrypted value of a secret
    secret          INTEGER NOT NULL DEFAULT 0,
    description     TEXT NOT NULL DEFAULT '',
    updated_by      TEXT,
    updated_by_name TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    CHECK ((scope = 'global' AND scope_id IS NULL) OR (scope <> 'global' AND scope_id IS NOT NULL))
);
CREATE UNIQUE INDEX variables_scope_name ON variables (scope, IFNULL(scope_id, ''), name COLLATE NOCASE);

-- ---------------------------------------------------------------- jobs
CREATE TABLE jobs (
    id                   TEXT PRIMARY KEY,
    name                 TEXT NOT NULL,
    script_id            TEXT REFERENCES scripts (id),   -- NULL for ad-hoc code
    script_version       INTEGER NOT NULL DEFAULT 0,
    adhoc_language       TEXT,
    adhoc_content        TEXT,
    content_sha256       TEXT NOT NULL,
    parameters           TEXT NOT NULL DEFAULT '{}',     -- JSON; secret values replaced by the mask
    secret_parameters    BLOB,                           -- field-encrypted JSON of secret values
    target_type          TEXT NOT NULL CHECK (target_type IN ('devices', 'group', 'site', 'client', 'policy')),
    target_ids           TEXT NOT NULL DEFAULT '[]',
    schedule             TEXT NOT NULL,                  -- JSON schedule
    next_run_at          TEXT,
    status               TEXT NOT NULL CHECK (status IN ('pending_approval', 'scheduled', 'running', 'completed', 'cancelled', 'rejected')),
    offline_wait_minutes INTEGER NOT NULL DEFAULT 60,
    concurrency          INTEGER NOT NULL DEFAULT 25,
    timeout_secs         INTEGER NOT NULL,
    policy_id            TEXT,                           -- policy task jobs
    policy_task_id       TEXT,
    client_id            TEXT,                           -- visibility scope (NULL = installation-wide)
    site_id              TEXT,
    created_by           TEXT,
    created_by_name      TEXT NOT NULL DEFAULT '',
    created_at           TEXT NOT NULL,
    approved_by          TEXT,
    approved_by_name     TEXT,
    approved_at          TEXT,
    deleted_at           TEXT,
    updated_at           TEXT NOT NULL
);
CREATE INDEX jobs_status ON jobs (status, next_run_at);
CREATE INDEX jobs_script ON jobs (script_id);
CREATE UNIQUE INDEX jobs_policy_task ON jobs (policy_id, policy_task_id) WHERE policy_id IS NOT NULL;

CREATE TABLE job_runs (
    id           TEXT PRIMARY KEY,
    job_id       TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
    status       TEXT NOT NULL CHECK (status IN ('running', 'completed', 'cancelled')),
    trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('manual', 'schedule', 'policy', 'rerun')),
    started_at   TEXT NOT NULL,
    finished_at  TEXT
);
CREATE INDEX job_runs_job ON job_runs (job_id, started_at);
CREATE INDEX job_runs_status ON job_runs (status);

CREATE TABLE job_results (
    run_id      TEXT NOT NULL REFERENCES job_runs (id) ON DELETE CASCADE,
    device_id   TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    job_id      TEXT NOT NULL,
    status      TEXT NOT NULL CHECK (status IN ('pending', 'waiting_offline', 'running', 'succeeded', 'failed', 'timed_out', 'skipped', 'cancelled')),
    command_id  TEXT,
    wait_until  TEXT,                             -- end of the offline wait window
    exit_code   INTEGER,
    started_at  TEXT,
    finished_at TEXT,
    duration_ms INTEGER,
    error       TEXT,
    stdout      TEXT,
    stderr      TEXT,
    truncated   INTEGER NOT NULL DEFAULT 0,
    directives  TEXT NOT NULL DEFAULT '[]',
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (run_id, device_id)
);
CREATE INDEX job_results_device ON job_results (device_id, updated_at);
CREATE INDEX job_results_status ON job_results (status);
CREATE INDEX job_results_command ON job_results (command_id);

-- ---------------------------------------------------------------- approvals (four-eyes)
CREATE TABLE approvals (
    id                TEXT PRIMARY KEY,
    kind              TEXT NOT NULL DEFAULT 'job' CHECK (kind IN ('job')),
    subject_id        TEXT NOT NULL,
    status            TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
    requested_by      TEXT,
    requested_by_name TEXT NOT NULL DEFAULT '',
    requested_at      TEXT NOT NULL,
    expires_at        TEXT NOT NULL,
    decided_by        TEXT,
    decided_by_name   TEXT,
    decided_at        TEXT,
    comment           TEXT,
    client_id         TEXT,
    site_id           TEXT
);
CREATE INDEX approvals_status ON approvals (status, requested_at);
CREATE INDEX approvals_subject ON approvals (subject_id);

-- ---------------------------------------------------------------- custom fields
CREATE TABLE custom_fields (
    id              TEXT PRIMARY KEY,
    key             TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    type            TEXT NOT NULL CHECK (type IN ('text', 'number', 'boolean', 'date', 'select')),
    options         TEXT NOT NULL DEFAULT '[]',
    scope           TEXT NOT NULL CHECK (scope IN ('device', 'client', 'site')),
    script_writable INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE TABLE custom_field_values (
    field_id   TEXT NOT NULL REFERENCES custom_fields (id) ON DELETE CASCADE,
    entity_id  TEXT NOT NULL,                 -- device, client or site id (by the field's scope)
    value      TEXT NOT NULL,                 -- JSON value
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL,                 -- user name or 'script'
    PRIMARY KEY (field_id, entity_id)
);
CREATE INDEX custom_field_values_entity ON custom_field_values (entity_id);

-- ---------------------------------------------------------------- device groups
CREATE TABLE device_groups (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    kind            TEXT NOT NULL CHECK (kind IN ('static', 'dynamic')),
    client_id       TEXT REFERENCES clients (id) ON DELETE CASCADE,
    rules           TEXT,                     -- JSON rule document (dynamic groups)
    created_by      TEXT,
    created_by_name TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX device_groups_name ON device_groups (IFNULL(client_id, ''), name COLLATE NOCASE);

CREATE TABLE device_group_members (
    group_id  TEXT NOT NULL REFERENCES device_groups (id) ON DELETE CASCADE,
    device_id TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    added_at  TEXT NOT NULL,
    PRIMARY KEY (group_id, device_id)
);
CREATE INDEX device_group_members_device ON device_group_members (device_id);

-- ---------------------------------------------------------------- policies
CREATE TABLE policies (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    version         INTEGER NOT NULL DEFAULT 1,
    document        TEXT NOT NULL DEFAULT '{}',
    created_by      TEXT,
    updated_by      TEXT,
    updated_by_name TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX policies_name ON policies (name COLLATE NOCASE);

CREATE TABLE policy_assignments (
    id          TEXT PRIMARY KEY,
    policy_id   TEXT NOT NULL REFERENCES policies (id) ON DELETE CASCADE,
    target_type TEXT NOT NULL CHECK (target_type IN ('global', 'client', 'site', 'group', 'device')),
    target_id   TEXT,
    priority    INTEGER NOT NULL DEFAULT 0,
    created_by  TEXT,
    created_at  TEXT NOT NULL,
    CHECK ((target_type = 'global' AND target_id IS NULL) OR (target_type <> 'global' AND target_id IS NOT NULL))
);
CREATE UNIQUE INDEX policy_assignments_unique ON policy_assignments (policy_id, target_type, IFNULL(target_id, ''));
CREATE INDEX policy_assignments_target ON policy_assignments (target_type, target_id);

-- ---------------------------------------------------------------- clean-up of scoped rows
CREATE TRIGGER clients_delete_automation AFTER DELETE ON clients
BEGIN
    DELETE FROM variables WHERE scope = 'client' AND scope_id = OLD.id;
    DELETE FROM custom_field_values WHERE entity_id = OLD.id;
    DELETE FROM policy_assignments WHERE target_type = 'client' AND target_id = OLD.id;
END;

CREATE TRIGGER sites_delete_automation AFTER DELETE ON sites
BEGIN
    DELETE FROM variables WHERE scope = 'site' AND scope_id = OLD.id;
    DELETE FROM custom_field_values WHERE entity_id = OLD.id;
    DELETE FROM policy_assignments WHERE target_type = 'site' AND target_id = OLD.id;
END;

CREATE TRIGGER devices_delete_automation AFTER DELETE ON devices
BEGIN
    DELETE FROM custom_field_values WHERE entity_id = OLD.id;
    DELETE FROM policy_assignments WHERE target_type = 'device' AND target_id = OLD.id;
END;

CREATE TRIGGER device_groups_delete_automation AFTER DELETE ON device_groups
BEGIN
    DELETE FROM policy_assignments WHERE target_type = 'group' AND target_id = OLD.id;
END;
