//! Users, roles and the permission catalog.

use std::collections::{HashMap, HashSet};

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::FromRow;

use crate::auth::{AuthCtx, password, session};
use crate::error::{ApiError, ApiResult};
use crate::rbac::{self, OWNER_ROLE_ID, perm};
use crate::setup::{validate_email, validate_name};
use crate::state::AppState;

// ------------------------------------------------------------------ users

#[derive(Debug, Clone, FromRow)]
struct UserRow {
    id: String,
    name: String,
    email: String,
    status: String,
    totp_enabled_at: Option<DateTime<Utc>>,
    last_login_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, FromRow)]
struct AssignmentRow {
    id: String,
    user_id: String,
    role_id: String,
    role_name: String,
    scope_type: String,
    scope_id: Option<String>,
    scope_name: Option<String>,
}

#[derive(Serialize)]
pub struct ScopeDto {
    #[serde(rename = "type")]
    kind: String,
    id: Option<String>,
    name: Option<String>,
}

#[derive(Serialize)]
pub struct AssignmentDto {
    id: String,
    role_id: String,
    role_name: String,
    scope: ScopeDto,
}

#[derive(Serialize)]
pub struct UserDto {
    id: String,
    name: String,
    email: String,
    status: String,
    mfa_enabled: bool,
    last_login_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
    assignments: Vec<AssignmentDto>,
}

const ASSIGNMENT_QUERY: &str = "SELECT ra.id, ra.user_id, ra.role_id, r.name AS role_name, ra.scope_type, ra.scope_id,
        CASE ra.scope_type
            WHEN 'client' THEN (SELECT name FROM clients WHERE id = ra.scope_id)
            WHEN 'site' THEN (SELECT s.name || ' (' || c.name || ')' FROM sites s JOIN clients c ON c.id = s.client_id WHERE s.id = ra.scope_id)
        END AS scope_name
    FROM role_assignments ra JOIN roles r ON r.id = ra.role_id";

async fn users_with_assignments(state: &AppState, only: Option<&str>) -> ApiResult<Vec<UserDto>> {
    let users: Vec<UserRow> = match only {
        Some(id) => sqlx::query_as(
            "SELECT id, name, email, status, totp_enabled_at, last_login_at, created_at FROM users WHERE id = ?",
        )
        .bind(id)
        .fetch_all(&state.db)
        .await?,
        None => sqlx::query_as(
            "SELECT id, name, email, status, totp_enabled_at, last_login_at, created_at FROM users ORDER BY name COLLATE NOCASE",
        )
        .fetch_all(&state.db)
        .await?,
    };
    let assignments: Vec<AssignmentRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{ASSIGNMENT_QUERY} ORDER BY r.name"
    )))
    .fetch_all(&state.db)
    .await?;
    let passkey_users: HashSet<String> =
        sqlx::query_scalar::<_, String>("SELECT DISTINCT user_id FROM webauthn_credentials")
            .fetch_all(&state.db)
            .await?
            .into_iter()
            .collect();
    let mut by_user: HashMap<String, Vec<AssignmentDto>> = HashMap::new();
    for a in assignments {
        by_user
            .entry(a.user_id.clone())
            .or_default()
            .push(AssignmentDto {
                id: a.id,
                role_id: a.role_id,
                role_name: a.role_name,
                scope: ScopeDto {
                    kind: a.scope_type,
                    id: a.scope_id,
                    name: a.scope_name,
                },
            });
    }
    Ok(users
        .into_iter()
        .map(|u| UserDto {
            mfa_enabled: u.totp_enabled_at.is_some() || passkey_users.contains(&u.id),
            assignments: by_user.remove(&u.id).unwrap_or_default(),
            id: u.id,
            name: u.name,
            email: u.email,
            status: u.status,
            last_login_at: u.last_login_at,
            created_at: u.created_at,
        })
        .collect())
}

/// `GET /api/v1/users`
#[utoipa::path(get, path = "/api/v1/users", tag = "Users & roles", summary = "List users", responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn list_users(State(state): State<AppState>, ctx: AuthCtx) -> ApiResult<Json<Value>> {
    ctx.require_global(perm::USERS_VIEW)?;
    Ok(Json(
        json!({ "items": users_with_assignments(&state, None).await? }),
    ))
}

#[derive(Debug, Deserialize)]
pub struct AssignmentInput {
    role_id: String,
    scope_type: String,
    scope_id: Option<String>,
}

/// Validates assignment inputs; returns normalised `(role_id, scope_type, scope_id)` tuples.
async fn validate_assignments(
    state: &AppState,
    ctx: &AuthCtx,
    inputs: &[AssignmentInput],
) -> ApiResult<Vec<(String, String, Option<String>)>> {
    if inputs.len() > 50 {
        return Err(ApiError::validation("Too many role assignments"));
    }
    let mut out = Vec::new();
    for input in inputs {
        let role: Option<String> = sqlx::query_scalar("SELECT id FROM roles WHERE id = ?")
            .bind(&input.role_id)
            .fetch_optional(&state.db)
            .await?;
        if role.is_none() {
            return Err(ApiError::validation(format!(
                "Unknown role {}",
                input.role_id
            )));
        }
        if input.role_id == OWNER_ROLE_ID {
            if !ctx.scope.is_owner {
                return Err(ApiError::forbidden("Only owners can grant the Owner role"));
            }
            if input.scope_type != "global" {
                return Err(ApiError::validation(
                    "The Owner role can only be granted globally",
                ));
            }
        }
        let scope_id = match input.scope_type.as_str() {
            "global" => None,
            "client" => {
                let id = input
                    .scope_id
                    .clone()
                    .ok_or_else(|| ApiError::validation("Client scope needs a client"))?;
                let exists: Option<String> =
                    sqlx::query_scalar("SELECT id FROM clients WHERE id = ?")
                        .bind(&id)
                        .fetch_optional(&state.db)
                        .await?;
                exists.ok_or_else(|| ApiError::validation("Unknown client in assignment"))?;
                Some(id)
            }
            "site" => {
                let id = input
                    .scope_id
                    .clone()
                    .ok_or_else(|| ApiError::validation("Site scope needs a site"))?;
                let exists: Option<String> =
                    sqlx::query_scalar("SELECT id FROM sites WHERE id = ?")
                        .bind(&id)
                        .fetch_optional(&state.db)
                        .await?;
                exists.ok_or_else(|| ApiError::validation("Unknown site in assignment"))?;
                Some(id)
            }
            _ => {
                return Err(ApiError::validation(
                    "scope_type must be global, client or site",
                ));
            }
        };
        let tuple = (input.role_id.clone(), input.scope_type.clone(), scope_id);
        if !out.contains(&tuple) {
            out.push(tuple);
        }
    }
    Ok(out)
}

async fn owner_count(state: &AppState) -> ApiResult<i64> {
    Ok(sqlx::query_scalar(
        "SELECT COUNT(DISTINCT ra.user_id) FROM role_assignments ra JOIN users u ON u.id = ra.user_id
         WHERE ra.role_id = ? AND ra.scope_type = 'global' AND u.status = 'active'",
    )
    .bind(OWNER_ROLE_ID)
    .fetch_one(&state.db)
    .await?)
}

async fn is_owner(state: &AppState, user_id: &str) -> ApiResult<bool> {
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM role_assignments WHERE user_id = ? AND role_id = ? AND scope_type = 'global'")
        .bind(user_id)
        .bind(OWNER_ROLE_ID)
        .fetch_one(&state.db)
        .await?;
    Ok(n > 0)
}

async fn replace_assignments(
    state: &AppState,
    user_id: &str,
    items: &[(String, String, Option<String>)],
) -> ApiResult<()> {
    let mut tx = state.db.begin().await?;
    sqlx::query("DELETE FROM role_assignments WHERE user_id = ?")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    let now = rustrmm_common::now();
    for (role_id, scope_type, scope_id) in items {
        sqlx::query("INSERT INTO role_assignments (id, user_id, role_id, scope_type, scope_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
            .bind(rustrmm_common::new_id())
            .bind(user_id)
            .bind(role_id)
            .bind(scope_type)
            .bind(scope_id)
            .bind(now)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

#[derive(Deserialize)]
pub struct CreateUser {
    name: String,
    email: String,
    password: String,
    #[serde(default)]
    assignments: Vec<AssignmentInput>,
}

/// `POST /api/v1/users`
#[utoipa::path(post, path = "/api/v1/users", tag = "Users & roles", summary = "Create user", request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn create_user(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Json(req): Json<CreateUser>,
) -> ApiResult<(StatusCode, Json<UserDto>)> {
    ctx.require_global(perm::USERS_MANAGE)?;
    let name = validate_name("Name", &req.name, 80)?;
    let email = validate_email(&req.email)?;
    if let Some(reason) = password::policy_violation(&req.password, &email, &name) {
        return Err(ApiError::validation(reason));
    }
    let assignments = validate_assignments(&state, &ctx, &req.assignments).await?;
    let pw = req.password.clone();
    let hash = tokio::task::spawn_blocking(move || password::hash(&pw)).await??;
    let id = rustrmm_common::new_id();
    let now = rustrmm_common::now();
    sqlx::query(
        "INSERT INTO users (id, email, name, password_hash, status, password_changed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?)",
    )
    .bind(&id)
    .bind(&email)
    .bind(&name)
    .bind(hash)
    .bind(now)
    .bind(now)
    .bind(now)
    .execute(&state.db)
    .await
    .map_err(|e| match ApiError::from(e) {
        err if err.code == "already_exists" => ApiError::conflict("already_exists", "A user with that email already exists"),
        err => err,
    })?;
    replace_assignments(&state, &id, &assignments).await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("user.created")
                .target("user", &id, &name)
                .details(json!({ "email": email, "assignments": assignments.len() })),
        )
        .await;
    let user = users_with_assignments(&state, Some(&id))
        .await?
        .pop()
        .ok_or_else(|| ApiError::not_found("User"))?;
    Ok((StatusCode::CREATED, Json(user)))
}

#[derive(Deserialize)]
pub struct UpdateUser {
    name: Option<String>,
    status: Option<String>,
    assignments: Option<Vec<AssignmentInput>>,
}

/// `PATCH /api/v1/users/{id}`
#[utoipa::path(patch, path = "/api/v1/users/{id}", tag = "Users & roles", summary = "Update user", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn update_user(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(req): Json<UpdateUser>,
) -> ApiResult<Json<UserDto>> {
    ctx.require_global(perm::USERS_MANAGE)?;
    let target = users_with_assignments(&state, Some(&id))
        .await?
        .pop()
        .ok_or_else(|| ApiError::not_found("User"))?;
    let target_is_owner = is_owner(&state, &id).await?;
    if target_is_owner && !ctx.scope.is_owner {
        return Err(ApiError::forbidden("Only owners can modify another owner"));
    }
    let mut changes = serde_json::Map::new();

    if let Some(name) = &req.name {
        let name = validate_name("Name", name, 80)?;
        sqlx::query("UPDATE users SET name = ?, updated_at = ? WHERE id = ?")
            .bind(&name)
            .bind(rustrmm_common::now())
            .bind(&id)
            .execute(&state.db)
            .await?;
        changes.insert("name".into(), json!(name));
    }

    if let Some(status) = &req.status {
        if status != "active" && status != "disabled" {
            return Err(ApiError::validation("status must be active or disabled"));
        }
        if status == "disabled" {
            if id == ctx.user.id {
                return Err(ApiError::conflict(
                    "self_disable",
                    "You cannot disable your own account",
                ));
            }
            if target_is_owner && owner_count(&state).await? <= 1 {
                return Err(ApiError::conflict(
                    "last_owner",
                    "The last owner cannot be disabled",
                ));
            }
        }
        sqlx::query("UPDATE users SET status = ?, updated_at = ? WHERE id = ?")
            .bind(status)
            .bind(rustrmm_common::now())
            .bind(&id)
            .execute(&state.db)
            .await?;
        if status == "disabled" {
            session::revoke_all_for_user(&state.db, &id, None).await?;
        }
        changes.insert("status".into(), json!(status));
    }

    if let Some(inputs) = &req.assignments {
        let items = validate_assignments(&state, &ctx, inputs).await?;
        let keeps_owner = items
            .iter()
            .any(|(r, s, _)| r == OWNER_ROLE_ID && s == "global");
        if target_is_owner && !keeps_owner {
            if !ctx.scope.is_owner {
                return Err(ApiError::forbidden("Only owners can remove the Owner role"));
            }
            if owner_count(&state).await? <= 1 {
                return Err(ApiError::conflict(
                    "last_owner",
                    "The last owner must keep the Owner role",
                ));
            }
        }
        replace_assignments(&state, &id, &items).await?;
        changes.insert("assignments".into(), json!(items.len()));
    }

    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("user.updated")
                .target("user", &id, &target.name)
                .details(Value::Object(changes)),
        )
        .await;
    let user = users_with_assignments(&state, Some(&id))
        .await?
        .pop()
        .ok_or_else(|| ApiError::not_found("User"))?;
    Ok(Json(user))
}

/// `DELETE /api/v1/users/{id}` (step-up)
#[utoipa::path(delete, path = "/api/v1/users/{id}", tag = "Users & roles", summary = "Delete user", params(("id" = String, Path)), responses((status = 204, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn delete_user(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    ctx.require_global(perm::USERS_MANAGE)?;
    ctx.require_step_up()?;
    if id == ctx.user.id {
        return Err(ApiError::conflict(
            "self_delete",
            "You cannot delete your own account",
        ));
    }
    let target = users_with_assignments(&state, Some(&id))
        .await?
        .pop()
        .ok_or_else(|| ApiError::not_found("User"))?;
    if is_owner(&state, &id).await? {
        if !ctx.scope.is_owner {
            return Err(ApiError::forbidden("Only owners can delete an owner"));
        }
        if owner_count(&state).await? <= 1 {
            return Err(ApiError::conflict(
                "last_owner",
                "The last owner cannot be deleted",
            ));
        }
    }
    sqlx::query("DELETE FROM users WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("user.deleted")
                .target("user", &id, &target.name)
                .details(json!({ "email": target.email })),
        )
        .await;
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /api/v1/users/{id}/reset-mfa` (step-up)
#[utoipa::path(post, path = "/api/v1/users/{id}/reset-mfa", tag = "Users & roles", summary = "Reset mfa", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn reset_mfa(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    ctx.require_global(perm::USERS_MANAGE)?;
    ctx.require_step_up()?;
    let target = users_with_assignments(&state, Some(&id))
        .await?
        .pop()
        .ok_or_else(|| ApiError::not_found("User"))?;
    if is_owner(&state, &id).await? && !ctx.scope.is_owner {
        return Err(ApiError::forbidden(
            "Only owners can reset another owner's MFA",
        ));
    }
    let mut tx = state.db.begin().await?;
    sqlx::query("UPDATE users SET totp_secret = NULL, totp_enabled_at = NULL, totp_last_step = NULL, updated_at = ? WHERE id = ?")
        .bind(rustrmm_common::now())
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM webauthn_credentials WHERE user_id = ?")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM recovery_codes WHERE user_id = ?")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    session::revoke_all_for_user(&state.db, &id, None).await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("user.mfa_reset")
                .target("user", &id, &target.name),
        )
        .await;
    Ok(StatusCode::NO_CONTENT)
}

// ------------------------------------------------------------------ roles

#[derive(Debug, Clone, FromRow)]
struct RoleRow {
    id: String,
    name: String,
    description: String,
    builtin: bool,
}

#[derive(Serialize)]
pub struct RoleDto {
    id: String,
    name: String,
    description: String,
    builtin: bool,
    permissions: Vec<String>,
    user_count: i64,
}

async fn roles(state: &AppState, only: Option<&str>) -> ApiResult<Vec<RoleDto>> {
    let rows: Vec<RoleRow> = match only {
        Some(id) => sqlx::query_as("SELECT id, name, description, builtin FROM roles WHERE id = ?").bind(id).fetch_all(&state.db).await?,
        None => sqlx::query_as("SELECT id, name, description, builtin FROM roles ORDER BY builtin DESC, name COLLATE NOCASE")
            .fetch_all(&state.db)
            .await?,
    };
    let perms: Vec<(String, String)> =
        sqlx::query_as("SELECT role_id, permission FROM role_permissions")
            .fetch_all(&state.db)
            .await?;
    let counts: Vec<(String, i64)> = sqlx::query_as(
        "SELECT role_id, COUNT(DISTINCT user_id) FROM role_assignments GROUP BY role_id",
    )
    .fetch_all(&state.db)
    .await?;
    let counts: HashMap<String, i64> = counts.into_iter().collect();
    let mut by_role: HashMap<String, Vec<String>> = HashMap::new();
    for (role, p) in perms {
        by_role.entry(role).or_default().push(p);
    }
    Ok(rows
        .into_iter()
        .map(|r| {
            let mut permissions = by_role.remove(&r.id).unwrap_or_default();
            permissions.sort();
            RoleDto {
                user_count: counts.get(&r.id).copied().unwrap_or(0),
                permissions,
                id: r.id,
                name: r.name,
                description: r.description,
                builtin: r.builtin,
            }
        })
        .collect())
}

/// `GET /api/v1/roles`
#[utoipa::path(get, path = "/api/v1/roles", tag = "Users & roles", summary = "List roles", responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn list_roles(State(state): State<AppState>, ctx: AuthCtx) -> ApiResult<Json<Value>> {
    if !(ctx.scope.has_global(perm::USERS_VIEW) || ctx.scope.has_global(perm::ROLES_MANAGE)) {
        return Err(ApiError::forbidden("Missing permission: users.view"));
    }
    Ok(Json(json!({ "items": roles(&state, None).await? })))
}

#[derive(Deserialize)]
pub struct RoleInput {
    name: Option<String>,
    description: Option<String>,
    permissions: Option<Vec<String>>,
}

fn validate_permissions(perms: &[String]) -> ApiResult<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for p in perms {
        if !rbac::is_known(p) {
            return Err(ApiError::validation(format!("Unknown permission {p}")));
        }
        if !out.contains(p) {
            out.push(p.clone());
        }
    }
    Ok(out)
}

async fn write_role_permissions(
    state: &AppState,
    role_id: &str,
    perms: &[String],
) -> ApiResult<()> {
    let mut tx = state.db.begin().await?;
    sqlx::query("DELETE FROM role_permissions WHERE role_id = ?")
        .bind(role_id)
        .execute(&mut *tx)
        .await?;
    for p in perms {
        sqlx::query("INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)")
            .bind(role_id)
            .bind(p)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// `POST /api/v1/roles`
#[utoipa::path(post, path = "/api/v1/roles", tag = "Users & roles", summary = "Create role", request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn create_role(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Json(req): Json<RoleInput>,
) -> ApiResult<(StatusCode, Json<RoleDto>)> {
    ctx.require_global(perm::ROLES_MANAGE)?;
    let name = validate_name("Role name", req.name.as_deref().unwrap_or(""), 60)?;
    let description = req
        .description
        .as_deref()
        .unwrap_or("")
        .trim()
        .chars()
        .take(400)
        .collect::<String>();
    let perms = validate_permissions(req.permissions.as_deref().unwrap_or(&[]))?;
    let id = rustrmm_common::new_id();
    let now = rustrmm_common::now();
    sqlx::query("INSERT INTO roles (id, name, description, builtin, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)")
        .bind(&id)
        .bind(&name)
        .bind(&description)
        .bind(now)
        .bind(now)
        .execute(&state.db)
        .await
        .map_err(|e| match ApiError::from(e) {
            err if err.code == "already_exists" => ApiError::conflict("already_exists", "A role with that name already exists"),
            err => err,
        })?;
    write_role_permissions(&state, &id, &perms).await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("role.created")
                .target("role", &id, &name)
                .details(json!({ "permissions": perms })),
        )
        .await;
    let role = roles(&state, Some(&id))
        .await?
        .pop()
        .ok_or_else(|| ApiError::not_found("Role"))?;
    Ok((StatusCode::CREATED, Json(role)))
}

/// `PATCH /api/v1/roles/{id}`
#[utoipa::path(patch, path = "/api/v1/roles/{id}", tag = "Users & roles", summary = "Update role", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn update_role(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(req): Json<RoleInput>,
) -> ApiResult<Json<RoleDto>> {
    ctx.require_global(perm::ROLES_MANAGE)?;
    let current = roles(&state, Some(&id))
        .await?
        .pop()
        .ok_or_else(|| ApiError::not_found("Role"))?;
    if current.builtin {
        return Err(ApiError::conflict(
            "builtin_role",
            "Built-in roles cannot be modified; create a custom role instead",
        ));
    }
    let name = match &req.name {
        Some(n) => validate_name("Role name", n, 60)?,
        None => current.name.clone(),
    };
    let description = req
        .description
        .clone()
        .unwrap_or(current.description.clone())
        .trim()
        .chars()
        .take(400)
        .collect::<String>();
    sqlx::query("UPDATE roles SET name = ?, description = ?, updated_at = ? WHERE id = ?")
        .bind(&name)
        .bind(&description)
        .bind(rustrmm_common::now())
        .bind(&id)
        .execute(&state.db)
        .await?;
    let mut details = json!({});
    if let Some(perms) = &req.permissions {
        let perms = validate_permissions(perms)?;
        write_role_permissions(&state, &id, &perms).await?;
        details = json!({ "permissions": perms });
    }
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("role.updated")
                .target("role", &id, &name)
                .details(details),
        )
        .await;
    let role = roles(&state, Some(&id))
        .await?
        .pop()
        .ok_or_else(|| ApiError::not_found("Role"))?;
    Ok(Json(role))
}

/// `DELETE /api/v1/roles/{id}`
#[utoipa::path(delete, path = "/api/v1/roles/{id}", tag = "Users & roles", summary = "Delete role", params(("id" = String, Path)), responses((status = 204, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn delete_role(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    ctx.require_global(perm::ROLES_MANAGE)?;
    let current = roles(&state, Some(&id))
        .await?
        .pop()
        .ok_or_else(|| ApiError::not_found("Role"))?;
    if current.builtin {
        return Err(ApiError::conflict(
            "builtin_role",
            "Built-in roles cannot be deleted",
        ));
    }
    sqlx::query("DELETE FROM roles WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("role.deleted").target("role", &id, &current.name),
        )
        .await;
    Ok(StatusCode::NO_CONTENT)
}

/// `GET /api/v1/permissions`
#[utoipa::path(get, path = "/api/v1/permissions", tag = "Users & roles", summary = "List permissions", responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn list_permissions(_ctx: AuthCtx) -> ApiResult<Json<Value>> {
    Ok(Json(json!({ "items": rbac::CATALOG })))
}
