//! Script library: named, versioned scripts with typed parameters and an approval workflow.
//! Saving changed content or parameters creates a new immutable version.

use std::collections::HashMap;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use rustrmm_proto::scripts as rules;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{QueryBuilder, Sqlite};

use super::params::{self, ScriptParameter};
use super::settings::AutomationSettings;
use crate::auth::AuthCtx;
use crate::db::Db;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

pub const VIEW: &str = "scripts.view";
pub const MANAGE: &str = "scripts.manage";
pub const APPROVE: &str = "scripts.approve";
pub const MAX_CONTENT_BYTES: usize = 256 * 1024;
pub const BUILTIN_AUTHOR: &str = "RustRMM";

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ScriptRow {
    pub id: String,
    pub builtin_id: Option<String>,
    pub name: String,
    pub description: String,
    pub category: String,
    pub language: String,
    pub platforms: String,
    pub timeout_secs: i64,
    pub risk: String,
    pub current_version: i64,
    pub approved_version: Option<i64>,
    pub archived_at: Option<DateTime<Utc>>,
    pub created_by_name: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

pub const SCRIPT_COLUMNS: &str =
    "id, builtin_id, name, description, category, language, platforms, timeout_secs, risk,
    current_version, approved_version, archived_at, created_by_name, created_at, updated_at";

impl ScriptRow {
    pub fn platforms(&self) -> Vec<String> {
        serde_json::from_str(&self.platforms).unwrap_or_default()
    }
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct VersionRow {
    pub version: i64,
    pub content: String,
    pub content_sha256: String,
    pub parameters: String,
    pub notes: String,
    pub created_by: Option<String>,
    pub created_by_name: String,
    pub created_at: DateTime<Utc>,
    pub approved_by_name: Option<String>,
    pub approved_at: Option<DateTime<Utc>>,
}

pub const VERSION_COLUMNS: &str =
    "version, content, content_sha256, parameters, notes, created_by, created_by_name, created_at,
    approved_by_name, approved_at";

impl VersionRow {
    pub fn parameters(&self) -> Vec<ScriptParameter> {
        serde_json::from_str(&self.parameters).unwrap_or_default()
    }

    fn summary(&self) -> Value {
        json!({ "version": self.version, "notes": self.notes, "content_sha256": self.content_sha256,
                "created_by_name": self.created_by_name, "created_at": self.created_at,
                "approved_by_name": self.approved_by_name, "approved_at": self.approved_at })
    }
}

pub async fn load(db: &Db, id: &str) -> anyhow::Result<Option<ScriptRow>> {
    Ok(sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {SCRIPT_COLUMNS} FROM scripts WHERE id = ?"
    )))
    .bind(id)
    .fetch_optional(db)
    .await?)
}

pub async fn load_version(db: &Db, id: &str, version: i64) -> anyhow::Result<Option<VersionRow>> {
    Ok(sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {VERSION_COLUMNS} FROM script_versions WHERE script_id = ? AND version = ?"
    )))
    .bind(id)
    .bind(version)
    .fetch_optional(db)
    .await?)
}

/// The version a new job would run, with everything dispatch needs.
#[derive(Debug, Clone)]
pub struct Runnable {
    pub script: ScriptRow,
    pub version: i64,
    pub content: String,
    pub content_sha256: String,
    pub parameters: Vec<ScriptParameter>,
}

/// The script's current version, or its approved version when approval is required.
pub async fn runnable_version(
    state: &AppState,
    script_id: &str,
    settings: &AutomationSettings,
) -> ApiResult<Runnable> {
    let script = load(&state.db, script_id)
        .await?
        .filter(|s| s.archived_at.is_none())
        .ok_or_else(|| ApiError::not_found("Script"))?;
    let version = if settings.require_script_approval {
        script.approved_version.ok_or_else(|| {
            ApiError::conflict(
                "script_not_approved",
                "This script has no approved version, and only approved versions may run",
            )
        })?
    } else {
        script.current_version
    };
    let row = load_version(&state.db, script_id, version)
        .await?
        .ok_or_else(|| ApiError::internal("script version missing"))?;
    if rules::sha256_hex(&row.content) != row.content_sha256 {
        return Err(ApiError::internal(
            "stored script content does not match its hash",
        ));
    }
    Ok(Runnable {
        parameters: row.parameters(),
        version,
        content: row.content,
        content_sha256: row.content_sha256,
        script,
    })
}

/// Latest run of any job using each script: script id → `last_run`.
async fn last_runs(db: &Db, script_id: Option<&str>) -> anyhow::Result<HashMap<String, Value>> {
    let mut qb = QueryBuilder::<Sqlite>::new(
        "SELECT j.script_id, r.job_id, r.id, r.started_at,
                (SELECT COUNT(*) FROM job_results x WHERE x.run_id = r.id AND x.status = 'succeeded'),
                (SELECT COUNT(*) FROM job_results x WHERE x.run_id = r.id AND x.status IN ('failed', 'timed_out'))
         FROM job_runs r JOIN jobs j ON j.id = r.job_id
         WHERE j.script_id IS NOT NULL AND r.id = (
             SELECT r2.id FROM job_runs r2 JOIN jobs j2 ON j2.id = r2.job_id
             WHERE j2.script_id = j.script_id ORDER BY r2.started_at DESC, r2.id DESC LIMIT 1)",
    );
    if let Some(id) = script_id {
        qb.push(" AND j.script_id = ").push_bind(id.to_string());
    }
    let rows: Vec<(String, String, String, DateTime<Utc>, i64, i64)> =
        qb.build_query_as().fetch_all(db).await?;
    Ok(rows
        .into_iter()
        .map(|(script, job, run, at, ok, failed)| {
            (
                script,
                json!({ "job_id": job, "run_id": run, "at": at, "succeeded": ok, "failed": failed }),
            )
        })
        .collect())
}

fn summary_json(
    script: &ScriptRow,
    current: Option<&VersionRow>,
    last_run: Option<&Value>,
) -> Value {
    json!({
        "id": script.id, "name": script.name, "description": script.description, "category": script.category,
        "language": script.language, "platforms": script.platforms(), "timeout_secs": script.timeout_secs,
        "risk": script.risk, "builtin": script.builtin_id.is_some(), "current_version": script.current_version,
        "approved_version": script.approved_version,
        "content_sha256": current.map(|v| v.content_sha256.clone()),
        "archived": script.archived_at.is_some(),
        "created_by_name": script.created_by_name, "created_at": script.created_at, "updated_at": script.updated_at,
        "last_run": last_run.cloned().unwrap_or(Value::Null),
    })
}

/// The full Script document.
pub async fn script_json(db: &Db, script: &ScriptRow) -> anyhow::Result<Value> {
    let versions: Vec<VersionRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {VERSION_COLUMNS} FROM script_versions WHERE script_id = ? ORDER BY version DESC"
    )))
    .bind(&script.id)
    .fetch_all(db)
    .await?;
    let current = versions
        .iter()
        .find(|v| v.version == script.current_version);
    let last = last_runs(db, Some(&script.id)).await?;
    let mut doc = summary_json(script, current, last.get(&script.id));
    doc["content"] = json!(current.map(|v| v.content.clone()).unwrap_or_default());
    doc["parameters"] = json!(current.map(|v| v.parameters()).unwrap_or_default());
    doc["versions"] = json!(versions.iter().map(VersionRow::summary).collect::<Vec<_>>());
    Ok(doc)
}

// ------------------------------------------------------------------ validation

#[derive(Debug, Clone, Deserialize)]
pub struct ScriptBody {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub category: String,
    pub language: String,
    pub platforms: Vec<String>,
    #[serde(default = "default_timeout")]
    pub timeout_secs: i64,
    #[serde(default = "default_risk")]
    pub risk: String,
    pub content: String,
    #[serde(default)]
    pub parameters: Vec<ScriptParameter>,
    #[serde(default)]
    pub notes: Option<String>,
}

fn default_timeout() -> i64 {
    600
}

fn default_risk() -> String {
    "normal".into()
}

/// A validated script body.
#[derive(Debug, Clone)]
pub struct ValidScript {
    pub name: String,
    pub description: String,
    pub category: String,
    pub language: String,
    pub platforms: Vec<String>,
    pub timeout_secs: i64,
    pub risk: String,
    pub content: String,
    pub content_sha256: String,
    pub parameters: Vec<ScriptParameter>,
    pub notes: String,
}

pub fn validate(body: &ScriptBody) -> Result<ValidScript, String> {
    let name = body.name.trim().to_string();
    if name.is_empty() || name.chars().count() > 120 {
        return Err("Name must be 1–120 characters".into());
    }
    if body.description.chars().count() > 2000 {
        return Err("Description must be at most 2000 characters".into());
    }
    let category = body.category.trim().to_string();
    let category = if category.is_empty() {
        "Other".to_string()
    } else {
        category
    };
    if category.chars().count() > 60 {
        return Err("Category must be at most 60 characters".into());
    }
    if !rules::known_language(&body.language) {
        return Err(format!(
            "language must be one of {}",
            rules::LANGUAGES.join(", ")
        ));
    }
    let mut platforms: Vec<String> = body
        .platforms
        .iter()
        .map(|p| p.trim().to_lowercase())
        .collect();
    platforms.sort();
    platforms.dedup();
    if platforms.is_empty() {
        return Err("Choose at least one platform".into());
    }
    let supported = rules::language_platforms(&body.language);
    if let Some(bad) = platforms.iter().find(|p| !supported.contains(&p.as_str())) {
        return Err(format!("{} scripts cannot run on {bad}", body.language));
    }
    if !(10..=86_400).contains(&body.timeout_secs) {
        return Err("timeout_secs must be between 10 and 86400".into());
    }
    if !matches!(body.risk.as_str(), "normal" | "high") {
        return Err("risk must be normal or high".into());
    }
    if body.content.trim().is_empty() {
        return Err("The script is empty".into());
    }
    if body.content.len() > MAX_CONTENT_BYTES {
        return Err(format!(
            "Scripts must be at most {} KiB",
            MAX_CONTENT_BYTES / 1024
        ));
    }
    if body.content.contains('\0') {
        return Err("Scripts must not contain NUL characters".into());
    }
    let parameters = params::validate_definitions(&body.parameters)?;
    let notes = body.notes.clone().unwrap_or_default().trim().to_string();
    if notes.chars().count() > 500 {
        return Err("Version notes must be at most 500 characters".into());
    }
    Ok(ValidScript {
        name,
        description: body.description.trim().to_string(),
        category,
        language: body.language.clone(),
        platforms,
        timeout_secs: body.timeout_secs,
        risk: body.risk.clone(),
        content_sha256: rules::sha256_hex(&body.content),
        content: body.content.clone(),
        parameters,
        notes,
    })
}

/// Who created a script or version.
pub struct Author<'a> {
    pub id: Option<&'a str>,
    pub name: &'a str,
}

/// Inserts a new script with version 1. `approved` auto-approves it (built-ins).
pub async fn insert(
    db: &Db,
    valid: &ValidScript,
    builtin_id: Option<&str>,
    author: &Author<'_>,
    approved: bool,
) -> anyhow::Result<String> {
    let id = rustrmm_common::new_id();
    let now = rustrmm_common::now();
    let mut tx = db.begin().await?;
    sqlx::query("INSERT INTO scripts (id, builtin_id, name, description, category, language, platforms, timeout_secs, risk,
                 current_version, approved_version, created_by, created_by_name, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)")
        .bind(&id)
        .bind(builtin_id)
        .bind(&valid.name)
        .bind(&valid.description)
        .bind(&valid.category)
        .bind(&valid.language)
        .bind(serde_json::to_string(&valid.platforms)?)
        .bind(valid.timeout_secs)
        .bind(&valid.risk)
        .bind(approved.then_some(1i64))
        .bind(author.id)
        .bind(author.name)
        .bind(now)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    insert_version(&mut tx, &id, 1, valid, author, approved).await?;
    tx.commit().await?;
    Ok(id)
}

pub async fn insert_version(
    tx: &mut sqlx::Transaction<'_, Sqlite>,
    script_id: &str,
    version: i64,
    valid: &ValidScript,
    author: &Author<'_>,
    approved: bool,
) -> anyhow::Result<()> {
    let now = rustrmm_common::now();
    sqlx::query("INSERT INTO script_versions (script_id, version, content, content_sha256, parameters, notes, created_by, created_by_name,
                 created_at, approved_by, approved_by_name, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(script_id)
        .bind(version)
        .bind(&valid.content)
        .bind(&valid.content_sha256)
        .bind(serde_json::to_string(&valid.parameters)?)
        .bind(&valid.notes)
        .bind(author.id)
        .bind(author.name)
        .bind(now)
        .bind(if approved { author.id } else { None })
        .bind(approved.then_some(author.name))
        .bind(approved.then_some(now))
        .execute(&mut **tx)
        .await?;
    Ok(())
}

// ------------------------------------------------------------------ API

#[derive(Deserialize, Default)]
pub struct ListQuery {
    search: Option<String>,
    category: Option<String>,
    language: Option<String>,
    platform: Option<String>,
    #[serde(default)]
    include_archived: bool,
}

/// `GET /api/v1/scripts`
#[utoipa::path(get, path = "/api/v1/scripts", tag = "Scripts", summary = "List scripts", responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn list(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Value>> {
    ctx.require(VIEW)?;
    let mut qb =
        QueryBuilder::<Sqlite>::new(format!("SELECT {SCRIPT_COLUMNS} FROM scripts WHERE 1 = 1"));
    if !q.include_archived {
        qb.push(" AND archived_at IS NULL");
    }
    if let Some(search) = q.search.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let like = format!("%{}%", search.replace(['%', '_'], ""));
        qb.push(" AND (name LIKE ")
            .push_bind(like.clone())
            .push(" OR description LIKE ")
            .push_bind(like)
            .push(")");
    }
    if let Some(category) = q.category.as_deref().filter(|s| !s.is_empty()) {
        qb.push(" AND category = ").push_bind(category.to_string());
    }
    if let Some(language) = q.language.as_deref().filter(|s| !s.is_empty()) {
        qb.push(" AND language = ").push_bind(language.to_string());
    }
    if let Some(platform) = q.platform.as_deref().filter(|s| !s.is_empty()) {
        qb.push(" AND EXISTS (SELECT 1 FROM json_each(scripts.platforms) WHERE value = ")
            .push_bind(platform.to_string())
            .push(")");
    }
    qb.push(" ORDER BY category COLLATE NOCASE, name COLLATE NOCASE");
    let rows: Vec<ScriptRow> = qb.build_query_as().fetch_all(&state.db).await?;
    let hashes: Vec<(String, String)> = sqlx::query_as(
        "SELECT v.script_id, v.content_sha256 FROM script_versions v JOIN scripts s ON s.id = v.script_id AND s.current_version = v.version",
    )
    .fetch_all(&state.db)
    .await?;
    let hashes: HashMap<String, String> = hashes.into_iter().collect();
    let last = last_runs(&state.db, None).await?;
    let items: Vec<Value> = rows
        .iter()
        .map(|s| {
            let mut doc = summary_json(s, None, last.get(&s.id));
            doc["content_sha256"] = json!(hashes.get(&s.id));
            doc
        })
        .collect();
    Ok(Json(json!({ "items": items })))
}

/// `GET /api/v1/script-categories`
#[utoipa::path(get, path = "/api/v1/script-categories", tag = "Scripts", summary = "Categories", responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn categories(State(state): State<AppState>, ctx: AuthCtx) -> ApiResult<Json<Value>> {
    ctx.require(VIEW)?;
    let rows: Vec<(String, i64)> = sqlx::query_as(
        "SELECT category, COUNT(*) FROM scripts WHERE archived_at IS NULL GROUP BY category ORDER BY category COLLATE NOCASE",
    )
    .fetch_all(&state.db)
    .await?;
    let items: Vec<Value> = rows
        .into_iter()
        .map(|(name, count)| json!({ "name": name, "count": count }))
        .collect();
    Ok(Json(json!({ "items": items })))
}

/// `GET /api/v1/scripts/{id}`
#[utoipa::path(get, path = "/api/v1/scripts/{id}", tag = "Scripts", summary = "Get script", params(("id" = String, Path)), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn get(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    ctx.require(VIEW)?;
    let script = load(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("Script"))?;
    Ok(Json(script_json(&state.db, &script).await?))
}

fn audit_details(script_id: &str, version: i64, valid: &ValidScript) -> Value {
    // Script content never reaches the audit log: only its hash.
    json!({ "script_id": script_id, "version": version, "content_sha256": valid.content_sha256,
            "language": valid.language, "risk": valid.risk, "platforms": valid.platforms,
            "parameters": valid.parameters.iter().map(|p| &p.name).collect::<Vec<_>>() })
}

/// `POST /api/v1/scripts` — scripts are installation-wide, so this needs global `scripts.manage`.
#[utoipa::path(post, path = "/api/v1/scripts", tag = "Scripts", summary = "Create script", request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn create(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Json(body): Json<ScriptBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    ctx.require_global(MANAGE)?;
    let valid = validate(&body).map_err(ApiError::validation)?;
    let id = insert(
        &state.db,
        &valid,
        None,
        &Author {
            id: Some(&ctx.user.id),
            name: &ctx.user.name,
        },
        false,
    )
    .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("script.created")
                .target("script", &id, &valid.name)
                .details(audit_details(&id, 1, &valid)),
        )
        .await;
    let script = load(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::internal("script vanished"))?;
    Ok((
        StatusCode::CREATED,
        Json(script_json(&state.db, &script).await?),
    ))
}

/// `PUT /api/v1/scripts/{id}` — a new version only when content or parameters changed.
#[utoipa::path(put, path = "/api/v1/scripts/{id}", tag = "Scripts", summary = "Update script", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn update(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(body): Json<ScriptBody>,
) -> ApiResult<Json<Value>> {
    ctx.require_global(MANAGE)?;
    let script = load(&state.db, &id)
        .await?
        .filter(|s| s.archived_at.is_none())
        .ok_or_else(|| ApiError::not_found("Script"))?;
    if script.builtin_id.is_some() {
        return Err(ApiError::conflict(
            "builtin_readonly",
            "Built-in scripts are read-only; duplicate it to customise",
        ));
    }
    let valid = validate(&body).map_err(ApiError::validation)?;
    let current = load_version(&state.db, &id, script.current_version)
        .await?
        .ok_or_else(|| ApiError::internal("current version missing"))?;
    let changed =
        current.content_sha256 != valid.content_sha256 || current.parameters() != valid.parameters;
    let version = if changed {
        script.current_version + 1
    } else {
        script.current_version
    };
    let mut tx = state.db.begin().await?;
    sqlx::query("UPDATE scripts SET name = ?, description = ?, category = ?, language = ?, platforms = ?, timeout_secs = ?, risk = ?,
                 current_version = ?, updated_at = ? WHERE id = ?")
        .bind(&valid.name)
        .bind(&valid.description)
        .bind(&valid.category)
        .bind(&valid.language)
        .bind(serde_json::to_string(&valid.platforms)?)
        .bind(valid.timeout_secs)
        .bind(&valid.risk)
        .bind(version)
        .bind(rustrmm_common::now())
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    if changed {
        insert_version(
            &mut tx,
            &id,
            version,
            &valid,
            &Author {
                id: Some(&ctx.user.id),
                name: &ctx.user.name,
            },
            false,
        )
        .await?;
    }
    tx.commit().await?;
    let mut details = audit_details(&id, version, &valid);
    details["new_version"] = json!(changed);
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("script.updated")
                .target("script", &id, &valid.name)
                .details(details),
        )
        .await;
    // `script` checks embed the current (or approved) version.
    crate::monitoring::push_soon(&state);
    let script = load(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::internal("script vanished"))?;
    Ok(Json(script_json(&state.db, &script).await?))
}

/// `POST /api/v1/scripts/{id}/duplicate`
#[utoipa::path(post, path = "/api/v1/scripts/{id}/duplicate", tag = "Scripts", summary = "Duplicate", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn duplicate(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    ctx.require_global(MANAGE)?;
    let script = load(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("Script"))?;
    let current = load_version(&state.db, &id, script.current_version)
        .await?
        .ok_or_else(|| ApiError::internal("current version missing"))?;
    let name: String = format!("{} (copy)", script.name)
        .chars()
        .take(120)
        .collect();
    let valid = ValidScript {
        name: name.clone(),
        description: script.description.clone(),
        category: script.category.clone(),
        language: script.language.clone(),
        platforms: script.platforms(),
        timeout_secs: script.timeout_secs,
        risk: script.risk.clone(),
        content: current.content.clone(),
        content_sha256: current.content_sha256.clone(),
        parameters: current.parameters(),
        notes: format!("Copied from {} v{}", script.name, script.current_version)
            .chars()
            .take(500)
            .collect(),
    };
    let new_id = insert(
        &state.db,
        &valid,
        None,
        &Author {
            id: Some(&ctx.user.id),
            name: &ctx.user.name,
        },
        false,
    )
    .await?;
    let mut details = audit_details(&new_id, 1, &valid);
    details["duplicated_from"] = json!(id);
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("script.created")
                .target("script", &new_id, &name)
                .details(details),
        )
        .await;
    let created = load(&state.db, &new_id)
        .await?
        .ok_or_else(|| ApiError::internal("script vanished"))?;
    Ok((
        StatusCode::CREATED,
        Json(script_json(&state.db, &created).await?),
    ))
}

/// `DELETE /api/v1/scripts/{id}` (step-up) — archives; history and running jobs are kept.
#[utoipa::path(delete, path = "/api/v1/scripts/{id}", tag = "Scripts", summary = "Archive script", params(("id" = String, Path)), responses((status = 204, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn archive(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    ctx.require_global(MANAGE)?;
    ctx.require_step_up()?;
    let script = load(&state.db, &id)
        .await?
        .filter(|s| s.archived_at.is_none())
        .ok_or_else(|| ApiError::not_found("Script"))?;
    sqlx::query("UPDATE scripts SET archived_at = ?, updated_at = ? WHERE id = ?")
        .bind(rustrmm_common::now())
        .bind(rustrmm_common::now())
        .bind(&id)
        .execute(&state.db)
        .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("script.archived")
                .target("script", &id, &script.name),
        )
        .await;
    Ok(StatusCode::NO_CONTENT)
}

/// `GET /api/v1/scripts/{id}/versions/{version}`
#[utoipa::path(get, path = "/api/v1/scripts/{id}/versions/{version}", tag = "Scripts", summary = "Get version", params(("id" = String, Path), ("version" = String, Path)), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn get_version(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path((id, version)): Path<(String, i64)>,
) -> ApiResult<Json<Value>> {
    ctx.require(VIEW)?;
    load(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("Script"))?;
    let row = load_version(&state.db, &id, version)
        .await?
        .ok_or_else(|| ApiError::not_found("Script version"))?;
    let mut doc = row.summary();
    doc["content"] = json!(row.content);
    doc["parameters"] = json!(row.parameters());
    Ok(Json(doc))
}

/// `POST /api/v1/scripts/{id}/versions/{version}/approve` (step-up)
#[utoipa::path(post, path = "/api/v1/scripts/{id}/versions/{version}/approve", tag = "Scripts", summary = "Approve version", params(("id" = String, Path), ("version" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn approve_version(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path((id, version)): Path<(String, i64)>,
) -> ApiResult<Json<Value>> {
    ctx.require_global(APPROVE)?;
    ctx.require_step_up()?;
    let script = load(&state.db, &id)
        .await?
        .filter(|s| s.archived_at.is_none())
        .ok_or_else(|| ApiError::not_found("Script"))?;
    let row = load_version(&state.db, &id, version)
        .await?
        .ok_or_else(|| ApiError::not_found("Script version"))?;
    let settings = super::settings::load(&state).await?;
    if row.created_by.as_deref() == Some(ctx.user.id.as_str()) && !settings.allow_self_approval {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "self_approval",
            "You cannot approve a version you created",
        ));
    }
    let now = rustrmm_common::now();
    let mut tx = state.db.begin().await?;
    sqlx::query("UPDATE script_versions SET approved_by = ?, approved_by_name = ?, approved_at = ? WHERE script_id = ? AND version = ?")
        .bind(&ctx.user.id)
        .bind(&ctx.user.name)
        .bind(now)
        .bind(&id)
        .bind(version)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE scripts SET approved_version = ?, updated_at = ? WHERE id = ?")
        .bind(version)
        .bind(now)
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("script.approved")
                .target("script", &id, &script.name)
                .details(json!({ "version": version, "content_sha256": row.content_sha256 })),
        )
        .await;
    crate::monitoring::push_soon(&state);
    let script = load(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::internal("script vanished"))?;
    Ok(Json(script_json(&state.db, &script).await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body() -> ScriptBody {
        ScriptBody {
            name: "Restart service".into(),
            description: String::new(),
            category: "Maintenance".into(),
            language: "powershell".into(),
            platforms: vec!["windows".into()],
            timeout_secs: 600,
            risk: "normal".into(),
            content: "Restart-Service $env:ServiceName".into(),
            parameters: vec![],
            notes: None,
        }
    }

    #[test]
    fn script_bodies_are_validated() {
        let valid = validate(&body()).expect("valid");
        assert_eq!(
            valid.content_sha256,
            rules::sha256_hex("Restart-Service $env:ServiceName")
        );
        let mut b = body();
        b.platforms = vec!["linux".into()];
        assert!(
            validate(&b)
                .expect_err("invalid")
                .contains("cannot run on linux")
        );
        let mut b = body();
        b.language = "perl".into();
        assert!(validate(&b).is_err());
        let mut b = body();
        b.timeout_secs = 5;
        assert!(validate(&b).is_err());
        let mut b = body();
        b.risk = "extreme".into();
        assert!(validate(&b).is_err());
        let mut b = body();
        b.content = "  ".into();
        assert!(validate(&b).is_err());
        let mut b = body();
        b.content = "x".repeat(MAX_CONTENT_BYTES + 1);
        assert!(validate(&b).is_err());
        let mut b = body();
        b.platforms = vec![];
        assert!(validate(&b).is_err());
    }
}
