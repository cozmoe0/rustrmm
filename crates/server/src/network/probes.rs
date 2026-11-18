//! Site probes: one agent per site runs the scans, SNMP polling and the optional trap receiver.

use axum::Json;
use axum::extract::{Path, State};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::auth::AuthCtx;
use crate::db::Db;
use crate::error::{ApiError, ApiResult};
use crate::rbac::perm;
use crate::state::AppState;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ProbeRow {
    pub site_id: String,
    pub site_name: String,
    pub client_id: String,
    pub device_id: String,
    pub hostname: String,
    pub os_family: String,
    pub trap_receiver: bool,
    pub trap_port: i64,
    pub assigned_at: DateTime<Utc>,
}

const SELECT: &str = "SELECT p.site_id, s.name AS site_name, s.client_id, p.device_id, d.hostname, d.os_family, p.trap_receiver,
    p.trap_port, p.assigned_at FROM site_probes p JOIN sites s ON s.id = p.site_id JOIN devices d ON d.id = p.device_id";

impl ProbeRow {
    pub fn to_json(&self, state: &AppState) -> Value {
        json!({
            "site_id": self.site_id, "site_name": self.site_name, "device_id": self.device_id,
            "hostname": self.hostname, "os_family": self.os_family,
            "online": state.agents.is_online(&self.device_id),
            "trap_receiver": self.trap_receiver, "trap_port": self.trap_port,
            "assigned_at": self.assigned_at,
        })
    }
}

/// The probe of a site.
pub async fn of_site(db: &Db, site_id: &str) -> anyhow::Result<Option<ProbeRow>> {
    Ok(
        sqlx::query_as(sqlx::AssertSqlSafe(format!("{SELECT} WHERE p.site_id = ?")))
            .bind(site_id)
            .fetch_optional(db)
            .await?,
    )
}

/// The site a device is the probe of.
pub async fn site_of(db: &Db, device_id: &str) -> anyhow::Result<Option<ProbeRow>> {
    Ok(sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{SELECT} WHERE p.device_id = ?"
    )))
    .bind(device_id)
    .fetch_optional(db)
    .await?)
}

/// `GET /api/v1/network/probes`
#[utoipa::path(get, path = "/api/v1/network/probes", tag = "Network", summary = "List probes", responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn list(State(state): State<AppState>, ctx: AuthCtx) -> ApiResult<Json<Value>> {
    ctx.require(perm::NETWORK_VIEW)?;
    let rows: Vec<ProbeRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{SELECT} ORDER BY s.name COLLATE NOCASE"
    )))
    .fetch_all(&state.db)
    .await?;
    let items: Vec<Value> = rows
        .iter()
        .filter(|r| {
            ctx.scope
                .can_site(perm::NETWORK_VIEW, &r.client_id, &r.site_id)
        })
        .map(|r| r.to_json(&state))
        .collect();
    Ok(Json(json!({ "items": items })))
}

fn empty(site_id: &str) -> Value {
    json!({ "site_id": site_id, "device_id": null, "hostname": null, "online": false,
            "trap_receiver": false, "trap_port": 162, "assigned_at": null })
}

/// `GET /api/v1/sites/{id}/probe`
#[utoipa::path(get, path = "/api/v1/sites/{id}/probe", tag = "Network", summary = "Get probe", params(("id" = String, Path)), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn get(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(site_id): Path<String>,
) -> ApiResult<Json<Value>> {
    super::site_scope(&state, &ctx, &site_id, perm::NETWORK_VIEW).await?;
    Ok(Json(match of_site(&state.db, &site_id).await? {
        Some(p) => p.to_json(&state),
        None => empty(&site_id),
    }))
}

#[derive(Deserialize)]
pub struct ProbeBody {
    #[serde(default)]
    device_id: Option<String>,
    #[serde(default)]
    trap_receiver: Option<bool>,
    #[serde(default)]
    trap_port: Option<u16>,
}

/// `PUT /api/v1/sites/{id}/probe` — body `{ device_id | null, trap_receiver?, trap_port? }`.
#[utoipa::path(put, path = "/api/v1/sites/{id}/probe", tag = "Network", summary = "Update probe", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn put(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(site_id): Path<String>,
    Json(body): Json<ProbeBody>,
) -> ApiResult<Json<Value>> {
    let client_id = super::site_scope(&state, &ctx, &site_id, perm::NETWORK_MANAGE).await?;
    let previous = of_site(&state.db, &site_id).await?;
    let Some(device_id) = body.device_id.filter(|d| !d.is_empty()) else {
        if let Some(prev) = &previous {
            sqlx::query("DELETE FROM site_probes WHERE site_id = ?")
                .bind(&site_id)
                .execute(&state.db)
                .await?;
            super::config::clear_probe(&state, &prev.device_id).await;
            state
                .audit
                .record_or_log(
                    &state.db,
                    ctx.audit("network.probe_cleared")
                        .target("site", &site_id, &prev.site_name)
                        .client(&client_id)
                        .site(&site_id)
                        .details(json!({ "device_id": prev.device_id })),
                )
                .await;
        }
        return Ok(Json(empty(&site_id)));
    };
    let device: Option<(String, String, String)> =
        sqlx::query_as("SELECT site_id, status, hostname FROM devices WHERE id = ?")
            .bind(&device_id)
            .fetch_optional(&state.db)
            .await?;
    let (device_site, status, hostname) =
        device.ok_or_else(|| ApiError::validation("Unknown device"))?;
    if device_site != site_id {
        return Err(ApiError::validation(
            "The probe must be an agent in this site",
        ));
    }
    if status != "active" {
        return Err(ApiError::validation("The device is not active"));
    }
    let same = previous.as_ref().is_some_and(|p| p.device_id == device_id);
    if !same && !state.agents.is_online(&device_id) {
        return Err(ApiError::conflict(
            "device_offline",
            "Only online agents can be probes",
        ));
    }
    let trap_receiver = body
        .trap_receiver
        .unwrap_or_else(|| previous.as_ref().is_some_and(|p| p.trap_receiver));
    let trap_port = body
        .trap_port
        .map(i64::from)
        .or_else(|| previous.as_ref().map(|p| p.trap_port))
        .unwrap_or(162);
    if trap_port == 0 {
        return Err(ApiError::validation("trap_port must be 1–65535"));
    }
    let now = rustrmm_common::now();
    sqlx::query(
        "INSERT INTO site_probes (site_id, device_id, trap_receiver, trap_port, assigned_by, assigned_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (site_id) DO UPDATE SET device_id = excluded.device_id, trap_receiver = excluded.trap_receiver,
             trap_port = excluded.trap_port, assigned_by = excluded.assigned_by,
             assigned_at = CASE WHEN site_probes.device_id = excluded.device_id THEN site_probes.assigned_at ELSE excluded.assigned_at END",
    )
    .bind(&site_id)
    .bind(&device_id)
    .bind(trap_receiver)
    .bind(trap_port)
    .bind(&ctx.user.id)
    .bind(now)
    .execute(&state.db)
    .await?;
    if let Some(prev) = &previous
        && prev.device_id != device_id
    {
        super::config::clear_probe(&state, &prev.device_id).await;
    }
    if let Err(e) = super::config::push_site(&state, &site_id).await {
        tracing::warn!(site = %site_id, error = %format!("{e:#}"), "pushing the SNMP configuration failed");
    }
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("network.probe_assigned")
                .target("device", &device_id, &hostname)
                .client(&client_id)
                .site(&site_id)
                .details(json!({ "trap_receiver": trap_receiver, "trap_port": trap_port })),
        )
        .await;
    let probe = of_site(&state.db, &site_id)
        .await?
        .ok_or_else(|| ApiError::internal("probe vanished"))?;
    Ok(Json(probe.to_json(&state)))
}
