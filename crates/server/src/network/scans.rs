//! Discovery scans: definitions, manual and scheduled runs through the site's probe, and the
//! streamed results that become assets.

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use rustrmm_proto::commands::{Command, CommandResult};
use rustrmm_proto::network::{NetworkScan, ScanMethods, ScanResults, validate_range};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::agents::DeviceRecord;
use crate::auth::AuthCtx;
use crate::db::Db;
use crate::error::{ApiError, ApiResult};
use crate::rbac::perm;
use crate::state::AppState;

/// A run that produced nothing for this long is failed.
const STALE_RUN_MINUTES: i64 = 120;
const MAX_RANGES: usize = 16;
const MAX_PORTS: usize = 64;

#[derive(Debug, Clone, sqlx::FromRow)]
struct ScanRow {
    id: String,
    site_id: String,
    site_name: String,
    client_id: String,
    site_timezone: String,
    name: String,
    ranges: String,
    methods: String,
    schedule: Option<String>,
    snmp_credential_ids: String,
    next_run_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

const SELECT: &str = "SELECT n.id, n.site_id, s.name AS site_name, s.client_id, s.timezone AS site_timezone, n.name, n.ranges,
    n.methods, n.schedule, n.snmp_credential_ids, n.next_run_at, n.created_at, n.updated_at
    FROM network_scans n JOIN sites s ON s.id = n.site_id";

impl ScanRow {
    fn ranges(&self) -> Vec<String> {
        serde_json::from_str(&self.ranges).unwrap_or_default()
    }

    fn methods(&self) -> ScanMethods {
        serde_json::from_str(&self.methods).unwrap_or_default()
    }

    fn schedule(&self) -> Option<Value> {
        self.schedule
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
    }

    fn credential_ids(&self) -> Vec<String> {
        serde_json::from_str(&self.snmp_credential_ids).unwrap_or_default()
    }

    async fn to_json(&self, db: &Db) -> anyhow::Result<Value> {
        let last: Option<(DateTime<Utc>, i64, Option<i64>, String, Option<String>)> = sqlx::query_as(
            "SELECT started_at, hosts_found, duration_ms, status, error FROM scan_runs WHERE scan_id = ?
             ORDER BY started_at DESC, id DESC LIMIT 1",
        )
        .bind(&self.id)
        .fetch_optional(db)
        .await?;
        Ok(json!({
            "id": self.id, "site_id": self.site_id, "site_name": self.site_name, "name": self.name,
            "ranges": self.ranges(), "methods": self.methods(), "schedule": self.schedule(),
            "snmp_credential_ids": self.credential_ids(),
            "last_run": last.map(|(at, hosts, duration, status, error)| json!({
                "at": at, "hosts_found": hosts, "duration_ms": duration, "status": status, "error": error,
            })),
            "next_run_at": self.next_run_at, "created_at": self.created_at, "updated_at": self.updated_at,
        }))
    }
}

async fn load_row(db: &Db, id: &str) -> anyhow::Result<Option<ScanRow>> {
    Ok(
        sqlx::query_as(sqlx::AssertSqlSafe(format!("{SELECT} WHERE n.id = ?")))
            .bind(id)
            .fetch_optional(db)
            .await?,
    )
}

async fn load(state: &AppState, ctx: &AuthCtx, id: &str, permission: &str) -> ApiResult<ScanRow> {
    let row = load_row(&state.db, id)
        .await?
        .filter(|r| {
            ctx.scope
                .can_site(perm::NETWORK_VIEW, &r.client_id, &r.site_id)
                || ctx.scope.can_site(permission, &r.client_id, &r.site_id)
        })
        .ok_or_else(|| ApiError::not_found("Scan"))?;
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

/// `GET /api/v1/network/scans`
#[utoipa::path(get, path = "/api/v1/network/scans", tag = "Network", summary = "List scans", responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn list(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::NETWORK_VIEW)?;
    let rows: Vec<ScanRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{SELECT} ORDER BY s.name COLLATE NOCASE, n.name COLLATE NOCASE"
    )))
    .fetch_all(&state.db)
    .await?;
    let mut items = Vec::new();
    for row in rows.iter().filter(|r| {
        ctx.scope
            .can_site(perm::NETWORK_VIEW, &r.client_id, &r.site_id)
            && q.site_id
                .as_deref()
                .is_none_or(|s| s.is_empty() || s == r.site_id)
    }) {
        items.push(row.to_json(&state.db).await?);
    }
    Ok(Json(json!({ "items": items })))
}

#[derive(Deserialize)]
pub struct ScheduleBody {
    cron: String,
    #[serde(default)]
    timezone: Option<String>,
}

#[derive(Deserialize)]
pub struct ScanBody {
    site_id: String,
    name: String,
    ranges: Vec<String>,
    #[serde(default)]
    methods: Option<ScanMethods>,
    #[serde(default)]
    schedule: Option<ScheduleBody>,
    #[serde(default)]
    snmp_credential_ids: Vec<String>,
}

struct Checked {
    name: String,
    ranges: Vec<String>,
    methods: ScanMethods,
    schedule: Option<Value>,
    next_run_at: Option<DateTime<Utc>>,
    credentials: Vec<String>,
}

async fn check_body(state: &AppState, body: &ScanBody) -> ApiResult<Checked> {
    let name = body.name.trim().to_string();
    if name.is_empty() || name.chars().count() > 120 {
        return Err(ApiError::validation("Name must be 1–120 characters"));
    }
    if body.ranges.is_empty() || body.ranges.len() > MAX_RANGES {
        return Err(ApiError::validation(format!(
            "ranges: 1–{MAX_RANGES} ranges"
        )));
    }
    let settings = super::load_settings(state).await?;
    let mut ranges = Vec::new();
    for (i, text) in body.ranges.iter().enumerate() {
        let range = validate_range(text, settings.allow_public_ranges).map_err(|e| {
            ApiError::validation(e).with_details(json!({ "path": format!("ranges[{i}]") }))
        })?;
        ranges.push(range.to_string());
    }
    ranges.dedup();
    let mut methods = body.methods.clone().unwrap_or_default();
    methods.tcp_ports.retain(|p| *p != 0);
    methods.tcp_ports.sort_unstable();
    methods.tcp_ports.dedup();
    if methods.tcp_ports.len() > MAX_PORTS {
        return Err(ApiError::validation(format!(
            "methods.tcp_ports: at most {MAX_PORTS} ports"
        )));
    }
    let tz: String = sqlx::query_scalar("SELECT timezone FROM sites WHERE id = ?")
        .bind(&body.site_id)
        .fetch_optional(&state.db)
        .await?
        .unwrap_or_else(|| "UTC".into());
    let (schedule, next_run_at) = match &body.schedule {
        Some(s) => {
            let timezone = s.timezone.clone().unwrap_or(tz);
            crate::automation::cron::validate(&s.cron, &timezone)
                .map_err(|e| ApiError::validation(format!("schedule: {e}")))?;
            let next =
                crate::automation::cron::next_after(&s.cron, &timezone, rustrmm_common::now());
            (
                Some(json!({ "cron": s.cron.trim(), "timezone": timezone })),
                next,
            )
        }
        None => (None, None),
    };
    let mut credentials = body.snmp_credential_ids.clone();
    credentials.dedup();
    if credentials.len() > 10 {
        return Err(ApiError::validation(
            "snmp_credential_ids: at most 10 credentials",
        ));
    }
    for id in &credentials {
        let found: Option<String> =
            sqlx::query_scalar("SELECT id FROM snmp_credentials WHERE id = ?")
                .bind(id)
                .fetch_optional(&state.db)
                .await?;
        if found.is_none() {
            return Err(
                ApiError::validation(format!("Unknown SNMP credential {id}"))
                    .with_details(json!({ "path": "snmp_credential_ids" })),
            );
        }
    }
    Ok(Checked {
        name,
        ranges,
        methods,
        schedule,
        next_run_at,
        credentials,
    })
}

/// `POST /api/v1/network/scans`
#[utoipa::path(post, path = "/api/v1/network/scans", tag = "Network", summary = "Create scan", request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn create(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Json(body): Json<ScanBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    ctx.require(perm::NETWORK_MANAGE)?;
    let client_id = super::site_scope(&state, &ctx, &body.site_id, perm::NETWORK_MANAGE).await?;
    let c = check_body(&state, &body).await?;
    let id = rustrmm_common::new_id();
    let now = rustrmm_common::now();
    sqlx::query(
        "INSERT INTO network_scans (id, site_id, name, ranges, methods, schedule, snmp_credential_ids, next_run_at, created_by,
                                    created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&body.site_id)
    .bind(&c.name)
    .bind(serde_json::to_string(&c.ranges)?)
    .bind(serde_json::to_string(&c.methods)?)
    .bind(c.schedule.as_ref().map(Value::to_string))
    .bind(serde_json::to_string(&c.credentials)?)
    .bind(c.next_run_at)
    .bind(&ctx.user.id)
    .bind(now)
    .bind(now)
    .execute(&state.db)
    .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("network.scan_created")
                .target("network_scan", &id, &c.name)
                .client(&client_id)
                .site(&body.site_id)
                .details(json!({ "ranges": c.ranges })),
        )
        .await;
    let row = load_row(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::internal("scan vanished"))?;
    Ok((StatusCode::CREATED, Json(row.to_json(&state.db).await?)))
}

/// `PUT /api/v1/network/scans/{id}`
#[utoipa::path(put, path = "/api/v1/network/scans/{id}", tag = "Network", summary = "Update scan", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn update(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(body): Json<ScanBody>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::NETWORK_MANAGE)?;
    let current = load(&state, &ctx, &id, perm::NETWORK_MANAGE).await?;
    if body.site_id != current.site_id {
        return Err(ApiError::validation("A scan cannot move to another site"));
    }
    let c = check_body(&state, &body).await?;
    sqlx::query(
        "UPDATE network_scans SET name = ?, ranges = ?, methods = ?, schedule = ?, snmp_credential_ids = ?, next_run_at = ?,
                                  updated_at = ? WHERE id = ?",
    )
    .bind(&c.name)
    .bind(serde_json::to_string(&c.ranges)?)
    .bind(serde_json::to_string(&c.methods)?)
    .bind(c.schedule.as_ref().map(Value::to_string))
    .bind(serde_json::to_string(&c.credentials)?)
    .bind(c.next_run_at)
    .bind(rustrmm_common::now())
    .bind(&id)
    .execute(&state.db)
    .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("network.scan_updated")
                .target("network_scan", &id, &c.name)
                .client(&current.client_id)
                .site(&current.site_id),
        )
        .await;
    let row = load_row(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("Scan"))?;
    Ok(Json(row.to_json(&state.db).await?))
}

/// `DELETE /api/v1/network/scans/{id}`
#[utoipa::path(delete, path = "/api/v1/network/scans/{id}", tag = "Network", summary = "Delete scan", params(("id" = String, Path)), responses((status = 204, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn delete(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    ctx.require(perm::NETWORK_MANAGE)?;
    let current = load(&state, &ctx, &id, perm::NETWORK_MANAGE).await?;
    sqlx::query("DELETE FROM network_scans WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("network.scan_deleted")
                .target("network_scan", &id, &current.name)
                .client(&current.client_id)
                .site(&current.site_id),
        )
        .await;
    Ok(StatusCode::NO_CONTENT)
}

/// Why a run could not start.
#[derive(Debug)]
pub enum RunError {
    NoProbe,
    ProbeOffline,
    Running,
    Invalid(String),
    Other(anyhow::Error),
}

impl From<anyhow::Error> for RunError {
    fn from(e: anyhow::Error) -> Self {
        Self::Other(e)
    }
}

impl From<sqlx::Error> for RunError {
    fn from(e: sqlx::Error) -> Self {
        Self::Other(e.into())
    }
}

/// Starts a run of a scan on its site's probe. Returns (run id, command id).
async fn start_run(
    state: &AppState,
    scan: &ScanRow,
    trigger: &str,
    created_by: Option<&str>,
) -> Result<(String, String), RunError> {
    let probe = super::probes::of_site(&state.db, &scan.site_id)
        .await?
        .ok_or(RunError::NoProbe)?;
    if !state.agents.is_online(&probe.device_id) {
        return Err(RunError::ProbeOffline);
    }
    let now = rustrmm_common::now();
    let active: Option<String> = sqlx::query_scalar(
        "SELECT id FROM scan_runs WHERE scan_id = ? AND status = 'running' AND started_at > ?",
    )
    .bind(&scan.id)
    .bind(now - chrono::Duration::minutes(STALE_RUN_MINUTES))
    .fetch_optional(&state.db)
    .await?;
    if active.is_some() {
        return Err(RunError::Running);
    }
    let settings = super::load_settings(state).await?;
    let mut ranges = Vec::new();
    for text in scan.ranges() {
        ranges.push(
            validate_range(&text, settings.allow_public_ranges)
                .map_err(RunError::Invalid)?
                .to_string(),
        );
    }
    let methods = scan.methods();
    let mut snmp = Vec::new();
    if methods.snmp {
        for id in scan.credential_ids() {
            if let Some(c) = super::credentials::load_decrypted(state, &id).await? {
                snmp.push(c);
            }
        }
    }
    let run_id = rustrmm_common::new_id();
    let cmd_id = rustrmm_common::new_id();
    sqlx::query(
        "INSERT INTO scan_runs (id, scan_id, site_id, device_id, cmd_id, trigger_kind, status, started_at) VALUES (?, ?, ?, ?, ?, ?, 'running', ?)",
    )
    .bind(&run_id)
    .bind(&scan.id)
    .bind(&scan.site_id)
    .bind(&probe.device_id)
    .bind(&cmd_id)
    .bind(trigger)
    .bind(now)
    .execute(&state.db)
    .await?;
    let command = Command::NetworkScan(NetworkScan {
        scan_id: scan.id.clone(),
        run_id: Some(run_id.clone()),
        ranges,
        methods,
        snmp,
        concurrency: 64,
        timeout_ms: 800,
        allow_public: settings.allow_public_ranges,
    });
    if let Err(e) = crate::agents::commands::send_as(
        state,
        &cmd_id,
        &probe.device_id,
        command,
        created_by,
        3600,
        &format!("Network scan: {}", scan.name),
    )
    .await
    {
        finish_run(state, &run_id, Some(&format!("{e:#}"))).await?;
        return Err(RunError::ProbeOffline);
    }
    state.events.publish(
        "network.scan",
        Some(scan.client_id.clone()),
        json!({ "scan_id": scan.id, "run_id": run_id, "status": "running", "hosts_found": 0 }),
    );
    Ok((run_id, cmd_id))
}

/// `POST /api/v1/network/scans/{id}/run`
#[utoipa::path(post, path = "/api/v1/network/scans/{id}/run", tag = "Network", summary = "Run", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn run(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::NETWORK_MANAGE)?;
    let scan = load(&state, &ctx, &id, perm::NETWORK_MANAGE).await?;
    let (run_id, cmd_id) = start_run(&state, &scan, "manual", Some(&ctx.user.id))
        .await
        .map_err(|e| match e {
            RunError::NoProbe => ApiError::conflict("no_probe", "This site has no probe"),
            RunError::ProbeOffline => {
                ApiError::conflict("probe_offline", "The site's probe is offline")
            }
            RunError::Running => ApiError::conflict("scan_running", "This scan is already running"),
            RunError::Invalid(m) => ApiError::validation(m),
            RunError::Other(e) => ApiError::internal(format!("{e:#}")),
        })?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("network.scan_started")
                .target("network_scan", &id, &scan.name)
                .client(&scan.client_id)
                .site(&scan.site_id)
                .details(json!({ "run_id": run_id })),
        )
        .await;
    Ok(Json(json!({ "run_id": run_id, "cmd_id": cmd_id })))
}

async fn finish_run(state: &AppState, run_id: &str, error: Option<&str>) -> anyhow::Result<()> {
    let now = rustrmm_common::now();
    let started: Option<(DateTime<Utc>, String, String, i64)> = sqlx::query_as(
        "SELECT r.started_at, r.scan_id, s.client_id, r.hosts_found FROM scan_runs r JOIN sites s ON s.id = r.site_id
         WHERE r.id = ? AND r.status = 'running'",
    )
    .bind(run_id)
    .fetch_optional(&state.db)
    .await?;
    let Some((started_at, scan_id, client_id, hosts)) = started else {
        return Ok(());
    };
    let status = if error.is_some() {
        "failed"
    } else {
        "succeeded"
    };
    sqlx::query(
        "UPDATE scan_runs SET status = ?, finished_at = ?, duration_ms = ?, error = ? WHERE id = ? AND status = 'running'",
    )
    .bind(status)
    .bind(now)
    .bind((now - started_at).num_milliseconds().max(0))
    .bind(error.map(|e| e.chars().take(500).collect::<String>()))
    .bind(run_id)
    .execute(&state.db)
    .await?;
    state.events.publish(
        "network.scan",
        Some(client_id),
        json!({ "scan_id": scan_id, "run_id": run_id, "status": status, "hosts_found": hosts }),
    );
    Ok(())
}

/// A batch of `scan_results` from a probe.
pub async fn on_results(
    state: &AppState,
    probe: &DeviceRecord,
    results: ScanResults,
) -> anyhow::Result<()> {
    let run: Option<(String, String, String)> = match &results.run_id {
        Some(run_id) => {
            sqlx::query_as(
                "SELECT r.id, r.site_id, s.client_id FROM scan_runs r JOIN sites s ON s.id = r.site_id
                 WHERE r.id = ? AND r.scan_id = ? AND r.device_id = ? AND r.status = 'running'",
            )
            .bind(run_id)
            .bind(&results.scan_id)
            .bind(&probe.id)
            .fetch_optional(&state.db)
            .await?
        }
        None => {
            sqlx::query_as(
                "SELECT r.id, r.site_id, s.client_id FROM scan_runs r JOIN sites s ON s.id = r.site_id
                 WHERE r.scan_id = ? AND r.device_id = ? AND r.status = 'running' ORDER BY r.started_at DESC LIMIT 1",
            )
            .bind(&results.scan_id)
            .bind(&probe.id)
            .fetch_optional(&state.db)
            .await?
        }
    };
    let Some((run_id, site_id, client_id)) = run else {
        tracing::debug!(device = %probe.id, scan = %results.scan_id, "scan results without a running run ignored");
        return Ok(());
    };
    let mut stored = 0i64;
    for host in results
        .hosts
        .iter()
        .take(rustrmm_proto::network::MAX_RANGE_HOSTS as usize)
    {
        match super::assets::upsert(state, &site_id, &client_id, host, &results.scan_id).await {
            Ok(Some(_)) => stored += 1,
            Ok(None) => {}
            Err(e) => tracing::warn!(error = %format!("{e:#}"), "storing a discovered host failed"),
        }
    }
    if stored > 0 {
        sqlx::query("UPDATE scan_runs SET hosts_found = hosts_found + ? WHERE id = ?")
            .bind(stored)
            .bind(&run_id)
            .execute(&state.db)
            .await?;
        state.events.publish(
            "network.assets",
            Some(client_id.clone()),
            json!({ "site_id": site_id, "scan_id": results.scan_id }),
        );
    }
    if results.done {
        finish_run(state, &run_id, results.error.as_deref()).await?;
    }
    Ok(())
}

/// The `network_scan` command failed or was refused before results arrived.
pub async fn on_command_result(
    state: &AppState,
    device_id: &str,
    result: &CommandResult,
) -> anyhow::Result<()> {
    if !matches!(result.status.as_str(), "failed" | "rejected") {
        return Ok(());
    }
    let run: Option<String> = sqlx::query_scalar(
        "SELECT id FROM scan_runs WHERE cmd_id = ? AND device_id = ? AND status = 'running'",
    )
    .bind(&result.cmd_id)
    .bind(device_id)
    .fetch_optional(&state.db)
    .await?;
    if let Some(run_id) = run {
        let message = if result.message.is_empty() {
            format!("The probe reported {}", result.status)
        } else {
            result.message.clone()
        };
        finish_run(state, &run_id, Some(&message)).await?;
    }
    Ok(())
}

/// Scheduled scans that are due, and stale runs.
pub async fn tick(state: &AppState) -> anyhow::Result<()> {
    let now = rustrmm_common::now();
    let stale: Vec<String> =
        sqlx::query_scalar("SELECT id FROM scan_runs WHERE status = 'running' AND started_at < ?")
            .bind(now - chrono::Duration::minutes(STALE_RUN_MINUTES))
            .fetch_all(&state.db)
            .await?;
    for run_id in stale {
        finish_run(state, &run_id, Some("The scan timed out")).await?;
    }
    let due: Vec<ScanRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{SELECT} WHERE n.schedule IS NOT NULL AND n.next_run_at IS NOT NULL AND n.next_run_at <= ?"
    )))
    .bind(now)
    .fetch_all(&state.db)
    .await?;
    for scan in due {
        let next = scan.schedule().and_then(|s| {
            let cron = s.get("cron")?.as_str()?.to_string();
            let tz = s
                .get("timezone")
                .and_then(Value::as_str)
                .unwrap_or(&scan.site_timezone)
                .to_string();
            crate::automation::cron::next_after(&cron, &tz, now)
        });
        sqlx::query("UPDATE network_scans SET next_run_at = ? WHERE id = ?")
            .bind(next)
            .bind(&scan.id)
            .execute(&state.db)
            .await?;
        match start_run(state, &scan, "schedule", None).await {
            Ok(_) => {}
            Err(RunError::Other(e)) => {
                tracing::warn!(scan = %scan.id, error = %format!("{e:#}"), "scheduled scan failed to start")
            }
            Err(e) => tracing::debug!(scan = %scan.id, reason = ?e, "scheduled scan skipped"),
        }
    }
    Ok(())
}
