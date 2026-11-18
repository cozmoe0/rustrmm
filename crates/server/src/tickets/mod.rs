//! Phase 9 ticketing and helpdesk (`docs/api-tickets.md`): tickets, comments and attachments,
//! activity, queues, SLA policies, canned responses, contacts, time entries, outbound e-mail,
//! the IMAP poller, alert-to-ticket rules and the agent "Request support" endpoint.

pub mod api;
pub mod canned;
pub mod comments;
pub mod contacts;
pub mod email;
pub mod imap;
pub mod inbound;
pub mod markdown;
pub mod model;
pub mod queues;
pub mod rules;
pub mod sla;
pub mod support;
pub mod time;

use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use dashmap::DashMap;
use serde_json::{Value, json};
use sqlx::{QueryBuilder, Sqlite};
use tokio::sync::{Mutex, Notify};

use crate::db::Db;
use crate::rbac::{AccessScope, ClientFilter};
use crate::state::AppState;

/// Statuses that count as open work.
pub const ACTIVE_STATUSES: [&str; 4] = ["new", "open", "pending", "on_hold"];
pub const STATUSES: [&str; 6] = ["new", "open", "pending", "on_hold", "resolved", "closed"];
pub const PRIORITIES: [&str; 4] = ["low", "normal", "high", "urgent"];
pub const TYPES: [&str; 5] = ["incident", "request", "problem", "change", "alert"];

/// `tickets.counts` is published at most this often per client.
const COUNTS_INTERVAL: Duration = Duration::from_secs(2);
/// SLA breach and delayed alert-rule sweep.
const SWEEP_EVERY: Duration = Duration::from_secs(30);

/// Outcome of the latest IMAP poll (shown with the e-mail settings).
#[derive(Debug, Clone, Default)]
pub struct PollStatus {
    pub last_poll_at: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
    pub last_processed: usize,
}

/// In-memory ticketing state.
#[derive(Default)]
pub struct Runtime {
    /// Wakes the outbound e-mail worker.
    pub(crate) email_wake: Notify,
    /// Wakes the IMAP poller (settings changed).
    pub(crate) imap_wake: Notify,
    /// Serialises IMAP polls (the scheduled poll and manual ones).
    pub(crate) imap_lock: Mutex<()>,
    pub(crate) poll_status: std::sync::Mutex<PollStatus>,
    counts: DashMap<String, (Instant, bool)>,
}

impl Runtime {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn kick_email(&self) {
        self.email_wake.notify_one();
    }

    pub fn poll_status(&self) -> PollStatus {
        self.poll_status
            .lock()
            .map(|s| s.clone())
            .unwrap_or_default()
    }
}

/// Seeds the default queue and SLA policy (idempotent).
pub async fn seed(db: &Db) -> anyhow::Result<()> {
    queues::seed(db).await?;
    sla::seed(db).await
}

/// Starts the e-mail worker, the IMAP poller and the SLA / alert-rule sweep.
pub fn spawn(state: AppState) {
    email::spawn_worker(state.clone());
    imap::spawn_poller(state.clone());
    tokio::spawn(async move {
        let mut next_purge = Instant::now();
        loop {
            if let Err(e) = sweep_breaches(&state).await {
                tracing::warn!(error = %format!("{e:#}"), "SLA breach sweep failed");
            }
            if let Err(e) = rules::sweep(&state).await {
                tracing::warn!(error = %format!("{e:#}"), "alert-to-ticket sweep failed");
            }
            if Instant::now() >= next_purge {
                next_purge = Instant::now() + Duration::from_secs(3600);
                if let Err(e) = purge(&state.db).await {
                    tracing::warn!(error = %format!("{e:#}"), "ticket housekeeping failed");
                }
            }
            tokio::time::sleep(SWEEP_EVERY).await;
        }
    });
}

/// Start-up recovery: e-mails left `sending` by a crash are retried.
pub async fn recover(state: &AppState) -> anyhow::Result<()> {
    sqlx::query("UPDATE ticket_email_outbox SET status = 'pending' WHERE status = 'sending'")
        .execute(&state.db)
        .await?;
    Ok(())
}

/// Expired support nonces, old dedupe rows and finished outbox rows.
pub async fn purge(db: &Db) -> anyhow::Result<()> {
    let now = rustrmm_common::now();
    sqlx::query("DELETE FROM support_nonces WHERE expires_at < ?")
        .bind(now)
        .execute(db)
        .await?;
    sqlx::query("DELETE FROM processed_emails WHERE processed_at < ?")
        .bind(now - chrono::Duration::days(90))
        .execute(db)
        .await?;
    sqlx::query(
        "DELETE FROM ticket_email_outbox WHERE status IN ('sent', 'failed') AND created_at < ?",
    )
    .bind(now - chrono::Duration::days(30))
    .execute(db)
    .await?;
    Ok(())
}

// ------------------------------------------------------------------ scope helpers

/// Whether a ticket (client, optional site) is visible for `permission`.
pub fn visible(
    scope: &AccessScope,
    permission: &str,
    client_id: &str,
    site_id: Option<&str>,
) -> bool {
    match site_id {
        Some(site) => scope.can_site(permission, client_id, site),
        None => scope.can_client(permission, client_id),
    }
}

/// Restricts a query on `alias.client_id` / `alias.site_id` to the caller's scope.
pub fn push_scope(
    qb: &mut QueryBuilder<Sqlite>,
    scope: &AccessScope,
    permission: &str,
    alias: &str,
) {
    if scope.has_global(permission) {
        return;
    }
    let clients = match scope.client_level(permission) {
        ClientFilter::All => return,
        ClientFilter::Only(c) => c,
    };
    let sites = scope.sites_with(permission);
    qb.push(format!(" AND ({alias}.client_id IN ("));
    {
        let mut sep = qb.separated(", ");
        sep.push_bind("");
        for c in clients {
            sep.push_bind(c);
        }
    }
    qb.push(format!(") OR {alias}.site_id IN ("));
    {
        let mut sep = qb.separated(", ");
        sep.push_bind("");
        for s in sites {
            sep.push_bind(s);
        }
    }
    qb.push("))");
}

pub fn csv_param(v: &Option<String>) -> Vec<String> {
    v.as_deref()
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

pub fn push_in(qb: &mut QueryBuilder<Sqlite>, column: &str, values: &[String]) {
    if values.is_empty() {
        return;
    }
    qb.push(format!(" AND {column} IN ("));
    let mut sep = qb.separated(", ");
    for v in values {
        sep.push_bind(v.clone());
    }
    qb.push(")");
}

/// `%text%` for LIKE … ESCAPE '\'.
pub fn like_pattern(text: &str) -> String {
    format!(
        "%{}%",
        text.replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    )
}

pub fn json_strings(text: &str) -> Vec<String> {
    serde_json::from_str(text).unwrap_or_default()
}

/// Trims, drops empties and duplicates, and bounds a tag list.
pub fn clean_tags(tags: &[String]) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for t in tags {
        let t = t.trim().to_string();
        if t.is_empty() {
            continue;
        }
        if t.chars().count() > 40 || t.chars().any(char::is_control) {
            return Err("tags are at most 40 characters".into());
        }
        if !out.iter().any(|o| o.eq_ignore_ascii_case(&t)) {
            out.push(t);
        }
    }
    if out.len() > 20 {
        return Err("at most 20 tags".into());
    }
    Ok(out)
}

/// Validates and normalises a CC list.
pub fn clean_cc(cc: &[String]) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for a in cc {
        let a = a.trim().to_string();
        if a.is_empty() {
            continue;
        }
        if !crate::monitoring::settings::valid_email(&a) {
            return Err(format!("cc address '{a}' is not a valid e-mail address"));
        }
        if !out.iter().any(|o| o.eq_ignore_ascii_case(&a)) {
            out.push(a);
        }
    }
    if out.len() > 20 {
        return Err("at most 20 cc addresses".into());
    }
    Ok(out)
}

// ------------------------------------------------------------------ live counts

/// Publishes `tickets.counts` for a client, at most once per 2 s (a trailing event carries the
/// latest numbers), and the data-less `fleet.summary`.
pub fn publish_counts(state: &AppState, client_id: &str) {
    let now = Instant::now();
    let delay = {
        let mut entry = state
            .helpdesk
            .counts
            .entry(client_id.to_string())
            .or_insert((now.checked_sub(COUNTS_INTERVAL).unwrap_or(now), false));
        let since = now.duration_since(entry.0);
        if since >= COUNTS_INTERVAL {
            entry.0 = now;
            Some(Duration::ZERO)
        } else if entry.1 {
            None
        } else {
            entry.1 = true;
            Some(COUNTS_INTERVAL - since)
        }
    };
    let Some(delay) = delay else {
        return;
    };
    let state = state.clone();
    let client_id = client_id.to_string();
    tokio::spawn(async move {
        if !delay.is_zero() {
            tokio::time::sleep(delay).await;
            if let Some(mut entry) = state.helpdesk.counts.get_mut(&client_id) {
                entry.0 = Instant::now();
                entry.1 = false;
            }
        }
        if let Ok(counts) = client_counts(&state.db, &client_id).await {
            state
                .events
                .publish("tickets.counts", Some(client_id.clone()), counts);
        }
        state
            .events
            .publish("fleet.summary", Some(client_id.clone()), Value::Null);
    });
}

async fn client_counts(db: &Db, client_id: &str) -> anyhow::Result<Value> {
    let (new, open, pending, on_hold, unassigned, breached): (i64, i64, i64, i64, i64, i64) =
        sqlx::query_as(
            "SELECT COALESCE(SUM(status = 'new'), 0), COALESCE(SUM(status = 'open'), 0),
                    COALESCE(SUM(status = 'pending'), 0), COALESCE(SUM(status = 'on_hold'), 0),
                    COALESCE(SUM(assignee_id IS NULL), 0),
                    COALESCE(SUM(first_response_breached = 1 OR resolution_breached = 1), 0)
             FROM tickets WHERE client_id = ? AND status IN ('new', 'open', 'pending', 'on_hold')",
        )
        .bind(client_id)
        .fetch_one(db)
        .await?;
    Ok(json!({
        "client_id": client_id, "new": new, "open": open, "pending": pending, "on_hold": on_hold,
        "unassigned": unassigned, "breached": breached, "total": new + open + pending + on_hold,
    }))
}

/// Open (new, open, pending, on hold) tickets the caller may see, for `fleet.summary`.
pub async fn open_count(
    state: &AppState,
    scope: &AccessScope,
    client_id: Option<&str>,
    site_id: Option<&str>,
) -> anyhow::Result<i64> {
    if !scope.has_anywhere(crate::rbac::perm::TICKETS_VIEW) {
        return Ok(0);
    }
    let rows: Vec<(String, Option<String>, i64)> = sqlx::query_as(
        "SELECT client_id, site_id, COUNT(*) FROM tickets WHERE status IN ('new', 'open', 'pending', 'on_hold')
         GROUP BY client_id, site_id",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(rows
        .into_iter()
        .filter(|(c, s, _)| {
            visible(scope, crate::rbac::perm::TICKETS_VIEW, c, s.as_deref())
                && client_id.is_none_or(|x| x == c)
                && site_id.is_none_or(|x| s.as_deref() == Some(x))
        })
        .map(|(_, _, n)| n)
        .sum())
}

// ------------------------------------------------------------------ SLA upkeep

/// Marks newly breached targets on running clocks.
pub async fn sweep_breaches(state: &AppState) -> anyhow::Result<()> {
    let now = rustrmm_common::now();
    let due: Vec<(String, String, bool, bool)> = sqlx::query_as(
        "SELECT id, client_id,
                (first_response_at IS NULL AND first_response_breached = 0 AND first_response_due < ?),
                (resolved_at IS NULL AND resolution_breached = 0 AND resolution_due < ?)
         FROM tickets
         WHERE status IN ('new', 'open', 'pending', 'on_hold') AND sla_paused_at IS NULL
           AND ((first_response_at IS NULL AND first_response_breached = 0 AND first_response_due < ?)
             OR (resolved_at IS NULL AND resolution_breached = 0 AND resolution_due < ?))
         LIMIT 500",
    )
    .bind(now)
    .bind(now)
    .bind(now)
    .bind(now)
    .fetch_all(&state.db)
    .await?;
    for (id, client_id, first, resolution) in due {
        sqlx::query(
            "UPDATE tickets SET first_response_breached = first_response_breached OR ?,
                    resolution_breached = resolution_breached OR ?, updated_at = ? WHERE id = ?",
        )
        .bind(first)
        .bind(resolution)
        .bind(now)
        .bind(&id)
        .execute(&state.db)
        .await?;
        let which = match (first, resolution) {
            (true, true) => "first_response,resolution",
            (true, false) => "first_response",
            _ => "resolution",
        };
        model::activity(
            &state.db,
            &id,
            &model::Who::system(),
            "sla_breached",
            None,
            Some(which),
        )
        .await?;
        state.events.publish(
            "ticket.updated",
            Some(client_id.clone()),
            json!({ "ticket_id": id, "changes": { "sla_breached": { "from": null, "to": which } } }),
        );
        publish_counts(state, &client_id);
    }
    Ok(())
}

/// Re-selects the SLA policy of every active ticket and recomputes its due times (after a
/// policy was created, changed or deleted).
pub async fn reassign_sla_all(state: &AppState) -> anyhow::Result<()> {
    let ids: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM tickets WHERE status IN ('new', 'open', 'pending', 'on_hold')",
    )
    .fetch_all(&state.db)
    .await?;
    let now = rustrmm_common::now();
    for id in ids {
        let Some(t) = model::load(&state.db, &id).await? else {
            continue;
        };
        let policy = sla::for_client(&state.db, &t.client_id).await?;
        let mut clock = t.clock();
        clock.recompute(policy.as_ref(), &t.priority, t.created_at, now);
        if clock != t.clock() {
            model::save_clock(&state.db, &id, &clock).await?;
        }
    }
    Ok(())
}
