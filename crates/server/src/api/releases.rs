//! Agent releases, rollouts and ad-hoc signed commands.

use std::collections::HashMap;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use rustrmm_proto::commands::{Command, ReleaseManifest};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::agents::releases::{self, RolloutScope, UpdateState};
use crate::auth::AuthCtx;
use crate::automation::policies::{self, PolicyContext};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

const PERM: &str = "agents.update";

/// `GET /api/v1/agent-releases`
#[utoipa::path(get, path = "/api/v1/agent-releases", tag = "Agent releases", summary = "List agent releases", responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn list(State(state): State<AppState>, ctx: AuthCtx) -> ApiResult<Json<Value>> {
    ctx.require("devices.view")?;
    let rows: Vec<(String, String, Vec<u8>, DateTime<Utc>, Option<DateTime<Utc>>)> = sqlx::query_as(
        "SELECT id, version, manifest, imported_at, pruned_at FROM agent_releases ORDER BY imported_at DESC",
    )
    .fetch_all(&state.db)
    .await?;
    let versions: Vec<(String, i64)> = sqlx::query_as(
        "SELECT agent_version, COUNT(*) FROM devices WHERE status = 'active' GROUP BY agent_version ORDER BY agent_version DESC",
    )
    .fetch_all(&state.db)
    .await?;
    let items: Vec<Value> = rows
        .into_iter()
        .map(|(id, version, manifest, imported_at, pruned_at)| {
            let manifest: Option<ReleaseManifest> = serde_json::from_slice(&manifest).ok();
            let devices = versions.iter().find(|(v, _)| v == &version).map(|(_, n)| *n).unwrap_or(0);
            json!({ "id": id, "version": version, "imported_at": imported_at, "pruned_at": pruned_at,
                    "files": manifest.map(|m| m.files).unwrap_or_default(), "devices": devices })
        })
        .collect();
    let versions: Vec<Value> = versions
        .into_iter()
        .map(|(v, n)| json!({ "version": v, "devices": n }))
        .collect();
    Ok(Json(json!({ "items": items, "versions": versions })))
}

/// `POST /api/v1/agent-releases/import` — imports the release published in the dist directory.
#[utoipa::path(post, path = "/api/v1/agent-releases/import", tag = "Agent releases", summary = "Import", request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn import(State(state): State<AppState>, ctx: AuthCtx) -> ApiResult<Json<Value>> {
    ctx.require_global(PERM)?;
    let imported = releases::import_dist(&state)
        .await
        .map_err(|e| ApiError::validation(format!("{e:#}")))?;
    if let Some(version) = &imported {
        state
            .audit
            .record_or_log(
                &state.db,
                ctx.audit("agent_release.imported")
                    .details(json!({ "version": version })),
            )
            .await;
    }
    Ok(Json(json!({ "imported": imported })))
}

#[derive(Deserialize)]
pub struct RolloutRequest {
    scope: RolloutScope,
    #[serde(default = "full")]
    percent: i64,
}

fn full() -> i64 {
    100
}

/// `POST /api/v1/agent-releases/{id}/rollouts` (step-up)
#[utoipa::path(post, path = "/api/v1/agent-releases/{id}/rollouts", tag = "Agent releases", summary = "Create rollout", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn create_rollout(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(release_id): Path<String>,
    Json(req): Json<RolloutRequest>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    ctx.require_global(PERM)?;
    ctx.require_step_up()?;
    let version: String = sqlx::query_scalar("SELECT version FROM agent_releases WHERE id = ?")
        .bind(&release_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| ApiError::not_found("Release"))?;
    let created =
        releases::create_rollout(&state, &release_id, &req.scope, req.percent, &ctx.user.id)
            .await
            .map_err(|e| ApiError::conflict("release_unavailable", format!("{e:#}")))?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("agent_rollout.created")
                .target("rollout", &created.id, &version)
                .details(json!({ "scope": req.scope, "percent": req.percent, "targeted": created.targeted })),
        )
        .await;
    Ok((
        StatusCode::CREATED,
        Json(json!({ "id": created.id, "targeted": created.targeted })),
    ))
}

/// `GET /api/v1/rollouts`
#[utoipa::path(get, path = "/api/v1/rollouts", tag = "Agent releases", summary = "List rollouts", responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn list_rollouts(State(state): State<AppState>, ctx: AuthCtx) -> ApiResult<Json<Value>> {
    ctx.require("devices.view")?;
    let rows: Vec<(String, String, String, i64, String, DateTime<Utc>, String, Option<String>, DateTime<Utc>)> = sqlx::query_as(
        "SELECT r.id, a.version, r.scope, r.percent, r.status, r.created_at, r.kind, u.name, r.updated_at
         FROM rollouts r JOIN agent_releases a ON a.id = r.release_id LEFT JOIN users u ON u.id = r.created_by
         ORDER BY r.created_at DESC LIMIT 100",
    )
    .fetch_all(&state.db)
    .await?;
    let mut items = Vec::new();
    for (id, version, scope, percent, status, created_at, kind, created_by, updated_at) in rows {
        let counts: Vec<(String, i64)> = sqlx::query_as(
            "SELECT status, COUNT(*) FROM rollout_targets WHERE rollout_id = ? GROUP BY status",
        )
        .bind(&id)
        .fetch_all(&state.db)
        .await?;
        let counts: serde_json::Map<String, Value> =
            counts.into_iter().map(|(s, n)| (s, json!(n))).collect();
        items.push(json!({
            "id": id, "version": version, "scope": serde_json::from_str::<Value>(&scope).unwrap_or(Value::Null),
            "percent": percent, "status": status, "created_at": created_at, "updated_at": updated_at,
            "kind": kind, "created_by": created_by, "counts": counts,
        }));
    }
    Ok(Json(json!({ "items": items })))
}

/// `POST /api/v1/rollouts/{id}/{action}` — action: pause | resume | cancel
#[utoipa::path(post, path = "/api/v1/rollouts/{id}/{action}", tag = "Agent releases", summary = "Rollout action", params(("id" = String, Path), ("action" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn rollout_action(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path((id, action)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    ctx.require_global(PERM)?;
    let (from, to) = match action.as_str() {
        "pause" => ("active", "paused"),
        "resume" => ("paused", "active"),
        "cancel" => ("%", "cancelled"),
        _ => return Err(ApiError::not_found("Action")),
    };
    let result = sqlx::query("UPDATE rollouts SET status = ?, updated_at = ? WHERE id = ? AND status LIKE ? AND status NOT IN ('completed', 'cancelled')")
        .bind(to)
        .bind(rustrmm_common::now())
        .bind(&id)
        .bind(from)
        .execute(&state.db)
        .await?;
    if result.rows_affected() == 0 {
        return Err(ApiError::conflict(
            "invalid_state",
            "The rollout cannot change to that state",
        ));
    }
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("agent_rollout.updated")
                .target("rollout", &id, &action),
        )
        .await;
    if to == "active" {
        let devices: Vec<String> = sqlx::query_scalar("SELECT device_id FROM rollout_targets WHERE rollout_id = ? AND status IN ('pending', 'sent')")
            .bind(&id)
            .fetch_all(&state.db)
            .await?;
        for device in devices.into_iter().filter(|d| state.agents.is_online(d)) {
            let _ = releases::dispatch_for_device(&state, &device).await;
        }
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn device_scope(
    state: &AppState,
    ctx: &AuthCtx,
    device_id: &str,
    permission: &str,
) -> ApiResult<(String, String)> {
    let row: Option<(String, String, String)> =
        sqlx::query_as("SELECT s.client_id, d.site_id, d.hostname FROM devices d JOIN sites s ON s.id = d.site_id WHERE d.id = ?")
            .bind(device_id)
            .fetch_optional(&state.db)
            .await?;
    let (client_id, site_id, hostname) = row.ok_or_else(|| ApiError::not_found("Device"))?;
    if !ctx.scope.can_site("devices.view", &client_id, &site_id) {
        return Err(ApiError::not_found("Device"));
    }
    if !ctx.scope.can_site(permission, &client_id, &site_id) {
        return Err(ApiError::forbidden(format!(
            "Missing permission: {permission}"
        )));
    }
    Ok((client_id, hostname))
}

/// `POST /api/v1/devices/{id}/ping` — a signed no-op that proves the command channel end to end.
#[utoipa::path(post, path = "/api/v1/devices/{id}/ping", tag = "Agent releases", summary = "Ping", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn ping(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    device_scope(&state, &ctx, &id, "devices.manage").await?;
    let cmd_id =
        crate::agents::commands::send(&state, &id, Command::Ping, Some(&ctx.user.id), 60, "Ping")
            .await
            .map_err(|e| ApiError::conflict("device_offline", format!("{e:#}")))?;
    Ok(Json(json!({ "cmd_id": cmd_id })))
}

/// `GET /api/v1/devices/{id}/commands`
#[utoipa::path(get, path = "/api/v1/devices/{id}/commands", tag = "Agent releases", summary = "Device commands", params(("id" = String, Path)), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn device_commands(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    device_scope(&state, &ctx, &id, "devices.view").await?;
    let rows: Vec<(String, String, String, String, Option<String>, DateTime<Utc>, DateTime<Utc>, Option<String>)> = sqlx::query_as(
        "SELECT id, kind, status, summary, created_by, created_at, updated_at, result FROM commands WHERE device_id = ? ORDER BY created_at DESC LIMIT 100",
    )
    .bind(&id)
    .fetch_all(&state.db)
    .await?;
    let items: Vec<Value> = rows
        .into_iter()
        .map(|(id, kind, status, summary, created_by, created_at, updated_at, result)| {
            json!({ "id": id, "kind": kind, "status": status, "summary": summary, "created_by": created_by, "created_at": created_at,
                    "updated_at": updated_at, "result": result.and_then(|r| serde_json::from_str::<Value>(&r).ok()) })
        })
        .collect();
    Ok(Json(json!({ "items": items })))
}

/// `POST /api/v1/devices/{id}/update` (step-up) — update one device to the newest release now.
#[utoipa::path(post, path = "/api/v1/devices/{id}/update", tag = "Agent releases", summary = "Update device", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn update_device(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    ctx.require_step_up()?;
    let (_, hostname) = device_scope(&state, &ctx, &id, PERM).await?;
    let latest = releases::latest_release(&state)
        .await?
        .ok_or_else(no_release)?;
    let created = releases::create_rollout(
        &state,
        &latest.id,
        &RolloutScope::Devices {
            ids: vec![id.clone()],
        },
        100,
        &ctx.user.id,
    )
    .await?;
    if created.targeted == 0 {
        return Err(ApiError::conflict(
            "not_needed",
            format!(
                "The device already runs {} or newer, or the release has no build for its platform",
                latest.version
            ),
        ));
    }
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("agent_rollout.created")
                .target("device", &id, &hostname)
                .details(json!({ "version": latest.version })),
        )
        .await;
    Ok(Json(
        json!({ "rollout_id": created.id, "version": latest.version, "targeted": created.targeted }),
    ))
}

fn no_release() -> ApiError {
    ApiError::conflict(
        "no_release",
        "No agent release has been imported. Rebuild and redeploy the server image to publish one.",
    )
}

// ------------------------------------------------------------------ agent updates overview

#[derive(Deserialize)]
pub struct UpdatesQuery {
    client_id: Option<String>,
    site_id: Option<String>,
}

/// One active device as the updates overview lists it.
#[derive(sqlx::FromRow)]
struct UpdateRow {
    id: String,
    hostname: String,
    display_name: Option<String>,
    os_family: String,
    os_name: String,
    arch: String,
    agent_version: String,
    online: bool,
    last_seen_at: Option<DateTime<Utc>>,
    site_id: String,
    site_name: String,
    client_id: String,
    client_name: String,
}

const UPDATE_ROW_SELECT: &str =
    "SELECT d.id, d.hostname, d.display_name, d.os_family, d.os_name, d.arch, d.agent_version,
        d.online, d.last_seen_at, d.site_id, s.name AS site_name, s.client_id, c.name AS client_name
 FROM devices d JOIN sites s ON s.id = d.site_id JOIN clients c ON c.id = s.client_id
 WHERE d.status = 'active'";

fn latest_json(latest: Option<&releases::Release>) -> Value {
    match latest {
        Some(r) => json!({
            "id": r.id, "version": r.version, "imported_at": r.imported_at,
            "platforms": r.manifest.files.iter().filter(|f| f.file.starts_with("rustrmm-agent")).map(|f| f.platform.clone()).collect::<Vec<_>>(),
        }),
        None => Value::Null,
    }
}

/// `GET /api/v1/agent-updates` — every device in scope against the latest agent release.
#[utoipa::path(get, path = "/api/v1/agent-updates", tag = "Agent releases", summary = "Agent update status", params(("client_id" = Option<String>, Query), ("site_id" = Option<String>, Query)), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn agent_updates(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Query(query): Query<UpdatesQuery>,
) -> ApiResult<Json<Value>> {
    ctx.require("devices.view")?;
    let latest = releases::latest_release(&state).await?;
    let attempts = match &latest {
        Some(r) => releases::attempts_for(&state, &r.id).await?,
        None => HashMap::new(),
    };
    let rows: Vec<UpdateRow> = sqlx::query_as(UPDATE_ROW_SELECT)
        .fetch_all(&state.db)
        .await?;
    let rows: Vec<UpdateRow> = rows
        .into_iter()
        .filter(|r| ctx.scope.can_site("devices.view", &r.client_id, &r.site_id))
        .filter(|r| query.client_id.as_ref().is_none_or(|c| c == &r.client_id))
        .filter(|r| query.site_id.as_ref().is_none_or(|s| s == &r.site_id))
        .collect();
    let policy = PolicyContext::load(&state.db, None).await?;
    let auto = releases::auto_update_map(&policy);
    let mut counts: HashMap<&'static str, i64> = HashMap::new();
    let mut auto_on = 0;
    let mut items = Vec::with_capacity(rows.len());
    for row in rows {
        let status = releases::status_for(
            latest.as_ref(),
            &row.os_family,
            &row.arch,
            &row.agent_version,
            attempts.get(&row.id),
            auto.get(&row.id).cloned().unwrap_or((true, None)),
        );
        let key = match status.state {
            UpdateState::Current => "current",
            UpdateState::Outdated => "outdated",
            UpdateState::Queued => "queued",
            UpdateState::Updating => "updating",
            UpdateState::Failed => "failed",
            UpdateState::Unsupported => "unsupported",
            UpdateState::Unknown => "unknown",
        };
        *counts.entry(key).or_default() += 1;
        if status.auto_update {
            auto_on += 1;
        }
        let mut item = serde_json::to_value(&status)?;
        if let Some(obj) = item.as_object_mut() {
            obj.insert("id".into(), json!(row.id));
            obj.insert("hostname".into(), json!(row.hostname));
            obj.insert("display_name".into(), json!(row.display_name));
            obj.insert("os_family".into(), json!(row.os_family));
            obj.insert("os_name".into(), json!(row.os_name));
            obj.insert("arch".into(), json!(row.arch));
            obj.insert("agent_version".into(), json!(row.agent_version));
            obj.insert("online".into(), json!(row.online));
            obj.insert("last_seen_at".into(), json!(row.last_seen_at));
            obj.insert("site_id".into(), json!(row.site_id));
            obj.insert("site_name".into(), json!(row.site_name));
            obj.insert("client_id".into(), json!(row.client_id));
            obj.insert("client_name".into(), json!(row.client_name));
        }
        items.push(item);
    }
    let count = |k: &str| counts.get(k).copied().unwrap_or(0);
    Ok(Json(json!({
        "server_version": rustrmm_common::VERSION,
        "latest": latest_json(latest.as_ref()),
        "summary": {
            "total": items.len(), "current": count("current"), "outdated": count("outdated"),
            "queued": count("queued"), "updating": count("updating"), "failed": count("failed"),
            "unsupported": count("unsupported"), "auto_update": auto_on,
        },
        "items": items,
    })))
}

/// `GET /api/v1/devices/{id}/agent-update` — one device against the latest agent release.
#[utoipa::path(get, path = "/api/v1/devices/{id}/agent-update", tag = "Agent releases", summary = "Device agent update status", params(("id" = String, Path)), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn device_agent_update(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<releases::DeviceUpdateStatus>> {
    device_scope(&state, &ctx, &id, "devices.view").await?;
    let row: Option<(String, String, String)> = sqlx::query_as(
        "SELECT os_family, arch, agent_version FROM devices WHERE id = ? AND status = 'active'",
    )
    .bind(&id)
    .fetch_optional(&state.db)
    .await?;
    let (os_family, arch, agent_version) = row.ok_or_else(|| ApiError::not_found("Device"))?;
    let latest = releases::latest_release(&state).await?;
    let attempts = match &latest {
        Some(r) => releases::attempts_for(&state, &r.id).await?,
        None => HashMap::new(),
    };
    let auto = match policies::effective_for_device(&state.db, &id).await? {
        Some(effective) => releases::auto_update_of(&effective),
        None => (true, None),
    };
    Ok(Json(releases::status_for(
        latest.as_ref(),
        &os_family,
        &arch,
        &agent_version,
        attempts.get(&id),
        auto,
    )))
}

#[derive(Deserialize)]
pub struct BulkUpdate {
    /// Devices to update now (ignored when `all_outdated` is set).
    #[serde(default)]
    device_ids: Vec<String>,
    /// Every outdated device in scope (optionally within `client_id` / `site_id`).
    #[serde(default)]
    all_outdated: bool,
    client_id: Option<String>,
    site_id: Option<String>,
}

/// `POST /api/v1/agent-updates/update` (step-up) — update devices to the latest release now,
/// whatever their automatic-update policy says.
#[utoipa::path(post, path = "/api/v1/agent-updates/update", tag = "Agent releases", summary = "Update agents now", request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 409, description = "No release imported")))]
pub async fn update_agents(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Json(req): Json<BulkUpdate>,
) -> ApiResult<Json<Value>> {
    ctx.require(PERM)?;
    ctx.require_step_up()?;
    if !req.all_outdated && req.device_ids.is_empty() {
        return Err(ApiError::validation(
            "Choose devices to update, or set all_outdated",
        ));
    }
    if req.device_ids.len() > 5000 {
        return Err(ApiError::validation("At most 5000 devices per request"));
    }
    let latest = releases::latest_release(&state)
        .await?
        .ok_or_else(no_release)?;
    let rows: Vec<UpdateRow> = sqlx::query_as(UPDATE_ROW_SELECT)
        .fetch_all(&state.db)
        .await?;
    let ids: Vec<String> = rows
        .into_iter()
        .filter(|r| ctx.scope.can_site(PERM, &r.client_id, &r.site_id))
        .filter(|r| {
            if req.all_outdated {
                req.client_id.as_ref().is_none_or(|c| c == &r.client_id)
                    && req.site_id.as_ref().is_none_or(|s| s == &r.site_id)
            } else {
                req.device_ids.contains(&r.id)
            }
        })
        .map(|r| r.id)
        .collect();
    if ids.is_empty() {
        return if req.all_outdated {
            Ok(Json(
                json!({ "rollout_id": null, "version": latest.version, "targeted": 0 }),
            ))
        } else {
            Err(ApiError::not_found("Device"))
        };
    }
    let devices = ids.len();
    let created = releases::create_rollout(
        &state,
        &latest.id,
        &RolloutScope::Devices { ids },
        100,
        &ctx.user.id,
    )
    .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("agent_rollout.created")
                .target("rollout", &created.id, &latest.version)
                .details(json!({ "devices": devices, "targeted": created.targeted, "all_outdated": req.all_outdated })),
        )
        .await;
    Ok(Json(json!({
        "rollout_id": created.id, "version": latest.version, "targeted": created.targeted,
    })))
}
