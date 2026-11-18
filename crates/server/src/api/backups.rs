//! Backup settings and history.

use axum::Json;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio_util::io::ReaderStream;

use crate::auth::AuthCtx;
use crate::backup::{self, BackupRow, BackupSettings, DestinationResult, Retention, Trigger};
use crate::db;
use crate::error::{ApiError, ApiResult};
use crate::rbac::perm;
use crate::state::AppState;

#[derive(Serialize)]
pub struct LocalDto {
    enabled: bool,
    path: String,
}

#[derive(Serialize)]
pub struct S3Dto {
    enabled: bool,
    endpoint: String,
    region: String,
    bucket: String,
    prefix: String,
    access_key_id: String,
    has_secret: bool,
    object_lock_days: Option<u32>,
}

#[derive(Serialize)]
pub struct DestinationsDto {
    local: LocalDto,
    s3: S3Dto,
}

#[derive(Serialize)]
pub struct SettingsDto {
    enabled: bool,
    schedule_cron: String,
    next_run_at: Option<DateTime<Utc>>,
    retention: Retention,
    include_files: bool,
    recipient: String,
    destinations: DestinationsDto,
}

fn to_dto(state: &AppState, s: &BackupSettings) -> SettingsDto {
    SettingsDto {
        enabled: s.enabled,
        schedule_cron: s.schedule_cron.clone(),
        next_run_at: s
            .enabled
            .then(|| backup::next_run(&s.schedule_cron, chrono::Local::now()))
            .flatten()
            .map(|t| t.with_timezone(&Utc)),
        retention: s.retention.clone(),
        include_files: s.include_files,
        recipient: s.recipient.clone(),
        destinations: DestinationsDto {
            local: LocalDto {
                enabled: s.local_enabled,
                path: state.args.backup_path().display().to_string(),
            },
            s3: S3Dto {
                enabled: s.s3.enabled,
                endpoint: s.s3.endpoint.clone(),
                region: s.s3.region.clone(),
                bucket: s.s3.bucket.clone(),
                prefix: s.s3.prefix.clone(),
                access_key_id: s.s3.access_key_id.clone(),
                has_secret: s.s3.secret_enc.is_some(),
                object_lock_days: s.s3.object_lock_days,
            },
        },
    }
}

async fn load_settings(state: &AppState) -> ApiResult<BackupSettings> {
    db::get_setting::<BackupSettings>(&state.db, backup::SETTINGS_KEY)
        .await?
        .ok_or_else(|| {
            ApiError::conflict(
                "not_configured",
                "Backups are configured during first-run setup",
            )
        })
}

/// `GET /api/v1/settings/backups`
pub async fn get_settings(
    State(state): State<AppState>,
    ctx: AuthCtx,
) -> ApiResult<Json<SettingsDto>> {
    ctx.require_global(perm::BACKUPS_VIEW)?;
    let settings = load_settings(&state).await?;
    Ok(Json(to_dto(&state, &settings)))
}

#[derive(Deserialize)]
pub struct LocalInput {
    enabled: bool,
}

#[derive(Deserialize)]
pub struct S3Input {
    enabled: bool,
    #[serde(default)]
    endpoint: String,
    #[serde(default)]
    region: String,
    #[serde(default)]
    bucket: String,
    #[serde(default)]
    prefix: String,
    #[serde(default)]
    access_key_id: String,
    #[serde(default)]
    secret_access_key: Option<String>,
    #[serde(default)]
    object_lock_days: Option<u32>,
}

#[derive(Deserialize)]
pub struct DestinationsInput {
    local: LocalInput,
    s3: S3Input,
}

#[derive(Deserialize)]
pub struct SettingsInput {
    enabled: bool,
    schedule_cron: String,
    retention: Retention,
    include_files: bool,
    destinations: DestinationsInput,
}

/// `PUT /api/v1/settings/backups` (step-up)
pub async fn put_settings(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Json(req): Json<SettingsInput>,
) -> ApiResult<Json<SettingsDto>> {
    ctx.require_global(perm::BACKUPS_MANAGE)?;
    ctx.require_step_up()?;
    let mut settings = load_settings(&state).await?;
    let cron = req.schedule_cron.trim().to_string();
    if !backup::validate_cron(&cron) {
        return Err(ApiError::validation(
            "Schedule is not a valid cron expression (minute hour day month weekday)",
        ));
    }
    let r = &req.retention;
    if [r.hourly, r.daily, r.weekly, r.monthly]
        .iter()
        .any(|v| *v > 1000)
    {
        return Err(ApiError::validation(
            "Retention counts must be at most 1000",
        ));
    }
    if !req.destinations.local.enabled && !req.destinations.s3.enabled {
        return Err(ApiError::validation(
            "Enable at least one backup destination",
        ));
    }
    let s3 = &req.destinations.s3;
    if s3.enabled {
        if s3.bucket.trim().is_empty() || s3.access_key_id.trim().is_empty() {
            return Err(ApiError::validation(
                "S3 needs a bucket and an access key id",
            ));
        }
        if !s3.endpoint.is_empty()
            && !(s3.endpoint.starts_with("https://") || s3.endpoint.starts_with("http://"))
        {
            return Err(ApiError::validation(
                "S3 endpoint must start with https:// (or http:// for a LAN MinIO)",
            ));
        }
        if settings.s3.secret_enc.is_none()
            && s3.secret_access_key.as_deref().is_none_or(str::is_empty)
        {
            return Err(ApiError::validation("Enter the S3 secret access key"));
        }
    }
    settings.enabled = req.enabled;
    settings.schedule_cron = cron;
    settings.retention = req.retention.clone();
    settings.include_files = req.include_files;
    settings.local_enabled = req.destinations.local.enabled;
    settings.s3.enabled = s3.enabled;
    settings.s3.endpoint = s3.endpoint.trim().trim_end_matches('/').to_string();
    settings.s3.region = s3.region.trim().to_string();
    settings.s3.bucket = s3.bucket.trim().to_string();
    settings.s3.prefix = s3.prefix.trim().trim_matches('/').to_string();
    settings.s3.access_key_id = s3.access_key_id.trim().to_string();
    settings.s3.object_lock_days = s3.object_lock_days;
    if let Some(secret) = s3.secret_access_key.as_deref().filter(|s| !s.is_empty()) {
        settings.set_s3_secret(&state.cipher, secret);
    }
    db::set_setting(&state.db, backup::SETTINGS_KEY, &settings).await?;
    state.backups.notify_settings_changed();
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("settings.backups_updated").details(json!({
                "enabled": settings.enabled,
                "schedule": settings.schedule_cron,
                "local": settings.local_enabled,
                "s3": settings.s3.enabled,
            })),
        )
        .await;
    Ok(Json(to_dto(&state, &settings)))
}

#[derive(Serialize)]
pub struct BackupDto {
    id: String,
    started_at: DateTime<Utc>,
    finished_at: Option<DateTime<Utc>>,
    status: String,
    trigger: String,
    file_name: Option<String>,
    size_bytes: Option<i64>,
    sha256: Option<String>,
    destinations: Vec<DestinationResult>,
    error: Option<String>,
}

fn row_dto(row: BackupRow) -> BackupDto {
    BackupDto {
        destinations: serde_json::from_str(&row.destinations).unwrap_or_default(),
        id: row.id,
        started_at: row.started_at,
        finished_at: row.finished_at,
        status: row.status,
        trigger: row.trigger_kind,
        file_name: row.file_name,
        size_bytes: row.size_bytes,
        sha256: row.sha256,
        error: row.error,
    }
}

/// `GET /api/v1/backups`
pub async fn list(State(state): State<AppState>, ctx: AuthCtx) -> ApiResult<Json<Value>> {
    ctx.require_global(perm::BACKUPS_VIEW)?;
    let rows: Vec<BackupRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {} FROM backups ORDER BY started_at DESC LIMIT 500",
        backup::ROW_COLUMNS
    )))
    .fetch_all(&state.db)
    .await?;
    Ok(Json(
        json!({ "items": rows.into_iter().map(row_dto).collect::<Vec<_>>(), "running": state.backups.is_running() }),
    ))
}

/// `POST /api/v1/backups` — starts a backup and returns once it finishes.
pub async fn run_now(
    State(state): State<AppState>,
    ctx: AuthCtx,
) -> ApiResult<(StatusCode, Json<BackupDto>)> {
    ctx.require_global(perm::BACKUPS_MANAGE)?;
    if state.backups.is_running() {
        return Err(ApiError::conflict(
            "backup_running",
            "A backup is already running",
        ));
    }
    let row = state
        .backups
        .run(&state, Trigger::Manual, ctx.actor())
        .await
        .map_err(|e| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "backup_failed",
                format!("{e:#}"),
            )
        })?;
    Ok((StatusCode::CREATED, Json(row_dto(row))))
}

async fn load_row(state: &AppState, id: &str) -> ApiResult<BackupRow> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {} FROM backups WHERE id = ?",
        backup::ROW_COLUMNS
    )))
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| ApiError::not_found("Backup"))
}

/// `GET /api/v1/backups/{id}/download` (step-up)
pub async fn download(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    ctx.require_global(perm::BACKUPS_MANAGE)?;
    ctx.require_step_up()?;
    let row = load_row(&state, &id).await?;
    let file_name = row
        .file_name
        .clone()
        .ok_or_else(|| ApiError::not_found("Backup file"))?;
    if file_name.contains(['/', '\\']) || file_name.contains("..") {
        return Err(ApiError::bad_request("Invalid backup file name"));
    }
    let path = state.args.backup_path().join(&file_name);
    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|_| ApiError::not_found("Local backup file"))?;
    let size = file.metadata().await.map(|m| m.len()).unwrap_or(0);
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("backup.downloaded")
                .target("backup", &id, &file_name),
        )
        .await;
    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_string()),
            (header::CONTENT_LENGTH, size.to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{file_name}\""),
            ),
        ],
        Body::from_stream(ReaderStream::new(file)),
    )
        .into_response())
}

/// `DELETE /api/v1/backups/{id}` (step-up)
pub async fn delete(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    ctx.require_global(perm::BACKUPS_MANAGE)?;
    ctx.require_step_up()?;
    let row = load_row(&state, &id).await?;
    if row.status == "running" {
        return Err(ApiError::conflict(
            "backup_running",
            "This backup is still running",
        ));
    }
    let settings = load_settings(&state).await?;
    let target = settings.s3_target(&state.cipher).ok().flatten();
    backup::delete_artifacts(&state.args, target.as_ref(), &row).await;
    sqlx::query("DELETE FROM backups WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("backup.deleted")
                .target("backup", &id, row.file_name.unwrap_or_default()),
        )
        .await;
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /api/v1/backups/test-s3` — probes the saved S3 settings (or the ones in the body).
pub async fn test_s3(
    State(state): State<AppState>,
    ctx: AuthCtx,
    body: Option<Json<S3Input>>,
) -> ApiResult<Json<Value>> {
    ctx.require_global(perm::BACKUPS_MANAGE)?;
    let settings = load_settings(&state).await?;
    let target = match body {
        Some(Json(input)) => {
            let secret = match input.secret_access_key.filter(|s| !s.is_empty()) {
                Some(s) => s,
                None => settings.s3_secret(&state.cipher)?.unwrap_or_default(),
            };
            backup::s3::S3Target {
                endpoint: input.endpoint.trim().trim_end_matches('/').to_string(),
                region: input.region.trim().to_string(),
                bucket: input.bucket.trim().to_string(),
                prefix: input.prefix.trim().trim_matches('/').to_string(),
                access_key_id: input.access_key_id.trim().to_string(),
                secret_access_key: secret,
            }
        }
        None => {
            let mut s = settings.clone();
            s.s3.enabled = true;
            s.s3_target(&state.cipher)?
                .ok_or_else(|| ApiError::validation("S3 is not configured"))?
        }
    };
    match target.test().await {
        Ok(()) => Ok(Json(json!({ "ok": true, "error": null }))),
        Err(e) => Ok(Json(json!({ "ok": false, "error": format!("{e:#}") }))),
    }
}
