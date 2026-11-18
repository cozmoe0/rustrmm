-- Phase 9: ticketing and helpdesk (additive only).
--
-- Times are RFC 3339 text like every other table. JSON columns hold arrays or objects as text.
-- The default "Support" queue and the default 24x7 SLA policy are seeded at start-up
-- (`tickets::seed`, idempotent).

-- Ticket numbers: one row, incremented with UPDATE … RETURNING. The first ticket is #1001.
CREATE TABLE ticket_sequence (
    id    INTEGER PRIMARY KEY CHECK (id = 1),
    value INTEGER NOT NULL
);
INSERT INTO ticket_sequence (id, value) VALUES (1, 1000);

CREATE TABLE ticket_queues (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    description         TEXT NOT NULL DEFAULT '',
    default_assignee_id TEXT REFERENCES users (id) ON DELETE SET NULL,
    default_priority    TEXT NOT NULL DEFAULT 'normal' CHECK (default_priority IN ('low', 'normal', 'high', 'urgent')),
    email_address       TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);
CREATE UNIQUE INDEX ticket_queues_name ON ticket_queues (name COLLATE NOCASE);

CREATE TABLE sla_policies (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    client_ids     TEXT NOT NULL DEFAULT '[]',   -- empty = default policy
    business_hours TEXT,                         -- JSON { timezone, days, start, end, holidays } or NULL (24x7)
    targets        TEXT NOT NULL,                -- JSON { urgent|high|normal|low: { first_response_minutes, resolution_minutes } }
    pause_on       TEXT NOT NULL DEFAULT '["pending","on_hold"]',
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
);

CREATE TABLE contacts (
    id         TEXT PRIMARY KEY,
    client_id  TEXT NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
    site_id    TEXT REFERENCES sites (id) ON DELETE SET NULL,
    name       TEXT NOT NULL,
    email      TEXT NOT NULL DEFAULT '',
    phone      TEXT NOT NULL DEFAULT '',
    title      TEXT NOT NULL DEFAULT '',
    is_primary INTEGER NOT NULL DEFAULT 0,
    notify     INTEGER NOT NULL DEFAULT 1,
    notes      TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
-- A contact's e-mail address is unique per client.
CREATE UNIQUE INDEX contacts_client_email ON contacts (client_id, email COLLATE NOCASE) WHERE email <> '';
CREATE INDEX contacts_email ON contacts (email COLLATE NOCASE);
CREATE INDEX contacts_client ON contacts (client_id, name);

CREATE TABLE tickets (
    id                      TEXT PRIMARY KEY,
    number                  INTEGER NOT NULL UNIQUE,
    subject                 TEXT NOT NULL,
    description             TEXT NOT NULL DEFAULT '',
    client_id               TEXT NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
    site_id                 TEXT REFERENCES sites (id) ON DELETE SET NULL,
    contact_id              TEXT REFERENCES contacts (id) ON DELETE SET NULL,
    status                  TEXT NOT NULL CHECK (status IN ('new', 'open', 'pending', 'on_hold', 'resolved', 'closed')),
    priority                TEXT NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
    type                    TEXT NOT NULL CHECK (type IN ('incident', 'request', 'problem', 'change', 'alert')),
    queue_id                TEXT REFERENCES ticket_queues (id) ON DELETE SET NULL,
    assignee_id             TEXT REFERENCES users (id) ON DELETE SET NULL,
    tags                    TEXT NOT NULL DEFAULT '[]',
    cc                      TEXT NOT NULL DEFAULT '[]',   -- extra e-mail recipients of public comments
    source                  TEXT NOT NULL CHECK (source IN ('console', 'email', 'agent', 'alert', 'api')),
    sla_policy_id           TEXT REFERENCES sla_policies (id) ON DELETE SET NULL,
    first_response_due      TEXT,
    first_response_at       TEXT,
    first_response_breached INTEGER NOT NULL DEFAULT 0,
    resolution_due          TEXT,
    resolved_at             TEXT,
    resolution_breached     INTEGER NOT NULL DEFAULT 0,
    sla_paused_at           TEXT,                         -- set while the SLA clock is stopped
    sla_pause_seconds       INTEGER NOT NULL DEFAULT 0,   -- business seconds spent paused so far
    alert_rule_id           TEXT,
    close_on_alert_resolve  INTEGER NOT NULL DEFAULT 0,
    merged_into             TEXT REFERENCES tickets (id) ON DELETE SET NULL,
    created_by              TEXT,
    created_by_name         TEXT NOT NULL DEFAULT '',
    created_at              TEXT NOT NULL,
    updated_at              TEXT NOT NULL,
    last_activity_at        TEXT NOT NULL,
    closed_at               TEXT
);
CREATE INDEX tickets_client ON tickets (client_id, status);
CREATE INDEX tickets_status ON tickets (status, last_activity_at);
CREATE INDEX tickets_assignee ON tickets (assignee_id, status);
CREATE INDEX tickets_queue ON tickets (queue_id, status);
CREATE INDEX tickets_created ON tickets (created_at);
CREATE INDEX tickets_resolved ON tickets (resolved_at);

CREATE TABLE ticket_comments (
    id               TEXT PRIMARY KEY,
    ticket_id        TEXT NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
    author_type      TEXT NOT NULL CHECK (author_type IN ('user', 'contact', 'system')),
    author_id        TEXT,
    author_name      TEXT NOT NULL DEFAULT '',
    visibility       TEXT NOT NULL CHECK (visibility IN ('public', 'internal')),
    body             TEXT NOT NULL DEFAULT '',
    source           TEXT NOT NULL DEFAULT 'console',     -- console | email | agent | system
    email_message_id TEXT,
    created_at       TEXT NOT NULL,
    edited_at        TEXT
);
CREATE INDEX ticket_comments_ticket ON ticket_comments (ticket_id, created_at);

-- Blobs live in the content-addressed store <data dir>/files/<sha256> (shared with Phase 7).
CREATE TABLE ticket_attachments (
    id           TEXT PRIMARY KEY,
    ticket_id    TEXT NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
    comment_id   TEXT REFERENCES ticket_comments (id) ON DELETE CASCADE,
    sha256       TEXT NOT NULL,
    size_bytes   INTEGER NOT NULL,
    file_name    TEXT NOT NULL,
    content_type TEXT NOT NULL,
    created_by   TEXT,
    created_at   TEXT NOT NULL
);
CREATE INDEX ticket_attachments_ticket ON ticket_attachments (ticket_id);
CREATE INDEX ticket_attachments_comment ON ticket_attachments (comment_id);

CREATE TABLE ticket_activity (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id  TEXT NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
    at         TEXT NOT NULL,
    actor_id   TEXT,
    actor_name TEXT NOT NULL DEFAULT '',
    kind       TEXT NOT NULL,
    from_value TEXT,
    to_value   TEXT
);
CREATE INDEX ticket_activity_ticket ON ticket_activity (ticket_id, id);

CREATE TABLE ticket_links (
    ticket_id  TEXT NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
    kind       TEXT NOT NULL CHECK (kind IN ('device', 'alert', 'ticket')),
    target_id  TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (ticket_id, kind, target_id)
);
CREATE INDEX ticket_links_target ON ticket_links (kind, target_id);

CREATE TABLE canned_responses (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    body       TEXT NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'internal')),
    shared     INTEGER NOT NULL DEFAULT 0,
    owner_id   TEXT REFERENCES users (id) ON DELETE SET NULL,  -- private responses of a deleted user stay hidden
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX canned_responses_owner ON canned_responses (owner_id);

CREATE TABLE time_entries (
    id         TEXT PRIMARY KEY,
    ticket_id  TEXT NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
    user_id    TEXT REFERENCES users (id) ON DELETE SET NULL,
    user_name  TEXT NOT NULL DEFAULT '',
    started_at TEXT NOT NULL,
    minutes    INTEGER NOT NULL CHECK (minutes > 0),
    billable   INTEGER NOT NULL DEFAULT 1,
    note       TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX time_entries_ticket ON time_entries (ticket_id);
CREATE INDEX time_entries_started ON time_entries (started_at);
CREATE INDEX time_entries_user ON time_entries (user_id, started_at);

CREATE TABLE alert_ticket_rules (
    id                      TEXT PRIMARY KEY,
    name                    TEXT NOT NULL,
    enabled                 INTEGER NOT NULL DEFAULT 1,
    filters                 TEXT NOT NULL DEFAULT '{}',
    after_minutes           INTEGER NOT NULL DEFAULT 0,
    ticket                  TEXT NOT NULL DEFAULT '{}',   -- { queue_id, priority, assignee_id? }
    close_ticket_on_resolve INTEGER NOT NULL DEFAULT 0,
    created_by              TEXT,
    created_at              TEXT NOT NULL,
    updated_at              TEXT NOT NULL
);

-- Message-ID ↔ ticket mapping (inbound and outbound), used for In-Reply-To threading.
CREATE TABLE email_threads (
    message_id TEXT PRIMARY KEY,
    ticket_id  TEXT NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
    direction  TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    created_at TEXT NOT NULL
);
CREATE INDEX email_threads_ticket ON email_threads (ticket_id);

-- Inbound dedupe: one row per Message-ID (or content hash when a message has none).
CREATE TABLE processed_emails (
    message_id   TEXT PRIMARY KEY,
    from_address TEXT NOT NULL DEFAULT '',
    subject      TEXT NOT NULL DEFAULT '',
    outcome      TEXT NOT NULL,             -- comment | ticket | ignored | dropped | too_large | failed
    ticket_id    TEXT,
    detail       TEXT NOT NULL DEFAULT '',
    processed_at TEXT NOT NULL
);
CREATE INDEX processed_emails_at ON processed_emails (processed_at);

-- Outbound ticket e-mail queue (one row per message, retried with backoff).
CREATE TABLE ticket_email_outbox (
    id              TEXT PRIMARY KEY,
    ticket_id       TEXT REFERENCES tickets (id) ON DELETE CASCADE,
    event           TEXT NOT NULL,          -- created | comment | resolved | assigned
    recipients      TEXT NOT NULL DEFAULT '[]',
    cc              TEXT NOT NULL DEFAULT '[]',
    subject         TEXT NOT NULL,
    text_body       TEXT NOT NULL,
    html_body       TEXT NOT NULL,
    message_id      TEXT NOT NULL,
    in_reply_to     TEXT,
    reply_to        TEXT,
    attachment_ids  TEXT NOT NULL DEFAULT '[]',
    status          TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    last_error      TEXT,
    created_at      TEXT NOT NULL,
    sent_at         TEXT
);
CREATE INDEX ticket_email_outbox_due ON ticket_email_outbox (status, next_attempt_at);

-- Support-request replay protection: each (device, nonce) is accepted once.
CREATE TABLE support_nonces (
    device_id  TEXT NOT NULL,
    nonce      TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    PRIMARY KEY (device_id, nonce)
);
CREATE INDEX support_nonces_expiry ON support_nonces (expires_at);
