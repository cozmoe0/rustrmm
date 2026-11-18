//! Phase 7 patching: the `patching` policy section, the patch catalog, approvals and rings,
//! scans and reports, maintenance-window patch runs and compliance (`docs/api-patching.md`).

pub mod api;
pub mod approvals;
pub mod compliance;
pub mod ingest;
pub mod policy;
pub mod runs;

use std::time::Duration;

use serde_json::json;

use crate::auth::AuthCtx;
use crate::automation::policies::PolicyContext;
use crate::db::Db;
use crate::error::{ApiError, ApiResult};
use crate::rbac::perm;
use crate::state::AppState;
use policy::PatchingConfig;

/// How often the patching and deployment scheduler runs.
pub const TICK: Duration = Duration::from_secs(30);

/// A device with its effective patching configuration.
#[derive(Debug, Clone)]
pub struct DeviceCtx {
    pub id: String,
    pub client_id: String,
    pub site_id: String,
    pub hostname: String,
    pub os_family: String,
    pub online: bool,
    pub config: PatchingConfig,
}

/// Active devices (all, or the given ones) with their effective patching configuration.
pub async fn load_devices(
    state: &AppState,
    ids: Option<&[String]>,
) -> anyhow::Result<Vec<DeviceCtx>> {
    let ctx = PolicyContext::load(&state.db, ids).await?;
    Ok(ctx
        .index
        .facts
        .iter()
        .filter(|f| ids.is_none_or(|ids| ids.contains(&f.id)))
        .map(|f| {
            let effective = ctx.effective(f);
            DeviceCtx {
                id: f.id.clone(),
                client_id: f.client_id.clone(),
                site_id: f.site_id.clone(),
                hostname: f.hostname.clone(),
                os_family: f.os_family.clone(),
                online: state.agents.is_online(&f.id),
                config: PatchingConfig::from_effective(&effective.document, &effective.origins),
            }
        })
        .collect())
}

/// Effective patching configuration of one device (defaults when it is not active).
pub async fn device_config(db: &Db, device_id: &str) -> anyhow::Result<PatchingConfig> {
    let ids = [device_id.to_string()];
    let ctx = PolicyContext::load(db, Some(&ids)).await?;
    Ok(ctx
        .facts(device_id)
        .map(|f| {
            let effective = ctx.effective(f);
            PatchingConfig::from_effective(&effective.document, &effective.origins)
        })
        .unwrap_or_default())
}

/// Starts the scheduler: scans, windows, deployments, token clean-up.
pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        // Let agents reconnect after a restart before the first pass.
        tokio::time::sleep(Duration::from_secs(20)).await;
        loop {
            tick(&state).await;
            tokio::time::sleep(TICK).await;
        }
    });
}

/// One scheduler pass now.
pub async fn tick(state: &AppState) {
    let now = rustrmm_common::now();
    if let Err(e) = runs::tick_at(state, now).await {
        tracing::warn!(error = %format!("{e:#}"), "patching scheduler tick failed");
    }
    if let Err(e) = crate::software::tick(state).await {
        tracing::warn!(error = %format!("{e:#}"), "software deployment tick failed");
    }
}

/// Start-up recovery: installs and actions in flight when the server stopped keep waiting for
/// their result (agents queue results across reconnects), so nothing changes here except
/// stale download tokens.
pub async fn recover(state: &AppState) -> anyhow::Result<()> {
    crate::software::files::purge_tokens(&state.db).await
}

/// Agent connected: scan when due, serve pending window installs and deployments.
pub async fn on_connect(state: &AppState, device_id: &str) {
    if let Err(e) = runs::on_connect(state, device_id).await {
        tracing::warn!(device = device_id, error = %format!("{e:#}"), "patching on connect failed");
    }
    if let Err(e) = crate::software::deployments::on_connect(state, device_id).await {
        tracing::warn!(device = device_id, error = %format!("{e:#}"), "software deployments on connect failed");
    }
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
