//! Devices: fleet list, cockpit detail, inventory, metrics, timeline and lifecycle actions.

use std::collections::BTreeMap;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use rustrmm_proto::messages::{LiveMode, RequestInventory};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{FromRow, QueryBuilder, Sqlite};

use crate::agents::health::{HealthInputs, evaluate};
use crate::auth::AuthCtx;
use crate::error::{ApiError, ApiResult};
use crate::rbac::{AccessScope, perm};
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct DeviceRow {
    pub id: String,
    pub hostname: String,
    pub display_name: Option<String>,
    pub status: String,
    pub online: bool,
    pub os_family: String,
    pub os_name: String,
    pub os_version: String,
    pub arch: String,
    pub device_type: Option<String>,
    pub manufacturer: Option<String>,
    pub model: Option<String>,
    pub serial: Option<String>,
    pub domain: Option<String>,
    pub client_id: String,
    pub client_name: String,
    pub site_id: String,
    pub site_name: String,
    pub last_seen_at: Option<DateTime<Utc>>,
    pub last_user: Option<String>,
    pub last_ip: Option<String>,
    pub cpu_pct: Option<f64>,
    pub mem_pct: Option<f64>,
    pub disk_pct: Option<f64>,
    pub uptime_s: Option<i64>,
    pub health_score: Option<i64>,
    pub agent_version: String,
    pub enrolled_at: DateTime<Utc>,
    pub tags: String,
    pub replaces_device_id: Option<String>,
}

const DEVICE_SELECT: &str = "SELECT d.id, d.hostname, d.display_name, d.status, d.online, d.os_family, d.os_name, d.os_version, d.arch,
    d.device_type, d.manufacturer, d.model, d.serial, d.domain, s.client_id, c.name AS client_name, d.site_id, s.name AS site_name,
    d.last_seen_at, d.last_user, d.last_ip, d.cpu_pct, d.mem_pct, d.disk_pct, d.uptime_s, d.health_score, d.agent_version,
    d.enrolled_at, d.tags, d.replaces_device_id
    FROM devices d JOIN sites s ON s.id = d.site_id JOIN clients c ON c.id = s.client_id";

#[derive(Serialize)]
pub struct DeviceDto {
    #[serde(flatten)]
    row: DeviceRow,
    tags: Vec<String>,
    /// Device custom field values by key.
    custom_fields: serde_json::Map<String, Value>,
}

fn dto(row: DeviceRow, custom_fields: serde_json::Map<String, Value>) -> DeviceDto {
    let tags = serde_json::from_str(&row.tags).unwrap_or_default();
    DeviceDto {
        row,
        tags,
        custom_fields,
    }
}

/// Device list items (the `GET /devices` shape) for the given ids that the caller can see,
/// ordered by host name.
pub async fn summaries(
    state: &AppState,
    scope: &AccessScope,
    ids: &[String],
) -> anyhow::Result<Vec<DeviceDto>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut custom = crate::automation::custom_fields::device_values(&state.db).await?;
    let mut out = Vec::new();
    for chunk in ids.chunks(500) {
        let mut builder = QueryBuilder::<Sqlite>::new(DEVICE_SELECT);
        builder.push(" WHERE d.id IN (");
        let mut sep = builder.separated(", ");
        for id in chunk {
            sep.push_bind(id.clone());
        }
        builder.push(")");
        let rows: Vec<DeviceRow> = builder.build_query_as().fetch_all(&state.db).await?;
        out.extend(
            rows.into_iter()
                .filter(|r| visible(scope, r, perm::DEVICES_VIEW))
                .map(|r| {
                    let fields = custom.remove(&r.id).unwrap_or_default();
                    dto(r, fields)
                }),
        );
    }
    out.sort_by_key(|a| a.row.hostname.to_lowercase());
    Ok(out)
}

fn visible(scope: &AccessScope, row: &DeviceRow, permission: &str) -> bool {
    scope.can_site(permission, &row.client_id, &row.site_id)
}

#[derive(Debug, Deserialize, Default)]
pub struct DeviceQuery {
    client_id: Option<String>,
    site_id: Option<String>,
    status: Option<String>,
    os: Option<String>,
    online: Option<bool>,
    q: Option<String>,
    group_id: Option<String>,
    /// `compliant` | `non_compliant` | `pending_reboot` | `failed` | `missing_critical` |
    /// `not_scanned` (needs `patches.view`).
    patch_state: Option<String>,
}

/// `GET /api/v1/devices`
#[utoipa::path(get, path = "/api/v1/devices", tag = "Devices", summary = "List devices", responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn list(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<DeviceQuery>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::DEVICES_VIEW)?;
    let mut builder = QueryBuilder::<Sqlite>::new(DEVICE_SELECT);
    builder.push(" WHERE 1 = 1");
    match q.status.as_deref() {
        Some("all") => {}
        Some(status) => {
            builder
                .push(" AND d.status = ")
                .push_bind(status.to_string());
        }
        None => {
            builder.push(" AND d.status IN ('active', 'quarantined')");
        }
    }
    if let Some(client) = q.client_id.as_deref().filter(|s| !s.is_empty()) {
        builder
            .push(" AND s.client_id = ")
            .push_bind(client.to_string());
    }
    if let Some(site) = q.site_id.as_deref().filter(|s| !s.is_empty()) {
        builder
            .push(" AND d.site_id = ")
            .push_bind(site.to_string());
    }
    if let Some(os) = q.os.as_deref().filter(|s| !s.is_empty()) {
        builder
            .push(" AND d.os_family = ")
            .push_bind(os.to_string());
    }
    if let Some(online) = q.online {
        builder.push(" AND d.online = ").push_bind(online);
    }
    if let Some(text) = q.q.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let like = format!("%{}%", text.replace(['%', '_'], ""));
        builder
            .push(" AND (d.hostname LIKE ")
            .push_bind(like.clone())
            .push(" OR d.display_name LIKE ")
            .push_bind(like.clone())
            .push(" OR d.last_user LIKE ")
            .push_bind(like.clone())
            .push(" OR d.serial LIKE ")
            .push_bind(like.clone())
            .push(" OR d.last_ip LIKE ")
            .push_bind(like.clone())
            .push(" OR d.model LIKE ")
            .push_bind(like)
            .push(")");
    }
    builder.push(" ORDER BY d.hostname COLLATE NOCASE LIMIT 5000");
    let rows: Vec<DeviceRow> = builder.build_query_as().fetch_all(&state.db).await?;
    let members: Option<std::collections::HashSet<String>> =
        match q.group_id.as_deref().filter(|g| !g.is_empty()) {
            Some(group_id) => {
                let group = crate::automation::groups::load(&state.db, group_id)
                    .await?
                    .filter(|g| g.visible(&ctx.scope))
                    .ok_or_else(|| ApiError::not_found("Group"))?;
                Some(
                    crate::automation::groups::member_ids(&state.db, &group.id)
                        .await?
                        .into_iter()
                        .collect(),
                )
            }
            None => None,
        };
    let patch_filter = match q.patch_state.as_deref().filter(|s| !s.is_empty()) {
        Some(wanted) => {
            if !matches!(
                wanted,
                "compliant"
                    | "non_compliant"
                    | "pending_reboot"
                    | "failed"
                    | "missing_critical"
                    | "not_scanned"
            ) {
                return Err(ApiError::validation(
                    "patch_state must be compliant, non_compliant, pending_reboot, failed, missing_critical or not_scanned",
                ));
            }
            ctx.require(perm::PATCHES_VIEW)?;
            Some((
                wanted.to_string(),
                crate::patching::compliance::device_states(&state, &ctx).await?,
            ))
        }
        None => None,
    };
    let now = rustrmm_common::now();
    let patch_ok = |id: &str| -> bool {
        let Some((wanted, states)) = &patch_filter else {
            return true;
        };
        let st = states.get(id);
        match wanted.as_str() {
            "compliant" => st.is_some_and(|s| s.compliant(now)),
            "non_compliant" => st.is_some_and(|s| !s.compliant(now)),
            "pending_reboot" => st.is_some_and(|s| s.pending_reboot()),
            "failed" => st.is_some_and(|s| s.failed()),
            "missing_critical" => st.is_some_and(|s| s.missing("Critical") > 0),
            _ => st.is_none(),
        }
    };
    let mut custom = crate::automation::custom_fields::device_values(&state.db).await?;
    let items: Vec<DeviceDto> = rows
        .into_iter()
        .filter(|r| visible(&ctx.scope, r, perm::DEVICES_VIEW))
        .filter(|r| members.as_ref().is_none_or(|m| m.contains(&r.id)))
        .filter(|r| patch_ok(&r.id))
        .map(|r| {
            let fields = custom.remove(&r.id).unwrap_or_default();
            dto(r, fields)
        })
        .collect();
    Ok(Json(json!({ "items": items })))
}

async fn load(state: &AppState, ctx: &AuthCtx, id: &str, permission: &str) -> ApiResult<DeviceRow> {
    let row: DeviceRow = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{DEVICE_SELECT} WHERE d.id = ?"
    )))
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| ApiError::not_found("Device"))?;
    if !visible(&ctx.scope, &row, perm::DEVICES_VIEW) {
        return Err(ApiError::not_found("Device"));
    }
    if !visible(&ctx.scope, &row, permission) {
        return Err(ApiError::forbidden(format!(
            "Missing permission: {permission}"
        )));
    }
    Ok(row)
}

/// `GET /api/v1/devices/{id}`
#[utoipa::path(get, path = "/api/v1/devices/{id}", tag = "Devices", summary = "Get device", params(("id" = String, Path)), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn get(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let row = load(&state, &ctx, &id, perm::DEVICES_VIEW).await?;
    let sections: Vec<(String, String)> =
        sqlx::query_as("SELECT section, data FROM device_inventory WHERE device_id = ? AND section IN ('security', 'system')")
            .bind(&id)
            .fetch_all(&state.db)
            .await?;
    let mut security = None;
    let mut system = None;
    for (name, data) in sections {
        let v: Option<Value> = serde_json::from_str(&data).ok();
        if name == "security" {
            security = v
        } else {
            system = v
        }
    }
    let health = evaluate(&HealthInputs {
        online: row.online,
        offline_hours: row
            .last_seen_at
            .map(|t| (rustrmm_common::now() - t).num_minutes() as f64 / 60.0),
        disk_pct: row.disk_pct,
        mem_pct: row.mem_pct,
        security: security.as_ref(),
        system: system.as_ref(),
    });
    let notes: String = sqlx::query_scalar("SELECT notes FROM devices WHERE id = ?")
        .bind(&id)
        .fetch_one(&state.db)
        .await?;
    let custom_fields = crate::automation::custom_fields::entity_values(&state.db, &id).await?;
    let mut value = serde_json::to_value(dto(row, custom_fields))?;
    value["health"] = serde_json::to_value(health)?;
    value["notes"] = json!(notes);
    value["connected"] = json!(state.agents.is_online(&id));
    Ok(Json(value))
}

/// `GET /api/v1/devices/{id}/inventory`
#[utoipa::path(get, path = "/api/v1/devices/{id}/inventory", tag = "Devices", summary = "Inventory", params(("id" = String, Path)), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn inventory(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    load(&state, &ctx, &id, perm::DEVICES_VIEW).await?;
    let rows: Vec<(String, String, DateTime<Utc>)> = sqlx::query_as(
        "SELECT section, data, collected_at FROM device_inventory WHERE device_id = ?",
    )
    .bind(&id)
    .fetch_all(&state.db)
    .await?;
    let mut sections = BTreeMap::new();
    for (section, data, collected_at) in rows {
        let data: Value = serde_json::from_str(&data).unwrap_or(Value::Null);
        sections.insert(
            section,
            json!({ "data": data, "collected_at": collected_at }),
        );
    }
    Ok(Json(json!({ "sections": sections })))
}

#[derive(Deserialize)]
pub struct MetricsQuery {
    range: Option<String>,
}

#[derive(Serialize, FromRow)]
pub struct Point {
    ts: i64,
    cpu: Option<f64>,
    mem: Option<f64>,
    disk: Option<f64>,
    net_rx: Option<f64>,
    net_tx: Option<f64>,
}

/// `GET /api/v1/devices/{id}/metrics?range=1h|24h|7d|30d`
#[utoipa::path(get, path = "/api/v1/devices/{id}/metrics", tag = "Devices", summary = "Metrics", params(("id" = String, Path)), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn metrics(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Query(q): Query<MetricsQuery>,
) -> ApiResult<Json<Value>> {
    load(&state, &ctx, &id, perm::DEVICES_VIEW).await?;
    let (range, resolution, seconds) = match q.range.as_deref().unwrap_or("24h") {
        "1h" => ("1h", "raw", 3600),
        "7d" => ("7d", "15m", 7 * 86_400),
        "30d" => ("30d", "1h", 30 * 86_400),
        _ => ("24h", "raw", 86_400),
    };
    let from = chrono::Utc::now().timestamp() - seconds;
    let points: Vec<Point> = sqlx::query_as(
        "SELECT ts, cpu, mem, disk, net_rx, net_tx FROM device_metrics WHERE device_id = ? AND resolution = ? AND ts >= ? ORDER BY ts",
    )
    .bind(&id)
    .bind(resolution)
    .bind(from)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(
        json!({ "range": range, "resolution": resolution, "points": points }),
    ))
}

#[derive(Deserialize)]
pub struct TimelineQuery {
    cursor: Option<i64>,
    limit: Option<i64>,
}

#[derive(Serialize, FromRow)]
pub struct TimelineEntry {
    id: i64,
    at: DateTime<Utc>,
    kind: String,
    severity: String,
    summary: String,
    details: String,
}

/// `GET /api/v1/devices/{id}/timeline`
#[utoipa::path(get, path = "/api/v1/devices/{id}/timeline", tag = "Devices", summary = "Timeline", params(("id" = String, Path)), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn timeline(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Query(q): Query<TimelineQuery>,
) -> ApiResult<Json<Value>> {
    load(&state, &ctx, &id, perm::DEVICES_VIEW).await?;
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let rows: Vec<TimelineEntry> = sqlx::query_as(
        "SELECT id, at, kind, severity, summary, details FROM device_timeline WHERE device_id = ? AND id < ? ORDER BY id DESC LIMIT ?",
    )
    .bind(&id)
    .bind(q.cursor.unwrap_or(i64::MAX))
    .bind(limit + 1)
    .fetch_all(&state.db)
    .await?;
    let has_more = rows.len() as i64 > limit;
    let items: Vec<Value> = rows
        .into_iter()
        .take(limit as usize)
        .map(|e| {
            json!({ "id": e.id, "at": e.at, "kind": e.kind, "severity": e.severity, "summary": e.summary,
                    "details": serde_json::from_str::<Value>(&e.details).unwrap_or(Value::Null) })
        })
        .collect();
    let next_cursor = if has_more {
        items.last().and_then(|e| e["id"].as_i64())
    } else {
        None
    };
    Ok(Json(json!({ "items": items, "next_cursor": next_cursor })))
}

#[derive(Deserialize)]
pub struct UpdateDevice {
    display_name: Option<Option<String>>,
    notes: Option<String>,
    tags: Option<Vec<String>>,
    site_id: Option<String>,
}

/// `PATCH /api/v1/devices/{id}`
#[utoipa::path(patch, path = "/api/v1/devices/{id}", tag = "Devices", summary = "Update device", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn update(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(req): Json<UpdateDevice>,
) -> ApiResult<Json<Value>> {
    let row = load(&state, &ctx, &id, perm::DEVICES_MANAGE).await?;
    if let Some(name) = &req.display_name {
        let name = name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.chars().take(120).collect::<String>());
        sqlx::query("UPDATE devices SET display_name = ?, updated_at = ? WHERE id = ?")
            .bind(name)
            .bind(rustrmm_common::now())
            .bind(&id)
            .execute(&state.db)
            .await?;
    }
    if let Some(notes) = &req.notes {
        if notes.chars().count() > 10_000 {
            return Err(ApiError::validation(
                "Notes must be at most 10,000 characters",
            ));
        }
        sqlx::query("UPDATE devices SET notes = ?, updated_at = ? WHERE id = ?")
            .bind(notes)
            .bind(rustrmm_common::now())
            .bind(&id)
            .execute(&state.db)
            .await?;
    }
    if let Some(tags) = &req.tags {
        let mut clean: Vec<String> = tags
            .iter()
            .map(|t| t.trim().to_lowercase())
            .filter(|t| !t.is_empty() && t.len() <= 40)
            .collect();
        clean.sort();
        clean.dedup();
        clean.truncate(30);
        sqlx::query("UPDATE devices SET tags = ?, updated_at = ? WHERE id = ?")
            .bind(serde_json::to_string(&clean)?)
            .bind(rustrmm_common::now())
            .bind(&id)
            .execute(&state.db)
            .await?;
    }
    if let Some(site_id) = &req.site_id
        && site_id != &row.site_id
    {
        let target: Option<String> = sqlx::query_scalar("SELECT client_id FROM sites WHERE id = ?")
            .bind(site_id)
            .fetch_optional(&state.db)
            .await?;
        let target_client = target.ok_or_else(|| ApiError::validation("Unknown site"))?;
        if !ctx
            .scope
            .can_site(perm::DEVICES_MANAGE, &target_client, site_id)
        {
            return Err(ApiError::forbidden(
                "Missing permission on the destination site",
            ));
        }
        sqlx::query("UPDATE devices SET site_id = ?, updated_at = ? WHERE id = ?")
            .bind(site_id)
            .bind(rustrmm_common::now())
            .bind(&id)
            .execute(&state.db)
            .await?;
        crate::agents::timeline(
            &state.db,
            &id,
            "device.moved",
            "info",
            "Moved to another site",
            json!({ "from": row.site_id, "to": site_id }),
        )
        .await?;
    }
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("device.updated")
                .target("device", &id, &row.hostname)
                .client(&row.client_id)
                .site(&row.site_id),
        )
        .await;
    state.events.publish(
        "devices.changed",
        Some(row.client_id.clone()),
        json!({ "id": id }),
    );
    state.events.publish(
        "fleet.summary",
        Some(row.client_id.clone()),
        serde_json::Value::Null,
    );
    get(State(state), ctx, Path(id)).await
}

/// `POST /api/v1/devices/{id}/approve`
#[utoipa::path(post, path = "/api/v1/devices/{id}/approve", tag = "Devices", summary = "Approve", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn approve(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let row = load(&state, &ctx, &id, "agents.approve").await?;
    if row.status != "pending" {
        return Err(ApiError::conflict(
            "not_pending",
            "This device is not waiting for approval",
        ));
    }
    let now = rustrmm_common::now();
    let mut tx = state.db.begin().await?;
    sqlx::query("UPDATE devices SET status = 'active', approved_at = ?, approved_by = ?, updated_at = ? WHERE id = ?")
        .bind(now)
        .bind(&ctx.user.id)
        .bind(now)
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    if let Some(old) = &row.replaces_device_id {
        sqlx::query(
            "UPDATE devices SET status = 'revoked', online = 0, updated_at = ? WHERE id = ?",
        )
        .bind(now)
        .bind(old)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    if let Some(old) = &row.replaces_device_id {
        state
            .agents
            .disconnect(old, "replaced by a re-enrolled device");
    }
    crate::agents::timeline(
        &state.db,
        &id,
        "agent.approved",
        "notice",
        &format!("Approved by {}", ctx.user.name),
        json!({}),
    )
    .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("device.approved")
                .target("device", &id, &row.hostname)
                .client(&row.client_id)
                .site(&row.site_id)
                .details(json!({ "replaced": row.replaces_device_id })),
        )
        .await;
    state.events.publish(
        "devices.changed",
        Some(row.client_id.clone()),
        json!({ "id": id }),
    );
    state.events.publish(
        "fleet.summary",
        Some(row.client_id),
        serde_json::Value::Null,
    );
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /api/v1/devices/{id}/reject` — discards a pending enrollment.
#[utoipa::path(post, path = "/api/v1/devices/{id}/reject", tag = "Devices", summary = "Reject", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn reject(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let row = load(&state, &ctx, &id, "agents.approve").await?;
    if row.status != "pending" {
        return Err(ApiError::conflict(
            "not_pending",
            "This device is not waiting for approval",
        ));
    }
    sqlx::query("DELETE FROM devices WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("device.rejected")
                .target("device", &id, &row.hostname)
                .client(&row.client_id)
                .site(&row.site_id),
        )
        .await;
    state.events.publish(
        "devices.changed",
        Some(row.client_id.clone()),
        json!({ "id": id, "deleted": true }),
    );
    state.events.publish(
        "fleet.summary",
        Some(row.client_id),
        serde_json::Value::Null,
    );
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /api/v1/devices/{id}/revoke` (step-up) — the device key stops working immediately.
#[utoipa::path(post, path = "/api/v1/devices/{id}/revoke", tag = "Devices", summary = "Revoke", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn revoke(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let row = load(&state, &ctx, &id, "devices.delete").await?;
    ctx.require_step_up()?;
    sqlx::query("UPDATE devices SET status = 'revoked', online = 0, updated_at = ? WHERE id = ?")
        .bind(rustrmm_common::now())
        .bind(&id)
        .execute(&state.db)
        .await?;
    state.agents.tunnels.end_device(&id);
    state.agents.disconnect(&id, "device revoked");
    crate::agents::timeline(
        &state.db,
        &id,
        "agent.revoked",
        "warning",
        &format!("Revoked by {}", ctx.user.name),
        json!({}),
    )
    .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("device.revoked")
                .target("device", &id, &row.hostname)
                .client(&row.client_id)
                .site(&row.site_id),
        )
        .await;
    state.events.publish(
        "devices.changed",
        Some(row.client_id.clone()),
        json!({ "id": id }),
    );
    state.events.publish(
        "fleet.summary",
        Some(row.client_id),
        serde_json::Value::Null,
    );
    Ok(StatusCode::NO_CONTENT)
}

/// `DELETE /api/v1/devices/{id}` (step-up) — only revoked devices can be deleted.
#[utoipa::path(delete, path = "/api/v1/devices/{id}", tag = "Devices", summary = "Delete device", params(("id" = String, Path)), responses((status = 204, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn delete(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let row = load(&state, &ctx, &id, "devices.delete").await?;
    ctx.require_step_up()?;
    if row.status != "revoked" {
        return Err(ApiError::conflict(
            "not_revoked",
            "Revoke the device before deleting it",
        ));
    }
    sqlx::query("DELETE FROM devices WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("device.deleted")
                .target("device", &id, &row.hostname)
                .client(&row.client_id)
                .site(&row.site_id),
        )
        .await;
    state.events.publish(
        "devices.changed",
        Some(row.client_id.clone()),
        json!({ "id": id, "deleted": true }),
    );
    state.events.publish(
        "fleet.summary",
        Some(row.client_id),
        serde_json::Value::Null,
    );
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /api/v1/devices/{id}/live` — asks the agent to stream metrics every 2 s for 90 s.
#[utoipa::path(post, path = "/api/v1/devices/{id}/live", tag = "Devices", summary = "Live", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn live(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    load(&state, &ctx, &id, perm::DEVICES_VIEW).await?;
    let frame = rustrmm_proto::encode(&LiveMode {
        interval_secs: 2,
        duration_secs: 90,
    })
    .map_err(ApiError::internal)?;
    Ok(Json(json!({ "ok": state.agents.send(&id, frame) })))
}

/// `POST /api/v1/devices/{id}/inventory/refresh`
#[utoipa::path(post, path = "/api/v1/devices/{id}/inventory/refresh", tag = "Devices", summary = "Refresh inventory", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn refresh_inventory(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    load(&state, &ctx, &id, perm::DEVICES_VIEW).await?;
    let frame = rustrmm_proto::encode(&RequestInventory { sections: vec![] })
        .map_err(ApiError::internal)?;
    Ok(Json(json!({ "ok": state.agents.send(&id, frame) })))
}

/// `GET /api/v1/fleet/summary`
#[utoipa::path(get, path = "/api/v1/fleet/summary", tag = "Devices", summary = "Fleet summary", responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn fleet_summary(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<DeviceQuery>,
) -> ApiResult<Json<Value>> {
    let rows: Vec<DeviceRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{DEVICE_SELECT} WHERE d.status IN ('active', 'quarantined', 'pending')"
    )))
    .fetch_all(&state.db)
    .await?;
    let rows: Vec<&DeviceRow> = rows
        .iter()
        .filter(|r| visible(&ctx.scope, r, perm::DEVICES_VIEW))
        .filter(|r| q.client_id.as_ref().is_none_or(|c| &r.client_id == c))
        .filter(|r| q.site_id.as_ref().is_none_or(|s| &r.site_id == s))
        .collect();
    let managed: Vec<&&DeviceRow> = rows.iter().filter(|r| r.status != "pending").collect();
    let online = managed.iter().filter(|r| r.online).count();
    let pending = rows.iter().filter(|r| r.status == "pending").count();
    let scores: Vec<i64> = managed.iter().filter_map(|r| r.health_score).collect();
    let avg_health =
        (!scores.is_empty()).then(|| scores.iter().sum::<i64>() as f64 / scores.len() as f64);
    let (critical, warning) = alert_counts(&state, &ctx, &q).await?;
    let open_tickets = crate::tickets::open_count(
        &state,
        &ctx.scope,
        q.client_id.as_deref(),
        q.site_id.as_deref(),
    )
    .await?;
    Ok(Json(json!({
        "devices_total": managed.len(),
        "online": online,
        "offline": managed.len() - online,
        "pending_approval": pending,
        "critical_alerts": critical,
        "warning_alerts": warning,
        "alerts": { "critical": critical, "warning": warning },
        "patch_compliance_pct": null,
        "open_tickets": open_tickets,
        "average_health": avg_health,
    })))
}

/// Open and acknowledged critical/warning alerts the caller may see (filtered like the fleet
/// summary).
async fn alert_counts(state: &AppState, ctx: &AuthCtx, q: &DeviceQuery) -> ApiResult<(i64, i64)> {
    if !ctx.scope.has_anywhere(perm::ALERTS_VIEW) {
        return Ok((0, 0));
    }
    let rows: Vec<(String, Option<String>, String, i64)> = sqlx::query_as(
        "SELECT client_id, site_id, severity, COUNT(*) FROM alerts WHERE status <> 'resolved' AND severity IN ('critical', 'warning')
         GROUP BY client_id, site_id, severity",
    )
    .fetch_all(&state.db)
    .await?;
    let (mut critical, mut warning) = (0, 0);
    for (client, site, severity, n) in rows {
        let visible = match &site {
            Some(s) => ctx.scope.can_site(perm::ALERTS_VIEW, &client, s),
            None => ctx.scope.can_client(perm::ALERTS_VIEW, &client),
        };
        if !visible
            || q.client_id.as_ref().is_some_and(|c| *c != client)
            || q.site_id.as_ref().is_some_and(|s| site.as_ref() != Some(s))
        {
            continue;
        }
        if severity == "critical" {
            critical += n;
        } else {
            warning += n;
        }
    }
    Ok((critical, warning))
}
