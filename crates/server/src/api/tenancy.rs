//! Clients and sites.

use std::collections::HashMap;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::FromRow;

use crate::auth::AuthCtx;
use crate::error::{ApiError, ApiResult};
use crate::rbac::perm;
use crate::setup::{validate_name, validate_timezone};
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct ClientRow {
    pub id: String,
    pub name: String,
    pub slug: String,
    pub notes: String,
    pub accent_color: Option<String>,
    /// Branding file id of the client's logo (exposed as `logo_url`).
    #[serde(skip)]
    pub logo_blob: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClientDto {
    #[serde(flatten)]
    pub row: ClientRow,
    pub logo_url: Option<String>,
    pub site_count: i64,
    pub device_count: i64,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct SiteRow {
    pub id: String,
    pub client_id: String,
    pub name: String,
    pub timezone: String,
    pub address: String,
    pub notes: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SiteDto {
    #[serde(flatten)]
    pub row: SiteRow,
    pub device_count: i64,
}

const CLIENT_COLUMNS: &str =
    "id, name, slug, notes, accent_color, logo_blob, created_at, updated_at";
const SITE_COLUMNS: &str = "id, client_id, name, timezone, address, notes, created_at, updated_at";

async fn all_sites(state: &AppState) -> ApiResult<Vec<SiteRow>> {
    Ok(sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {SITE_COLUMNS} FROM sites ORDER BY name COLLATE NOCASE"
    )))
    .fetch_all(&state.db)
    .await?)
}

/// Device counts per site (devices arrive in Phase 2; the table may not exist yet).
async fn device_counts(state: &AppState) -> HashMap<String, i64> {
    let rows: Result<Vec<(String, i64)>, _> =
        sqlx::query_as("SELECT site_id, COUNT(*) FROM devices GROUP BY site_id")
            .fetch_all(&state.db)
            .await;
    rows.map(|r| r.into_iter().collect()).unwrap_or_default()
}

fn visible_sites<'a>(ctx: &AuthCtx, sites: &'a [SiteRow], client_id: &str) -> Vec<&'a SiteRow> {
    sites
        .iter()
        .filter(|s| {
            s.client_id == client_id && ctx.scope.can_site(perm::CLIENTS_VIEW, &s.client_id, &s.id)
        })
        .collect()
}

fn client_dto(
    ctx: &AuthCtx,
    row: ClientRow,
    sites: &[SiteRow],
    devices: &HashMap<String, i64>,
) -> ClientDto {
    let visible = visible_sites(ctx, sites, &row.id);
    let device_count = visible
        .iter()
        .map(|s| devices.get(&s.id).copied().unwrap_or(0))
        .sum();
    ClientDto {
        logo_url: row.logo_blob.as_deref().map(crate::branding::file_url),
        row,
        site_count: visible.len() as i64,
        device_count,
    }
}

fn site_dto(row: SiteRow, devices: &HashMap<String, i64>) -> SiteDto {
    let device_count = devices.get(&row.id).copied().unwrap_or(0);
    SiteDto { row, device_count }
}

#[derive(Deserialize)]
pub struct ListQuery {
    search: Option<String>,
}

/// `GET /api/v1/clients`
#[utoipa::path(get, path = "/api/v1/clients", tag = "Clients & sites", summary = "List clients", responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn list_clients(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::CLIENTS_VIEW)?;
    let rows: Vec<ClientRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {CLIENT_COLUMNS} FROM clients ORDER BY name COLLATE NOCASE"
    )))
    .fetch_all(&state.db)
    .await?;
    let sites = all_sites(&state).await?;
    let devices = device_counts(&state).await;
    let needle = q
        .search
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_lowercase);
    let items: Vec<ClientDto> = rows
        .into_iter()
        .filter(|c| ctx.scope.can_see_client(perm::CLIENTS_VIEW, &c.id))
        .filter(|c| {
            needle
                .as_ref()
                .is_none_or(|n| c.name.to_lowercase().contains(n) || c.slug.contains(n))
        })
        .map(|c| client_dto(&ctx, c, &sites, &devices))
        .collect();
    Ok(Json(json!({ "items": items })))
}

async fn load_client(state: &AppState, id: &str) -> ApiResult<ClientRow> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {CLIENT_COLUMNS} FROM clients WHERE id = ?"
    )))
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| ApiError::not_found("Client"))
}

/// `GET /api/v1/clients/{id}`
#[utoipa::path(get, path = "/api/v1/clients/{id}", tag = "Clients & sites", summary = "Get client", params(("id" = String, Path)), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn get_client(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let row = load_client(&state, &id).await?;
    if !ctx.scope.can_see_client(perm::CLIENTS_VIEW, &row.id) {
        return Err(ApiError::not_found("Client"));
    }
    let sites = all_sites(&state).await?;
    let devices = device_counts(&state).await;
    let site_items: Vec<SiteDto> = visible_sites(&ctx, &sites, &row.id)
        .into_iter()
        .cloned()
        .map(|s| site_dto(s, &devices))
        .collect();
    let dto = client_dto(&ctx, row, &sites, &devices);
    let mut value = serde_json::to_value(dto)?;
    value["sites"] = serde_json::to_value(site_items)?;
    Ok(Json(value))
}

#[derive(Deserialize)]
pub struct CreateClient {
    name: String,
    #[serde(default)]
    notes: Option<String>,
}

fn validate_notes(notes: Option<&str>) -> ApiResult<String> {
    let notes = notes.unwrap_or("").trim();
    if notes.chars().count() > 4000 {
        return Err(ApiError::validation(
            "Notes must be at most 4000 characters",
        ));
    }
    Ok(notes.to_string())
}

fn validate_color(color: &str) -> ApiResult<String> {
    let c = color.trim();
    let valid =
        c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|ch| ch.is_ascii_hexdigit());
    if valid {
        Ok(c.to_ascii_lowercase())
    } else {
        Err(ApiError::validation("Accent colour must look like #1a2b3c"))
    }
}

async fn unique_slug(state: &AppState, name: &str, exclude_id: Option<&str>) -> ApiResult<String> {
    let base = rustrmm_common::slugify(name);
    for n in 1..1000 {
        let candidate = if n == 1 {
            base.clone()
        } else {
            format!("{base}-{n}")
        };
        let taken: Option<String> =
            sqlx::query_scalar("SELECT id FROM clients WHERE slug = ? AND id <> ?")
                .bind(&candidate)
                .bind(exclude_id.unwrap_or(""))
                .fetch_optional(&state.db)
                .await?;
        if taken.is_none() {
            return Ok(candidate);
        }
    }
    Err(ApiError::conflict(
        "slug_exhausted",
        "Could not derive a unique short name",
    ))
}

/// `POST /api/v1/clients`
#[utoipa::path(post, path = "/api/v1/clients", tag = "Clients & sites", summary = "Create client", request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn create_client(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Json(req): Json<CreateClient>,
) -> ApiResult<(StatusCode, Json<ClientDto>)> {
    ctx.require_global(perm::CLIENTS_MANAGE)?;
    let name = validate_name("Client name", &req.name, 80)?;
    let notes = validate_notes(req.notes.as_deref())?;
    let slug = unique_slug(&state, &name, None).await?;
    let now = rustrmm_common::now();
    let id = rustrmm_common::new_id();
    sqlx::query("INSERT INTO clients (id, name, slug, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(&id)
        .bind(&name)
        .bind(&slug)
        .bind(&notes)
        .bind(now)
        .bind(now)
        .execute(&state.db)
        .await
        .map_err(|e| match ApiError::from(e) {
            err if err.code == "already_exists" => ApiError::conflict("already_exists", "A client with that name already exists"),
            err => err,
        })?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("client.created")
                .target("client", &id, &name)
                .client(&id),
        )
        .await;
    state
        .events
        .publish("clients.changed", Some(id.clone()), json!({ "id": id }));
    let row = load_client(&state, &id).await?;
    Ok((
        StatusCode::CREATED,
        Json(ClientDto {
            row,
            logo_url: None,
            site_count: 0,
            device_count: 0,
        }),
    ))
}

#[derive(Deserialize)]
pub struct UpdateClient {
    name: Option<String>,
    notes: Option<String>,
    accent_color: Option<Option<String>>,
}

/// `PATCH /api/v1/clients/{id}`
#[utoipa::path(patch, path = "/api/v1/clients/{id}", tag = "Clients & sites", summary = "Update client", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn update_client(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(req): Json<UpdateClient>,
) -> ApiResult<Json<ClientDto>> {
    let current = load_client(&state, &id).await?;
    ctx.require_client(perm::CLIENTS_MANAGE, &id)?;
    let name = match &req.name {
        Some(n) => validate_name("Client name", n, 80)?,
        None => current.name.clone(),
    };
    let slug = if name != current.name {
        unique_slug(&state, &name, Some(&id)).await?
    } else {
        current.slug.clone()
    };
    let notes = match &req.notes {
        Some(n) => validate_notes(Some(n))?,
        None => current.notes.clone(),
    };
    let accent = match &req.accent_color {
        Some(Some(c)) => Some(validate_color(c)?),
        Some(None) => None,
        None => current.accent_color.clone(),
    };
    sqlx::query("UPDATE clients SET name = ?, slug = ?, notes = ?, accent_color = ?, updated_at = ? WHERE id = ?")
        .bind(&name)
        .bind(&slug)
        .bind(&notes)
        .bind(&accent)
        .bind(rustrmm_common::now())
        .bind(&id)
        .execute(&state.db)
        .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("client.updated")
                .target("client", &id, &name)
                .client(&id)
                .details(
                    json!({ "renamed_from": (name != current.name).then_some(&current.name) }),
                ),
        )
        .await;
    state
        .events
        .publish("clients.changed", Some(id.clone()), json!({ "id": id }));
    let sites = all_sites(&state).await?;
    let devices = device_counts(&state).await;
    let row = load_client(&state, &id).await?;
    Ok(Json(client_dto(&ctx, row, &sites, &devices)))
}

/// `DELETE /api/v1/clients/{id}` (step-up)
#[utoipa::path(delete, path = "/api/v1/clients/{id}", tag = "Clients & sites", summary = "Delete client", params(("id" = String, Path)), responses((status = 204, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn delete_client(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let current = load_client(&state, &id).await?;
    ctx.require_client(perm::CLIENTS_MANAGE, &id)?;
    ctx.require_step_up()?;
    let devices: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM devices d JOIN sites s ON s.id = d.site_id WHERE s.client_id = ?",
    )
    .bind(&id)
    .fetch_one(&state.db)
    .await
    .unwrap_or(0);
    if devices > 0 {
        return Err(ApiError::conflict(
            "client_not_empty",
            "Move or retire this client's devices before deleting it",
        ));
    }
    sqlx::query("DELETE FROM clients WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("client.deleted")
                .target("client", &id, &current.name)
                .client(&id),
        )
        .await;
    state.events.publish(
        "clients.changed",
        Some(id.clone()),
        json!({ "id": id, "deleted": true }),
    );
    Ok(StatusCode::NO_CONTENT)
}

// ------------------------------------------------------------------ sites

#[derive(Deserialize)]
pub struct SiteQuery {
    client_id: Option<String>,
}

/// `GET /api/v1/sites`
#[utoipa::path(get, path = "/api/v1/sites", tag = "Clients & sites", summary = "List sites", responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn list_sites(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<SiteQuery>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::CLIENTS_VIEW)?;
    let devices = device_counts(&state).await;
    let items: Vec<SiteDto> = all_sites(&state)
        .await?
        .into_iter()
        .filter(|s| q.client_id.as_ref().is_none_or(|c| &s.client_id == c))
        .filter(|s| ctx.scope.can_site(perm::CLIENTS_VIEW, &s.client_id, &s.id))
        .map(|s| site_dto(s, &devices))
        .collect();
    Ok(Json(json!({ "items": items })))
}

async fn load_site(state: &AppState, id: &str) -> ApiResult<SiteRow> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {SITE_COLUMNS} FROM sites WHERE id = ?"
    )))
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| ApiError::not_found("Site"))
}

#[derive(Deserialize)]
pub struct SiteInput {
    name: Option<String>,
    timezone: Option<String>,
    address: Option<String>,
    notes: Option<String>,
}

fn validate_address(address: Option<&str>) -> ApiResult<String> {
    let a = address.unwrap_or("").trim();
    if a.chars().count() > 500 {
        return Err(ApiError::validation(
            "Address must be at most 500 characters",
        ));
    }
    Ok(a.to_string())
}

/// `POST /api/v1/clients/{id}/sites`
#[utoipa::path(post, path = "/api/v1/clients/{id}/sites", tag = "Clients & sites", summary = "Create site", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn create_site(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(client_id): Path<String>,
    Json(req): Json<SiteInput>,
) -> ApiResult<(StatusCode, Json<SiteDto>)> {
    let client = load_client(&state, &client_id).await?;
    ctx.require_client(perm::SITES_MANAGE, &client_id)?;
    let name = validate_name("Site name", req.name.as_deref().unwrap_or(""), 80)?;
    let timezone = validate_timezone(req.timezone.as_deref())?;
    let address = validate_address(req.address.as_deref())?;
    let notes = validate_notes(req.notes.as_deref())?;
    let now = rustrmm_common::now();
    let id = rustrmm_common::new_id();
    sqlx::query(
        "INSERT INTO sites (id, client_id, name, timezone, address, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&client_id)
    .bind(&name)
    .bind(&timezone)
    .bind(&address)
    .bind(&notes)
    .bind(now)
    .bind(now)
    .execute(&state.db)
    .await
    .map_err(|e| match ApiError::from(e) {
        err if err.code == "already_exists" => ApiError::conflict("already_exists", "This client already has a site with that name"),
        err => err,
    })?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("site.created")
                .target("site", &id, &name)
                .client(&client_id)
                .site(&id)
                .details(json!({ "client": client.name })),
        )
        .await;
    state.events.publish(
        "clients.changed",
        Some(client_id.clone()),
        json!({ "id": client_id }),
    );
    let row = load_site(&state, &id).await?;
    Ok((
        StatusCode::CREATED,
        Json(SiteDto {
            row,
            device_count: 0,
        }),
    ))
}

/// `PATCH /api/v1/sites/{id}`
#[utoipa::path(patch, path = "/api/v1/sites/{id}", tag = "Clients & sites", summary = "Update site", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn update_site(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(req): Json<SiteInput>,
) -> ApiResult<Json<SiteDto>> {
    let current = load_site(&state, &id).await?;
    if !ctx
        .scope
        .can_site(perm::SITES_MANAGE, &current.client_id, &id)
    {
        return Err(ApiError::forbidden("Missing permission: sites.manage"));
    }
    let name = match &req.name {
        Some(n) => validate_name("Site name", n, 80)?,
        None => current.name.clone(),
    };
    let timezone = match &req.timezone {
        Some(tz) => validate_timezone(Some(tz))?,
        None => current.timezone.clone(),
    };
    let address = match &req.address {
        Some(a) => validate_address(Some(a))?,
        None => current.address.clone(),
    };
    let notes = match &req.notes {
        Some(n) => validate_notes(Some(n))?,
        None => current.notes.clone(),
    };
    sqlx::query("UPDATE sites SET name = ?, timezone = ?, address = ?, notes = ?, updated_at = ? WHERE id = ?")
        .bind(&name)
        .bind(&timezone)
        .bind(&address)
        .bind(&notes)
        .bind(rustrmm_common::now())
        .bind(&id)
        .execute(&state.db)
        .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("site.updated")
                .target("site", &id, &name)
                .client(&current.client_id)
                .site(&id),
        )
        .await;
    state.events.publish(
        "clients.changed",
        Some(current.client_id.clone()),
        json!({ "id": current.client_id }),
    );
    let devices = device_counts(&state).await;
    Ok(Json(site_dto(load_site(&state, &id).await?, &devices)))
}

/// `DELETE /api/v1/sites/{id}` (step-up)
#[utoipa::path(delete, path = "/api/v1/sites/{id}", tag = "Clients & sites", summary = "Delete site", params(("id" = String, Path)), responses((status = 204, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn delete_site(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let current = load_site(&state, &id).await?;
    ctx.require_client(perm::SITES_MANAGE, &current.client_id)?;
    ctx.require_step_up()?;
    let devices: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM devices WHERE site_id = ?")
        .bind(&id)
        .fetch_one(&state.db)
        .await
        .unwrap_or(0);
    if devices > 0 {
        return Err(ApiError::conflict(
            "site_not_empty",
            "Move or retire this site's devices before deleting it",
        ));
    }
    sqlx::query("DELETE FROM sites WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("site.deleted")
                .target("site", &id, &current.name)
                .client(&current.client_id)
                .site(&id),
        )
        .await;
    state.events.publish(
        "clients.changed",
        Some(current.client_id.clone()),
        json!({ "id": current.client_id }),
    );
    Ok(StatusCode::NO_CONTENT)
}
