//! Software deployments: install or uninstall a library package on devices now, at a time or in
//! each device's patch window, behind the Phase 5 mass-action guard.

use std::collections::{HashMap, HashSet};

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use rustrmm_proto::commands::{Command, CommandResult};
use rustrmm_proto::software::{FileDownload, PackageSource, SoftwareAction, SoftwareActionOutcome};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::library::{self, PackageRow};
use crate::auth::AuthCtx;
use crate::automation::jobs::{self, TargetSpec};
use crate::db::Db;
use crate::error::{ApiError, ApiResult};
use crate::rbac::perm;
use crate::state::AppState;

/// Actions running at the same time per deployment.
const CONCURRENCY: i64 = 50;
/// How long `now`/`once` deployments wait for offline devices.
const OFFLINE_WAIT_HOURS: i64 = 24;
/// How long `window` deployments wait for a device's next window.
const WINDOW_WAIT_DAYS: i64 = 14;
/// Per-action timeout sent to the agent.
pub const ACTION_TIMEOUT_SECS: u32 = 3600;
const OUTPUT_PREVIEW: usize = 200;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DeploySchedule {
    Now,
    Once { at: DateTime<Utc> },
    Window,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct DeploymentRow {
    pub id: String,
    pub package_id: Option<String>,
    pub package_name: String,
    pub action: String,
    pub target_type: String,
    pub target_ids: String,
    pub schedule: String,
    pub status: String,
    pub client_id: Option<String>,
    pub site_id: Option<String>,
    pub created_by: Option<String>,
    pub created_by_name: String,
    pub created_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
}

const SELECT: &str = "SELECT id, package_id, package_name, action, target_type, target_ids, schedule, status, client_id, site_id,
    created_by, created_by_name, created_at, finished_at FROM software_deployments";

impl DeploymentRow {
    fn schedule(&self) -> DeploySchedule {
        serde_json::from_str(&self.schedule).unwrap_or(DeploySchedule::Now)
    }

    fn target_ids(&self) -> Vec<String> {
        serde_json::from_str(&self.target_ids).unwrap_or_default()
    }

    fn visible(&self, ctx: &AuthCtx, permission: &str) -> bool {
        jobs::scope_allows(
            &ctx.scope,
            permission,
            self.client_id.as_deref(),
            self.site_id.as_deref(),
        )
    }
}

async fn load(db: &Db, id: &str) -> anyhow::Result<Option<DeploymentRow>> {
    Ok(
        sqlx::query_as(sqlx::AssertSqlSafe(format!("{SELECT} WHERE id = ?")))
            .bind(id)
            .fetch_optional(db)
            .await?,
    )
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct Counts {
    pub total: i64,
    pub succeeded: i64,
    pub failed: i64,
    /// Pending and running.
    pub pending: i64,
    pub skipped: i64,
    pub cancelled: i64,
}

async fn counts(db: &Db, deployment_id: &str) -> anyhow::Result<Counts> {
    let rows: Vec<(String, i64)> = sqlx::query_as(
        "SELECT status, COUNT(*) FROM software_deployment_results WHERE deployment_id = ? GROUP BY status",
    )
    .bind(deployment_id)
    .fetch_all(db)
    .await?;
    let mut c = Counts::default();
    for (status, n) in rows {
        c.total += n;
        match status.as_str() {
            "succeeded" => c.succeeded += n,
            "failed" => c.failed += n,
            "pending" | "running" => c.pending += n,
            "skipped" => c.skipped += n,
            _ => c.cancelled += n,
        }
    }
    Ok(c)
}

async fn summary_json(db: &Db, row: &DeploymentRow) -> anyhow::Result<Value> {
    let c = counts(db, &row.id).await?;
    let label = jobs::label_for(db, &row.target_type, &row.target_ids()).await;
    Ok(json!({
        "id": row.id, "package": { "id": row.package_id, "name": row.package_name }, "action": row.action,
        "target_label": label, "status": row.status, "total": c.total, "succeeded": c.succeeded,
        "failed": c.failed, "pending": c.pending, "skipped": c.skipped, "cancelled": c.cancelled,
        "created_by_name": row.created_by_name, "created_at": row.created_at,
    }))
}

async fn detail_json(db: &Db, row: &DeploymentRow) -> anyhow::Result<Value> {
    let mut v = summary_json(db, row).await?;
    v["target"] = json!({ "type": row.target_type, "ids": row.target_ids() });
    v["schedule"] = serde_json::to_value(row.schedule())?;
    v["finished_at"] = json!(row.finished_at);
    Ok(v)
}

fn publish(state: &AppState, row: &DeploymentRow) {
    let state = state.clone();
    let row = row.clone();
    tokio::spawn(async move {
        let status: String =
            sqlx::query_scalar("SELECT status FROM software_deployments WHERE id = ?")
                .bind(&row.id)
                .fetch_optional(&state.db)
                .await
                .ok()
                .flatten()
                .unwrap_or(row.status.clone());
        if let Ok(c) = counts(&state.db, &row.id).await {
            state.events.publish(
                "software_deployment.updated",
                row.client_id.clone(),
                json!({ "deployment_id": row.id, "status": status, "counts": c }),
            );
        }
    });
}

// ------------------------------------------------------------------ creation

#[derive(Deserialize)]
pub struct CreateBody {
    package_id: String,
    action: String,
    target: TargetSpec,
    #[serde(default)]
    schedule: Option<DeploySchedule>,
    #[serde(default)]
    confirm_count: Option<i64>,
}

/// Whether a source can perform an action at all.
fn supports(source: &PackageSource, action: &str) -> Result<(), String> {
    if action == "install" {
        return Ok(());
    }
    match source {
        PackageSource::File {
            installer,
            uninstall_args,
            ..
        } => match installer.as_str() {
            "msi" => Ok(()),
            "exe" | "sh" if !uninstall_args.trim().is_empty() => Ok(()),
            "exe" | "sh" => Err("uninstalling this file needs uninstall_args".into()),
            other => Err(format!("{other} files cannot be uninstalled by RustRMM")),
        },
        _ => Ok(()),
    }
}

/// `POST /api/v1/software/deployments`
pub async fn create(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Json(body): Json<CreateBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    ctx.require(perm::SOFTWARE_DEPLOY)?;
    if !matches!(body.action.as_str(), "install" | "uninstall") {
        return Err(ApiError::validation("action must be install or uninstall"));
    }
    let package = library::load(&state.db, &body.package_id)
        .await?
        .ok_or_else(|| {
            ApiError::validation("Unknown package").with_details(json!({ "path": "package_id" }))
        })?;
    let source = package
        .source()
        .ok_or_else(|| ApiError::internal("package source is unreadable"))?;
    supports(&source, &body.action).map_err(ApiError::validation)?;
    let schedule = body.schedule.clone().unwrap_or(DeploySchedule::Now);
    let now = rustrmm_common::now();
    if let DeploySchedule::Once { at } = &schedule {
        if *at < now - chrono::Duration::minutes(5) {
            return Err(ApiError::validation("schedule.at is in the past"));
        }
        if *at > now + chrono::Duration::days(366) {
            return Err(ApiError::validation("schedule.at is more than a year away"));
        }
    }
    let (client_id, site_id) =
        jobs::check_target_for(&state, &ctx, &body.target, perm::SOFTWARE_DEPLOY).await?;
    let mut target_ids = body.target.ids.clone();
    target_ids.sort();
    target_ids.dedup();
    let devices = jobs::resolve_targets(
        &state.db,
        &body.target.kind,
        &target_ids,
        client_id.as_deref(),
        None,
    )
    .await?;
    if let Some(d) = devices.iter().find(|d| {
        !ctx.scope
            .can_site(perm::SOFTWARE_DEPLOY, &d.client_id, &d.site_id)
    }) {
        return Err(ApiError::forbidden(format!(
            "Missing software.deploy on {}",
            d.hostname
        )));
    }
    // Phase 5 mass-action guard.
    let settings = crate::automation::settings::load(&state).await?;
    let count = devices.len() as i64;
    if count > settings.mass_action_threshold {
        ctx.require_step_up()?;
        if body.confirm_count != Some(count) {
            return Err(ApiError::conflict(
                "confirmation_required",
                format!("Type the number of devices ({count}) to confirm this deployment"),
            )
            .with_details(json!({ "count": count })));
        }
    }
    let platforms = package.platforms();
    let id = rustrmm_common::new_id();
    let status = match &schedule {
        DeploySchedule::Once { at } if *at > now => "scheduled",
        _ => "running",
    };
    let wait_from = match &schedule {
        DeploySchedule::Once { at } => (*at).max(now),
        _ => now,
    };
    let wait_until = match &schedule {
        DeploySchedule::Window => wait_from + chrono::Duration::days(WINDOW_WAIT_DAYS),
        _ => wait_from + chrono::Duration::hours(OFFLINE_WAIT_HOURS),
    };
    let mut tx = state.db.begin().await?;
    sqlx::query(
        "INSERT INTO software_deployments (id, package_id, package_name, action, target_type, target_ids, schedule, status,
                client_id, site_id, created_by, created_by_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&package.id)
    .bind(&package.name)
    .bind(&body.action)
    .bind(&body.target.kind)
    .bind(serde_json::to_string(&target_ids)?)
    .bind(serde_json::to_string(&schedule)?)
    .bind(status)
    .bind(&client_id)
    .bind(&site_id)
    .bind(&ctx.user.id)
    .bind(&ctx.user.name)
    .bind(now)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    for device in &devices {
        let (st, error) = if platforms.contains(&device.os_family) {
            ("pending", None)
        } else {
            (
                "skipped",
                Some(format!("The package does not support {}", device.os_family)),
            )
        };
        sqlx::query(
            "INSERT INTO software_deployment_results (deployment_id, device_id, status, error, wait_until, finished_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(&device.id)
        .bind(st)
        .bind(&error)
        .bind(wait_until)
        .bind((st == "skipped").then_some(now))
        .bind(now)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    let mut entry = ctx
        .audit("software.deployment_created")
        .target("software_deployment", &id, &package.name)
        .details(json!({ "package_id": package.id, "action": body.action, "source": source.kind(),
                         "target": { "type": body.target.kind, "ids": target_ids }, "device_count": count,
                         "schedule": schedule }));
    if let Some(c) = &client_id {
        entry = entry.client(c);
    }
    if let Some(s) = &site_id {
        entry = entry.site(s);
    }
    state.audit.record_or_log(&state.db, entry).await;
    if status == "running" {
        dispatch(&state, &id, None).await?;
        complete_if_done(&state, &id).await?;
    }
    let row = load(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::internal("deployment vanished"))?;
    publish(&state, &row);
    Ok((
        StatusCode::CREATED,
        Json(detail_json(&state.db, &row).await?),
    ))
}

// ------------------------------------------------------------------ dispatch

/// Sends pending actions of a deployment to online devices that are due (all devices, or one).
pub async fn dispatch(
    state: &AppState,
    deployment_id: &str,
    only_device: Option<&str>,
) -> anyhow::Result<()> {
    let _guard = state.automation.dispatch.lock().await;
    let Some(row) = load(&state.db, deployment_id).await? else {
        return Ok(());
    };
    if row.status != "running" {
        return Ok(());
    }
    let package = match row.package_id.as_deref() {
        Some(pid) => library::load(&state.db, pid).await?,
        None => None,
    };
    let Some(package) = package else {
        fail_pending(state, deployment_id, "The package was deleted").await?;
        return Ok(());
    };
    let running: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM software_deployment_results WHERE deployment_id = ? AND status = 'running'",
    )
    .bind(deployment_id)
    .fetch_one(&state.db)
    .await?;
    let slots = CONCURRENCY - running;
    if slots <= 0 {
        return Ok(());
    }
    let pending: Vec<String> = sqlx::query_scalar(
        "SELECT device_id FROM software_deployment_results WHERE deployment_id = ? AND status = 'pending' ORDER BY device_id",
    )
    .bind(deployment_id)
    .fetch_all(&state.db)
    .await?;
    let candidates: Vec<String> = pending
        .into_iter()
        .filter(|d| only_device.is_none_or(|o| o == d))
        .filter(|d| state.agents.is_online(d))
        .collect();
    if candidates.is_empty() {
        return Ok(());
    }
    // `window` deployments only run while the device's patch window is open; devices without
    // a window are skipped.
    let allowed: HashSet<String> = if row.schedule() == DeploySchedule::Window {
        let now = rustrmm_common::now();
        let devices = crate::patching::load_devices(state, Some(&candidates)).await?;
        for d in devices.iter().filter(|d| d.config.window.is_none()) {
            sqlx::query(
                "UPDATE software_deployment_results SET status = 'skipped', error = 'No patch window applies to this device',
                        finished_at = ?, updated_at = ? WHERE deployment_id = ? AND device_id = ? AND status = 'pending'",
            )
            .bind(now)
            .bind(now)
            .bind(deployment_id)
            .bind(&d.id)
            .execute(&state.db)
            .await?;
        }
        devices
            .into_iter()
            .filter(|d| {
                d.config
                    .window
                    .as_ref()
                    .is_some_and(|w| w.open_at(now).is_some())
            })
            .map(|d| d.id)
            .collect()
    } else {
        candidates.iter().cloned().collect()
    };
    let mut sent = 0i64;
    for device_id in candidates.iter().filter(|d| allowed.contains(*d)) {
        if sent >= slots {
            break;
        }
        if let Err(e) = send_action(state, &row, &package, device_id).await {
            tracing::debug!(device = %device_id, error = %format!("{e:#}"), "software action not sent; waiting");
        } else {
            sent += 1;
        }
    }
    if sent > 0 {
        publish(state, &row);
    }
    Ok(())
}

async fn send_action(
    state: &AppState,
    row: &DeploymentRow,
    package: &PackageRow,
    device_id: &str,
) -> anyhow::Result<()> {
    let source = package
        .source()
        .ok_or_else(|| anyhow::anyhow!("package source is unreadable"))?;
    let download = match &source {
        PackageSource::File {
            sha256, size_bytes, ..
        } => {
            let token =
                super::files::issue_token(&state.db, device_id, sha256, Some(&row.id)).await?;
            Some(FileDownload {
                url: super::files::download_path(sha256, &token),
                sha256: sha256.clone(),
                size: *size_bytes,
            })
        }
        _ => None,
    };
    let command = Command::SoftwareAction(SoftwareAction {
        action: row.action.clone(),
        source,
        detection: package.detection(),
        download,
        timeout_secs: ACTION_TIMEOUT_SECS,
        deployment_id: Some(row.id.clone()),
    });
    let cmd_id = rustrmm_common::new_id();
    let now = rustrmm_common::now();
    sqlx::query(
        "UPDATE software_deployment_results SET status = 'running', command_id = ?, started_at = ?, error = NULL, updated_at = ?
         WHERE deployment_id = ? AND device_id = ? AND status = 'pending'",
    )
    .bind(&cmd_id)
    .bind(now)
    .bind(now)
    .bind(&row.id)
    .bind(device_id)
    .execute(&state.db)
    .await?;
    let verb = if row.action == "install" {
        "Install"
    } else {
        "Uninstall"
    };
    let sent = crate::agents::commands::send_as(
        state,
        &cmd_id,
        device_id,
        command,
        row.created_by.as_deref(),
        600,
        &format!("{verb} {}", row.package_name),
    )
    .await;
    if let Err(e) = sent {
        sqlx::query("UPDATE software_deployment_results SET status = 'pending', command_id = NULL, started_at = NULL
                     WHERE deployment_id = ? AND device_id = ? AND command_id = ?")
            .bind(&row.id)
            .bind(device_id)
            .bind(&cmd_id)
            .execute(&state.db)
            .await?;
        return Err(e);
    }
    Ok(())
}

async fn fail_pending(state: &AppState, deployment_id: &str, reason: &str) -> anyhow::Result<()> {
    let now = rustrmm_common::now();
    sqlx::query("UPDATE software_deployment_results SET status = 'failed', error = ?, finished_at = ?, updated_at = ?
                 WHERE deployment_id = ? AND status = 'pending'")
        .bind(reason)
        .bind(now)
        .bind(now)
        .bind(deployment_id)
        .execute(&state.db)
        .await?;
    complete_if_done(state, deployment_id).await
}

/// Completes a running deployment once nothing is pending or running.
pub async fn complete_if_done(state: &AppState, deployment_id: &str) -> anyhow::Result<()> {
    let open: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM software_deployment_results WHERE deployment_id = ? AND status IN ('pending', 'running')",
    )
    .bind(deployment_id)
    .fetch_one(&state.db)
    .await?;
    if open > 0 {
        return Ok(());
    }
    let now = rustrmm_common::now();
    let changed = sqlx::query(
        "UPDATE software_deployments SET status = 'completed', finished_at = ?, updated_at = ? WHERE id = ? AND status = 'running'",
    )
    .bind(now)
    .bind(now)
    .bind(deployment_id)
    .execute(&state.db)
    .await?
    .rows_affected();
    if changed > 0
        && let Some(row) = load(&state.db, deployment_id).await?
    {
        publish(state, &row);
    }
    Ok(())
}

/// Scheduler pass: starts due deployments, expires waits and silent actions, dispatches.
pub async fn tick(state: &AppState) -> anyhow::Result<()> {
    let now = rustrmm_common::now();
    let scheduled: Vec<(String, String)> =
        sqlx::query_as("SELECT id, schedule FROM software_deployments WHERE status = 'scheduled'")
            .fetch_all(&state.db)
            .await?;
    for (id, schedule) in scheduled {
        let due = match serde_json::from_str::<DeploySchedule>(&schedule) {
            Ok(DeploySchedule::Once { at }) => at <= now,
            _ => true,
        };
        if due {
            sqlx::query("UPDATE software_deployments SET status = 'running', updated_at = ? WHERE id = ? AND status = 'scheduled'")
                .bind(now)
                .bind(&id)
                .execute(&state.db)
                .await?;
        }
    }
    sqlx::query(
        "UPDATE software_deployment_results SET status = 'skipped', error = 'The device was offline', finished_at = ?, updated_at = ?
         WHERE status = 'pending' AND wait_until IS NOT NULL AND wait_until <= ?
           AND deployment_id IN (SELECT id FROM software_deployments WHERE status = 'running')",
    )
    .bind(now)
    .bind(now)
    .bind(now)
    .execute(&state.db)
    .await?;
    let grace = i64::from(ACTION_TIMEOUT_SECS) + 1800;
    sqlx::query(
        "UPDATE software_deployment_results SET status = 'failed', error = 'The device did not report a result', finished_at = ?, updated_at = ?
         WHERE status = 'running' AND started_at IS NOT NULL AND started_at <= ?",
    )
    .bind(now)
    .bind(now)
    .bind(now - chrono::Duration::seconds(grace))
    .execute(&state.db)
    .await?;
    let running: Vec<String> =
        sqlx::query_scalar("SELECT id FROM software_deployments WHERE status = 'running'")
            .fetch_all(&state.db)
            .await?;
    for id in running {
        if let Err(e) = dispatch(state, &id, None).await {
            tracing::warn!(deployment = %id, error = %format!("{e:#}"), "software dispatch failed");
        }
        complete_if_done(state, &id).await?;
    }
    Ok(())
}

/// A device connected: its pending actions run now (when due).
pub async fn on_connect(state: &AppState, device_id: &str) -> anyhow::Result<()> {
    let ids: Vec<String> = sqlx::query_scalar(
        "SELECT r.deployment_id FROM software_deployment_results r JOIN software_deployments d ON d.id = r.deployment_id
         WHERE r.device_id = ? AND r.status = 'pending' AND d.status = 'running'",
    )
    .bind(device_id)
    .fetch_all(&state.db)
    .await?;
    for id in ids {
        dispatch(state, &id, Some(device_id)).await?;
    }
    Ok(())
}

/// Handles a `software_action` command result (called from `record_result`).
pub async fn on_result(
    state: &AppState,
    device_id: &str,
    result: &CommandResult,
) -> anyhow::Result<()> {
    if matches!(result.status.as_str(), "accepted" | "running") {
        return Ok(());
    }
    let found: Option<(String, String)> = sqlx::query_as(
        "SELECT deployment_id, status FROM software_deployment_results WHERE command_id = ? AND device_id = ?",
    )
    .bind(&result.cmd_id)
    .bind(device_id)
    .fetch_optional(&state.db)
    .await?;
    let Some((deployment_id, current)) = found else {
        return Ok(());
    };
    if current != "running" {
        return Ok(());
    }
    let Some(row) = load(&state.db, &deployment_id).await? else {
        return Ok(());
    };
    let outcome: SoftwareActionOutcome =
        serde_json::from_value(result.data.clone()).unwrap_or_default();
    let (status, error) = if result.status != "succeeded" {
        (
            "failed",
            Some(if result.message.is_empty() {
                format!("The device reported {}", result.status)
            } else {
                result.message.chars().take(500).collect()
            }),
        )
    } else if outcome.skipped {
        (
            "skipped",
            Some(if row.action == "install" {
                "Already installed".to_string()
            } else {
                "Not installed".to_string()
            }),
        )
    } else if outcome.succeeded(&row.action) {
        ("succeeded", None)
    } else if outcome
        .exit_code
        .is_some_and(|c| rustrmm_proto::patching::exit_code_outcome(c).0)
    {
        (
            "failed",
            Some("The installer succeeded but detection does not confirm the result".to_string()),
        )
    } else {
        (
            "failed",
            Some(match outcome.exit_code {
                Some(code) => format!("Exit code {code}"),
                None => "The action did not run".to_string(),
            }),
        )
    };
    let now = rustrmm_common::now();
    let output: String = outcome.output.chars().take(4096).collect();
    sqlx::query(
        "UPDATE software_deployment_results SET status = ?, exit_code = ?, detected_after = ?, error = ?, output = ?,
                finished_at = ?, updated_at = ? WHERE deployment_id = ? AND device_id = ?",
    )
    .bind(status)
    .bind(outcome.exit_code)
    .bind(outcome.detected_after)
    .bind(&error)
    .bind(&output)
    .bind(now)
    .bind(now)
    .bind(&deployment_id)
    .bind(device_id)
    .execute(&state.db)
    .await?;
    let verb = if row.action == "install" {
        "installed"
    } else {
        "uninstalled"
    };
    let (kind, severity, summary) = match status {
        "succeeded" => (
            format!("software.{verb}"),
            "info",
            format!("{} {verb}", row.package_name),
        ),
        "skipped" => (
            "software.skipped".to_string(),
            "info",
            format!(
                "{}: {}",
                row.package_name,
                error.clone().unwrap_or_default()
            ),
        ),
        _ => (
            "software.failed".to_string(),
            "warning",
            format!(
                "{} could not be {verb}: {}",
                row.package_name,
                error.clone().unwrap_or_default()
            ),
        ),
    };
    let _ = crate::agents::timeline(
        &state.db,
        device_id,
        &kind,
        severity,
        &summary,
        json!({ "deployment_id": deployment_id, "exit_code": outcome.exit_code, "reboot_required": outcome.reboot_required }),
    )
    .await;
    publish(state, &row);
    dispatch(state, &deployment_id, None).await?;
    complete_if_done(state, &deployment_id).await
}

// ------------------------------------------------------------------ API

#[derive(Deserialize)]
pub struct ListQuery {
    limit: Option<i64>,
}

/// `GET /api/v1/software/deployments?limit=`
pub async fn list(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::SOFTWARE_VIEW)?;
    let limit = q.limit.unwrap_or(50).clamp(1, 500) as usize;
    let rows: Vec<DeploymentRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{SELECT} ORDER BY created_at DESC, id DESC LIMIT 2000"
    )))
    .fetch_all(&state.db)
    .await?;
    let mut items = Vec::new();
    for row in rows
        .iter()
        .filter(|r| r.visible(&ctx, perm::SOFTWARE_VIEW))
        .take(limit)
    {
        items.push(summary_json(&state.db, row).await?);
    }
    Ok(Json(json!({ "items": items })))
}

async fn visible(state: &AppState, ctx: &AuthCtx, id: &str) -> ApiResult<DeploymentRow> {
    load(&state.db, id)
        .await?
        .filter(|r| r.visible(ctx, perm::SOFTWARE_VIEW))
        .ok_or_else(|| ApiError::not_found("Deployment"))
}

/// `GET /api/v1/software/deployments/{id}`
pub async fn get(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::SOFTWARE_VIEW)?;
    let row = visible(&state, &ctx, &id).await?;
    let results: Vec<(
        String,
        String,
        String,
        String,
        String,
        Option<i64>,
        Option<bool>,
        Option<String>,
        Option<String>,
    )> = sqlx::query_as(
        "SELECT r.device_id, COALESCE(d.display_name, d.hostname), s.client_id, d.site_id, r.status, r.exit_code,
                r.detected_after, r.error, r.output
         FROM software_deployment_results r JOIN devices d ON d.id = r.device_id JOIN sites s ON s.id = d.site_id
         WHERE r.deployment_id = ? ORDER BY d.hostname COLLATE NOCASE",
    )
    .bind(&id)
    .fetch_all(&state.db)
    .await?;
    let results: Vec<Value> = results
        .into_iter()
        .filter(|r| ctx.scope.can_site(perm::SOFTWARE_VIEW, &r.2, &r.3))
        .map(|(device_id, hostname, _, _, status, exit_code, detected_after, error, output)| {
            json!({ "device_id": device_id, "hostname": hostname, "status": status, "exit_code": exit_code,
                    "detected_after": detected_after, "error": error,
                    "output_preview": output.map(|o| o.chars().take(OUTPUT_PREVIEW).collect::<String>()) })
        })
        .collect();
    Ok(Json(
        json!({ "deployment": detail_json(&state.db, &row).await?, "results": results }),
    ))
}

/// `POST /api/v1/software/deployments/{id}/cancel`
pub async fn cancel(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::SOFTWARE_DEPLOY)?;
    let row = visible(&state, &ctx, &id).await?;
    if !row.visible(&ctx, perm::SOFTWARE_DEPLOY) {
        return Err(ApiError::forbidden("Missing permission: software.deploy"));
    }
    if !matches!(row.status.as_str(), "scheduled" | "running") {
        return Err(ApiError::conflict(
            "invalid_status",
            "Only scheduled or running deployments can be cancelled",
        ));
    }
    let now = rustrmm_common::now();
    sqlx::query("UPDATE software_deployment_results SET status = 'cancelled', finished_at = ?, updated_at = ? WHERE deployment_id = ? AND status = 'pending'")
        .bind(now)
        .bind(now)
        .bind(&id)
        .execute(&state.db)
        .await?;
    sqlx::query("UPDATE software_deployments SET status = 'cancelled', finished_at = ?, updated_at = ? WHERE id = ?")
        .bind(now)
        .bind(now)
        .bind(&id)
        .execute(&state.db)
        .await?;
    let mut entry = ctx.audit("software.deployment_cancelled").target(
        "software_deployment",
        &id,
        &row.package_name,
    );
    if let Some(c) = &row.client_id {
        entry = entry.client(c);
    }
    state.audit.record_or_log(&state.db, entry).await;
    let row = load(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::internal("deployment vanished"))?;
    publish(&state, &row);
    Ok(Json(detail_json(&state.db, &row).await?))
}

/// `GET /api/v1/devices/{id}/software-deployments`
pub async fn device_list(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    crate::patching::device_scope(&state, &ctx, &id, perm::SOFTWARE_VIEW).await?;
    let rows: Vec<(
        String,
        Option<String>,
        String,
        String,
        String,
        Option<i64>,
        Option<bool>,
        Option<String>,
        DateTime<Utc>,
        Option<DateTime<Utc>>,
    )> = sqlx::query_as(
        "SELECT d.id, d.package_id, d.package_name, d.action, r.status, r.exit_code, r.detected_after, r.error, d.created_at,
                r.finished_at
         FROM software_deployment_results r JOIN software_deployments d ON d.id = r.deployment_id
         WHERE r.device_id = ? ORDER BY d.created_at DESC LIMIT 200",
    )
    .bind(&id)
    .fetch_all(&state.db)
    .await?;
    let items: Vec<Value> = rows
        .into_iter()
        .map(|(dep, package_id, package_name, action, status, exit_code, detected, error, created, finished)| {
            json!({ "deployment_id": dep, "package": { "id": package_id, "name": package_name }, "action": action,
                    "status": status, "exit_code": exit_code, "detected_after": detected, "error": error,
                    "created_at": created, "finished_at": finished })
        })
        .collect();
    Ok(Json(json!({ "items": items })))
}

/// Deployment counts by status for one device (used by tests and the device page).
pub async fn device_counts(db: &Db, device_id: &str) -> anyhow::Result<HashMap<String, i64>> {
    let rows: Vec<(String, i64)> = sqlx::query_as(
        "SELECT status, COUNT(*) FROM software_deployment_results WHERE device_id = ? GROUP BY status",
    )
    .bind(device_id)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uninstall_support_depends_on_the_source() {
        let file = |installer: &str, uninstall: &str| PackageSource::File {
            file_id: String::new(),
            file_name: String::new(),
            sha256: String::new(),
            size_bytes: 0,
            installer: installer.into(),
            install_args: String::new(),
            uninstall_args: uninstall.into(),
        };
        assert!(supports(&file("msi", ""), "uninstall").is_ok());
        assert!(supports(&file("exe", ""), "uninstall").is_err());
        assert!(supports(&file("exe", "/S /uninstall"), "uninstall").is_ok());
        assert!(supports(&file("pkg", ""), "uninstall").is_err());
        assert!(supports(&file("pkg", ""), "install").is_ok());
        assert!(
            supports(
                &PackageSource::Winget {
                    id: "7zip.7zip".into()
                },
                "uninstall"
            )
            .is_ok()
        );
        let schedule: DeploySchedule =
            serde_json::from_value(json!({ "type": "window" })).expect("window");
        assert_eq!(schedule, DeploySchedule::Window);
    }
}
