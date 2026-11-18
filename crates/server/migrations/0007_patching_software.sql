-- Phase 7: patching, the software library and software deployments (additive only).

CREATE TABLE patch_catalog (
    id              TEXT PRIMARY KEY,
    platform        TEXT NOT NULL,             -- windows | linux | macos | winget
    key             TEXT NOT NULL,             -- WUA UpdateID | <manager>:<package>:<version> | label | winget:<id>:<version>
    kb              TEXT,
    title           TEXT NOT NULL,
    classification  TEXT NOT NULL DEFAULT 'other',
    severity        TEXT,                      -- Critical | Important | Moderate | Low
    size_bytes      INTEGER,
    reboot_required INTEGER NOT NULL DEFAULT 0,
    release_date    TEXT,
    description     TEXT NOT NULL DEFAULT '',
    support_url     TEXT,
    cves            TEXT NOT NULL DEFAULT '[]', -- JSON array
    package         TEXT,                      -- package-manager patches: the package name
    version         TEXT,
    first_seen_at   TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    UNIQUE (platform, key)
);
CREATE INDEX patch_catalog_kb ON patch_catalog (kb);

CREATE TABLE device_patches (
    device_id    TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    patch_id     TEXT NOT NULL REFERENCES patch_catalog (id) ON DELETE CASCADE,
    state        TEXT NOT NULL CHECK (state IN ('missing', 'downloaded', 'installing', 'installed', 'failed', 'pending_reboot', 'superseded')),
    detected_at  TEXT NOT NULL,
    installed_at TEXT,
    last_error   TEXT,
    attempts     INTEGER NOT NULL DEFAULT 0,
    updated_at   TEXT NOT NULL,
    PRIMARY KEY (device_id, patch_id)
);
CREATE INDEX device_patches_patch ON device_patches (patch_id, state);

-- Latest scan per device.
CREATE TABLE device_patch_status (
    device_id              TEXT PRIMARY KEY REFERENCES devices (id) ON DELETE CASCADE,
    scanned_at             TEXT,
    source                 TEXT,
    pending_reboot         INTEGER NOT NULL DEFAULT 0,
    reboot_reasons         TEXT NOT NULL DEFAULT '[]',
    last_install_at        TEXT,
    error                  TEXT,
    last_scan_requested_at TEXT,
    updated_at             TEXT NOT NULL
);

-- One decision per patch and scope (client_id NULL = global). Rule approvals are client-scoped
-- and carry the matching rule's ring delays.
CREATE TABLE patch_approvals (
    id         TEXT PRIMARY KEY,
    patch_id   TEXT NOT NULL REFERENCES patch_catalog (id) ON DELETE CASCADE,
    client_id  TEXT REFERENCES clients (id) ON DELETE CASCADE,
    decision   TEXT NOT NULL CHECK (decision IN ('approved', 'declined', 'deferred')),
    until      TEXT,
    source     TEXT NOT NULL CHECK (source IN ('rule', 'manual')),
    by         TEXT,
    by_name    TEXT NOT NULL DEFAULT '',
    at         TEXT NOT NULL,
    policy_id  TEXT,                            -- rule approvals: the policy holding the rule
    delay_days TEXT NOT NULL DEFAULT '{}'       -- rule approvals: { pilot, broad, late }
);
CREATE UNIQUE INDEX patch_approvals_scope ON patch_approvals (patch_id, COALESCE(client_id, ''));

CREATE TABLE patch_runs (
    id           TEXT PRIMARY KEY,
    policy_id    TEXT,
    policy_name  TEXT NOT NULL DEFAULT '',
    window_start TEXT NOT NULL,
    window_end   TEXT NOT NULL,
    status       TEXT NOT NULL CHECK (status IN ('running', 'completed', 'cancelled')),
    trigger_kind TEXT NOT NULL DEFAULT 'window',  -- window | manual
    created_at   TEXT NOT NULL,
    finished_at  TEXT
);
CREATE UNIQUE INDEX patch_runs_window ON patch_runs (policy_id, window_start) WHERE trigger_kind = 'window';

CREATE TABLE patch_run_results (
    run_id      TEXT NOT NULL REFERENCES patch_runs (id) ON DELETE CASCADE,
    device_id   TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    status      TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'pending_reboot', 'skipped', 'cancelled')),
    keys        TEXT NOT NULL DEFAULT '[]',    -- patch keys sent (JSON)
    installed   INTEGER NOT NULL DEFAULT 0,
    failed      INTEGER NOT NULL DEFAULT 0,
    rebooted    INTEGER NOT NULL DEFAULT 0,
    error       TEXT,
    command_id  TEXT,
    window_end  TEXT,
    started_at  TEXT,
    finished_at TEXT,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (run_id, device_id)
);
CREATE INDEX patch_run_results_command ON patch_run_results (command_id);
CREATE INDEX patch_run_results_device ON patch_run_results (device_id, status);

CREATE TABLE software_files (
    id          TEXT PRIMARY KEY,
    sha256      TEXT NOT NULL,
    size_bytes  INTEGER NOT NULL,
    file_name   TEXT NOT NULL,
    created_by  TEXT,
    created_at  TEXT NOT NULL
);
CREATE INDEX software_files_sha ON software_files (sha256);

CREATE TABLE software_packages (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    publisher       TEXT NOT NULL DEFAULT '',
    description     TEXT NOT NULL DEFAULT '',
    platforms       TEXT NOT NULL DEFAULT '[]', -- JSON array
    source          TEXT NOT NULL,              -- JSON PackageSource
    detection       TEXT NOT NULL DEFAULT '{"type":"none"}',
    created_by      TEXT,
    created_by_name TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE TABLE software_deployments (
    id              TEXT PRIMARY KEY,
    package_id      TEXT REFERENCES software_packages (id) ON DELETE SET NULL,
    package_name    TEXT NOT NULL,
    action          TEXT NOT NULL CHECK (action IN ('install', 'uninstall')),
    target_type     TEXT NOT NULL,
    target_ids      TEXT NOT NULL,             -- JSON array
    schedule        TEXT NOT NULL,             -- JSON { type: now | once | window, at? }
    status          TEXT NOT NULL CHECK (status IN ('scheduled', 'running', 'completed', 'cancelled')),
    client_id       TEXT,
    site_id         TEXT,
    created_by      TEXT,
    created_by_name TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    finished_at     TEXT
);

CREATE TABLE software_deployment_results (
    deployment_id  TEXT NOT NULL REFERENCES software_deployments (id) ON DELETE CASCADE,
    device_id      TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    status         TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'skipped', 'cancelled')),
    exit_code      INTEGER,
    detected_after INTEGER,
    error          TEXT,
    output         TEXT,
    command_id     TEXT,
    wait_until     TEXT,
    started_at     TEXT,
    finished_at    TEXT,
    updated_at     TEXT NOT NULL,
    PRIMARY KEY (deployment_id, device_id)
);
CREATE INDEX software_deployment_results_command ON software_deployment_results (command_id);
CREATE INDEX software_deployment_results_device ON software_deployment_results (device_id, status);

CREATE TABLE file_download_tokens (
    token_hash    TEXT PRIMARY KEY,              -- SHA-256 of the token; the token itself is never stored
    device_id     TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    sha256        TEXT NOT NULL,
    deployment_id TEXT,
    created_at    TEXT NOT NULL,
    expires_at    TEXT NOT NULL,
    used_at       TEXT
);
CREATE INDEX file_download_tokens_expiry ON file_download_tokens (expires_at);
