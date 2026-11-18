//! Monitored SNMP devices (polled by their site's probe).

use std::net::IpAddr;
use std::time::Duration;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use rustrmm_proto::commands::Command;
use rustrmm_proto::network::{MAX_POLL_SECS, MIN_POLL_SECS};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::auth::AuthCtx;
use crate::error::{ApiError, ApiResult};
use crate::rbac::perm;
use crate::state::AppState;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct DeviceRow {
    pub id: String,
    pub site_id: String,
    pub site_name: String,
    pub client_id: String,
    pub asset_id: Option<String>,
    pub name: String,
    pub ip: String,
    pub port: i64,
    pub credential_id: String,
    pub template_ids: String,
    pub poll_interval_secs: i64,
    pub enabled: bool,
    pub status: String,
    pub last_poll_at: Option<DateTime<Utc>>,
    pub sys_descr: Option<String>,
    pub uptime_secs: Option<i64>,
    pub last_error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

pub const SELECT: &str = "SELECT sd.id, sd.site_id, s.name AS site_name, s.client_id, sd.asset_id, sd.name, sd.ip, sd.port,
    sd.credential_id, sd.template_ids, sd.poll_interval_secs, sd.enabled, sd.status, sd.last_poll_at, sd.sys_descr,
    sd.uptime_secs, sd.last_error, sd.created_at, sd.updated_at FROM snmp_devices sd JOIN sites s ON s.id = sd.site_id";

impl DeviceRow {
    pub fn template_ids(&self) -> Vec<String> {
        serde_json::from_str(&self.template_ids).unwrap_or_default()
    }

    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id, "site_id": self.site_id, "site_name": self.site_name, "asset_id": self.asset_id,
            "name": self.name, "ip": self.ip, "port": self.port, "credential_id": self.credential_id,
            "template_ids": self.template_ids(), "poll_interval_secs": self.poll_interval_secs,
            "enabled": self.enabled, "status": self.status, "last_poll_at": self.last_poll_at,
            "sys_descr": self.sys_descr, "uptime_secs": self.uptime_secs, "last_error": self.last_error,
            "created_at": self.created_at, "updated_at": self.updated_at,
        })
    }
}

pub async fn load_row(state: &AppState, id: &str) -> anyhow::Result<Option<DeviceRow>> {
    Ok(
        sqlx::query_as(sqlx::AssertSqlSafe(format!("{SELECT} WHERE sd.id = ?")))
            .bind(id)
            .fetch_optional(&state.db)
            .await?,
    )
}

/// An SNMP device the caller may see (and act on with `permission`).
pub async fn load(
    state: &AppState,
    ctx: &AuthCtx,
    id: &str,
    permission: &str,
) -> ApiResult<DeviceRow> {
    let row = load_row(state, id)
        .await?
        .filter(|r| {
            ctx.scope
                .can_site(perm::NETWORK_VIEW, &r.client_id, &r.site_id)
                || ctx.scope.can_site(permission, &r.client_id, &r.site_id)
        })
        .ok_or_else(|| ApiError::not_found("SNMP device"))?;
    if !ctx.scope.can_site(permission, &row.client_id, &row.site_id) {
        return Err(
            ApiError::forbidden(format!("Missing permission: {permission}"))
                .with_details(json!({ "permission": permission })),
        );
    }
    Ok(row)
}

#[derive(Deserialize)]
pub struct ListQuery {
    site_id: Option<String>,
}

/// `GET /api/v1/network/snmp/devices?site_id=`
#[utoipa::path(get, path = "/api/v1/network/snmp/devices", tag = "Network", summary = "List devices", responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn list(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::NETWORK_VIEW)?;
    let rows: Vec<DeviceRow> = match q.site_id.as_deref().filter(|s| !s.is_empty()) {
        Some(site) => {
            sqlx::query_as(sqlx::AssertSqlSafe(format!(
                "{SELECT} WHERE sd.site_id = ? ORDER BY sd.name COLLATE NOCASE"
            )))
            .bind(site)
            .fetch_all(&state.db)
            .await?
        }
        None => {
            sqlx::query_as(sqlx::AssertSqlSafe(format!(
                "{SELECT} ORDER BY sd.name COLLATE NOCASE"
            )))
            .fetch_all(&state.db)
            .await?
        }
    };
    let items: Vec<Value> = rows
        .iter()
        .filter(|r| {
            ctx.scope
                .can_site(perm::NETWORK_VIEW, &r.client_id, &r.site_id)
        })
        .map(DeviceRow::to_json)
        .collect();
    Ok(Json(json!({ "items": items })))
}

/// Validated input for creating or updating a device.
#[derive(Debug, Clone, Deserialize)]
pub struct DeviceInput {
    pub site_id: String,
    #[serde(default)]
    pub asset_id: Option<String>,
    pub name: String,
    pub ip: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub credential_id: String,
    #[serde(default)]
    pub template_ids: Vec<String>,
    #[serde(default = "default_poll")]
    pub poll_interval_secs: i64,
    #[serde(default = "yes")]
    pub enabled: bool,
}

fn default_port() -> u16 {
    161
}

fn default_poll() -> i64 {
    300
}

fn yes() -> bool {
    true
}

async fn validate(state: &AppState, input: &mut DeviceInput) -> ApiResult<()> {
    input.name = input.name.trim().to_string();
    if input.name.is_empty() || input.name.chars().count() > 120 {
        return Err(ApiError::validation("Name must be 1–120 characters"));
    }
    let ip: IpAddr = input
        .ip
        .trim()
        .parse()
        .map_err(|_| ApiError::validation("ip must be an IPv4 or IPv6 address"))?;
    let settings = super::load_settings(state).await?;
    if !settings.allow_public_ranges && !rustrmm_proto::network::is_private(ip) {
        return Err(ApiError::validation(
            "ip must be a private address (RFC 1918, CGNAT or link-local) unless public ranges are allowed",
        ));
    }
    input.ip = ip.to_string();
    if input.port == 0 {
        return Err(ApiError::validation("port must be 1–65535"));
    }
    if !(i64::from(MIN_POLL_SECS)..=i64::from(MAX_POLL_SECS)).contains(&input.poll_interval_secs) {
        return Err(ApiError::validation(format!(
            "poll_interval_secs must be {MIN_POLL_SECS}–{MAX_POLL_SECS}"
        )));
    }
    let credential: Option<String> =
        sqlx::query_scalar("SELECT id FROM snmp_credentials WHERE id = ?")
            .bind(&input.credential_id)
            .fetch_optional(&state.db)
            .await?;
    if credential.is_none() {
        return Err(ApiError::validation("Unknown SNMP credential")
            .with_details(json!({ "path": "credential_id" })));
    }
    if input.template_ids.is_empty() {
        input.template_ids = vec![super::templates::GENERIC.to_string()];
    }
    input.template_ids.dedup();
    if input.template_ids.len() > 20 {
        return Err(ApiError::validation("At most 20 templates per device"));
    }
    for id in &input.template_ids {
        let found: Option<String> =
            sqlx::query_scalar("SELECT id FROM snmp_templates WHERE id = ?")
                .bind(id)
                .fetch_optional(&state.db)
                .await?;
        if found.is_none() {
            return Err(ApiError::validation(format!("Unknown template {id}"))
                .with_details(json!({ "path": "template_ids" })));
        }
    }
    if let Some(asset) = &input.asset_id {
        let found: Option<String> =
            sqlx::query_scalar("SELECT id FROM network_assets WHERE id = ? AND site_id = ?")
                .bind(asset)
                .bind(&input.site_id)
                .fetch_optional(&state.db)
                .await?;
        if found.is_none() {
            return Err(ApiError::validation("Unknown asset in this site"));
        }
    }
    Ok(())
}

/// Creates a device (also used by "monitor this asset").
pub async fn create_device(
    state: &AppState,
    ctx: &AuthCtx,
    mut input: DeviceInput,
) -> ApiResult<Value> {
    let client_id = super::site_scope(state, ctx, &input.site_id, perm::NETWORK_MANAGE).await?;
    validate(state, &mut input).await?;
    let id = rustrmm_common::new_id();
    let now = rustrmm_common::now();
    sqlx::query(
        "INSERT INTO snmp_devices (id, site_id, asset_id, name, ip, port, credential_id, template_ids, poll_interval_secs, enabled,
                                   status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
    )
    .bind(&id)
    .bind(&input.site_id)
    .bind(&input.asset_id)
    .bind(&input.name)
    .bind(&input.ip)
    .bind(i64::from(input.port))
    .bind(&input.credential_id)
    .bind(serde_json::to_string(&input.template_ids)?)
    .bind(input.poll_interval_secs)
    .bind(input.enabled)
    .bind(now)
    .bind(now)
    .execute(&state.db)
    .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("snmp.device_created")
                .target("snmp_device", &id, &input.name)
                .client(&client_id)
                .site(&input.site_id)
                .details(json!({ "ip": input.ip, "templates": input.template_ids })),
        )
        .await;
    super::config::push_site_soon(state, &input.site_id);
    let row = load_row(state, &id)
        .await?
        .ok_or_else(|| ApiError::internal("device vanished"))?;
    Ok(row.to_json())
}

/// `POST /api/v1/network/snmp/devices`
#[utoipa::path(post, path = "/api/v1/network/snmp/devices", tag = "Network", summary = "Create device", request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn create(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Json(input): Json<DeviceInput>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    ctx.require(perm::NETWORK_MANAGE)?;
    Ok((
        StatusCode::CREATED,
        Json(create_device(&state, &ctx, input).await?),
    ))
}

/// `PUT /api/v1/network/snmp/devices/{id}`
#[utoipa::path(put, path = "/api/v1/network/snmp/devices/{id}", tag = "Network", summary = "Update device", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn update(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(mut input): Json<DeviceInput>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::NETWORK_MANAGE)?;
    let current = load(&state, &ctx, &id, perm::NETWORK_MANAGE).await?;
    if input.site_id != current.site_id {
        return Err(ApiError::validation(
            "An SNMP device cannot move to another site",
        ));
    }
    validate(&state, &mut input).await?;
    sqlx::query(
        "UPDATE snmp_devices SET asset_id = ?, name = ?, ip = ?, port = ?, credential_id = ?, template_ids = ?, poll_interval_secs = ?,
                                 enabled = ?, updated_at = ? WHERE id = ?",
    )
    .bind(&input.asset_id)
    .bind(&input.name)
    .bind(&input.ip)
    .bind(i64::from(input.port))
    .bind(&input.credential_id)
    .bind(serde_json::to_string(&input.template_ids)?)
    .bind(input.poll_interval_secs)
    .bind(input.enabled)
    .bind(rustrmm_common::now())
    .bind(&id)
    .execute(&state.db)
    .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("snmp.device_updated")
                .target("snmp_device", &id, &input.name)
                .client(&current.client_id)
                .site(&current.site_id),
        )
        .await;
    super::config::push_site_soon(&state, &current.site_id);
    let row = load_row(&state, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("SNMP device"))?;
    Ok(Json(row.to_json()))
}

/// `DELETE /api/v1/network/snmp/devices/{id}`
#[utoipa::path(delete, path = "/api/v1/network/snmp/devices/{id}", tag = "Network", summary = "Delete device", params(("id" = String, Path)), responses((status = 204, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn delete(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    ctx.require(perm::NETWORK_MANAGE)?;
    let current = load(&state, &ctx, &id, perm::NETWORK_MANAGE).await?;
    sqlx::query("DELETE FROM snmp_devices WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("snmp.device_deleted")
                .target("snmp_device", &id, &current.name)
                .client(&current.client_id)
                .site(&current.site_id),
        )
        .await;
    crate::monitoring::publish_summary(&state, &current.client_id);
    super::config::push_site_soon(&state, &current.site_id);
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /api/v1/network/snmp/devices/{id}/test` — polls once through the probe.
#[utoipa::path(post, path = "/api/v1/network/snmp/devices/{id}/test", tag = "Network", summary = "Test", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn test(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::NETWORK_MANAGE)?;
    let device = load(&state, &ctx, &id, perm::NETWORK_MANAGE).await?;
    let Some(probe) = super::probes::of_site(&state.db, &device.site_id).await? else {
        return Ok(Json(
            json!({ "ok": false, "error": "This site has no probe" }),
        ));
    };
    if !state.agents.is_online(&probe.device_id) {
        return Ok(Json(
            json!({ "ok": false, "error": "The site's probe is offline" }),
        ));
    }
    let Some(target) = super::config::target_for(&state, &id).await? else {
        return Ok(Json(
            json!({ "ok": false, "error": "The device's credential is missing" }),
        ));
    };
    let outcome = crate::agents::commands::request(
        &state,
        &probe.device_id,
        Command::SnmpTest(target),
        Some(&ctx.user.id),
        &format!("Test SNMP device {}", device.name),
        false,
        Duration::from_secs(45),
    )
    .await;
    Ok(Json(match outcome {
        Ok(result) => {
            let ok = result
                .data
                .get("ok")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let sys_descr = result.data.get("sys_descr").cloned().unwrap_or(Value::Null);
            if let Some(descr) = sys_descr.as_str() {
                let _ = sqlx::query("UPDATE snmp_devices SET sys_descr = ? WHERE id = ?")
                    .bind(descr.chars().take(1000).collect::<String>())
                    .bind(&id)
                    .execute(&state.db)
                    .await;
            }
            json!({ "ok": ok, "sys_descr": sys_descr,
                    "error": result.data.get("error").cloned().unwrap_or(Value::Null) })
        }
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }))
}
