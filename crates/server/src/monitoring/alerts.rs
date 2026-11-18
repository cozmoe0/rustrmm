//! The alert lifecycle (dedupe, escalation of severity, auto-resolve, reopen, maintenance,
//! remediation) and the alert API.

use std::collections::HashMap;

use axum::Json;
use axum::extract::{Path, Query, State};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{QueryBuilder, Sqlite};

use super::policy::Remediation;
use crate::auth::AuthCtx;
use crate::db::Db;
use crate::error::{ApiError, ApiResult};
use crate::rbac::{AccessScope, ClientFilter, perm};
use crate::state::AppState;

pub fn severity_rank(severity: &str) -> u8 {
    match severity {
        "critical" => 2,
        "warning" => 1,
        _ => 0,
    }
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct AlertRow {
    pub id: String,
    pub device_id: Option<String>,
    pub hostname: Option<String>,
    pub client_id: String,
    pub client_name: String,
    pub site_id: Option<String>,
    pub site_name: Option<String>,
    pub source: String,
    pub check_id: String,
    pub check_type: String,
    pub severity: String,
    pub title: String,
    pub message: String,
    pub status: String,
    pub opened_at: DateTime<Utc>,
    pub last_occurrence_at: DateTime<Utc>,
    pub occurrences: i64,
    pub acknowledged_at: Option<DateTime<Utc>>,
    pub acknowledged_by_name: Option<String>,
    pub resolved_at: Option<DateTime<Utc>>,
    pub resolved_by_name: Option<String>,
    pub resolution: Option<String>,
    pub snoozed_until: Option<DateTime<Utc>>,
    pub assigned_to: Option<String>,
    pub assigned_name: Option<String>,
    pub in_maintenance: bool,
    pub ticket_id: Option<String>,
    pub remediation: Option<String>,
    pub policy_id: Option<String>,
    pub condition_cleared_at: Option<DateTime<Utc>>,
    pub snmp_device_id: Option<String>,
    pub snmp_device_name: Option<String>,
}

pub const ALERT_SELECT: &str = "SELECT a.id, a.device_id, COALESCE(d.hostname, sd.name) AS hostname, a.client_id, c.name AS client_name,
    a.site_id, s.name AS site_name,
    a.source, a.check_id, a.check_type, a.severity, a.title, a.message, a.status, a.opened_at, a.last_occurrence_at, a.occurrences,
    a.acknowledged_at, a.acknowledged_by_name, a.resolved_at, a.resolved_by_name, a.resolution, a.snoozed_until, a.assigned_to,
    u.name AS assigned_name, a.in_maintenance, a.ticket_id, a.remediation, a.policy_id, a.condition_cleared_at,
    a.snmp_device_id, sd.name AS snmp_device_name
    FROM alerts a LEFT JOIN devices d ON d.id = a.device_id JOIN clients c ON c.id = a.client_id
    LEFT JOIN sites s ON s.id = a.site_id LEFT JOIN users u ON u.id = a.assigned_to
    LEFT JOIN snmp_devices sd ON sd.id = a.snmp_device_id";

impl AlertRow {
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id, "device_id": self.device_id, "hostname": self.hostname,
            "client_id": self.client_id, "client_name": self.client_name, "site_id": self.site_id,
            "source": self.source, "check_id": self.check_id, "check_type": self.check_type,
            "severity": self.severity, "title": self.title, "message": self.message, "status": self.status,
            "opened_at": self.opened_at, "last_occurrence_at": self.last_occurrence_at, "occurrences": self.occurrences,
            "acknowledged_at": self.acknowledged_at, "acknowledged_by_name": self.acknowledged_by_name,
            "resolved_at": self.resolved_at, "resolved_by_name": self.resolved_by_name, "resolution": self.resolution,
            "snoozed_until": self.snoozed_until,
            "assigned_to": self.assigned_to.as_ref().map(|id| json!({ "id": id, "name": self.assigned_name })),
            "in_maintenance": self.in_maintenance, "ticket_id": self.ticket_id,
            "remediation": self.remediation.as_deref().and_then(|r| serde_json::from_str::<Value>(r).ok()),
            "snmp_device_id": self.snmp_device_id, "snmp_device_name": self.snmp_device_name,
        })
    }

    pub fn visible(&self, scope: &AccessScope, permission: &str) -> bool {
        match &self.site_id {
            Some(site) => scope.can_site(permission, &self.client_id, site),
            None => scope.can_client(permission, &self.client_id),
        }
    }

    pub fn facts(&self) -> super::notify::rules::AlertFacts<'_> {
        super::notify::rules::AlertFacts {
            client_id: &self.client_id,
            site_id: self.site_id.as_deref(),
            severity: &self.severity,
            source: &self.source,
            check_type: &self.check_type,
            check_id: &self.check_id,
        }
    }
}

pub async fn load(db: &Db, id: &str) -> anyhow::Result<Option<AlertRow>> {
    Ok(sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{ALERT_SELECT} WHERE a.id = ?"
    )))
    .bind(id)
    .fetch_optional(db)
    .await?)
}

/// Appends an alert event.
pub async fn add_event(
    db: &Db,
    alert_id: &str,
    kind: &str,
    actor: Option<(&str, &str)>,
    message: &str,
    details: Value,
) -> anyhow::Result<()> {
    sqlx::query("INSERT INTO alert_events (alert_id, at, kind, actor_id, actor_name, message, details) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(alert_id)
        .bind(rustrmm_common::now())
        .bind(kind)
        .bind(actor.map(|a| a.0))
        .bind(actor.map(|a| a.1).unwrap_or("System"))
        .bind(message.chars().take(1000).collect::<String>())
        .bind(details.to_string())
        .execute(db)
        .await?;
    Ok(())
}

/// Publishes `alert.opened` / `alert.updated`, the throttled `alerts.summary` and
/// `fleet.summary`.
pub async fn publish(state: &AppState, alert_id: &str, opened: bool) {
    let Ok(Some(alert)) = load(&state.db, alert_id).await else {
        return;
    };
    state.events.publish(
        if opened {
            "alert.opened"
        } else {
            "alert.updated"
        },
        Some(alert.client_id.clone()),
        json!({ "alert": alert.to_json() }),
    );
    super::publish_summary(state, &alert.client_id);
    state
        .events
        .publish("fleet.summary", Some(alert.client_id.clone()), Value::Null);
}

// ------------------------------------------------------------------ engine

/// A failing condition reported by a check or a server-side check.
#[derive(Debug, Clone)]
pub struct Raise {
    pub device_id: String,
    /// `check` | `server`
    pub source: &'static str,
    pub check_id: String,
    pub check_type: String,
    pub severity: String,
    pub title: String,
    pub message: String,
    pub policy_id: Option<String>,
    pub remediation: Option<Remediation>,
    /// A new occurrence (a state transition), not a repeat report of the same state.
    pub repeat: bool,
}

#[derive(sqlx::FromRow)]
struct DevicePlace {
    client_id: String,
    site_id: String,
}

/// Records a failing condition: bumps the open alert, reopens a manually resolved one whose
/// condition never cleared, or opens a new alert. Returns the alert id (`None` when a
/// maintenance window suppresses new alerts).
pub async fn raise(state: &AppState, r: Raise) -> anyhow::Result<Option<String>> {
    let now = rustrmm_common::now();
    let title: String = r.title.chars().take(200).collect();
    let message: String = r.message.chars().take(1000).collect();
    let open: Option<(String, String, String)> = sqlx::query_as(
        "SELECT id, severity, status FROM alerts WHERE device_id = ? AND check_id = ? AND status <> 'resolved'",
    )
    .bind(&r.device_id)
    .bind(&r.check_id)
    .fetch_optional(&state.db)
    .await?;
    if let Some((id, severity, _status)) = open {
        let escalate = severity_rank(&r.severity) > severity_rank(&severity);
        if !r.repeat && !escalate {
            sqlx::query("UPDATE alerts SET message = ?, updated_at = ? WHERE id = ?")
                .bind(&message)
                .bind(now)
                .bind(&id)
                .execute(&state.db)
                .await?;
            return Ok(Some(id));
        }
        sqlx::query("UPDATE alerts SET occurrences = occurrences + 1, last_occurrence_at = ?, title = ?, message = ?,
                     severity = CASE WHEN ? THEN ? ELSE severity END, updated_at = ? WHERE id = ?")
            .bind(now)
            .bind(&title)
            .bind(&message)
            .bind(escalate)
            .bind(&r.severity)
            .bind(now)
            .bind(&id)
            .execute(&state.db)
            .await?;
        add_event(
            &state.db,
            &id,
            "occurred",
            None,
            &message,
            json!({ "severity": r.severity }),
        )
        .await?;
        if escalate {
            add_event(
                &state.db,
                &id,
                "severity_changed",
                None,
                &format!("Severity raised from {severity} to {}", r.severity),
                json!({ "from": severity, "to": r.severity }),
            )
            .await?;
            super::notify::dispatch(state, &id, "severity_changed").await?;
        }
        publish(state, &id, false).await;
        return Ok(Some(id));
    }

    let Some(place): Option<DevicePlace> = sqlx::query_as(
        "SELECT s.client_id, d.site_id FROM devices d JOIN sites s ON s.id = d.site_id WHERE d.id = ?",
    )
    .bind(&r.device_id)
    .fetch_optional(&state.db)
    .await?
    else {
        return Ok(None);
    };
    let windows = super::maintenance::active_for_device(state, &r.device_id, now).await?;
    if let Some(w) = windows.iter().find(|w| w.suppress == "alerts") {
        tracing::debug!(device = %r.device_id, check = %r.check_id, window = %w.name, "maintenance window suppresses new alerts");
        return Ok(None);
    }
    let in_maintenance = !windows.is_empty();

    // Reopen a manually resolved alert whose condition never cleared.
    let last: Option<(String, Option<String>, Option<DateTime<Utc>>)> = sqlx::query_as(
        "SELECT id, resolution, condition_cleared_at FROM alerts WHERE device_id = ? AND check_id = ?
         ORDER BY opened_at DESC, id DESC LIMIT 1",
    )
    .bind(&r.device_id)
    .bind(&r.check_id)
    .fetch_optional(&state.db)
    .await?;
    let id = match last {
        Some((id, Some(resolution), None)) if resolution == "manual" => {
            let reopened = sqlx::query("UPDATE alerts SET status = 'open', resolved_at = NULL, resolved_by = NULL, resolved_by_name = NULL,
                         resolution = NULL, acknowledged_at = NULL, acknowledged_by = NULL, acknowledged_by_name = NULL,
                         occurrences = occurrences + 1, last_occurrence_at = ?, severity = ?, title = ?, message = ?,
                         in_maintenance = ?, updated_at = ? WHERE id = ? AND status = 'resolved'")
                .bind(now)
                .bind(&r.severity)
                .bind(&title)
                .bind(&message)
                .bind(in_maintenance)
                .bind(now)
                .bind(&id)
                .execute(&state.db)
                .await;
            match reopened {
                Ok(done) if done.rows_affected() == 1 => {
                    sqlx::query("DELETE FROM notification_escalations WHERE alert_id = ?")
                        .bind(&id)
                        .execute(&state.db)
                        .await?;
                    add_event(
                        &state.db,
                        &id,
                        "reopened",
                        None,
                        "The condition is still present after a manual resolve",
                        json!({ "severity": r.severity }),
                    )
                    .await?;
                    Some(id)
                }
                // Another alert opened meanwhile (the unique index refused the update).
                _ => None,
            }
        }
        _ => None,
    };
    let (id, opened) = match id {
        Some(id) => (id, false),
        None => {
            let id = rustrmm_common::new_id();
            let inserted = sqlx::query("INSERT OR IGNORE INTO alerts (id, device_id, client_id, site_id, source, check_id, check_type, severity, title, message,
                         status, opened_at, last_occurrence_at, occurrences, in_maintenance, policy_id, updated_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, 1, ?, ?, ?)")
                .bind(&id)
                .bind(&r.device_id)
                .bind(&place.client_id)
                .bind(&place.site_id)
                .bind(r.source)
                .bind(&r.check_id)
                .bind(&r.check_type)
                .bind(&r.severity)
                .bind(&title)
                .bind(&message)
                .bind(now)
                .bind(now)
                .bind(in_maintenance)
                .bind(&r.policy_id)
                .bind(now)
                .execute(&state.db)
                .await?;
            if inserted.rows_affected() == 0 {
                // Raced with another writer: treat as a repeat of the open alert.
                return Box::pin(raise(state, Raise { repeat: true, ..r })).await;
            }
            add_event(
                &state.db,
                &id,
                "opened",
                None,
                &message,
                json!({ "severity": r.severity, "source": r.source }),
            )
            .await?;
            (id, true)
        }
    };
    if in_maintenance {
        let names: Vec<&str> = windows.iter().map(|w| w.name.as_str()).collect();
        add_event(
            &state.db,
            &id,
            "maintenance",
            None,
            &format!(
                "Recorded during maintenance ({}); no notifications or remediation",
                names.join(", ")
            ),
            json!({ "windows": windows.iter().map(|w| &w.id).collect::<Vec<_>>() }),
        )
        .await?;
    } else {
        super::notify::dispatch(state, &id, "opened").await?;
        if let Some(remediation) = &r.remediation
            && r.source == "check"
            && let Err(e) = super::remediation::start(state, &id, &r.device_id, remediation).await
        {
            tracing::warn!(alert = %id, error = %format!("{e:#}"), "remediation could not start");
            add_event(
                &state.db,
                &id,
                "remediation_finished",
                None,
                &format!("Remediation could not start: {e:#}"),
                json!({ "status": "failed" }),
            )
            .await?;
        }
    }
    let _ = crate::agents::timeline(
        &state.db,
        &r.device_id,
        "alert.opened",
        if r.severity == "critical" {
            "critical"
        } else if r.severity == "warning" {
            "warning"
        } else {
            "info"
        },
        &title,
        json!({ "alert_id": id, "check_id": r.check_id, "reopened": !opened }),
    )
    .await;
    publish(state, &id, true).await;
    crate::tickets::rules::alert_opened(state, &id).await;
    Ok(Some(id))
}

/// The condition cleared: resolves the open alert automatically (or notes that a manually
/// resolved alert's condition is gone, so it will not reopen).
pub async fn clear(
    state: &AppState,
    device_id: &str,
    check_id: &str,
    message: &str,
) -> anyhow::Result<()> {
    let now = rustrmm_common::now();
    let open: Option<String> = sqlx::query_scalar(
        "SELECT id FROM alerts WHERE device_id = ? AND check_id = ? AND status <> 'resolved'",
    )
    .bind(device_id)
    .bind(check_id)
    .fetch_optional(&state.db)
    .await?;
    let Some(id) = open else {
        sqlx::query("UPDATE alerts SET condition_cleared_at = ? WHERE device_id = ? AND check_id = ? AND status = 'resolved'
                     AND condition_cleared_at IS NULL")
            .bind(now)
            .bind(device_id)
            .bind(check_id)
            .execute(&state.db)
            .await?;
        return Ok(());
    };
    sqlx::query("UPDATE alerts SET status = 'resolved', resolution = 'auto', resolved_at = ?, resolved_by = NULL, resolved_by_name = 'System',
                 condition_cleared_at = ?, updated_at = ? WHERE id = ?")
        .bind(now)
        .bind(now)
        .bind(now)
        .bind(&id)
        .execute(&state.db)
        .await?;
    add_event(
        &state.db,
        &id,
        "resolved",
        None,
        message,
        json!({ "resolution": "auto" }),
    )
    .await?;
    super::notify::dispatch(state, &id, "resolved").await?;
    publish(state, &id, false).await;
    crate::tickets::rules::alert_resolved(state, &id).await;
    Ok(())
}

// ------------------------------------------------------------------ API helpers

fn client_scope(qb: &mut QueryBuilder<Sqlite>, scope: &AccessScope, permission: &str) {
    if scope.has_global(permission) {
        return;
    }
    let clients = match scope.client_level(permission) {
        ClientFilter::All => return,
        ClientFilter::Only(c) => c,
    };
    let sites = scope.sites_with(permission);
    qb.push(" AND (a.client_id IN (");
    {
        let mut sep = qb.separated(", ");
        sep.push_bind("");
        for c in clients {
            sep.push_bind(c);
        }
    }
    qb.push(") OR a.site_id IN (");
    {
        let mut sep = qb.separated(", ");
        sep.push_bind("");
        for s in sites {
            sep.push_bind(s);
        }
    }
    qb.push("))");
}

#[derive(Debug, Default, Deserialize)]
pub struct ListQuery {
    status: Option<String>,
    severity: Option<String>,
    client_id: Option<String>,
    site_id: Option<String>,
    device_id: Option<String>,
    source: Option<String>,
    check_type: Option<String>,
    assigned: Option<String>,
    q: Option<String>,
    cursor: Option<String>,
    limit: Option<i64>,
}

fn csv(v: &Option<String>) -> Vec<String> {
    v.as_deref()
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn push_in(qb: &mut QueryBuilder<Sqlite>, column: &str, values: &[String]) {
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

/// Filters shared by the list and its counts (everything but status and severity).
fn push_filters(qb: &mut QueryBuilder<Sqlite>, ctx: &AuthCtx, q: &ListQuery) {
    client_scope(qb, &ctx.scope, perm::ALERTS_VIEW);
    push_in(qb, "a.client_id", &csv(&q.client_id));
    push_in(qb, "a.site_id", &csv(&q.site_id));
    push_in(qb, "a.device_id", &csv(&q.device_id));
    push_in(qb, "a.source", &csv(&q.source));
    push_in(qb, "a.check_type", &csv(&q.check_type));
    match q.assigned.as_deref() {
        None | Some("") => {}
        Some("me") => {
            qb.push(" AND a.assigned_to = ")
                .push_bind(ctx.user.id.clone());
        }
        Some("none") => {
            qb.push(" AND a.assigned_to IS NULL");
        }
        Some(user) => {
            qb.push(" AND a.assigned_to = ").push_bind(user.to_string());
        }
    }
    if let Some(text) = q.q.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        let like = format!(
            "%{}%",
            text.replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        );
        qb.push(" AND (a.title LIKE ")
            .push_bind(like.clone())
            .push(" ESCAPE '\\' OR a.message LIKE ")
            .push_bind(like.clone())
            .push(" ESCAPE '\\' OR COALESCE(d.hostname, sd.name) LIKE ")
            .push_bind(like.clone())
            .push(" ESCAPE '\\' OR a.check_id LIKE ")
            .push_bind(like)
            .push(" ESCAPE '\\')");
    }
}

async fn list_alerts(state: &AppState, ctx: &AuthCtx, q: &ListQuery) -> ApiResult<Value> {
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let offset: i64 = q
        .cursor
        .as_deref()
        .and_then(|c| c.parse().ok())
        .unwrap_or(0)
        .max(0);
    let statuses = {
        let s = csv(&q.status);
        if s.is_empty() {
            vec!["open".to_string(), "acknowledged".to_string()]
        } else if s.iter().any(|x| x == "all") {
            Vec::new()
        } else {
            s
        }
    };
    let mut qb = QueryBuilder::<Sqlite>::new(format!("{ALERT_SELECT} WHERE 1 = 1"));
    push_filters(&mut qb, ctx, q);
    push_in(&mut qb, "a.status", &statuses);
    push_in(&mut qb, "a.severity", &csv(&q.severity));
    qb.push(
        " ORDER BY CASE a.status WHEN 'resolved' THEN 1 ELSE 0 END,
          CASE a.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
          a.last_occurrence_at DESC, a.id DESC LIMIT ",
    )
    .push_bind(limit + 1)
    .push(" OFFSET ")
    .push_bind(offset);
    let mut rows: Vec<AlertRow> = qb.build_query_as().fetch_all(&state.db).await?;
    let next_cursor = (rows.len() as i64 > limit).then(|| (offset + limit).to_string());
    rows.truncate(limit as usize);

    let mut cq = QueryBuilder::<Sqlite>::new(
        "SELECT COALESCE(SUM(a.status = 'open'), 0), COALESCE(SUM(a.status = 'acknowledged'), 0),
                COALESCE(SUM(a.severity = 'critical'), 0), COALESCE(SUM(a.severity = 'warning'), 0),
                COALESCE(SUM(a.severity = 'info'), 0)
         FROM alerts a LEFT JOIN devices d ON d.id = a.device_id LEFT JOIN snmp_devices sd ON sd.id = a.snmp_device_id
         WHERE a.status <> 'resolved'",
    );
    push_filters(&mut cq, ctx, q);
    let (open, acknowledged, critical, warning, info): (i64, i64, i64, i64, i64) =
        cq.build_query_as().fetch_one(&state.db).await?;
    Ok(json!({
        "items": rows.iter().map(AlertRow::to_json).collect::<Vec<_>>(),
        "next_cursor": next_cursor,
        "counts": { "open": open, "acknowledged": acknowledged, "critical": critical, "warning": warning, "info": info },
    }))
}

/// `GET /api/v1/alerts`
#[utoipa::path(get, path = "/api/v1/alerts", tag = "Alerts", summary = "List alerts", responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn list(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::ALERTS_VIEW)?;
    Ok(Json(list_alerts(&state, &ctx, &q).await?))
}

#[derive(Deserialize)]
pub struct DeviceAlertsQuery {
    status: Option<String>,
    cursor: Option<String>,
    limit: Option<i64>,
}

/// `GET /api/v1/devices/{id}/alerts`
#[utoipa::path(get, path = "/api/v1/devices/{id}/alerts", tag = "Alerts", summary = "Device alerts", params(("id" = String, Path)), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn device_alerts(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Query(dq): Query<DeviceAlertsQuery>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::ALERTS_VIEW)?;
    super::device_scope(&state, &ctx, &id, perm::ALERTS_VIEW).await?;
    let q = ListQuery {
        status: dq.status,
        device_id: Some(id),
        cursor: dq.cursor,
        limit: dq.limit,
        ..ListQuery::default()
    };
    Ok(Json(list_alerts(&state, &ctx, &q).await?))
}

/// Non-resolved alert counts in the caller's scope.
pub async fn summary_counts(state: &AppState, ctx: &AuthCtx) -> anyhow::Result<Value> {
    let mut qb = QueryBuilder::<Sqlite>::new(
        "SELECT a.client_id, c.name, a.status, a.severity, COUNT(*) FROM alerts a JOIN clients c ON c.id = a.client_id
         WHERE a.status <> 'resolved'",
    );
    client_scope(&mut qb, &ctx.scope, perm::ALERTS_VIEW);
    qb.push(" GROUP BY a.client_id, c.name, a.status, a.severity");
    let rows: Vec<(String, String, String, String, i64)> =
        qb.build_query_as().fetch_all(&state.db).await?;
    let (mut open, mut acknowledged, mut critical, mut warning, mut info) = (0, 0, 0, 0, 0);
    let mut by_client: HashMap<String, (String, i64, i64)> = HashMap::new();
    for (client_id, name, status, severity, n) in rows {
        if status == "open" {
            open += n;
        } else {
            acknowledged += n;
        }
        let entry = by_client.entry(client_id).or_insert((name, 0, 0));
        match severity.as_str() {
            "critical" => {
                critical += n;
                entry.1 += n;
            }
            "warning" => {
                warning += n;
                entry.2 += n;
            }
            _ => info += n,
        }
    }
    let mut clients: Vec<Value> = by_client
        .into_iter()
        .filter(|(_, (_, c, w))| c + w > 0)
        .map(|(id, (name, c, w))| json!({ "client_id": id, "client_name": name, "critical": c, "warning": w }))
        .collect();
    clients.sort_by(|a, b| {
        b["critical"]
            .as_i64()
            .cmp(&a["critical"].as_i64())
            .then(b["warning"].as_i64().cmp(&a["warning"].as_i64()))
    });
    Ok(
        json!({ "open": open, "acknowledged": acknowledged, "critical": critical, "warning": warning, "info": info,
               "by_client": clients }),
    )
}

/// `GET /api/v1/alerts/summary`
#[utoipa::path(get, path = "/api/v1/alerts/summary", tag = "Alerts", summary = "Summary", responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn summary(State(state): State<AppState>, ctx: AuthCtx) -> ApiResult<Json<Value>> {
    ctx.require(perm::ALERTS_VIEW)?;
    Ok(Json(summary_counts(&state, &ctx).await?))
}

async fn visible_alert(
    state: &AppState,
    ctx: &AuthCtx,
    id: &str,
    permission: &str,
) -> ApiResult<AlertRow> {
    let alert = load(&state.db, id)
        .await?
        .filter(|a| a.visible(&ctx.scope, perm::ALERTS_VIEW))
        .ok_or_else(|| ApiError::not_found("Alert"))?;
    if !alert.visible(&ctx.scope, permission) {
        return Err(
            ApiError::forbidden(format!("Missing permission: {permission}"))
                .with_details(json!({ "permission": permission })),
        );
    }
    Ok(alert)
}

#[derive(sqlx::FromRow, Serialize)]
struct EventRow {
    id: i64,
    at: DateTime<Utc>,
    kind: String,
    actor_name: Option<String>,
    message: String,
    details: String,
}

/// `GET /api/v1/alerts/{id}`
#[utoipa::path(get, path = "/api/v1/alerts/{id}", tag = "Alerts", summary = "Get alert", params(("id" = String, Path)), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn get(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::ALERTS_VIEW)?;
    let alert = visible_alert(&state, &ctx, &id, perm::ALERTS_VIEW).await?;
    let events: Vec<EventRow> = sqlx::query_as(
        "SELECT id, at, kind, actor_name, message, details FROM alert_events WHERE alert_id = ? ORDER BY id DESC LIMIT 500",
    )
    .bind(&id)
    .fetch_all(&state.db)
    .await?;
    let events: Vec<Value> = events
        .into_iter()
        .map(|e| {
            json!({ "id": e.id, "at": e.at, "kind": e.kind, "actor_name": e.actor_name, "message": e.message,
                    "details": serde_json::from_str::<Value>(&e.details).unwrap_or(Value::Null) })
        })
        .collect();
    let check = match (&alert.device_id, alert.source.as_str()) {
        (Some(device), "check") => {
            super::ingest::check_state(&state, device, &alert.check_id).await?
        }
        _ => None,
    };
    Ok(Json(
        json!({ "alert": alert.to_json(), "events": events, "check": check }),
    ))
}

#[derive(Default, Deserialize)]
pub struct NoteBody {
    #[serde(default)]
    note: Option<String>,
}

fn note_of(body: &NoteBody) -> ApiResult<Option<String>> {
    let note = body
        .note
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty());
    if note.is_some_and(|n| n.chars().count() > 2000) {
        return Err(ApiError::validation("note is at most 2000 characters"));
    }
    Ok(note.map(str::to_string))
}

/// One alert action, shared by the single routes and `POST /alerts/bulk`. Returns false when
/// the action does not apply to the alert's current status.
async fn apply(
    state: &AppState,
    ctx: &AuthCtx,
    alert: &AlertRow,
    action: &Action,
) -> ApiResult<bool> {
    let now = rustrmm_common::now();
    let actor = (ctx.user.id.as_str(), ctx.user.name.as_str());
    match action {
        Action::Acknowledge(note) => {
            if alert.status != "open" {
                return Ok(false);
            }
            sqlx::query("UPDATE alerts SET status = 'acknowledged', acknowledged_at = ?, acknowledged_by = ?, acknowledged_by_name = ?, updated_at = ? WHERE id = ? AND status = 'open'")
                .bind(now).bind(&ctx.user.id).bind(&ctx.user.name).bind(now).bind(&alert.id)
                .execute(&state.db).await?;
            add_event(
                &state.db,
                &alert.id,
                "acknowledged",
                Some(actor),
                note.as_deref().unwrap_or("Acknowledged"),
                json!({ "note": note }),
            )
            .await?;
        }
        Action::Unacknowledge => {
            if alert.status != "acknowledged" {
                return Ok(false);
            }
            sqlx::query("UPDATE alerts SET status = 'open', acknowledged_at = NULL, acknowledged_by = NULL, acknowledged_by_name = NULL, updated_at = ? WHERE id = ? AND status = 'acknowledged'")
                .bind(now).bind(&alert.id)
                .execute(&state.db).await?;
            add_event(
                &state.db,
                &alert.id,
                "unacknowledged",
                Some(actor),
                "Acknowledgement removed",
                json!({}),
            )
            .await?;
        }
        Action::Resolve(note) => {
            if alert.status == "resolved" {
                return Ok(false);
            }
            sqlx::query("UPDATE alerts SET status = 'resolved', resolution = 'manual', resolved_at = ?, resolved_by = ?, resolved_by_name = ?,
                         condition_cleared_at = NULL, updated_at = ? WHERE id = ? AND status <> 'resolved'")
                .bind(now).bind(&ctx.user.id).bind(&ctx.user.name).bind(now).bind(&alert.id)
                .execute(&state.db).await?;
            add_event(
                &state.db,
                &alert.id,
                "resolved",
                Some(actor),
                note.as_deref().unwrap_or("Resolved manually"),
                json!({ "resolution": "manual", "note": note }),
            )
            .await?;
            super::notify::dispatch(state, &alert.id, "resolved").await?;
            crate::tickets::rules::alert_resolved(state, &alert.id).await;
        }
        Action::Snooze(until) => {
            if alert.status == "resolved" {
                return Ok(false);
            }
            sqlx::query("UPDATE alerts SET snoozed_until = ?, updated_at = ? WHERE id = ?")
                .bind(until)
                .bind(now)
                .bind(&alert.id)
                .execute(&state.db)
                .await?;
            add_event(
                &state.db,
                &alert.id,
                "snoozed",
                Some(actor),
                &format!(
                    "Notifications snoozed until {}",
                    until.format("%Y-%m-%d %H:%M UTC")
                ),
                json!({ "until": until }),
            )
            .await?;
        }
        Action::Assign(user) => {
            let name: Option<String> = match user {
                Some(uid) => Some(
                    sqlx::query_scalar("SELECT name FROM users WHERE id = ? AND status = 'active'")
                        .bind(uid)
                        .fetch_optional(&state.db)
                        .await?
                        .ok_or_else(|| ApiError::validation("Unknown or inactive user"))?,
                ),
                None => None,
            };
            sqlx::query("UPDATE alerts SET assigned_to = ?, updated_at = ? WHERE id = ?")
                .bind(user)
                .bind(now)
                .bind(&alert.id)
                .execute(&state.db)
                .await?;
            let message = match &name {
                Some(n) => format!("Assigned to {n}"),
                None => "Unassigned".to_string(),
            };
            add_event(
                &state.db,
                &alert.id,
                "assigned",
                Some(actor),
                &message,
                json!({ "user_id": user, "user_name": name }),
            )
            .await?;
        }
        Action::Note(text) => {
            add_event(&state.db, &alert.id, "note", Some(actor), text, json!({})).await?;
        }
    }
    publish(state, &alert.id, false).await;
    Ok(true)
}

enum Action {
    Acknowledge(Option<String>),
    Unacknowledge,
    Resolve(Option<String>),
    Snooze(DateTime<Utc>),
    Assign(Option<String>),
    Note(String),
}

impl Action {
    fn audit_name(&self) -> &'static str {
        match self {
            Self::Acknowledge(_) => "alerts.acknowledged",
            Self::Unacknowledge => "alerts.unacknowledged",
            Self::Resolve(_) => "alerts.resolved",
            Self::Snooze(_) => "alerts.snoozed",
            Self::Assign(_) => "alerts.assigned",
            Self::Note(_) => "alerts.note_added",
        }
    }

    fn details(&self) -> Value {
        match self {
            Self::Acknowledge(n) | Self::Resolve(n) => json!({ "note": n }),
            Self::Unacknowledge => json!({}),
            Self::Snooze(until) => json!({ "until": until }),
            Self::Assign(u) => json!({ "user_id": u }),
            Self::Note(t) => json!({ "note": t }),
        }
    }
}

async fn single(
    state: AppState,
    ctx: AuthCtx,
    id: String,
    action: Action,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::ALERTS_MANAGE)?;
    let alert = visible_alert(&state, &ctx, &id, perm::ALERTS_MANAGE).await?;
    if !apply(&state, &ctx, &alert, &action).await? {
        return Err(ApiError::conflict(
            "invalid_status",
            format!("The alert is {}", alert.status),
        ));
    }
    let mut entry = ctx
        .audit(action.audit_name())
        .target("alert", &alert.id, &alert.title)
        .client(&alert.client_id)
        .details(action.details());
    if let Some(site) = &alert.site_id {
        entry = entry.site(site);
    }
    state.audit.record_or_log(&state.db, entry).await;
    let alert = load(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("Alert"))?;
    Ok(Json(json!({ "alert": alert.to_json() })))
}

/// `POST /api/v1/alerts/{id}/acknowledge`
#[utoipa::path(post, path = "/api/v1/alerts/{id}/acknowledge", tag = "Alerts", summary = "Acknowledge", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn acknowledge(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    body: Option<Json<NoteBody>>,
) -> ApiResult<Json<Value>> {
    let note = note_of(&body.map(|b| b.0).unwrap_or_default())?;
    single(state, ctx, id, Action::Acknowledge(note)).await
}

/// `POST /api/v1/alerts/{id}/unacknowledge`
#[utoipa::path(post, path = "/api/v1/alerts/{id}/unacknowledge", tag = "Alerts", summary = "Unacknowledge", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn unacknowledge(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    single(state, ctx, id, Action::Unacknowledge).await
}

/// `POST /api/v1/alerts/{id}/resolve`
#[utoipa::path(post, path = "/api/v1/alerts/{id}/resolve", tag = "Alerts", summary = "Resolve", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn resolve(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    body: Option<Json<NoteBody>>,
) -> ApiResult<Json<Value>> {
    let note = note_of(&body.map(|b| b.0).unwrap_or_default())?;
    single(state, ctx, id, Action::Resolve(note)).await
}

#[derive(Deserialize)]
pub struct SnoozeBody {
    #[serde(default)]
    minutes: Option<i64>,
    #[serde(default)]
    until: Option<DateTime<Utc>>,
}

fn snooze_until(minutes: Option<i64>, until: Option<DateTime<Utc>>) -> ApiResult<DateTime<Utc>> {
    let now = rustrmm_common::now();
    let until = match (minutes, until) {
        (Some(m), _) => {
            if !(15..=10_080).contains(&m) {
                return Err(ApiError::validation("minutes must be between 15 and 10080"));
            }
            now + chrono::Duration::minutes(m)
        }
        (None, Some(u)) => u,
        (None, None) => return Err(ApiError::validation("Give minutes or until")),
    };
    if until <= now || until > now + chrono::Duration::days(7) + chrono::Duration::minutes(1) {
        return Err(ApiError::validation("until must be in the next 7 days"));
    }
    Ok(until)
}

/// `POST /api/v1/alerts/{id}/snooze`
#[utoipa::path(post, path = "/api/v1/alerts/{id}/snooze", tag = "Alerts", summary = "Snooze", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn snooze(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(body): Json<SnoozeBody>,
) -> ApiResult<Json<Value>> {
    // Authorise before looking at the input (the per-alert scope check follows in `single`).
    ctx.require(perm::ALERTS_MANAGE)?;
    let until = snooze_until(body.minutes, body.until)?;
    single(state, ctx, id, Action::Snooze(until)).await
}

#[derive(Deserialize)]
pub struct AssignBody {
    #[serde(default)]
    user_id: Option<String>,
}

/// `POST /api/v1/alerts/{id}/assign`
#[utoipa::path(post, path = "/api/v1/alerts/{id}/assign", tag = "Alerts", summary = "Assign", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn assign(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(body): Json<AssignBody>,
) -> ApiResult<Json<Value>> {
    single(
        state,
        ctx,
        id,
        Action::Assign(body.user_id.filter(|u| !u.is_empty())),
    )
    .await
}

#[derive(Deserialize)]
pub struct TextBody {
    text: String,
}

/// `POST /api/v1/alerts/{id}/notes`
#[utoipa::path(post, path = "/api/v1/alerts/{id}/notes", tag = "Alerts", summary = "Add note", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn add_note(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(body): Json<TextBody>,
) -> ApiResult<Json<Value>> {
    let text = body.text.trim().to_string();
    if text.is_empty() || text.chars().count() > 2000 {
        return Err(ApiError::validation("text must be 1–2000 characters"));
    }
    single(state, ctx, id, Action::Note(text)).await
}

#[derive(Deserialize)]
pub struct BulkBody {
    ids: Vec<String>,
    action: String,
    #[serde(default)]
    minutes: Option<i64>,
    #[serde(default)]
    until: Option<DateTime<Utc>>,
    #[serde(default)]
    user_id: Option<String>,
    #[serde(default)]
    note: Option<String>,
}

/// `POST /api/v1/alerts/bulk`
#[utoipa::path(post, path = "/api/v1/alerts/bulk", tag = "Alerts", summary = "Bulk", request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn bulk(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Json(body): Json<BulkBody>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::ALERTS_MANAGE)?;
    if body.ids.is_empty() || body.ids.len() > 500 {
        return Err(ApiError::validation("ids must hold 1–500 alert ids"));
    }
    let note = note_of(&NoteBody {
        note: body.note.clone(),
    })?;
    let action = match body.action.as_str() {
        "acknowledge" => Action::Acknowledge(note),
        "resolve" => Action::Resolve(note),
        "snooze" => Action::Snooze(snooze_until(body.minutes, body.until)?),
        "assign" => Action::Assign(body.user_id.clone().filter(|u| !u.is_empty())),
        _ => {
            return Err(ApiError::validation(
                "action must be acknowledge, resolve, snooze or assign",
            ));
        }
    };
    let mut ids = body.ids.clone();
    ids.sort();
    ids.dedup();
    let (mut updated, mut skipped) = (Vec::new(), Vec::new());
    for id in &ids {
        let alert = match load(&state.db, id).await? {
            Some(a) if a.visible(&ctx.scope, perm::ALERTS_MANAGE) => a,
            _ => {
                skipped.push(id.clone());
                continue;
            }
        };
        if apply(&state, &ctx, &alert, &action).await? {
            updated.push(id.clone());
        } else {
            skipped.push(id.clone());
        }
    }
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("alerts.bulk").details(json!({
                "action": body.action, "updated": updated, "skipped": skipped, "details": action.details(),
            })),
        )
        .await;
    Ok(Json(
        json!({ "updated": updated.len(), "skipped": skipped.len(), "updated_ids": updated, "skipped_ids": skipped }),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn severities_rank() {
        assert!(severity_rank("critical") > severity_rank("warning"));
        assert!(severity_rank("warning") > severity_rank("info"));
        assert_eq!(severity_rank("nonsense"), 0);
    }

    #[test]
    fn snooze_bounds() {
        assert!(snooze_until(Some(10), None).is_err());
        assert!(snooze_until(Some(15), None).is_ok());
        assert!(snooze_until(Some(10_081), None).is_err());
        assert!(
            snooze_until(
                None,
                Some(rustrmm_common::now() - chrono::Duration::minutes(1))
            )
            .is_err()
        );
        assert!(
            snooze_until(
                None,
                Some(rustrmm_common::now() + chrono::Duration::hours(2))
            )
            .is_ok()
        );
        assert!(snooze_until(None, None).is_err());
    }
}
