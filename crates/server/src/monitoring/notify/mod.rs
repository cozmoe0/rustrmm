//! Notifications: channels, rules, quiet hours, escalation and delivery.

pub mod channels;
pub mod delivery;
pub mod rules;
pub mod smtp;
pub mod ssrf;

use std::collections::HashSet;

use axum::Json;
use axum::extract::{Query, State};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{QueryBuilder, Sqlite};

use super::alerts::{self, AlertRow};
use crate::auth::AuthCtx;
use crate::error::ApiResult;
use crate::rbac::perm;
use crate::state::AppState;
use delivery::Payload;

/// The rendered message for an alert event.
pub fn payload_for(state: &AppState, alert: &AlertRow, event: &str) -> Payload {
    Payload {
        event: event.to_string(),
        alert_id: Some(alert.id.clone()),
        title: alert.title.clone(),
        severity: alert.severity.clone(),
        status: alert.status.clone(),
        source: alert.source.clone(),
        check_id: alert.check_id.clone(),
        check_type: alert.check_type.clone(),
        message: alert.message.clone(),
        hostname: alert.hostname.clone(),
        client_name: alert.client_name.clone(),
        site_name: alert.site_name.clone(),
        opened_at: Some(alert.opened_at),
        last_occurrence_at: Some(alert.last_occurrence_at),
        resolved_at: alert.resolved_at,
        occurrences: alert.occurrences,
        link: Some(format!(
            "{}alerts/{}",
            delivery::console_base(state),
            alert.id
        )),
        sent_at: rustrmm_common::now(),
    }
}

/// Whether notifications for the alert are held back right now (snoozed, or its device is in a
/// maintenance window).
async fn held_back(state: &AppState, alert: &AlertRow) -> anyhow::Result<bool> {
    let now = rustrmm_common::now();
    if alert.snoozed_until.is_some_and(|t| t > now) {
        return Ok(true);
    }
    if let Some(device) = &alert.device_id
        && !super::maintenance::active_for_device(state, device, now)
            .await?
            .is_empty()
    {
        return Ok(true);
    }
    // SNMP alerts have no agent device: windows targeting their site or client apply.
    if alert.device_id.is_none()
        && let Some(site) = &alert.site_id
        && !super::maintenance::active_for_place(state, &alert.client_id, site, now)
            .await?
            .is_empty()
    {
        return Ok(true);
    }
    Ok(false)
}

/// Queues `channel_ids` for one rule (or records them as suppressed by quiet hours).
async fn route(
    state: &AppState,
    rule: &rules::Rule,
    channel_ids: &[String],
    payload: &Payload,
    sent: &mut HashSet<String>,
) -> anyhow::Result<()> {
    let quiet = rule
        .quiet_hours
        .as_ref()
        .is_some_and(|q| q.suppresses(&payload.severity, rustrmm_common::now()));
    for channel_id in channel_ids {
        if !sent.insert(channel_id.clone()) {
            continue;
        }
        let Some(channel) = channels::load(state, channel_id).await? else {
            continue;
        };
        if !channel.enabled {
            continue;
        }
        if quiet {
            delivery::record_suppressed(state, &channel, Some(&rule.id), payload, "quiet hours")
                .await?;
        } else {
            delivery::enqueue(state, &channel, Some(&rule.id), payload).await?;
        }
    }
    Ok(())
}

/// Notifies every enabled rule that matches the alert and listens for `event`.
pub async fn dispatch(state: &AppState, alert_id: &str, event: &str) -> anyhow::Result<()> {
    let Some(alert) = alerts::load(&state.db, alert_id).await? else {
        return Ok(());
    };
    if event == "resolved" {
        // Webhooks (alert.opened is published with the alert itself).
        state.events.publish(
            "alert.resolved",
            Some(alert.client_id.clone()),
            json!({ "alert": alert.to_json() }),
        );
    }
    if held_back(state, &alert).await? {
        return Ok(());
    }
    let payload = payload_for(state, &alert, event);
    let mut sent = HashSet::new();
    for rule in rules::load_all(&state.db).await? {
        if !rule.enabled
            || !rule.events.iter().any(|e| e == event)
            || !rule.filters.matches(&alert.facts())
        {
            continue;
        }
        route(state, &rule, &rule.channel_ids, &payload, &mut sent).await?;
    }
    Ok(())
}

/// Notifies rules that listen for a non-alert event (`secret.revealed`). Only the client and
/// site filters apply; quiet hours apply as usual. The payload never carries secrets.
pub async fn dispatch_event(
    state: &AppState,
    client_id: &str,
    site_id: Option<&str>,
    payload: &Payload,
) -> anyhow::Result<()> {
    let mut sent = HashSet::new();
    for rule in rules::load_all(&state.db).await? {
        if !rule.enabled || !rule.events.contains(&payload.event) {
            continue;
        }
        let clients = &rule.filters.client_ids;
        let sites = &rule.filters.site_ids;
        if (!clients.is_empty() && !clients.iter().any(|c| c == client_id))
            || (!sites.is_empty() && !site_id.is_some_and(|s| sites.iter().any(|x| x == s)))
        {
            continue;
        }
        route(state, &rule, &rule.channel_ids, payload, &mut sent).await?;
    }
    Ok(())
}

/// Escalation timer: open (unacknowledged) alerts older than a rule's `after_minutes` notify the
/// rule's escalation channels once (plus its normal channels when it listens for
/// `escalated`).
pub async fn escalate(state: &AppState) -> anyhow::Result<usize> {
    let now = rustrmm_common::now();
    let rules: Vec<rules::Rule> = rules::load_all(&state.db)
        .await?
        .into_iter()
        .filter(|r| r.enabled && r.escalation.as_ref().is_some_and(|e| e.enabled))
        .collect();
    let mut fired = 0;
    for rule in rules {
        let Some(escalation) = &rule.escalation else {
            continue;
        };
        let cutoff = now - chrono::Duration::minutes(escalation.after_minutes);
        let candidates: Vec<AlertRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "{} WHERE a.status = 'open' AND a.opened_at <= ? AND (a.snoozed_until IS NULL OR a.snoozed_until <= ?)
               AND NOT EXISTS (SELECT 1 FROM notification_escalations e WHERE e.alert_id = a.id AND e.rule_id = ?)
             LIMIT 500",
            alerts::ALERT_SELECT
        )))
        .bind(cutoff)
        .bind(now)
        .bind(&rule.id)
        .fetch_all(&state.db)
        .await?;
        for alert in candidates {
            if !rule.filters.matches(&alert.facts()) || held_back(state, &alert).await? {
                continue;
            }
            let inserted = sqlx::query("INSERT OR IGNORE INTO notification_escalations (alert_id, rule_id, at) VALUES (?, ?, ?)")
                .bind(&alert.id)
                .bind(&rule.id)
                .bind(now)
                .execute(&state.db)
                .await?;
            if inserted.rows_affected() == 0 {
                continue;
            }
            let mut channels = escalation.channel_ids.clone();
            if rule.events.iter().any(|e| e == "escalated") {
                channels.extend(rule.channel_ids.iter().cloned());
            }
            let payload = payload_for(state, &alert, "escalated");
            route(state, &rule, &channels, &payload, &mut HashSet::new()).await?;
            fired += 1;
        }
    }
    Ok(fired)
}

#[derive(Deserialize)]
pub struct LogQuery {
    alert_id: Option<String>,
    channel_id: Option<String>,
    limit: Option<i64>,
}

#[derive(sqlx::FromRow)]
struct LogRow {
    id: String,
    delivery_id: String,
    alert_id: Option<String>,
    channel_id: Option<String>,
    channel_name: String,
    channel_kind: String,
    rule_id: Option<String>,
    event: String,
    attempt: i64,
    status: String,
    http_status: Option<i64>,
    error: Option<String>,
    created_at: chrono::DateTime<chrono::Utc>,
    next_attempt_at: Option<chrono::DateTime<chrono::Utc>>,
    finished_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// `GET /api/v1/notification-log`
pub async fn log(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<LogQuery>,
) -> ApiResult<Json<Value>> {
    ctx.require_global(perm::NOTIFICATIONS_MANAGE)?;
    let limit = q.limit.unwrap_or(100).clamp(1, 1000);
    let mut qb = QueryBuilder::<Sqlite>::new(
        "SELECT id, delivery_id, alert_id, channel_id, channel_name, channel_kind, rule_id, event, attempt, status, http_status,
                error, created_at, next_attempt_at, finished_at FROM notification_log WHERE 1 = 1",
    );
    if let Some(a) = q.alert_id.as_deref().filter(|s| !s.is_empty()) {
        qb.push(" AND alert_id = ").push_bind(a.to_string());
    }
    if let Some(c) = q.channel_id.as_deref().filter(|s| !s.is_empty()) {
        qb.push(" AND channel_id = ").push_bind(c.to_string());
    }
    qb.push(" ORDER BY created_at DESC, id DESC LIMIT ")
        .push_bind(limit);
    let rows: Vec<LogRow> = qb.build_query_as().fetch_all(&state.db).await?;
    let items: Vec<Value> = rows
        .into_iter()
        .map(|r| {
            json!({
                "id": r.id, "delivery_id": r.delivery_id, "at": r.created_at, "alert_id": r.alert_id,
                "channel_id": r.channel_id, "channel_name": r.channel_name, "channel_kind": r.channel_kind,
                "rule_id": r.rule_id, "event": r.event, "attempt": r.attempt,
                "status": if r.status == "sending" { "pending".to_string() } else { r.status },
                "http_status": r.http_status, "error": r.error, "next_attempt_at": r.next_attempt_at,
                "finished_at": r.finished_at,
            })
        })
        .collect();
    Ok(Json(json!({ "items": items })))
}
