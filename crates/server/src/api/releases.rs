//! Agent releases, rollouts and ad-hoc signed commands.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use rustrmm_proto::commands::{Command, ReleaseManifest};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::agents::releases::{self, RolloutScope};
use crate::auth::AuthCtx;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

const PERM: &str = "agents.update";

/// `GET /api/v1/agent-releases`
#[utoipa::path(get, path = "/api/v1/agent-releases", tag = "Agent releases", summary = "List agent releases", responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn list(State(state): State<AppState>, ctx: AuthCtx) -> ApiResult<Json<Value>> {
    ctx.require("devices.view")?;
    let rows: Vec<(String, String, Vec<u8>, DateTime<Utc>)> = sqlx::query_as(
        "SELECT id, version, manifest, imported_at FROM agent_releases ORDER BY imported_at DESC",
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
        .map(|(id, version, manifest, imported_at)| {
            let manifest: Option<ReleaseManifest> = serde_json::from_slice(&manifest).ok();
            let devices = versions.iter().find(|(v, _)| v == &version).map(|(_, n)| *n).unwrap_or(0);
            json!({ "id": id, "version": version, "imported_at": imported_at, "files": manifest.map(|m| m.files).unwrap_or_default(), "devices": devices })
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
    let id = releases::create_rollout(&state, &release_id, &req.scope, req.percent, &ctx.user.id)
        .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("agent_rollout.created")
                .target("rollout", &id, &version)
                .details(json!({ "scope": req.scope, "percent": req.percent })),
        )
        .await;
    Ok((StatusCode::CREATED, Json(json!({ "id": id }))))
}

/// `GET /api/v1/rollouts`
#[utoipa::path(get, path = "/api/v1/rollouts", tag = "Agent releases", summary = "List rollouts", responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn list_rollouts(State(state): State<AppState>, ctx: AuthCtx) -> ApiResult<Json<Value>> {
    ctx.require("devices.view")?;
    let rows: Vec<(String, String, String, i64, String, DateTime<Utc>)> = sqlx::query_as(
        "SELECT r.id, a.version, r.scope, r.percent, r.status, r.created_at FROM rollouts r JOIN agent_releases a ON a.id = r.release_id
         ORDER BY r.created_at DESC LIMIT 100",
    )
    .fetch_all(&state.db)
    .await?;
    let mut items = Vec::new();
    for (id, version, scope, percent, status, created_at) in rows {
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
            "percent": percent, "status": status, "created_at": created_at, "counts": counts,
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
    let release: Option<(String, String)> =
        sqlx::query_as("SELECT id, version FROM agent_releases ORDER BY imported_at DESC LIMIT 1")
            .fetch_optional(&state.db)
            .await?;
    let (release_id, version) = release
        .ok_or_else(|| ApiError::conflict("no_release", "No agent release has been imported"))?;
    let rollout = releases::create_rollout(
        &state,
        &release_id,
        &RolloutScope::Devices {
            ids: vec![id.clone()],
        },
        100,
        &ctx.user.id,
    )
    .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("agent_rollout.created")
                .target("device", &id, &hostname)
                .details(json!({ "version": version })),
        )
        .await;
    Ok(Json(json!({ "rollout_id": rollout, "version": version })))
}
