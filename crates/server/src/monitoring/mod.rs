//! Phase 6 monitoring: the check catalog and `monitoring` policy section, check results from
//! agents, server-side checks, the alert lifecycle, notifications and maintenance windows
//! (`docs/api-monitoring.md`).

pub mod alerts;
pub mod baseline;
pub mod catalog;
pub mod ingest;
pub mod maintenance;
pub mod notify;
pub mod policy;
pub mod remediation;
pub mod server_checks;
pub mod settings;

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::Json;
use axum::extract::State;
use dashmap::DashMap;
use serde_json::{Value, json};
use tokio::sync::Notify;

use crate::auth::AuthCtx;
use crate::error::{ApiError, ApiResult};
use crate::rbac::perm;
use crate::state::AppState;

/// How often escalations and remediation outcomes are checked.
const TICK: Duration = Duration::from_secs(15);
const OFFLINE_EVERY: Duration = Duration::from_secs(60);
const HOURLY: Duration = Duration::from_secs(3600);
/// `alerts.summary` is published at most this often per client.
const SUMMARY_INTERVAL: Duration = Duration::from_secs(2);

/// In-memory monitoring state.
#[derive(Default)]
pub struct Runtime {
    /// Wakes the notification worker.
    pub(crate) delivery: Notify,
    /// Effective monitoring per device, refreshed whenever configuration is pushed.
    pub(crate) devices: DashMap<String, Arc<policy::DeviceMonitoring>>,
    /// Configuration version last sent to each connected device.
    pub(crate) pushed: DashMap<String, String>,
    summary: DashMap<String, (Instant, bool)>,
}

impl Runtime {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn kick_delivery(&self) {
        self.delivery.notify_one();
    }
}

/// Publishes `alerts.summary` for a client, at most once per 2 s (a trailing event carries
/// the latest counts).
pub fn publish_summary(state: &AppState, client_id: &str) {
    let now = Instant::now();
    let delay = {
        let mut entry = state
            .monitoring
            .summary
            .entry(client_id.to_string())
            // `Instant` cannot go before boot, so the first publish is never delayed artificially.
            .or_insert((now.checked_sub(SUMMARY_INTERVAL).unwrap_or(now), false));
        let since = now.duration_since(entry.0);
        if since >= SUMMARY_INTERVAL {
            entry.0 = now;
            Some(Duration::ZERO)
        } else if entry.1 {
            None
        } else {
            entry.1 = true;
            Some(SUMMARY_INTERVAL - since)
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
            if let Some(mut entry) = state.monitoring.summary.get_mut(&client_id) {
                entry.0 = Instant::now();
                entry.1 = false;
            }
        }
        let counts: Result<(i64, i64, i64), _> = sqlx::query_as(
            "SELECT COUNT(*), COALESCE(SUM(severity = 'critical'), 0), COALESCE(SUM(severity = 'warning'), 0)
             FROM alerts WHERE client_id = ? AND status <> 'resolved'",
        )
        .bind(&client_id)
        .fetch_one(&state.db)
        .await;
        if let Ok((open, critical, warning)) = counts {
            state.events.publish(
                "alerts.summary",
                Some(client_id.clone()),
                json!({ "client_id": client_id, "open": open, "critical": critical, "warning": warning }),
            );
        }
    });
}

/// Starts the notification worker and the monitoring scheduler.
pub fn spawn(state: AppState) {
    notify::delivery::spawn_worker(state.clone());
    tokio::spawn(async move {
        let mut next_offline = Instant::now();
        // The first hourly pass runs a few minutes after start, once agents have reconnected.
        let mut next_hourly = Instant::now() + Duration::from_secs(300);
        loop {
            if let Err(e) = notify::escalate(&state).await {
                tracing::warn!(error = %format!("{e:#}"), "notification escalation failed");
            }
            if let Err(e) = remediation::sweep(&state).await {
                tracing::warn!(error = %format!("{e:#}"), "remediation sweep failed");
            }
            if Instant::now() >= next_offline {
                next_offline = Instant::now() + OFFLINE_EVERY;
                if let Err(e) = server_checks::check_offline(&state).await {
                    tracing::warn!(error = %format!("{e:#}"), "offline check failed");
                }
            }
            if Instant::now() >= next_hourly {
                next_hourly = Instant::now() + HOURLY;
                if let Err(e) = hourly(&state).await {
                    tracing::warn!(error = %format!("{e:#}"), "hourly monitoring pass failed");
                }
            }
            tokio::time::sleep(TICK).await;
        }
    });
}

/// Outdated agents, disk forecasts and retention.
pub async fn hourly(state: &AppState) -> anyhow::Result<()> {
    let ctx = crate::automation::policies::PolicyContext::load(&state.db, None).await?;
    server_checks::check_outdated(state, &ctx).await?;
    server_checks::check_disk_forecast(state, &ctx).await?;
    purge(state).await
}

/// Deletes resolved alerts (with their events) and delivery history older than the retention.
pub async fn purge(state: &AppState) -> anyhow::Result<()> {
    let settings = settings::load(state).await?;
    let cutoff = rustrmm_common::now() - chrono::Duration::days(settings.retention_days.max(7));
    sqlx::query("DELETE FROM alerts WHERE status = 'resolved' AND resolved_at < ?")
        .bind(cutoff)
        .execute(&state.db)
        .await?;
    sqlx::query("DELETE FROM notification_log WHERE created_at < ? AND status IN ('sent', 'failed', 'suppressed')")
        .bind(cutoff)
        .execute(&state.db)
        .await?;
    Ok(())
}

/// Start-up recovery (before agents connect).
pub async fn recover(state: &AppState) -> anyhow::Result<()> {
    notify::delivery::recover(state).await
}

/// Re-sends changed monitoring configurations in the background (after a variable or script
/// change: `script` checks embed both).
pub fn push_soon(state: &AppState) {
    let state = state.clone();
    tokio::spawn(async move {
        if let Err(e) = policy::push_all(&state).await {
            tracing::warn!(error = %format!("{e:#}"), "pushing monitoring configurations failed");
        }
    });
}

/// Agent connected: send its configuration and resolve an open offline alert.
pub async fn on_connect(state: &AppState, device_id: &str) {
    if let Err(e) = policy::push_device(state, device_id).await {
        tracing::warn!(device = device_id, error = %format!("{e:#}"), "sending the monitoring configuration failed");
    }
    if let Err(e) = alerts::clear(state, device_id, "offline", "The device is back online").await {
        tracing::warn!(device = device_id, error = %format!("{e:#}"), "resolving the offline alert failed");
    }
}

/// Agent disconnected: its next connection gets a full configuration again.
pub fn on_disconnect(state: &AppState, device_id: &str) {
    state.monitoring.pushed.remove(device_id);
}

/// Checks the caller can see a device for `permission`; returns its client and site.
pub async fn device_scope(
    state: &AppState,
    ctx: &AuthCtx,
    device_id: &str,
    permission: &str,
) -> ApiResult<(String, String)> {
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT s.client_id, d.site_id FROM devices d JOIN sites s ON s.id = d.site_id WHERE d.id = ?",
    )
    .bind(device_id)
    .fetch_optional(&state.db)
    .await?;
    let (client, site) = row.ok_or_else(|| ApiError::not_found("Device"))?;
    if !ctx.scope.can_site(perm::DEVICES_VIEW, &client, &site)
        && !ctx.scope.can_site(permission, &client, &site)
    {
        return Err(ApiError::not_found("Device"));
    }
    if !ctx.scope.can_site(permission, &client, &site) {
        return Err(
            ApiError::forbidden(format!("Missing permission: {permission}"))
                .with_details(json!({ "permission": permission })),
        );
    }
    Ok((client, site))
}

/// `GET /api/v1/monitoring/check-types`
pub async fn check_types(State(_state): State<AppState>, ctx: AuthCtx) -> ApiResult<Json<Value>> {
    ctx.require(perm::ALERTS_VIEW)?;
    Ok(Json(json!({ "items": catalog::catalog() })))
}
