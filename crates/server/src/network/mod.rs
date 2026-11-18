//! Phase 10 network discovery and SNMP monitoring (`docs/api-escrow-network.md`): site probes,
//! discovery scans and assets (OUI vendors, type guesses), SNMP credentials, templates and
//! devices, polling configuration pushed to probes, metrics with rates, rollups and retention,
//! threshold and unreachability alerts, traps and trap rules, and a best-effort topology.

pub mod alerting;
pub mod assets;
pub mod classify;
pub mod config;
pub mod credentials;
pub mod devices;
pub mod metrics;
pub mod oui;
pub mod probes;
pub mod scans;
pub mod templates;
pub mod topology;
pub mod traps;

use std::time::{Duration, Instant};

use axum::Json;
use axum::extract::State;
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::auth::AuthCtx;
use crate::error::{ApiError, ApiResult};
use crate::rbac::perm;
use crate::state::AppState;

/// Scheduler period (scan schedules, stale runs).
const TICK: Duration = Duration::from_secs(30);
/// Rollups run this often.
const ROLLUP_EVERY: Duration = Duration::from_secs(300);
/// Retention runs this often.
const HOURLY: Duration = Duration::from_secs(3600);
/// Received traps are kept this long.
pub const TRAP_RETENTION_DAYS: i64 = 90;

/// In-memory network state.
#[derive(Default)]
pub struct Runtime {
    /// SNMP configuration version last sent to each connected probe.
    pub(crate) pushed: DashMap<String, String>,
    /// Serialises configuration pushes.
    pub(crate) push_lock: tokio::sync::Mutex<()>,
}

impl Runtime {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Installation-wide network settings (`settings` key `network`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct NetworkSettings {
    /// Allow scans and SNMP devices outside private address space.
    #[serde(default)]
    pub allow_public_ranges: bool,
}

pub async fn load_settings(state: &AppState) -> anyhow::Result<NetworkSettings> {
    Ok(crate::db::get_setting(&state.db, "network")
        .await?
        .unwrap_or_default())
}

/// `GET /api/v1/settings/network`
#[utoipa::path(get, path = "/api/v1/settings/network", tag = "Network", summary = "Get settings", responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn get_settings(State(state): State<AppState>, ctx: AuthCtx) -> ApiResult<Json<Value>> {
    ctx.require(perm::NETWORK_VIEW)?;
    Ok(Json(serde_json::to_value(load_settings(&state).await?)?))
}

/// `PUT /api/v1/settings/network` (global `network.manage` + step-up)
#[utoipa::path(put, path = "/api/v1/settings/network", tag = "Network", summary = "Put settings", request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn put_settings(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Json(body): Json<NetworkSettings>,
) -> ApiResult<Json<Value>> {
    ctx.require_global(perm::NETWORK_MANAGE)?;
    ctx.require_step_up()?;
    crate::db::set_setting(&state.db, "network", &body).await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("settings.network_updated")
                .details(serde_json::to_value(&body)?),
        )
        .await;
    Ok(Json(serde_json::to_value(body)?))
}

/// The caller can see the site for `permission`; returns its client id.
pub async fn site_scope(
    state: &AppState,
    ctx: &AuthCtx,
    site_id: &str,
    permission: &str,
) -> ApiResult<String> {
    let client: Option<String> = sqlx::query_scalar("SELECT client_id FROM sites WHERE id = ?")
        .bind(site_id)
        .fetch_optional(&state.db)
        .await?;
    let client = client.ok_or_else(|| ApiError::not_found("Site"))?;
    let sees = |p: &str| ctx.scope.can_site(p, &client, site_id);
    if !sees(perm::NETWORK_VIEW) && !sees(permission) && !sees(perm::CLIENTS_VIEW) {
        return Err(ApiError::not_found("Site"));
    }
    if !sees(permission) {
        return Err(
            ApiError::forbidden(format!("Missing permission: {permission}"))
                .with_details(json!({ "permission": permission })),
        );
    }
    Ok(client)
}

/// Sites (with their client) the caller holds `permission` on.
pub async fn visible_sites(
    state: &AppState,
    ctx: &AuthCtx,
    permission: &str,
) -> anyhow::Result<Vec<(String, String)>> {
    let rows: Vec<(String, String)> = sqlx::query_as("SELECT id, client_id FROM sites")
        .fetch_all(&state.db)
        .await?;
    Ok(rows
        .into_iter()
        .filter(|(site, client)| ctx.scope.can_site(permission, client, site))
        .collect())
}

/// Starts the network scheduler: scan schedules, stale runs, rollups and retention.
pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(20)).await;
        let mut next_rollup = Instant::now() + ROLLUP_EVERY;
        let mut next_hourly = Instant::now() + Duration::from_secs(300);
        loop {
            if let Err(e) = scans::tick(&state).await {
                tracing::warn!(error = %format!("{e:#}"), "scan scheduler tick failed");
            }
            if Instant::now() >= next_rollup {
                next_rollup = Instant::now() + ROLLUP_EVERY;
                if let Err(e) = metrics::rollup(&state.db).await {
                    tracing::warn!(error = %format!("{e:#}"), "SNMP metrics rollup failed");
                }
            }
            if Instant::now() >= next_hourly {
                next_hourly = Instant::now() + HOURLY;
                if let Err(e) = retention(&state).await {
                    tracing::warn!(error = %format!("{e:#}"), "network retention failed");
                }
            }
            tokio::time::sleep(TICK).await;
        }
    });
}

/// Purges old traps and finished scan runs.
pub async fn retention(state: &AppState) -> anyhow::Result<()> {
    let cutoff = rustrmm_common::now() - chrono::Duration::days(TRAP_RETENTION_DAYS);
    sqlx::query("DELETE FROM snmp_traps WHERE at < ?")
        .bind(cutoff)
        .execute(&state.db)
        .await?;
    sqlx::query("DELETE FROM scan_runs WHERE started_at < ? AND status <> 'running'")
        .bind(cutoff)
        .execute(&state.db)
        .await?;
    Ok(())
}

/// Start-up recovery: runs that were in flight when the server stopped are failed.
pub async fn recover(state: &AppState) -> anyhow::Result<()> {
    let now = rustrmm_common::now();
    sqlx::query(
        "UPDATE scan_runs SET status = 'failed', finished_at = ?, error = 'The server restarted during the scan'
         WHERE status = 'running'",
    )
    .bind(now)
    .execute(&state.db)
    .await?;
    Ok(())
}

/// Agent connected: a probe receives its SNMP configuration.
pub async fn on_connect(state: &AppState, device_id: &str) {
    if let Err(e) = config::push_probe(state, device_id).await {
        tracing::warn!(device = device_id, error = %format!("{e:#}"), "sending the SNMP configuration failed");
    }
}

/// Agent disconnected: its next connection gets a full configuration again.
pub fn on_disconnect(state: &AppState, device_id: &str) {
    state.network.pushed.remove(device_id);
}
