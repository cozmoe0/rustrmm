//! Script variables: named values scoped global, client or site that reach scripts as
//! environment variables. Secret values are field-encrypted and never returned.

use std::collections::HashMap;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use rustrmm_proto::scripts::{is_reserved_env_name, valid_env_name};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::audit::AuditEntry;
use crate::auth::AuthCtx;
use crate::error::{ApiError, ApiResult};
use crate::rbac::AccessScope;
use crate::state::AppState;

const VIEW: &str = "scripts.view";
const MANAGE: &str = "scripts.manage";
pub const MAX_VALUE_LEN: usize = 8192;

pub fn secret_aad(id: &str) -> String {
    format!("variables/secret_value/{id}")
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct VariableRow {
    id: String,
    scope: String,
    scope_id: Option<String>,
    scope_name: Option<String>,
    scope_client_id: Option<String>,
    name: String,
    value: Option<String>,
    secret: bool,
    description: String,
    updated_at: DateTime<Utc>,
    updated_by_name: String,
}

const SELECT: &str = "SELECT v.id, v.scope, v.scope_id,
    CASE v.scope WHEN 'client' THEN (SELECT name FROM clients WHERE id = v.scope_id)
                 WHEN 'site' THEN (SELECT name FROM sites WHERE id = v.scope_id) ELSE 'Global' END AS scope_name,
    CASE v.scope WHEN 'client' THEN v.scope_id
                 WHEN 'site' THEN (SELECT client_id FROM sites WHERE id = v.scope_id) ELSE NULL END AS scope_client_id,
    v.name, v.value, v.secret, v.description, v.updated_at, v.updated_by_name FROM variables v";

impl VariableRow {
    fn to_json(&self) -> Value {
        json!({
            "id": self.id, "scope": self.scope, "scope_id": self.scope_id, "scope_name": self.scope_name,
            "name": self.name, "value": if self.secret { Value::Null } else { json!(self.value) },
            "secret": self.secret, "description": self.description, "updated_at": self.updated_at,
            "updated_by_name": self.updated_by_name,
        })
    }

    fn allowed(&self, scope: &AccessScope, permission: &str, manage: bool) -> bool {
        allowed(
            scope,
            permission,
            &self.scope,
            self.scope_client_id.as_deref(),
            self.scope_id.as_deref(),
            manage,
        )
    }
}

fn allowed(
    access: &AccessScope,
    permission: &str,
    scope: &str,
    client: Option<&str>,
    scope_id: Option<&str>,
    manage: bool,
) -> bool {
    match (scope, client, scope_id) {
        ("global", _, _) if manage => access.has_global(permission),
        ("global", _, _) => access.has_anywhere(permission),
        ("client", Some(c), _) if manage => access.can_client(permission, c),
        ("client", Some(c), _) => access.can_see_client(permission, c),
        ("site", Some(c), Some(s)) => access.can_site(permission, c, s),
        _ => false,
    }
}

/// One variable as a script sees it.
#[derive(Debug, Clone)]
pub struct ResolvedVariable {
    pub name: String,
    pub value: String,
    pub secret: bool,
}

/// Variables for a device: global, then client, then site; the most specific scope wins.
pub async fn for_device(
    state: &AppState,
    client_id: &str,
    site_id: &str,
) -> anyhow::Result<Vec<ResolvedVariable>> {
    let rows: Vec<(String, String, String, Option<String>, Option<Vec<u8>>, bool)> = sqlx::query_as(
        "SELECT id, scope, name, value, secret_value, secret FROM variables
         WHERE scope = 'global' OR (scope = 'client' AND scope_id = ?) OR (scope = 'site' AND scope_id = ?)
         ORDER BY CASE scope WHEN 'global' THEN 0 WHEN 'client' THEN 1 ELSE 2 END, name",
    )
    .bind(client_id)
    .bind(site_id)
    .fetch_all(&state.db)
    .await?;
    let mut by_name: HashMap<String, usize> = HashMap::new();
    let mut out: Vec<ResolvedVariable> = Vec::new();
    for (id, _scope, name, value, secret_value, secret) in rows {
        let value = if secret {
            match secret_value {
                Some(blob) => match state.cipher.decrypt_string(&blob, &secret_aad(&id)) {
                    Ok(v) => v.to_string(),
                    Err(e) => {
                        tracing::warn!(variable = %id, error = %e, "secret variable could not be decrypted; skipped");
                        continue;
                    }
                },
                None => continue,
            }
        } else {
            value.unwrap_or_default()
        };
        let resolved = ResolvedVariable {
            name: name.clone(),
            value,
            secret,
        };
        match by_name.get(&name.to_ascii_uppercase()) {
            Some(&i) => out[i] = resolved,
            None => {
                by_name.insert(name.to_ascii_uppercase(), out.len());
                out.push(resolved);
            }
        }
    }
    Ok(out)
}

#[derive(Deserialize)]
pub struct ListQuery {
    scope: Option<String>,
    scope_id: Option<String>,
}

/// `GET /api/v1/variables?scope=&scope_id=`
#[utoipa::path(get, path = "/api/v1/variables", tag = "Scripts", summary = "List variables", responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn list(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Value>> {
    ctx.require(VIEW)?;
    let rows: Vec<VariableRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{SELECT} ORDER BY CASE v.scope WHEN 'global' THEN 0 WHEN 'client' THEN 1 ELSE 2 END, v.name COLLATE NOCASE"
    )))
    .fetch_all(&state.db)
    .await?;
    let items: Vec<Value> = rows
        .iter()
        .filter(|r| {
            q.scope
                .as_deref()
                .filter(|s| !s.is_empty())
                .is_none_or(|s| r.scope == s)
        })
        .filter(|r| {
            q.scope_id
                .as_deref()
                .filter(|s| !s.is_empty())
                .is_none_or(|s| r.scope_id.as_deref() == Some(s))
        })
        .filter(|r| r.allowed(&ctx.scope, VIEW, false))
        .map(VariableRow::to_json)
        .collect();
    Ok(Json(json!({ "items": items })))
}

#[derive(Deserialize)]
pub struct VariableBody {
    scope: String,
    #[serde(default)]
    scope_id: Option<String>,
    name: String,
    #[serde(default)]
    value: Option<String>,
    #[serde(default)]
    secret: bool,
    #[serde(default)]
    description: String,
}

/// Validates name, value and scope; returns the scope's client id (for permission checks).
async fn check(
    state: &AppState,
    ctx: &AuthCtx,
    body: &VariableBody,
    value_required: bool,
) -> ApiResult<(Option<String>, Option<String>)> {
    let name = body.name.trim();
    if !valid_env_name(name) {
        return Err(ApiError::validation(
            "Name must match [A-Za-z_][A-Za-z0-9_]{0,63}",
        ));
    }
    if is_reserved_env_name(name) {
        return Err(ApiError::validation(format!("{name} is a reserved name")));
    }
    match &body.value {
        None if value_required => return Err(ApiError::validation("A value is required")),
        Some(v) if v.len() > MAX_VALUE_LEN || v.contains('\0') => {
            return Err(ApiError::validation(format!(
                "Values must be at most {MAX_VALUE_LEN} bytes without NUL characters"
            )));
        }
        _ => {}
    }
    if body.description.chars().count() > 1000 {
        return Err(ApiError::validation("Description is too long"));
    }
    let scope_id = body.scope_id.clone().filter(|s| !s.is_empty());
    let client = match (body.scope.as_str(), &scope_id) {
        ("global", None) => None,
        ("global", Some(_)) => {
            return Err(ApiError::validation("Global variables have no scope_id"));
        }
        (_, None) => return Err(ApiError::validation("scope_id is required")),
        ("client", Some(id)) => {
            let found: Option<String> = sqlx::query_scalar("SELECT id FROM clients WHERE id = ?")
                .bind(id)
                .fetch_optional(&state.db)
                .await?;
            Some(found.ok_or_else(|| ApiError::validation("Unknown client"))?)
        }
        ("site", Some(id)) => {
            let found: Option<String> =
                sqlx::query_scalar("SELECT client_id FROM sites WHERE id = ?")
                    .bind(id)
                    .fetch_optional(&state.db)
                    .await?;
            Some(found.ok_or_else(|| ApiError::validation("Unknown site"))?)
        }
        _ => return Err(ApiError::validation("scope must be global, client or site")),
    };
    if !allowed(
        &ctx.scope,
        MANAGE,
        &body.scope,
        client.as_deref(),
        scope_id.as_deref(),
        true,
    ) {
        return Err(ApiError::forbidden("Missing permission: scripts.manage")
            .with_details(json!({ "permission": MANAGE })));
    }
    Ok((client, scope_id))
}

fn audit_entry(ctx: &AuthCtx, action: &'static str, row: &VariableRow) -> AuditEntry {
    // Values never reach the audit log, secret or not.
    let mut entry = ctx
        .audit(action)
        .target("variable", &row.id, &row.name)
        .details(json!({ "scope": row.scope, "scope_id": row.scope_id, "secret": row.secret }));
    if let Some(c) = &row.scope_client_id {
        entry = entry.client(c);
    }
    if row.scope == "site"
        && let Some(s) = &row.scope_id
    {
        entry = entry.site(s);
    }
    entry
}

async fn load(state: &AppState, id: &str) -> ApiResult<VariableRow> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!("{SELECT} WHERE v.id = ?")))
        .bind(id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| ApiError::not_found("Variable"))
}

/// `POST /api/v1/variables`
#[utoipa::path(post, path = "/api/v1/variables", tag = "Scripts", summary = "Create variable", request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn create(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Json(body): Json<VariableBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    ctx.require(MANAGE)?;
    let (_, scope_id) = check(&state, &ctx, &body, true).await?;
    let id = rustrmm_common::new_id();
    let now = rustrmm_common::now();
    let value = body.value.clone().unwrap_or_default();
    let (plain, encrypted) = if body.secret {
        (
            None,
            Some(state.cipher.encrypt_str(&value, &secret_aad(&id))),
        )
    } else {
        (Some(value), None)
    };
    sqlx::query("INSERT INTO variables (id, scope, scope_id, name, value, secret_value, secret, description, updated_by, updated_by_name, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(&id)
        .bind(&body.scope)
        .bind(&scope_id)
        .bind(body.name.trim())
        .bind(plain)
        .bind(encrypted)
        .bind(body.secret)
        .bind(body.description.trim())
        .bind(&ctx.user.id)
        .bind(&ctx.user.name)
        .bind(now)
        .bind(now)
        .execute(&state.db)
        .await
        .map_err(|e| match ApiError::from(e) {
            e if e.code == "already_exists" => ApiError::conflict(
                "already_exists",
                "A variable with this name already exists in this scope",
            ),
            e => e,
        })?;
    let row = load(&state, &id).await?;
    state
        .audit
        .record_or_log(&state.db, audit_entry(&ctx, "variable.created", &row))
        .await;
    // `script` checks embed variables in the monitoring configuration.
    crate::monitoring::push_soon(&state);
    Ok((StatusCode::CREATED, Json(row.to_json())))
}

/// `PUT /api/v1/variables/{id}` — leave `value` out to keep a secret unchanged.
#[utoipa::path(put, path = "/api/v1/variables/{id}", tag = "Scripts", summary = "Update variable", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn update(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(body): Json<VariableBody>,
) -> ApiResult<Json<Value>> {
    ctx.require(MANAGE)?;
    let current = load(&state, &id).await?;
    if !current.allowed(&ctx.scope, VIEW, false) {
        return Err(ApiError::not_found("Variable"));
    }
    if !current.allowed(&ctx.scope, MANAGE, true) {
        return Err(ApiError::forbidden("Missing permission: scripts.manage"));
    }
    // Keeping the stored value is only possible when it stays a secret.
    let keep_value = body.value.is_none() && current.secret && body.secret;
    let (_, scope_id) = check(&state, &ctx, &body, !keep_value).await?;
    let now = rustrmm_common::now();
    if keep_value {
        sqlx::query("UPDATE variables SET scope = ?, scope_id = ?, name = ?, description = ?, updated_by = ?, updated_by_name = ?, updated_at = ? WHERE id = ?")
            .bind(&body.scope)
            .bind(&scope_id)
            .bind(body.name.trim())
            .bind(body.description.trim())
            .bind(&ctx.user.id)
            .bind(&ctx.user.name)
            .bind(now)
            .bind(&id)
            .execute(&state.db)
            .await?;
    } else {
        let value = body.value.clone().unwrap_or_default();
        let (plain, encrypted) = if body.secret {
            (
                None,
                Some(state.cipher.encrypt_str(&value, &secret_aad(&id))),
            )
        } else {
            (Some(value), None)
        };
        sqlx::query("UPDATE variables SET scope = ?, scope_id = ?, name = ?, value = ?, secret_value = ?, secret = ?, description = ?,
                     updated_by = ?, updated_by_name = ?, updated_at = ? WHERE id = ?")
            .bind(&body.scope)
            .bind(&scope_id)
            .bind(body.name.trim())
            .bind(plain)
            .bind(encrypted)
            .bind(body.secret)
            .bind(body.description.trim())
            .bind(&ctx.user.id)
            .bind(&ctx.user.name)
            .bind(now)
            .bind(&id)
            .execute(&state.db)
            .await?;
    }
    let row = load(&state, &id).await?;
    state
        .audit
        .record_or_log(&state.db, audit_entry(&ctx, "variable.updated", &row))
        .await;
    crate::monitoring::push_soon(&state);
    Ok(Json(row.to_json()))
}

/// `DELETE /api/v1/variables/{id}`
#[utoipa::path(delete, path = "/api/v1/variables/{id}", tag = "Scripts", summary = "Delete variable", params(("id" = String, Path)), responses((status = 204, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn delete(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    ctx.require(MANAGE)?;
    let current = load(&state, &id).await?;
    if !current.allowed(&ctx.scope, VIEW, false) {
        return Err(ApiError::not_found("Variable"));
    }
    if !current.allowed(&ctx.scope, MANAGE, true) {
        return Err(ApiError::forbidden("Missing permission: scripts.manage"));
    }
    sqlx::query("DELETE FROM variables WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;
    state
        .audit
        .record_or_log(&state.db, audit_entry(&ctx, "variable.deleted", &current))
        .await;
    crate::monitoring::push_soon(&state);
    Ok(StatusCode::NO_CONTENT)
}
