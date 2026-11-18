//! Phase 6 alerts for SNMP conditions (`source: "snmp"`): threshold breaches, unreachable
//! devices and trap rules. They follow the same lifecycle as agent alerts (dedupe, severity
//! escalation, auto-resolve, reopen after a manual resolve, maintenance, notifications) but name
//! an SNMP device (`snmp_device_id`) instead of an agent device; trap alerts from unknown senders
//! name only the site.

use chrono::{DateTime, Utc};
use serde_json::json;

use crate::monitoring::alerts::{add_event, publish, severity_rank};
use crate::state::AppState;

/// A failing SNMP condition.
#[derive(Debug, Clone)]
pub struct SnmpRaise {
    pub snmp_device_id: Option<String>,
    pub client_id: String,
    pub site_id: String,
    /// `snmp:<metric key>[:<index>]`, `snmp:unreachable` or `snmp:trap:<oid prefix>[:<sender>]`.
    pub check_id: String,
    pub check_type: String,
    pub severity: String,
    pub title: String,
    pub message: String,
    /// A new occurrence, not a repeat report of the same state.
    pub repeat: bool,
}

const SUBJECT: &str = "((? IS NOT NULL AND snmp_device_id = ?) OR (? IS NULL AND snmp_device_id IS NULL AND device_id IS NULL
    AND source = 'snmp' AND site_id = ?))";

async fn open_alert(
    state: &AppState,
    snmp_device_id: Option<&str>,
    site_id: &str,
    check_id: &str,
) -> anyhow::Result<Option<(String, String)>> {
    Ok(sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT id, severity FROM alerts WHERE {SUBJECT} AND check_id = ? AND status <> 'resolved'"
    )))
    .bind(snmp_device_id)
    .bind(snmp_device_id)
    .bind(snmp_device_id)
    .bind(site_id)
    .bind(check_id)
    .fetch_optional(&state.db)
    .await?)
}

/// Records a failing SNMP condition. Returns the alert id (`None` when a maintenance window
/// suppresses new alerts).
pub async fn raise(state: &AppState, r: SnmpRaise) -> anyhow::Result<Option<String>> {
    let now = rustrmm_common::now();
    let title: String = r.title.chars().take(200).collect();
    let message: String = r.message.chars().take(1000).collect();
    let device = r.snmp_device_id.as_deref();
    if let Some((id, severity)) = open_alert(state, device, &r.site_id, &r.check_id).await? {
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
        sqlx::query(
            "UPDATE alerts SET occurrences = occurrences + 1, last_occurrence_at = ?, title = ?, message = ?,
             severity = CASE WHEN ? THEN ? ELSE severity END, updated_at = ? WHERE id = ?",
        )
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
            crate::monitoring::notify::dispatch(state, &id, "severity_changed").await?;
        }
        publish(state, &id, false).await;
        return Ok(Some(id));
    }

    let windows =
        crate::monitoring::maintenance::active_for_place(state, &r.client_id, &r.site_id, now)
            .await?;
    if windows.iter().any(|w| w.suppress == "alerts") {
        return Ok(None);
    }
    let in_maintenance = !windows.is_empty();

    let last: Option<(String, Option<String>, Option<DateTime<Utc>>)> =
        sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "SELECT id, resolution, condition_cleared_at FROM alerts WHERE {SUBJECT} AND check_id = ?
             ORDER BY opened_at DESC, id DESC LIMIT 1"
        )))
        .bind(device)
        .bind(device)
        .bind(device)
        .bind(&r.site_id)
        .bind(&r.check_id)
        .fetch_optional(&state.db)
        .await?;
    let reopened = match last {
        Some((id, Some(resolution), None)) if resolution == "manual" => {
            let done = sqlx::query(
                "UPDATE alerts SET status = 'open', resolved_at = NULL, resolved_by = NULL, resolved_by_name = NULL,
                 resolution = NULL, acknowledged_at = NULL, acknowledged_by = NULL, acknowledged_by_name = NULL,
                 occurrences = occurrences + 1, last_occurrence_at = ?, severity = ?, title = ?, message = ?,
                 in_maintenance = ?, updated_at = ? WHERE id = ? AND status = 'resolved'",
            )
            .bind(now)
            .bind(&r.severity)
            .bind(&title)
            .bind(&message)
            .bind(in_maintenance)
            .bind(now)
            .bind(&id)
            .execute(&state.db)
            .await;
            match done {
                Ok(d) if d.rows_affected() == 1 => {
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
                _ => None,
            }
        }
        _ => None,
    };
    let id = match reopened {
        Some(id) => id,
        None => {
            let id = rustrmm_common::new_id();
            let inserted = sqlx::query(
                "INSERT OR IGNORE INTO alerts (id, device_id, snmp_device_id, client_id, site_id, source, check_id, check_type, severity,
                     title, message, status, opened_at, last_occurrence_at, occurrences, in_maintenance, updated_at)
                 VALUES (?, NULL, ?, ?, ?, 'snmp', ?, ?, ?, ?, ?, 'open', ?, ?, 1, ?, ?)",
            )
            .bind(&id)
            .bind(device)
            .bind(&r.client_id)
            .bind(&r.site_id)
            .bind(&r.check_id)
            .bind(&r.check_type)
            .bind(&r.severity)
            .bind(&title)
            .bind(&message)
            .bind(now)
            .bind(now)
            .bind(in_maintenance)
            .bind(now)
            .execute(&state.db)
            .await?;
            if inserted.rows_affected() == 0 {
                return Box::pin(raise(state, SnmpRaise { repeat: true, ..r })).await;
            }
            add_event(
                &state.db,
                &id,
                "opened",
                None,
                &message,
                json!({ "severity": r.severity, "source": "snmp" }),
            )
            .await?;
            id
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
                "Recorded during maintenance ({}); no notifications",
                names.join(", ")
            ),
            json!({ "windows": windows.iter().map(|w| &w.id).collect::<Vec<_>>() }),
        )
        .await?;
    } else {
        crate::monitoring::notify::dispatch(state, &id, "opened").await?;
    }
    publish(state, &id, true).await;
    crate::tickets::rules::alert_opened(state, &id).await;
    Ok(Some(id))
}

/// The condition cleared: resolves the open alert automatically (or notes that a manually
/// resolved alert's condition is gone, so it will not reopen).
pub async fn clear(
    state: &AppState,
    snmp_device_id: &str,
    site_id: &str,
    check_id: &str,
    message: &str,
) -> anyhow::Result<()> {
    let now = rustrmm_common::now();
    let Some((id, _)) = open_alert(state, Some(snmp_device_id), site_id, check_id).await? else {
        sqlx::query(
            "UPDATE alerts SET condition_cleared_at = ? WHERE snmp_device_id = ? AND check_id = ? AND status = 'resolved'
             AND condition_cleared_at IS NULL",
        )
        .bind(now)
        .bind(snmp_device_id)
        .bind(check_id)
        .execute(&state.db)
        .await?;
        return Ok(());
    };
    sqlx::query(
        "UPDATE alerts SET status = 'resolved', resolution = 'auto', resolved_at = ?, resolved_by = NULL, resolved_by_name = 'System',
         condition_cleared_at = ?, updated_at = ? WHERE id = ?",
    )
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
    crate::monitoring::notify::dispatch(state, &id, "resolved").await?;
    publish(state, &id, false).await;
    crate::tickets::rules::alert_resolved(state, &id).await;
    Ok(())
}
