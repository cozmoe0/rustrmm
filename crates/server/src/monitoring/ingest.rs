//! Check results from agents: stores check states and drives the alert lifecycle.

use axum::Json;
use axum::extract::{Path, State};
use chrono::{DateTime, Utc};
use rustrmm_proto::monitoring::{CheckResults, CheckState};
use serde_json::{Value, json};

use super::alerts::{self, Raise};
use super::catalog;
use crate::agents::DeviceRecord;
use crate::auth::AuthCtx;
use crate::error::ApiResult;
use crate::rbac::perm;
use crate::state::AppState;

const MAX_RESULTS: usize = 500;

#[derive(sqlx::FromRow)]
struct Prev {
    state: String,
    since: DateTime<Utc>,
    last_ok_at: Option<DateTime<Utc>>,
}

/// Handles a `check_results` message.
pub async fn on_results(
    state: &AppState,
    device: &DeviceRecord,
    results: CheckResults,
) -> anyhow::Result<()> {
    let Some(monitoring) = super::policy::cached_device(state, &device.id).await? else {
        return Ok(());
    };
    let settings = super::settings::load(state).await?;
    let threshold = settings.unknown_threshold.max(1) as u32;
    let now = rustrmm_common::now();
    for r in results.results.iter().take(MAX_RESULTS) {
        let Some(spec) = monitoring.check(&r.check_id) else {
            tracing::debug!(device = %device.id, check = %r.check_id, "result for a check that is not configured");
            continue;
        };
        let at = DateTime::<Utc>::from_timestamp_millis(r.at)
            .unwrap_or(now)
            .clamp(now - chrono::Duration::days(7), now);
        let message: String = r.message.chars().take(500).collect();
        let value = r.value.filter(|v| v.is_finite());
        let prev: Option<Prev> = sqlx::query_as(
            "SELECT state, since, last_ok_at FROM check_states WHERE device_id = ? AND check_id = ?",
        )
        .bind(&device.id)
        .bind(&r.check_id)
        .fetch_optional(&state.db)
        .await?;
        let changed = prev.as_ref().is_none_or(|p| p.state != r.state.as_str());
        let since = match &prev {
            Some(p) if !changed => p.since,
            _ => at,
        };
        let last_ok_at = if r.state == CheckState::Ok {
            Some(at)
        } else {
            prev.as_ref().and_then(|p| p.last_ok_at)
        };
        sqlx::query(
            "INSERT INTO check_states (device_id, check_id, type, name, state, message, value, since, last_at, streak, last_ok_at, interval_secs, policy_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (device_id, check_id) DO UPDATE SET type = excluded.type, name = excluded.name, state = excluded.state,
               message = excluded.message, value = excluded.value, since = excluded.since, last_at = excluded.last_at,
               streak = excluded.streak, last_ok_at = excluded.last_ok_at, interval_secs = excluded.interval_secs,
               policy_id = excluded.policy_id",
        )
        .bind(&device.id)
        .bind(&r.check_id)
        .bind(&spec.kind)
        .bind(&spec.name)
        .bind(r.state.as_str())
        .bind(&message)
        .bind(value)
        .bind(since)
        .bind(at)
        .bind(i64::from(r.streak.max(1)))
        .bind(last_ok_at)
        .bind(i64::from(spec.interval_secs))
        .bind(&spec.policy_id)
        .execute(&state.db)
        .await?;

        match r.state {
            CheckState::Ok => {
                alerts::clear(
                    state,
                    &device.id,
                    &r.check_id,
                    &format!("{} recovered: {message}", spec.name),
                )
                .await?;
            }
            CheckState::Warning | CheckState::Critical => {
                let severity =
                    catalog::alert_severity(&spec.kind, r.state.as_str(), &spec.severity);
                let title = if message.is_empty() {
                    spec.name.clone()
                } else {
                    format!("{}: {message}", spec.name)
                };
                alerts::raise(
                    state,
                    Raise {
                        device_id: device.id.clone(),
                        source: "check",
                        check_id: r.check_id.clone(),
                        check_type: spec.kind.clone(),
                        severity: severity.to_string(),
                        title,
                        message: message.clone(),
                        policy_id: spec.policy_id.clone(),
                        remediation: spec.remediation.clone(),
                        repeat: changed && prev.is_some(),
                    },
                )
                .await?;
            }
            CheckState::Unknown => {
                let open: Option<String> = sqlx::query_scalar(
                    "SELECT id FROM alerts WHERE device_id = ? AND check_id = ? AND status <> 'resolved'",
                )
                .bind(&device.id)
                .bind(&r.check_id)
                .fetch_optional(&state.db)
                .await?;
                if open.is_none() && r.streak >= threshold {
                    alerts::raise(
                        state,
                        Raise {
                            device_id: device.id.clone(),
                            source: "check",
                            check_id: r.check_id.clone(),
                            check_type: spec.kind.clone(),
                            severity: "info".into(),
                            title: format!("{}: the check could not run", spec.name),
                            message: message.clone(),
                            policy_id: spec.policy_id.clone(),
                            remediation: None,
                            repeat: false,
                        },
                    )
                    .await?;
                }
            }
        }
    }
    if results.full {
        reconcile(
            state,
            &device.id,
            &monitoring
                .checks
                .iter()
                .map(|c| c.id.clone())
                .collect::<Vec<_>>(),
        )
        .await?;
    }
    state.events.publish(
        "device.checks",
        Some(device.client_id.clone()),
        json!({ "device_id": device.id }),
    );
    Ok(())
}

/// Forgets states of checks that are no longer configured and resolves their alerts.
pub async fn reconcile(
    state: &AppState,
    device_id: &str,
    configured: &[String],
) -> anyhow::Result<()> {
    let stored: Vec<String> =
        sqlx::query_scalar("SELECT check_id FROM check_states WHERE device_id = ?")
            .bind(device_id)
            .fetch_all(&state.db)
            .await?;
    for check_id in stored.iter().filter(|c| !configured.contains(c)) {
        sqlx::query("DELETE FROM check_states WHERE device_id = ? AND check_id = ?")
            .bind(device_id)
            .bind(check_id)
            .execute(&state.db)
            .await?;
    }
    let open: Vec<String> = sqlx::query_scalar(
        "SELECT check_id FROM alerts WHERE device_id = ? AND source = 'check' AND status <> 'resolved'",
    )
    .bind(device_id)
    .fetch_all(&state.db)
    .await?;
    for check_id in open.iter().filter(|c| !configured.contains(c)) {
        alerts::clear(
            state,
            device_id,
            check_id,
            "The check was removed from the device's policy",
        )
        .await?;
    }
    Ok(())
}

#[derive(sqlx::FromRow)]
struct StateRow {
    check_id: String,
    #[sqlx(rename = "type")]
    kind: String,
    name: String,
    state: String,
    message: String,
    value: Option<f64>,
    since: DateTime<Utc>,
    last_at: DateTime<Utc>,
    interval_secs: i64,
    policy_id: Option<String>,
    policy_name: Option<String>,
}

const STATE_SELECT: &str = "SELECT c.check_id, c.type, c.name, c.state, c.message, c.value, c.since, c.last_at, c.interval_secs,
    c.policy_id, p.name AS policy_name FROM check_states c LEFT JOIN policies p ON p.id = c.policy_id";

impl StateRow {
    fn to_json(&self) -> Value {
        json!({ "check_id": self.check_id, "type": self.kind, "name": self.name, "state": self.state,
                "message": self.message, "value": self.value, "since": self.since, "last_at": self.last_at,
                "interval_secs": self.interval_secs, "policy_id": self.policy_id, "policy_name": self.policy_name })
    }
}

/// One check's stored state (`CheckState` in the API document).
pub async fn check_state(
    state: &AppState,
    device_id: &str,
    check_id: &str,
) -> anyhow::Result<Option<Value>> {
    let row: Option<StateRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{STATE_SELECT} WHERE c.device_id = ? AND c.check_id = ?"
    )))
    .bind(device_id)
    .bind(check_id)
    .fetch_optional(&state.db)
    .await?;
    Ok(row.map(|r| r.to_json()))
}

/// `GET /api/v1/devices/{id}/checks`: every configured check with its latest state (`null`
/// until the agent reports it).
#[utoipa::path(get, path = "/api/v1/devices/{id}/checks", tag = "Monitoring", summary = "Device checks", params(("id" = String, Path)), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn device_checks(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::ALERTS_VIEW)?;
    super::device_scope(&state, &ctx, &id, perm::ALERTS_VIEW).await?;
    let rows: Vec<StateRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{STATE_SELECT} WHERE c.device_id = ? ORDER BY c.name COLLATE NOCASE"
    )))
    .bind(&id)
    .fetch_all(&state.db)
    .await?;
    let configured = super::policy::load_device(&state, &id).await?;
    let mut items = Vec::new();
    match configured {
        Some(m) => {
            let names: std::collections::HashMap<String, String> =
                sqlx::query_as::<_, (String, String)>("SELECT id, name FROM policies")
                    .fetch_all(&state.db)
                    .await?
                    .into_iter()
                    .collect();
            for spec in &m.checks {
                match rows.iter().find(|r| r.check_id == spec.id) {
                    Some(r) => {
                        let mut v = r.to_json();
                        v["name"] = json!(spec.name);
                        v["interval_secs"] = json!(spec.interval_secs);
                        v["policy_id"] = json!(spec.policy_id);
                        v["policy_name"] = json!(spec.policy_id.as_ref().and_then(|p| names.get(p)));
                        items.push(v);
                    }
                    None => items.push(json!({
                        "check_id": spec.id, "type": spec.kind, "name": spec.name, "state": null, "message": "",
                        "value": null, "since": null, "last_at": null, "interval_secs": spec.interval_secs,
                        "policy_id": spec.policy_id,
                        "policy_name": spec.policy_id.as_ref().and_then(|p| names.get(p)),
                    })),
                }
            }
        }
        None => items.extend(rows.iter().map(StateRow::to_json)),
    }
    Ok(Json(json!({ "items": items })))
}
