//! Jobs, runs and results.
//!
//! A job runs one script version on a set of devices: once now, once at a time, or on a cron
//! schedule. Each execution is a run, and each device in a run gets a result. Creation applies
//! the mass-action guard and four-eyes; dispatch sends signed `run_script` commands up to the
//! job's concurrency; results come back through `agents::commands::record_result`.

use std::collections::{BTreeMap, HashMap, HashSet};

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use rustrmm_proto::commands::{Command, CommandResult, RunScript};
use rustrmm_proto::scripts::{self as rules, MASK};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sqlx::{QueryBuilder, Sqlite};

use super::params::{self, ParamValue, SecretRule};
use super::scripts::{self, Runnable};
use super::settings::{self, AutomationSettings};
use crate::audit::{Actor, AuditEntry};
use crate::auth::AuthCtx;
use crate::db::Db;
use crate::error::{ApiError, ApiResult};
use crate::rbac::{AccessScope, perm};
use crate::state::AppState;

pub const VIEW: &str = "scripts.view";
pub const RUN: &str = "scripts.run";
const MANAGE: &str = "scripts.manage";
/// Results still waiting for an outcome.
const OPEN: &str = "('pending', 'waiting_offline', 'running')";
const PREVIEW_CHARS: usize = 200;

// ------------------------------------------------------------------ types

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Schedule {
    Now,
    Once {
        at: DateTime<Utc>,
    },
    Cron {
        cron: String,
        #[serde(default = "utc")]
        timezone: String,
    },
}

fn utc() -> String {
    "UTC".into()
}

impl Schedule {
    fn validate(&self) -> ApiResult<()> {
        match self {
            Self::Now => Ok(()),
            Self::Once { at } => {
                let now = rustrmm_common::now();
                if *at < now - chrono::Duration::minutes(5) {
                    return Err(ApiError::validation("schedule.at is in the past"));
                }
                if *at > now + chrono::Duration::days(366) {
                    return Err(ApiError::validation("schedule.at is more than a year away"));
                }
                Ok(())
            }
            Self::Cron { cron, timezone } => super::cron::validate(cron, timezone)
                .map_err(|e| ApiError::validation(e).with_details(json!({ "path": "schedule" }))),
        }
    }

    /// When the job should first run after being scheduled at `now` (`None` = immediately).
    fn first_run(&self, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
        match self {
            Self::Now => None,
            Self::Once { at } => Some(*at),
            Self::Cron { cron, timezone } => super::cron::next_after(cron, timezone, now),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TargetSpec {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub ids: Vec<String>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct JobRow {
    pub id: String,
    pub name: String,
    pub script_id: Option<String>,
    pub script_version: i64,
    pub adhoc_language: Option<String>,
    pub adhoc_content: Option<String>,
    pub content_sha256: String,
    pub parameters: String,
    pub secret_parameters: Option<Vec<u8>>,
    pub target_type: String,
    pub target_ids: String,
    pub schedule: String,
    pub next_run_at: Option<DateTime<Utc>>,
    pub status: String,
    pub offline_wait_minutes: i64,
    pub concurrency: i64,
    pub timeout_secs: i64,
    pub policy_id: Option<String>,
    pub policy_task_id: Option<String>,
    pub client_id: Option<String>,
    pub site_id: Option<String>,
    pub created_by: Option<String>,
    pub created_by_name: String,
    pub created_at: DateTime<Utc>,
    pub approved_by_name: Option<String>,
    pub deleted_at: Option<DateTime<Utc>>,
    pub script_name: Option<String>,
    pub script_language: Option<String>,
    pub script_risk: Option<String>,
    pub script_platforms: Option<String>,
}

const JOB_SELECT: &str = "SELECT j.id, j.name, j.script_id, j.script_version, j.adhoc_language, j.adhoc_content, j.content_sha256,
    j.parameters, j.secret_parameters, j.target_type, j.target_ids, j.schedule, j.next_run_at, j.status, j.offline_wait_minutes,
    j.concurrency, j.timeout_secs, j.policy_id, j.policy_task_id, j.client_id, j.site_id, j.created_by, j.created_by_name,
    j.created_at, j.approved_by_name, j.deleted_at, s.name AS script_name, s.language AS script_language, s.risk AS script_risk,
    s.platforms AS script_platforms
    FROM jobs j LEFT JOIN scripts s ON s.id = j.script_id";

impl JobRow {
    pub fn language(&self) -> String {
        self.adhoc_language
            .clone()
            .or_else(|| self.script_language.clone())
            .unwrap_or_default()
    }

    pub fn risk(&self) -> &str {
        self.script_risk.as_deref().unwrap_or("normal")
    }

    fn platforms(&self) -> Vec<String> {
        match (&self.adhoc_language, &self.script_platforms) {
            (Some(language), _) => rules::language_platforms(language)
                .iter()
                .map(|p| p.to_string())
                .collect(),
            (None, Some(p)) => serde_json::from_str(p).unwrap_or_default(),
            _ => Vec::new(),
        }
    }

    pub fn target_ids(&self) -> Vec<String> {
        serde_json::from_str(&self.target_ids).unwrap_or_default()
    }

    pub fn schedule(&self) -> Schedule {
        serde_json::from_str(&self.schedule).unwrap_or(Schedule::Now)
    }

    /// Visibility by the job's client/site scope (installation-wide jobs need a global grant).
    pub fn visible(&self, scope: &AccessScope, permission: &str) -> bool {
        scope_allows(
            scope,
            permission,
            self.client_id.as_deref(),
            self.site_id.as_deref(),
        )
    }
}

pub fn scope_allows(
    scope: &AccessScope,
    permission: &str,
    client: Option<&str>,
    site: Option<&str>,
) -> bool {
    match (client, site) {
        (Some(c), Some(s)) => scope.can_site(permission, c, s),
        (Some(c), None) => scope.can_client(permission, c),
        (None, _) => scope.has_global(permission),
    }
}

pub async fn load_job(db: &Db, id: &str) -> anyhow::Result<Option<JobRow>> {
    Ok(
        sqlx::query_as(sqlx::AssertSqlSafe(format!("{JOB_SELECT} WHERE j.id = ?")))
            .bind(id)
            .fetch_optional(db)
            .await?,
    )
}

fn secret_aad(job_id: &str) -> String {
    format!("jobs/secret_parameters/{job_id}")
}

/// A device a run targets.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct TargetDevice {
    pub id: String,
    pub hostname: String,
    pub client_id: String,
    pub site_id: String,
    pub os_family: String,
}

pub(crate) async fn devices_by_id(
    db: &Db,
    ids: &[String],
    client: Option<&str>,
) -> anyhow::Result<Vec<TargetDevice>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for chunk in ids.chunks(500) {
        let mut qb = QueryBuilder::<Sqlite>::new(
            "SELECT d.id, d.hostname, s.client_id, d.site_id, d.os_family FROM devices d JOIN sites s ON s.id = d.site_id
             WHERE d.status = 'active' AND d.id IN (",
        );
        let mut sep = qb.separated(", ");
        for id in chunk {
            sep.push_bind(id.clone());
        }
        qb.push(")");
        if let Some(c) = client {
            qb.push(" AND s.client_id = ").push_bind(c.to_string());
        }
        let rows: Vec<TargetDevice> = qb.build_query_as().fetch_all(db).await?;
        out.extend(rows);
    }
    out.sort_by_key(|a| a.hostname.to_lowercase());
    Ok(out)
}

/// Active devices a target currently resolves to (restricted to `client` when set).
pub(crate) async fn resolve_targets(
    db: &Db,
    kind: &str,
    ids: &[String],
    client: Option<&str>,
    policy_task: Option<&str>,
) -> anyhow::Result<Vec<TargetDevice>> {
    let device_ids: Vec<String> = match kind {
        "devices" => ids.to_vec(),
        "group" => {
            let mut all = HashSet::new();
            for group in ids {
                all.extend(super::groups::member_ids(db, group).await?);
            }
            all.into_iter().collect()
        }
        "site" | "client" => {
            let column = if kind == "site" {
                "d.site_id"
            } else {
                "s.client_id"
            };
            let mut qb = QueryBuilder::<Sqlite>::new(
                "SELECT d.id FROM devices d JOIN sites s ON s.id = d.site_id WHERE d.status = 'active' AND ",
            );
            qb.push(column).push(" IN (");
            let mut sep = qb.separated(", ");
            for id in ids {
                sep.push_bind(id.clone());
            }
            qb.push(")");
            if ids.is_empty() {
                Vec::new()
            } else {
                qb.build_query_scalar().fetch_all(db).await?
            }
        }
        "policy" => match (ids.first(), policy_task) {
            (Some(policy), Some(task)) => {
                super::policies::devices_with_task(db, policy, task).await?
            }
            _ => Vec::new(),
        },
        _ => Vec::new(),
    };
    devices_by_id(db, &device_ids, client).await
}

/// Checks the target exists and the caller may run scripts on it; returns the job's
/// visibility scope (client, site) and whether a global grant is required.
async fn check_target(
    state: &AppState,
    ctx: &AuthCtx,
    target: &TargetSpec,
) -> ApiResult<(Option<String>, Option<String>)> {
    check_target_for(state, ctx, target, RUN).await
}

/// [`check_target`] for another permission (software deployments use `software.deploy`).
pub(crate) async fn check_target_for(
    state: &AppState,
    ctx: &AuthCtx,
    target: &TargetSpec,
    permission: &'static str,
) -> ApiResult<(Option<String>, Option<String>)> {
    if target.ids.is_empty() || target.ids.len() > 5000 {
        return Err(ApiError::validation("target.ids must hold 1–5000 ids"));
    }
    let mut ids = target.ids.clone();
    ids.sort();
    ids.dedup();
    match target.kind.as_str() {
        "devices" => {
            let devices = devices_by_id(&state.db, &ids, None).await?;
            if devices.len() != ids.len() {
                return Err(ApiError::validation("Unknown or inactive device in target")
                    .with_details(json!({ "path": "target.ids" })));
            }
            for d in &devices {
                if !ctx
                    .scope
                    .can_site(perm::DEVICES_VIEW, &d.client_id, &d.site_id)
                {
                    return Err(ApiError::validation("Unknown or inactive device in target"));
                }
                if !ctx.scope.can_site(permission, &d.client_id, &d.site_id) {
                    return Err(ApiError::forbidden(format!(
                        "Missing {permission} on {}",
                        d.hostname
                    )));
                }
            }
            let clients: HashSet<&str> = devices.iter().map(|d| d.client_id.as_str()).collect();
            let sites: HashSet<&str> = devices.iter().map(|d| d.site_id.as_str()).collect();
            Ok(match (clients.len(), sites.len()) {
                (1, 1) => (
                    Some(devices[0].client_id.clone()),
                    Some(devices[0].site_id.clone()),
                ),
                (1, _) => {
                    let client = devices[0].client_id.clone();
                    if !ctx.scope.can_client(permission, &client) {
                        return Err(ApiError::forbidden(
                            "Targets across several sites need the permission for the whole client",
                        ));
                    }
                    (Some(client), None)
                }
                _ => {
                    ctx.require_global(permission)?;
                    (None, None)
                }
            })
        }
        "group" => {
            let mut client: Option<Option<String>> = None;
            for id in &ids {
                let group = super::groups::load(&state.db, id)
                    .await?
                    .filter(|g| g.visible(&ctx.scope))
                    .ok_or_else(|| ApiError::validation("Unknown group in target"))?;
                match &group.client_id {
                    None => ctx.require_global(permission)?,
                    Some(c) => ctx.require_client(permission, c)?,
                }
                client = match client {
                    None => Some(group.client_id.clone()),
                    Some(prev) if prev == group.client_id => Some(prev),
                    Some(_) => Some(None),
                };
            }
            let client = client.flatten();
            if client.is_none() {
                ctx.require_global(permission)?;
            }
            Ok((client, None))
        }
        "site" => {
            let mut scope: Option<(String, Option<String>)> = None;
            for id in &ids {
                let client: Option<String> =
                    sqlx::query_scalar("SELECT client_id FROM sites WHERE id = ?")
                        .bind(id)
                        .fetch_optional(&state.db)
                        .await?;
                let client =
                    client.ok_or_else(|| ApiError::validation("Unknown site in target"))?;
                if !ctx.scope.can_site(permission, &client, id) {
                    return Err(ApiError::forbidden("Missing permission on a target site"));
                }
                scope = match scope {
                    None => Some((client, Some(id.clone()))),
                    Some((c, _)) if c == client => Some((c, None)),
                    Some(_) => {
                        ctx.require_global(permission)?;
                        return Ok((None, None));
                    }
                };
            }
            let (client, site) = scope.ok_or_else(|| ApiError::validation("No target"))?;
            if site.is_none() && !ctx.scope.can_client(permission, &client) {
                return Err(ApiError::forbidden(
                    "Targets across several sites need the permission for the whole client",
                ));
            }
            Ok((Some(client), site))
        }
        "client" => {
            for id in &ids {
                let found: Option<String> =
                    sqlx::query_scalar("SELECT id FROM clients WHERE id = ?")
                        .bind(id)
                        .fetch_optional(&state.db)
                        .await?;
                found.ok_or_else(|| ApiError::validation("Unknown client in target"))?;
                ctx.require_client(permission, id)?;
            }
            if ids.len() == 1 {
                Ok((Some(ids[0].clone()), None))
            } else {
                ctx.require_global(permission)?;
                Ok((None, None))
            }
        }
        _ => Err(ApiError::validation(
            "target.type must be devices, group, site or client",
        )),
    }
}

/// Human label for a target.
async fn target_label(db: &Db, job: &JobRow) -> String {
    label_for(db, &job.target_type, &job.target_ids()).await
}

/// Human label for a target type and ids (`3 devices`, `Acme / Main Office`, …).
pub(crate) async fn label_for(db: &Db, target_type: &str, ids: &[String]) -> String {
    let ids = ids.to_vec();
    let first = ids.first().cloned().unwrap_or_default();
    let name = |sql: &'static str| {
        let first = first.clone();
        async move {
            sqlx::query_scalar::<_, String>(sql)
                .bind(first)
                .fetch_optional(db)
                .await
                .ok()
                .flatten()
                .unwrap_or_default()
        }
    };
    let more = if ids.len() > 1 {
        format!(" + {} more", ids.len() - 1)
    } else {
        String::new()
    };
    match target_type {
        "devices" if ids.len() == 1 => {
            name("SELECT COALESCE(display_name, hostname) FROM devices WHERE id = ?").await
        }
        "devices" => format!("{} devices", ids.len()),
        "group" => {
            let row: Option<(String, String)> =
                sqlx::query_as("SELECT name, kind FROM device_groups WHERE id = ?")
                    .bind(&first)
                    .fetch_optional(db)
                    .await
                    .ok()
                    .flatten();
            match row {
                Some((n, kind)) => format!("{n} ({kind}){more}"),
                None => "Deleted group".into(),
            }
        }
        "site" => {
            let row: Option<(String, String)> = sqlx::query_as(
                "SELECT c.name, s.name FROM sites s JOIN clients c ON c.id = s.client_id WHERE s.id = ?",
            )
            .bind(&first)
            .fetch_optional(db)
            .await
            .ok()
            .flatten();
            row.map(|(c, s)| format!("{c} / {s}{more}"))
                .unwrap_or_else(|| "Deleted site".into())
        }
        "client" => format!(
            "{}{more}",
            name("SELECT name FROM clients WHERE id = ?").await
        ),
        "policy" => {
            let policy = name("SELECT name FROM policies WHERE id = ?").await;
            format!("Policy: {policy}")
        }
        other => other.to_string(),
    }
}

// ------------------------------------------------------------------ JSON

#[derive(Debug, Clone, Default, Serialize)]
pub struct Counts {
    pub total: i64,
    pub pending: i64,
    pub waiting_offline: i64,
    pub running: i64,
    pub succeeded: i64,
    /// Failed and timed out.
    pub failed: i64,
    pub skipped: i64,
    pub cancelled: i64,
}

pub async fn counts(db: &Db, run_id: &str) -> anyhow::Result<Counts> {
    let row: (i64, i64, i64, i64, i64, i64, i64, i64) = sqlx::query_as(
        "SELECT COUNT(*), COALESCE(SUM(status = 'pending'), 0), COALESCE(SUM(status = 'waiting_offline'), 0),
                COALESCE(SUM(status = 'running'), 0), COALESCE(SUM(status = 'succeeded'), 0),
                COALESCE(SUM(status IN ('failed', 'timed_out')), 0), COALESCE(SUM(status = 'skipped'), 0),
                COALESCE(SUM(status = 'cancelled'), 0)
         FROM job_results WHERE run_id = ?",
    )
    .bind(run_id)
    .fetch_one(db)
    .await?;
    Ok(Counts {
        total: row.0,
        pending: row.1,
        waiting_offline: row.2,
        running: row.3,
        succeeded: row.4,
        failed: row.5,
        skipped: row.6,
        cancelled: row.7,
    })
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct RunRow {
    id: String,
    job_id: String,
    status: String,
    trigger_kind: String,
    started_at: DateTime<Utc>,
    finished_at: Option<DateTime<Utc>>,
}

const RUN_SELECT: &str =
    "SELECT id, job_id, status, trigger_kind, started_at, finished_at FROM job_runs";

async fn run_json(db: &Db, run: &RunRow) -> anyhow::Result<Value> {
    let c = counts(db, &run.id).await?;
    Ok(json!({
        "id": run.id, "job_id": run.job_id, "status": run.status, "trigger": run.trigger_kind,
        "total": c.total, "pending": c.pending, "waiting_offline": c.waiting_offline, "running": c.running,
        "succeeded": c.succeeded, "failed": c.failed, "skipped": c.skipped, "cancelled": c.cancelled,
        "started_at": run.started_at, "finished_at": run.finished_at,
    }))
}

/// Job document: `runs` (latest 20) when `detailed`, otherwise `last_run`.
async fn job_json(db: &Db, job: &JobRow, detailed: bool) -> anyhow::Result<Value> {
    let runs: Vec<RunRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{RUN_SELECT} WHERE job_id = ? ORDER BY started_at DESC, id DESC LIMIT ?"
    )))
    .bind(&job.id)
    .bind(if detailed { 20 } else { 1 })
    .fetch_all(db)
    .await?;
    let mut run_docs = Vec::with_capacity(runs.len());
    for run in &runs {
        run_docs.push(run_json(db, run).await?);
    }
    let script_name = match (&job.script_name, &job.adhoc_language) {
        (_, Some(_)) => "Ad-hoc script".to_string(),
        (Some(n), None) => n.clone(),
        _ => String::new(),
    };
    let mut doc = json!({
        "id": job.id, "name": job.name,
        "script": { "id": job.script_id, "name": script_name, "language": job.language(), "risk": job.risk() },
        "script_version": job.script_version, "content_sha256": job.content_sha256,
        "parameters": serde_json::from_str::<Value>(&job.parameters).unwrap_or_else(|_| json!({})),
        "target": { "type": job.target_type, "ids": job.target_ids(), "label": target_label(db, job).await },
        "schedule": serde_json::from_str::<Value>(&job.schedule).unwrap_or(Value::Null),
        "next_run_at": job.next_run_at, "status": job.status,
        "offline_wait_minutes": job.offline_wait_minutes, "concurrency": job.concurrency, "timeout_secs": job.timeout_secs,
        "created_by_name": job.created_by_name, "created_at": job.created_at, "approved_by_name": job.approved_by_name,
        "policy_id": job.policy_id,
    });
    if detailed {
        doc["runs"] = json!(run_docs);
    } else {
        doc["last_run"] = run_docs.into_iter().next().unwrap_or(Value::Null);
    }
    Ok(doc)
}

pub async fn job_summary(db: &Db, job: &JobRow) -> anyhow::Result<Value> {
    job_json(db, job, false).await
}

#[derive(Debug, sqlx::FromRow)]
struct ResultRow {
    run_id: String,
    job_id: String,
    device_id: String,
    hostname: String,
    os_family: String,
    client_name: String,
    client_id: String,
    site_id: String,
    status: String,
    exit_code: Option<i64>,
    started_at: Option<DateTime<Utc>>,
    finished_at: Option<DateTime<Utc>>,
    duration_ms: Option<i64>,
    error: Option<String>,
    stdout: Option<String>,
    stderr: Option<String>,
    truncated: bool,
    directives: String,
}

const RESULT_SELECT: &str = "SELECT r.run_id, r.job_id, r.device_id, d.hostname, d.os_family, c.name AS client_name, s.client_id,
    d.site_id, r.status, r.exit_code, r.started_at, r.finished_at, r.duration_ms, r.error, r.stdout, r.stderr, r.truncated,
    r.directives FROM job_results r JOIN devices d ON d.id = r.device_id JOIN sites s ON s.id = d.site_id
    JOIN clients c ON c.id = s.client_id";

impl ResultRow {
    fn to_json(&self) -> Value {
        json!({
            "device_id": self.device_id, "hostname": self.hostname, "os_family": self.os_family,
            "client_name": self.client_name, "status": self.status, "exit_code": self.exit_code,
            "started_at": self.started_at, "finished_at": self.finished_at, "duration_ms": self.duration_ms,
            "error": self.error,
            "stdout_preview": self.stdout.as_deref().map(|s| s.chars().take(PREVIEW_CHARS).collect::<String>()),
        })
    }

    fn visible(&self, scope: &AccessScope) -> bool {
        scope.can_site(perm::DEVICES_VIEW, &self.client_id, &self.site_id)
    }
}

// ------------------------------------------------------------------ creation

/// What a job runs.
pub enum Source {
    Script(Box<Runnable>),
    Adhoc { language: String, content: String },
}

pub struct NewJob {
    pub name: String,
    pub source: Source,
    pub parameters: BTreeMap<String, ParamValue>,
    pub target: TargetSpec,
    pub schedule: Schedule,
    pub offline_wait_minutes: i64,
    pub concurrency: i64,
    pub timeout_secs: i64,
    pub confirm_count: Option<i64>,
}

pub struct Created {
    pub job_id: String,
    pub run_id: Option<String>,
    pub status: String,
}

/// Creates a job after scope checks, the mass-action guard and four-eyes; starts it when due.
pub async fn create_job(state: &AppState, ctx: &AuthCtx, new: NewJob) -> ApiResult<Created> {
    new.schedule.validate()?;
    if !(1..=500).contains(&new.concurrency) {
        return Err(ApiError::validation(
            "concurrency must be between 1 and 500",
        ));
    }
    if !(0..=10_080).contains(&new.offline_wait_minutes) {
        return Err(ApiError::validation(
            "offline_wait_minutes must be between 0 and 10080",
        ));
    }
    if !(10..=86_400).contains(&new.timeout_secs) {
        return Err(ApiError::validation(
            "timeout_secs must be between 10 and 86400",
        ));
    }
    let name = new.name.trim().to_string();
    if name.is_empty() || name.chars().count() > 120 {
        return Err(ApiError::validation("Name must be 1–120 characters"));
    }
    let (client_id, site_id) = check_target(state, ctx, &new.target).await?;
    let mut target_ids = new.target.ids.clone();
    target_ids.sort();
    target_ids.dedup();
    let devices = resolve_targets(
        &state.db,
        &new.target.kind,
        &target_ids,
        client_id.as_deref(),
        None,
    )
    .await?;
    if let Some(d) = devices
        .iter()
        .find(|d| !ctx.scope.can_site(RUN, &d.client_id, &d.site_id))
    {
        return Err(ApiError::forbidden(format!(
            "Missing scripts.run on {}",
            d.hostname
        )));
    }

    let settings = settings::load(state).await?;
    let count = devices.len() as i64;
    let (risk, language, content_sha256, script_id, version, adhoc) = match &new.source {
        Source::Script(r) => (
            r.script.risk.clone(),
            r.script.language.clone(),
            r.content_sha256.clone(),
            Some(r.script.id.clone()),
            r.version,
            None,
        ),
        Source::Adhoc { language, content } => (
            "normal".to_string(),
            language.clone(),
            rules::sha256_hex(content),
            None,
            0,
            Some(content.clone()),
        ),
    };
    let guarded = count > settings.mass_action_threshold || risk == "high";
    if guarded {
        ctx.require_step_up()?;
        if new.confirm_count != Some(count) {
            return Err(ApiError::conflict(
                "confirmation_required",
                format!("Type the number of devices ({count}) to confirm this job"),
            )
            .with_details(json!({ "count": count })));
        }
    }
    let four_eyes = settings.four_eyes_jobs && guarded;

    let id = rustrmm_common::new_id();
    let now = rustrmm_common::now();
    let mut display = Map::new();
    let mut secrets = Map::new();
    for (key, value) in &new.parameters {
        if value.secret {
            display.insert(key.clone(), json!(MASK));
            secrets.insert(key.clone(), json!(value.value));
        } else {
            display.insert(key.clone(), json!(value.value));
        }
    }
    let secret_blob = (!secrets.is_empty()).then(|| {
        state
            .cipher
            .encrypt_str(&Value::Object(secrets).to_string(), &secret_aad(&id))
    });
    let status = if four_eyes {
        "pending_approval"
    } else {
        "scheduled"
    };
    let next_run_at = if four_eyes {
        None
    } else {
        new.schedule.first_run(now)
    };
    sqlx::query(
        "INSERT INTO jobs (id, name, script_id, script_version, adhoc_language, adhoc_content, content_sha256, parameters, secret_parameters,
                           target_type, target_ids, schedule, next_run_at, status, offline_wait_minutes, concurrency, timeout_secs,
                           client_id, site_id, created_by, created_by_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&name)
    .bind(&script_id)
    .bind(version)
    .bind(adhoc.as_ref().map(|_| language.clone()))
    .bind(&adhoc)
    .bind(&content_sha256)
    .bind(Value::Object(display.clone()).to_string())
    .bind(secret_blob)
    .bind(&new.target.kind)
    .bind(serde_json::to_string(&target_ids)?)
    .bind(serde_json::to_string(&new.schedule)?)
    .bind(next_run_at)
    .bind(status)
    .bind(new.offline_wait_minutes)
    .bind(new.concurrency)
    .bind(new.timeout_secs)
    .bind(&client_id)
    .bind(&site_id)
    .bind(&ctx.user.id)
    .bind(&ctx.user.name)
    .bind(now)
    .bind(now)
    .execute(&state.db)
    .await?;

    // Audit: hashes and parameter names only, never script content or secret values.
    let mut details = json!({
        "script_id": script_id, "script_version": version, "content_sha256": content_sha256, "language": language,
        "risk": risk, "target": { "type": new.target.kind, "ids": target_ids }, "device_count": count,
        "schedule": new.schedule, "parameters": display, "status": status,
    });
    if let Some(content) = &adhoc {
        details["preview"] = json!(content.chars().take(PREVIEW_CHARS).collect::<String>());
    }
    let mut entry = ctx
        .audit(if adhoc.is_some() {
            "script.adhoc_run"
        } else {
            "job.created"
        })
        .target("job", &id, &name)
        .details(details);
    if let Some(c) = &client_id {
        entry = entry.client(c);
    }
    if let Some(s) = &site_id {
        entry = entry.site(s);
    }
    state.audit.record_or_log(&state.db, entry).await;

    if four_eyes {
        super::approvals::open(state, ctx, &id, client_id.as_deref(), site_id.as_deref()).await?;
        return Ok(Created {
            job_id: id,
            run_id: None,
            status: status.into(),
        });
    }
    let due_now = next_run_at.is_none_or(|t| t <= now);
    let run_id = if due_now {
        if next_run_at.is_some() {
            sqlx::query("UPDATE jobs SET next_run_at = NULL WHERE id = ?")
                .bind(&id)
                .execute(&state.db)
                .await?;
        }
        Some(start_run(state, &id, "manual", Some(ctx), None).await?)
    } else {
        None
    };
    let status: String = sqlx::query_scalar("SELECT status FROM jobs WHERE id = ?")
        .bind(&id)
        .fetch_one(&state.db)
        .await?;
    Ok(Created {
        job_id: id,
        run_id,
        status,
    })
}

/// Starts a run of a job now. `only` limits it to these devices (re-runs).
pub async fn start_run(
    state: &AppState,
    job_id: &str,
    trigger: &str,
    actor: Option<&AuthCtx>,
    only: Option<Vec<String>>,
) -> anyhow::Result<String> {
    let mut job = load_job(&state.db, job_id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("job {job_id} not found"))?;
    if job.policy_id.is_some() {
        refresh_policy_job(state, &mut job).await?;
    }
    let devices = match only {
        Some(ids) => devices_by_id(&state.db, &ids, job.client_id.as_deref()).await?,
        None => {
            resolve_targets(
                &state.db,
                &job.target_type,
                &job.target_ids(),
                job.client_id.as_deref(),
                job.policy_task_id.as_deref(),
            )
            .await?
        }
    };
    let platforms = job.platforms();
    let now = rustrmm_common::now();
    let wait_until = now + chrono::Duration::minutes(job.offline_wait_minutes);
    let run_id = rustrmm_common::new_id();
    let mut tx = state.db.begin().await?;
    sqlx::query("INSERT INTO job_runs (id, job_id, status, trigger_kind, started_at) VALUES (?, ?, 'running', ?, ?)")
        .bind(&run_id)
        .bind(job_id)
        .bind(trigger)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    for device in &devices {
        let (status, error, wait): (&str, Option<String>, Option<DateTime<Utc>>) =
            if !platforms.contains(&device.os_family) {
                (
                    "skipped",
                    Some(format!("The script does not support {}", device.os_family)),
                    None,
                )
            } else if state.agents.is_online(&device.id) {
                ("pending", None, None)
            } else if job.offline_wait_minutes > 0 {
                ("waiting_offline", None, Some(wait_until))
            } else {
                ("skipped", Some("Device offline".to_string()), None)
            };
        sqlx::query("INSERT INTO job_results (run_id, device_id, job_id, status, wait_until, error, finished_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
            .bind(&run_id)
            .bind(&device.id)
            .bind(job_id)
            .bind(status)
            .bind(wait)
            .bind(&error)
            .bind((status == "skipped").then_some(now))
            .bind(now)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("UPDATE jobs SET status = 'running', updated_at = ? WHERE id = ? AND status IN ('scheduled', 'running', 'completed')")
        .bind(now)
        .bind(job_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    let entry = match actor {
        Some(ctx) => ctx.audit("job.run_started"),
        None => AuditEntry::new(Actor::System, "job.run_started"),
    };
    let mut entry = entry
        .target("job", job_id, &job.name)
        .details(json!({ "run_id": run_id, "trigger": trigger, "devices": devices.len(),
                         "script_version": job.script_version, "content_sha256": job.content_sha256 }));
    if let Some(c) = &job.client_id {
        entry = entry.client(c);
    }
    state.audit.record_or_log(&state.db, entry).await;
    super::publish_job_updated(state, job_id, &run_id, true);
    dispatch_run(state, &run_id).await?;
    complete_run_if_done(state, &run_id).await?;
    Ok(run_id)
}

/// Policy jobs follow the script's current (or approved) version at each run.
async fn refresh_policy_job(state: &AppState, job: &mut JobRow) -> anyhow::Result<()> {
    let Some(script_id) = job.script_id.clone() else {
        return Ok(());
    };
    let settings = settings::load(state).await?;
    let runnable = scripts::runnable_version(state, &script_id, &settings)
        .await
        .map_err(|e| anyhow::anyhow!("{}", e.message))?;
    if runnable.version != job.script_version {
        sqlx::query(
            "UPDATE jobs SET script_version = ?, content_sha256 = ?, updated_at = ? WHERE id = ?",
        )
        .bind(runnable.version)
        .bind(&runnable.content_sha256)
        .bind(rustrmm_common::now())
        .bind(&job.id)
        .execute(&state.db)
        .await?;
        job.script_version = runnable.version;
        job.content_sha256 = runnable.content_sha256;
    }
    Ok(())
}

// ------------------------------------------------------------------ dispatch

/// The script content of a job, checked against the job's hash.
async fn job_content(db: &Db, job: &JobRow) -> anyhow::Result<String> {
    let content = match (&job.adhoc_content, &job.script_id) {
        (Some(content), _) => content.clone(),
        (None, Some(script_id)) => {
            scripts::load_version(db, script_id, job.script_version)
                .await?
                .ok_or_else(|| anyhow::anyhow!("script version {} missing", job.script_version))?
                .content
        }
        _ => anyhow::bail!("job has no script"),
    };
    if rules::sha256_hex(&content) != job.content_sha256 {
        anyhow::bail!("script content does not match the job's hash; refusing to dispatch");
    }
    Ok(content)
}

fn secret_params(state: &AppState, job: &JobRow) -> Map<String, Value> {
    job.secret_parameters
        .as_ref()
        .and_then(|blob| state.cipher.decrypt_string(blob, &secret_aad(&job.id)).ok())
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

/// Environment and mask list for one device: variables (most specific scope wins), then the
/// job's parameters.
async fn environment(
    state: &AppState,
    job: &JobRow,
    secrets: &Map<String, Value>,
    client_id: &str,
    site_id: &str,
) -> anyhow::Result<(Vec<(String, String)>, Vec<String>)> {
    let mut env = Vec::new();
    let mut mask = Vec::new();
    for var in super::variables::for_device(state, client_id, site_id).await? {
        if var.secret {
            mask.push(var.value.clone());
        }
        env.push((var.name, var.value));
    }
    let plain: Map<String, Value> = serde_json::from_str(&job.parameters).unwrap_or_default();
    for (key, value) in plain {
        if let Some(secret) = secrets.get(&key).and_then(Value::as_str) {
            mask.push(secret.to_string());
            env.push((key, secret.to_string()));
        } else if let Some(text) = value.as_str() {
            env.push((key, text.to_string()));
        }
    }
    mask.retain(|m| m.chars().count() >= rules::MIN_MASK_LEN);
    Ok((env, mask))
}

/// Sends pending results of a run to online devices, up to the job's concurrency.
pub async fn dispatch_run(state: &AppState, run_id: &str) -> anyhow::Result<()> {
    let _guard = state.automation.dispatch.lock().await;
    let run: Option<(String, String)> =
        sqlx::query_as("SELECT job_id, status FROM job_runs WHERE id = ?")
            .bind(run_id)
            .fetch_optional(&state.db)
            .await?;
    let Some((job_id, status)) = run else {
        return Ok(());
    };
    if status != "running" {
        return Ok(());
    }
    let Some(job) = load_job(&state.db, &job_id).await? else {
        return Ok(());
    };
    let running: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM job_results WHERE run_id = ? AND status = 'running'",
    )
    .bind(run_id)
    .fetch_one(&state.db)
    .await?;
    let slots = job.concurrency - running;
    if slots <= 0 {
        return Ok(());
    }
    let pending: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT r.device_id, s.client_id, d.site_id FROM job_results r JOIN devices d ON d.id = r.device_id
         JOIN sites s ON s.id = d.site_id WHERE r.run_id = ? AND r.status = 'pending' ORDER BY d.hostname COLLATE NOCASE LIMIT ?",
    )
    .bind(run_id)
    .bind(slots)
    .fetch_all(&state.db)
    .await?;
    if pending.is_empty() {
        return Ok(());
    }
    let content = match job_content(&state.db, &job).await {
        Ok(c) => c,
        Err(e) => {
            let message = format!("{e:#}");
            tracing::error!(job = %job.id, error = %message, "cannot dispatch job");
            sqlx::query("UPDATE job_results SET status = 'failed', error = ?, finished_at = ?, updated_at = ? WHERE run_id = ? AND status = 'pending'")
                .bind(&message)
                .bind(rustrmm_common::now())
                .bind(rustrmm_common::now())
                .bind(run_id)
                .execute(&state.db)
                .await?;
            super::publish_job_updated(state, &job.id, run_id, false);
            return Ok(());
        }
    };
    let settings = settings::load(state).await?;
    let secrets = secret_params(state, &job);
    let language = job.language();
    let summary = format!("Run script {}", job.name);
    for (device_id, client_id, site_id) in pending {
        let now = rustrmm_common::now();
        if !state.agents.is_online(&device_id) {
            park_offline(state, &job, run_id, &device_id).await?;
            continue;
        }
        let (env, mask) = environment(state, &job, &secrets, &client_id, &site_id).await?;
        let command = Command::RunScript(RunScript {
            language: language.clone(),
            content: content.clone(),
            content_sha256: job.content_sha256.clone(),
            env,
            mask,
            timeout_secs: job.timeout_secs.clamp(10, 86_400) as u32,
            max_output_bytes: settings.max_output_bytes(),
        });
        // The result row points at the command before it is sent: a fast agent can answer
        // before `send` returns.
        let cmd_id = rustrmm_common::new_id();
        sqlx::query("UPDATE job_results SET status = 'running', command_id = ?, started_at = ?, error = NULL, updated_at = ? WHERE run_id = ? AND device_id = ? AND status = 'pending'")
            .bind(&cmd_id)
            .bind(now)
            .bind(now)
            .bind(run_id)
            .bind(&device_id)
            .execute(&state.db)
            .await?;
        let sent = crate::agents::commands::send_as(
            state,
            &cmd_id,
            &device_id,
            command,
            job.created_by.as_deref(),
            job.timeout_secs + 60,
            &summary,
        )
        .await;
        if let Err(e) = sent {
            tracing::debug!(device = %device_id, error = %format!("{e:#}"), "script dispatch failed; parking result");
            sqlx::query("UPDATE job_results SET status = 'pending', command_id = NULL, started_at = NULL WHERE run_id = ? AND device_id = ? AND command_id = ?")
                .bind(run_id)
                .bind(&device_id)
                .bind(&cmd_id)
                .execute(&state.db)
                .await?;
            park_offline(state, &job, run_id, &device_id).await?;
        }
    }
    super::publish_job_updated(state, &job.id, run_id, false);
    Ok(())
}

/// A pending result whose device is offline waits (within the window) or is skipped.
async fn park_offline(
    state: &AppState,
    job: &JobRow,
    run_id: &str,
    device_id: &str,
) -> anyhow::Result<()> {
    let now = rustrmm_common::now();
    let started: Option<DateTime<Utc>> =
        sqlx::query_scalar("SELECT started_at FROM job_runs WHERE id = ?")
            .bind(run_id)
            .fetch_optional(&state.db)
            .await?;
    let deadline = started.unwrap_or(now) + chrono::Duration::minutes(job.offline_wait_minutes);
    if job.offline_wait_minutes > 0 && deadline > now {
        sqlx::query("UPDATE job_results SET status = 'waiting_offline', wait_until = ?, updated_at = ? WHERE run_id = ? AND device_id = ? AND status = 'pending'")
            .bind(deadline)
            .bind(now)
            .bind(run_id)
            .bind(device_id)
            .execute(&state.db)
            .await?;
    } else {
        sqlx::query("UPDATE job_results SET status = 'skipped', error = 'Device offline', finished_at = ?, updated_at = ? WHERE run_id = ? AND device_id = ? AND status = 'pending'")
            .bind(now)
            .bind(now)
            .bind(run_id)
            .bind(device_id)
            .execute(&state.db)
            .await?;
    }
    Ok(())
}

/// Marks a run completed when no result is open, then refreshes its job's status.
pub async fn complete_run_if_done(state: &AppState, run_id: &str) -> anyhow::Result<()> {
    let open: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT COUNT(*) FROM job_results WHERE run_id = ? AND status IN {OPEN}"
    )))
    .bind(run_id)
    .fetch_one(&state.db)
    .await?;
    if open > 0 {
        return Ok(());
    }
    let job_id: Option<String> = sqlx::query_scalar("SELECT job_id FROM job_runs WHERE id = ?")
        .bind(run_id)
        .fetch_optional(&state.db)
        .await?;
    let Some(job_id) = job_id else {
        return Ok(());
    };
    let now = rustrmm_common::now();
    let changed = sqlx::query("UPDATE job_runs SET status = 'completed', finished_at = ? WHERE id = ? AND status = 'running'")
        .bind(now)
        .bind(run_id)
        .execute(&state.db)
        .await?
        .rows_affected();
    refresh_job_status(&state.db, &job_id).await?;
    if changed > 0 {
        super::publish_job_updated(state, &job_id, run_id, true);
        publish_job_completed(state, &job_id, run_id).await;
    }
    Ok(())
}

/// `job.completed` (webhooks): the run's outcome counts, never script content or output.
async fn publish_job_completed(state: &AppState, job_id: &str, run_id: &str) {
    let row: Option<(String, Option<String>)> =
        sqlx::query_as("SELECT name, client_id FROM jobs WHERE id = ?")
            .bind(job_id)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten();
    let Some((name, client_id)) = row else {
        return;
    };
    let counts = counts(&state.db, run_id).await.ok();
    state.events.publish(
        "job.completed",
        client_id,
        json!({ "job_id": job_id, "run_id": run_id, "name": name, "status": "completed", "counts": counts }),
    );
}

/// running while a run is active; scheduled while a next run is planned; otherwise completed.
pub async fn refresh_job_status(db: &Db, job_id: &str) -> anyhow::Result<()> {
    sqlx::query(
        "UPDATE jobs SET status = CASE
             WHEN EXISTS (SELECT 1 FROM job_runs WHERE job_id = jobs.id AND status = 'running') THEN 'running'
             WHEN next_run_at IS NOT NULL THEN 'scheduled'
             ELSE 'completed' END,
         updated_at = ?
         WHERE id = ? AND status IN ('running', 'scheduled', 'completed')",
    )
    .bind(rustrmm_common::now())
    .bind(job_id)
    .execute(db)
    .await?;
    Ok(())
}

// ------------------------------------------------------------------ results

fn cap(text: &str, max_bytes: usize) -> (String, bool) {
    if text.len() <= max_bytes {
        return (text.to_string(), false);
    }
    let mut end = max_bytes;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_string(), true)
}

/// Handles a `run_script` command result (called from `record_result`).
pub async fn on_script_result(
    state: &AppState,
    device_id: &str,
    result: &CommandResult,
) -> anyhow::Result<()> {
    let row: Option<(String, String, String)> = sqlx::query_as(
        "SELECT run_id, job_id, status FROM job_results WHERE command_id = ? AND device_id = ?",
    )
    .bind(&result.cmd_id)
    .bind(device_id)
    .fetch_optional(&state.db)
    .await?;
    let Some((run_id, job_id, current)) = row else {
        return Ok(());
    };
    if matches!(result.status.as_str(), "accepted" | "running") || current != "running" {
        return Ok(());
    }
    let Some(job) = load_job(&state.db, &job_id).await? else {
        return Ok(());
    };
    let settings = settings::load(state).await?;
    let max = settings.max_output_bytes() as usize;

    let data = &result.data;
    let (status, exit_code, error, stdout, stderr, truncated, duration) = if result.status
        == "succeeded"
    {
        let exit_code = data.get("exit_code").and_then(Value::as_i64);
        let timed_out = data
            .get("timed_out")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let status = if timed_out {
            "timed_out"
        } else if exit_code == Some(0) {
            "succeeded"
        } else {
            "failed"
        };
        let error = timed_out.then(|| format!("The script timed out after {} s", job.timeout_secs));
        let (out, out_cut) = cap(
            data.get("stdout")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            max,
        );
        let (err, err_cut) = cap(
            data.get("stderr")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            max,
        );
        let truncated = out_cut
            || err_cut
            || data
                .get("truncated")
                .and_then(Value::as_bool)
                .unwrap_or(false);
        (
            status,
            exit_code,
            error,
            Some(out),
            Some(err),
            truncated,
            data.get("duration_ms").and_then(Value::as_i64),
        )
    } else {
        let message = if result.message.is_empty() {
            format!("The device reported {}", result.status)
        } else {
            result.message.chars().take(500).collect()
        };
        ("failed", None, Some(message), None, None, false, None)
    };

    // Mask again on the server: a defect on one side must not leak a secret.
    let place: Option<(String, String)> = sqlx::query_as(
        "SELECT s.client_id, d.site_id FROM devices d JOIN sites s ON s.id = d.site_id WHERE d.id = ?",
    )
    .bind(device_id)
    .fetch_optional(&state.db)
    .await?;
    let masks = match &place {
        Some((client, site)) => environment(state, &job, &secret_params(state, &job), client, site)
            .await
            .map(|(_, m)| m)
            .unwrap_or_default(),
        None => Vec::new(),
    };
    let stdout = stdout.map(|s| rules::mask_output(&s, &masks, truncated));
    let stderr = stderr.map(|s| rules::mask_output(&s, &masks, truncated));

    let mut directives = Vec::new();
    if let Some(out) = &stdout {
        for directive in super::directives::parse(out) {
            match super::custom_fields::apply_directive(
                state,
                device_id,
                &directive.field,
                &directive.value,
                &job.name,
            )
            .await
            {
                Ok(_) => directives.push(json!({ "field": directive.field, "value": directive.value, "applied": true })),
                Err(reason) => directives.push(json!({ "field": directive.field, "value": directive.value, "applied": false, "reason": reason })),
            }
        }
    }

    let now = rustrmm_common::now();
    sqlx::query("UPDATE job_results SET status = ?, exit_code = ?, finished_at = ?, duration_ms = ?, error = ?, stdout = ?, stderr = ?,
                 truncated = ?, directives = ?, updated_at = ? WHERE run_id = ? AND device_id = ?")
        .bind(status)
        .bind(exit_code)
        .bind(now)
        .bind(duration)
        .bind(&error)
        .bind(&stdout)
        .bind(&stderr)
        .bind(truncated)
        .bind(serde_json::to_string(&directives)?)
        .bind(now)
        .bind(&run_id)
        .bind(device_id)
        .execute(&state.db)
        .await?;

    let (kind, severity, summary) = if status == "succeeded" {
        (
            "script.succeeded",
            "info",
            format!("{} succeeded (exit code 0)", job.name),
        )
    } else {
        let detail = match (exit_code, &error) {
            (Some(code), None) => format!("exit code {code}"),
            (_, Some(e)) => e.clone(),
            (None, None) => status.to_string(),
        };
        (
            "script.failed",
            "warning",
            format!("{} failed: {detail}", job.name),
        )
    };
    let _ = crate::agents::timeline(
        &state.db,
        device_id,
        kind,
        severity,
        &summary,
        json!({ "job_id": job.id, "run_id": run_id, "job_name": job.name, "exit_code": exit_code, "status": status }),
    )
    .await;
    state.events.publish(
        "job.result",
        place.as_ref().map(|(c, _)| c.clone()),
        json!({ "job_id": job.id, "run_id": run_id, "device_id": device_id, "status": status }),
    );
    super::publish_job_updated(state, &job.id, &run_id, false);
    if job.created_by_name == crate::monitoring::remediation::CREATED_BY
        && let Err(e) = crate::monitoring::remediation::on_job_result(state, &job.id, status).await
    {
        tracing::warn!(job = %job.id, error = %format!("{e:#}"), "recording the remediation outcome failed");
    }
    dispatch_run(state, &run_id).await?;
    complete_run_if_done(state, &run_id).await
}

// ------------------------------------------------------------------ scheduler hooks

/// Starts due `once` and `cron` jobs. A missed cron tick runs once, not once per missed tick.
pub async fn start_due(state: &AppState) -> anyhow::Result<()> {
    let now = rustrmm_common::now();
    let due: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT id, schedule, policy_id FROM jobs WHERE status = 'scheduled' AND deleted_at IS NULL
           AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at",
    )
    .bind(now)
    .fetch_all(&state.db)
    .await?;
    for (job_id, schedule, policy_id) in due {
        let next = match serde_json::from_str::<Schedule>(&schedule) {
            Ok(Schedule::Cron { cron, timezone }) => super::cron::next_after(&cron, &timezone, now),
            _ => None,
        };
        sqlx::query("UPDATE jobs SET next_run_at = ?, updated_at = ? WHERE id = ?")
            .bind(next)
            .bind(now)
            .bind(&job_id)
            .execute(&state.db)
            .await?;
        let active: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM job_runs WHERE job_id = ? AND status = 'running'",
        )
        .bind(&job_id)
        .fetch_one(&state.db)
        .await?;
        if active > 0 {
            tracing::info!(job = %job_id, "previous run still active; skipping this occurrence");
            continue;
        }
        if policy_id.is_some() {
            let Some(job) = load_job(&state.db, &job_id).await? else {
                continue;
            };
            let targets = resolve_targets(
                &state.db,
                "policy",
                &job.target_ids(),
                None,
                job.policy_task_id.as_deref(),
            )
            .await?;
            if targets.is_empty() {
                refresh_job_status(&state.db, &job_id).await?;
                continue;
            }
        }
        let trigger = if policy_id.is_some() {
            "policy"
        } else {
            "schedule"
        };
        if let Err(e) = start_run(state, &job_id, trigger, None, None).await {
            tracing::warn!(job = %job_id, error = %format!("{e:#}"), "could not start scheduled run");
            refresh_job_status(&state.db, &job_id).await?;
        }
    }
    Ok(())
}

/// Expires offline waits and silent devices, dispatches pending results, completes runs.
pub async fn sweep(state: &AppState) -> anyhow::Result<()> {
    let now = rustrmm_common::now();
    sqlx::query("UPDATE job_results SET status = 'skipped', error = 'Device offline beyond the wait window', finished_at = ?, updated_at = ?
                 WHERE status = 'waiting_offline' AND wait_until IS NOT NULL AND wait_until <= ?")
        .bind(now)
        .bind(now)
        .bind(now)
        .execute(&state.db)
        .await?;
    let running: Vec<(String, String, Option<DateTime<Utc>>, i64)> = sqlx::query_as(
        "SELECT r.run_id, r.device_id, r.started_at, j.timeout_secs FROM job_results r JOIN jobs j ON j.id = r.job_id
         WHERE r.status = 'running'",
    )
    .fetch_all(&state.db)
    .await?;
    for (run_id, device_id, started, timeout) in running {
        let deadline = started.unwrap_or(now) + chrono::Duration::seconds(timeout + 120);
        if deadline < now {
            sqlx::query("UPDATE job_results SET status = 'failed', error = 'The device did not report a result', finished_at = ?, updated_at = ?
                         WHERE run_id = ? AND device_id = ? AND status = 'running'")
                .bind(now)
                .bind(now)
                .bind(&run_id)
                .bind(&device_id)
                .execute(&state.db)
                .await?;
        }
    }
    let waiting: Vec<(String, String)> = sqlx::query_as(
        "SELECT run_id, device_id FROM job_results WHERE status = 'waiting_offline'",
    )
    .fetch_all(&state.db)
    .await?;
    for (run_id, device_id) in waiting {
        if state.agents.is_online(&device_id) {
            sqlx::query("UPDATE job_results SET status = 'pending', updated_at = ? WHERE run_id = ? AND device_id = ? AND status = 'waiting_offline'")
                .bind(now)
                .bind(&run_id)
                .bind(&device_id)
                .execute(&state.db)
                .await?;
        }
    }
    let runs: Vec<String> = sqlx::query_scalar("SELECT id FROM job_runs WHERE status = 'running'")
        .fetch_all(&state.db)
        .await?;
    for run_id in runs {
        if let Err(e) = dispatch_run(state, &run_id).await {
            tracing::warn!(run = %run_id, error = %format!("{e:#}"), "dispatch failed");
        }
        complete_run_if_done(state, &run_id).await?;
    }
    Ok(())
}

/// A device connected: its waiting results are dispatched immediately.
pub async fn on_connect(state: &AppState, device_id: &str) -> anyhow::Result<()> {
    let now = rustrmm_common::now();
    sqlx::query("UPDATE job_results SET status = 'pending', updated_at = ? WHERE device_id = ? AND status = 'waiting_offline'
                 AND (wait_until IS NULL OR wait_until > ?) AND run_id IN (SELECT id FROM job_runs WHERE status = 'running')")
        .bind(now)
        .bind(device_id)
        .bind(now)
        .execute(&state.db)
        .await?;
    let runs: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT run_id FROM job_results WHERE device_id = ? AND status = 'pending'",
    )
    .bind(device_id)
    .fetch_all(&state.db)
    .await?;
    for run_id in runs {
        dispatch_run(state, &run_id).await?;
    }
    Ok(())
}

/// A device disconnected: scripts it was running can no longer report back.
pub async fn on_disconnect(state: &AppState, device_id: &str) -> anyhow::Result<()> {
    let runs: Vec<String> = sqlx::query_scalar(
        "SELECT run_id FROM job_results WHERE device_id = ? AND status = 'running'",
    )
    .bind(device_id)
    .fetch_all(&state.db)
    .await?;
    if runs.is_empty() {
        return Ok(());
    }
    let now = rustrmm_common::now();
    sqlx::query("UPDATE job_results SET status = 'failed', error = 'The device disconnected while the script was running',
                 finished_at = ?, updated_at = ? WHERE device_id = ? AND status = 'running'")
        .bind(now)
        .bind(now)
        .bind(device_id)
        .execute(&state.db)
        .await?;
    for run_id in runs {
        dispatch_run(state, &run_id).await?;
        complete_run_if_done(state, &run_id).await?;
    }
    Ok(())
}

/// Start-up: scripts that were running when the server stopped can no longer report back.
pub async fn recover(db: &Db) -> anyhow::Result<()> {
    let now = rustrmm_common::now();
    let n = sqlx::query("UPDATE job_results SET status = 'failed', error = 'Interrupted: the server restarted while the script was running',
                         finished_at = ?, updated_at = ? WHERE status = 'running'")
        .bind(now)
        .bind(now)
        .execute(db)
        .await?
        .rows_affected();
    if n > 0 {
        tracing::warn!(results = n, "marked interrupted script results as failed");
    }
    Ok(())
}

// ------------------------------------------------------------------ policy jobs

/// Keeps one policy job per enabled task of a policy (removing jobs of deleted tasks).
pub async fn sync_policy_jobs(
    state: &AppState,
    policy_id: &str,
    actor_name: &str,
) -> anyhow::Result<()> {
    let doc: Option<String> = sqlx::query_scalar("SELECT document FROM policies WHERE id = ?")
        .bind(policy_id)
        .fetch_optional(&state.db)
        .await?;
    let tasks: Vec<super::policies::PolicyTask> = doc
        .and_then(|d| serde_json::from_str::<Value>(&d).ok())
        .and_then(|d| super::policies::validate_structure(&d).ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|t| t.enabled)
        .collect();
    let existing: Vec<(
        String,
        Option<String>,
        Option<DateTime<Utc>>,
        String,
        String,
    )> = sqlx::query_as(
        "SELECT id, policy_task_id, deleted_at, schedule, status FROM jobs WHERE policy_id = ?",
    )
    .bind(policy_id)
    .fetch_all(&state.db)
    .await?;
    let settings = settings::load(state).await?;
    let now = rustrmm_common::now();
    let mut kept = HashSet::new();
    for task in &tasks {
        let runnable = match scripts::runnable_version(state, &task.script_id, &settings).await {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(policy = policy_id, task = %task.id, error = %e.message, "policy task script unavailable");
                continue;
            }
        };
        let values = params::validate_values(
            &runnable.parameters,
            &task.parameters,
            SecretRule::FromVariables,
        )
        .unwrap_or_default();
        let parameters: Map<String, Value> = values
            .into_iter()
            .map(|(k, v)| (k, json!(v.value)))
            .collect();
        let schedule = Schedule::Cron {
            cron: task.cron.clone(),
            timezone: task.timezone.clone(),
        };
        let schedule_json = serde_json::to_string(&schedule)?;
        let next = schedule.first_run(now);
        let name = task.name.clone();
        match existing
            .iter()
            .find(|e| e.1.as_deref() == Some(task.id.as_str()))
        {
            Some((id, _, deleted, old_schedule, status)) => {
                let reschedule =
                    deleted.is_some() || old_schedule != &schedule_json || status != "running";
                sqlx::query("UPDATE jobs SET name = ?, script_id = ?, script_version = ?, content_sha256 = ?, parameters = ?, schedule = ?,
                             next_run_at = CASE WHEN ? THEN ? ELSE next_run_at END,
                             status = CASE WHEN status = 'running' THEN 'running' ELSE 'scheduled' END,
                             offline_wait_minutes = ?, timeout_secs = ?, deleted_at = NULL, updated_at = ? WHERE id = ?")
                    .bind(&name)
                    .bind(&runnable.script.id)
                    .bind(runnable.version)
                    .bind(&runnable.content_sha256)
                    .bind(Value::Object(parameters).to_string())
                    .bind(&schedule_json)
                    .bind(reschedule)
                    .bind(next)
                    .bind(task.offline_wait_minutes)
                    .bind(runnable.script.timeout_secs)
                    .bind(now)
                    .bind(id)
                    .execute(&state.db)
                    .await?;
                kept.insert(id.clone());
            }
            None => {
                let id = rustrmm_common::new_id();
                sqlx::query("INSERT INTO jobs (id, name, script_id, script_version, content_sha256, parameters, target_type, target_ids, schedule,
                             next_run_at, status, offline_wait_minutes, concurrency, timeout_secs, policy_id, policy_task_id, created_by_name,
                             created_at, updated_at)
                             VALUES (?, ?, ?, ?, ?, ?, 'policy', ?, ?, ?, 'scheduled', ?, 50, ?, ?, ?, ?, ?, ?)")
                    .bind(&id)
                    .bind(&name)
                    .bind(&runnable.script.id)
                    .bind(runnable.version)
                    .bind(&runnable.content_sha256)
                    .bind(Value::Object(parameters).to_string())
                    .bind(serde_json::to_string(&[policy_id])?)
                    .bind(&schedule_json)
                    .bind(next)
                    .bind(task.offline_wait_minutes)
                    .bind(runnable.script.timeout_secs)
                    .bind(policy_id)
                    .bind(&task.id)
                    .bind(actor_name)
                    .bind(now)
                    .bind(now)
                    .execute(&state.db)
                    .await?;
                kept.insert(id);
            }
        }
    }
    for (id, _, deleted, _, _) in &existing {
        if deleted.is_none() && !kept.contains(id) {
            sqlx::query("UPDATE jobs SET status = CASE WHEN status = 'running' THEN 'running' ELSE 'cancelled' END, next_run_at = NULL,
                         deleted_at = ?, updated_at = ? WHERE id = ?")
                .bind(now)
                .bind(now)
                .bind(id)
                .execute(&state.db)
                .await?;
        }
    }
    state.automation.kick();
    Ok(())
}

// ------------------------------------------------------------------ API

#[derive(Deserialize)]
pub struct CreateBody {
    #[serde(default)]
    name: Option<String>,
    script_id: String,
    #[serde(default)]
    parameters: Map<String, Value>,
    target: TargetSpec,
    #[serde(default)]
    schedule: Option<Schedule>,
    #[serde(default)]
    offline_wait_minutes: Option<i64>,
    #[serde(default)]
    concurrency: Option<i64>,
    #[serde(default)]
    timeout_secs: Option<i64>,
    #[serde(default)]
    confirm_count: Option<i64>,
}

async fn created_job_json(state: &AppState, job_id: &str) -> ApiResult<Value> {
    let job = load_job(&state.db, job_id)
        .await?
        .ok_or_else(|| ApiError::internal("job vanished"))?;
    Ok(job_json(&state.db, &job, true).await?)
}

/// `POST /api/v1/jobs`
#[utoipa::path(post, path = "/api/v1/jobs", tag = "Jobs", summary = "Create job", request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn create(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Json(body): Json<CreateBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    ctx.require(RUN)?;
    let settings = settings::load(&state).await?;
    let runnable = scripts::runnable_version(&state, &body.script_id, &settings).await?;
    let parameters =
        params::validate_values(&runnable.parameters, &body.parameters, SecretRule::Supplied)
            .map_err(|e| ApiError::validation(e).with_details(json!({ "path": "parameters" })))?;
    let new = NewJob {
        name: body
            .name
            .clone()
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| runnable.script.name.clone()),
        timeout_secs: body.timeout_secs.unwrap_or(runnable.script.timeout_secs),
        source: Source::Script(Box::new(runnable)),
        parameters,
        target: body.target,
        schedule: body.schedule.unwrap_or(Schedule::Now),
        offline_wait_minutes: body
            .offline_wait_minutes
            .unwrap_or(settings.default_offline_wait_minutes),
        concurrency: body.concurrency.unwrap_or(25),
        confirm_count: body.confirm_count,
    };
    let created = create_job(&state, &ctx, new).await?;
    Ok((
        StatusCode::CREATED,
        Json(created_job_json(&state, &created.job_id).await?),
    ))
}

#[derive(Deserialize)]
pub struct ListQuery {
    status: Option<String>,
    script_id: Option<String>,
    device_id: Option<String>,
    limit: Option<i64>,
    cursor: Option<String>,
}

/// `GET /api/v1/jobs?status=&script_id=&device_id=&limit=50&cursor=`
#[utoipa::path(get, path = "/api/v1/jobs", tag = "Jobs", summary = "List jobs", responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn list(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Value>> {
    ctx.require(VIEW)?;
    let limit = q.limit.unwrap_or(50).clamp(1, 200) as usize;
    let mut qb = QueryBuilder::<Sqlite>::new(JOB_SELECT);
    qb.push(" WHERE j.deleted_at IS NULL");
    if let Some(status) = q.status.as_deref().filter(|s| !s.is_empty()) {
        qb.push(" AND j.status = ").push_bind(status.to_string());
    }
    if let Some(script) = q.script_id.as_deref().filter(|s| !s.is_empty()) {
        qb.push(" AND j.script_id = ").push_bind(script.to_string());
    }
    if let Some(device) = q.device_id.as_deref().filter(|s| !s.is_empty()) {
        qb.push(" AND (EXISTS (SELECT 1 FROM job_results r WHERE r.job_id = j.id AND r.device_id = ")
            .push_bind(device.to_string())
            .push(") OR (j.target_type = 'devices' AND EXISTS (SELECT 1 FROM json_each(j.target_ids) WHERE value = ")
            .push_bind(device.to_string())
            .push(")))");
    }
    if let Some(cursor) = q.cursor.as_deref().filter(|s| !s.is_empty()) {
        qb.push(" AND j.id < ").push_bind(cursor.to_string());
    }
    qb.push(" ORDER BY j.id DESC LIMIT 2000");
    let rows: Vec<JobRow> = qb.build_query_as().fetch_all(&state.db).await?;
    let visible: Vec<&JobRow> = rows
        .iter()
        .filter(|j| j.visible(&ctx.scope, VIEW))
        .take(limit + 1)
        .collect();
    let has_more = visible.len() > limit;
    let mut items = Vec::new();
    for job in visible.iter().take(limit) {
        items.push(job_json(&state.db, job, false).await?);
    }
    let next_cursor = if has_more {
        visible.get(limit - 1).map(|j| j.id.clone())
    } else {
        None
    };
    Ok(Json(json!({ "items": items, "next_cursor": next_cursor })))
}

async fn visible_job(
    state: &AppState,
    ctx: &AuthCtx,
    id: &str,
    permission: &str,
) -> ApiResult<JobRow> {
    let job = load_job(&state.db, id)
        .await?
        .filter(|j| j.deleted_at.is_none() && j.visible(&ctx.scope, VIEW))
        .ok_or_else(|| ApiError::not_found("Job"))?;
    if !job.visible(&ctx.scope, permission) {
        return Err(
            ApiError::forbidden(format!("Missing permission: {permission}"))
                .with_details(json!({ "permission": permission })),
        );
    }
    Ok(job)
}

/// `GET /api/v1/jobs/{id}`
#[utoipa::path(get, path = "/api/v1/jobs/{id}", tag = "Jobs", summary = "Get job", params(("id" = String, Path)), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn get(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let job = visible_job(&state, &ctx, &id, VIEW).await?;
    Ok(Json(job_json(&state.db, &job, true).await?))
}

/// `POST /api/v1/jobs/{id}/run-now`
#[utoipa::path(post, path = "/api/v1/jobs/{id}/run-now", tag = "Jobs", summary = "Run now", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn run_now(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let job = visible_job(&state, &ctx, &id, RUN).await?;
    if !matches!(job.status.as_str(), "scheduled" | "completed") {
        return Err(ApiError::conflict(
            "invalid_state",
            format!("A {} job cannot be started", job.status.replace('_', " ")),
        ));
    }
    if matches!(job.schedule(), Schedule::Once { .. }) {
        sqlx::query("UPDATE jobs SET next_run_at = NULL WHERE id = ?")
            .bind(&id)
            .execute(&state.db)
            .await?;
    }
    let run_id = start_run(&state, &id, "manual", Some(&ctx), None).await?;
    Ok(Json(json!({ "job_id": id, "run_id": run_id })))
}

async fn cancel_results(state: &AppState, filter_column: &str, id: &str) -> anyhow::Result<()> {
    let now = rustrmm_common::now();
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "UPDATE job_results SET status = 'cancelled', finished_at = ?, updated_at = ? WHERE {filter_column} = ? AND status IN ('pending', 'waiting_offline')"
    )))
    .bind(now)
    .bind(now)
    .bind(id)
    .execute(&state.db)
    .await?;
    let run_filter = if filter_column == "run_id" {
        "id"
    } else {
        "job_id"
    };
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "UPDATE job_runs SET status = 'cancelled', finished_at = ? WHERE {run_filter} = ? AND status = 'running'"
    )))
    .bind(now)
    .bind(id)
    .execute(&state.db)
    .await?;
    Ok(())
}

/// `POST /api/v1/jobs/{id}/cancel` — stops the schedule and cancels results not yet started.
#[utoipa::path(post, path = "/api/v1/jobs/{id}/cancel", tag = "Jobs", summary = "Cancel", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn cancel(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let job = visible_job(&state, &ctx, &id, RUN).await?;
    if matches!(job.status.as_str(), "cancelled" | "rejected") {
        return Err(ApiError::conflict("invalid_state", "The job is not active"));
    }
    sqlx::query(
        "UPDATE jobs SET status = 'cancelled', next_run_at = NULL, updated_at = ? WHERE id = ?",
    )
    .bind(rustrmm_common::now())
    .bind(&id)
    .execute(&state.db)
    .await?;
    cancel_results(&state, "job_id", &id).await?;
    super::approvals::close_for_job(&state, &id, "rejected", &ctx, "Cancelled by the requester")
        .await?;
    let mut entry = ctx.audit("job.cancelled").target("job", &id, &job.name);
    if let Some(c) = &job.client_id {
        entry = entry.client(c);
    }
    state.audit.record_or_log(&state.db, entry).await;
    let runs: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM job_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT 1",
    )
    .bind(&id)
    .fetch_all(&state.db)
    .await?;
    for run in runs {
        super::publish_job_updated(&state, &id, &run, true);
    }
    get(State(state), ctx, Path(id)).await
}

/// `DELETE /api/v1/jobs/{id}` — only when no run is active; runs stay for history.
#[utoipa::path(delete, path = "/api/v1/jobs/{id}", tag = "Jobs", summary = "Delete job", params(("id" = String, Path)), responses((status = 204, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn delete(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let job = visible_job(&state, &ctx, &id, RUN).await?;
    if job.policy_id.is_some() {
        return Err(ApiError::conflict(
            "managed_by_policy",
            "This job belongs to a policy task; change the policy instead",
        ));
    }
    let active: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM job_runs WHERE job_id = ? AND status = 'running'")
            .bind(&id)
            .fetch_one(&state.db)
            .await?;
    if active > 0 {
        return Err(ApiError::conflict(
            "job_active",
            "Cancel the active run first",
        ));
    }
    let now = rustrmm_common::now();
    sqlx::query("UPDATE jobs SET deleted_at = ?, next_run_at = NULL, status = CASE WHEN status IN ('scheduled', 'pending_approval') THEN 'cancelled' ELSE status END,
                 updated_at = ? WHERE id = ?")
        .bind(now)
        .bind(now)
        .bind(&id)
        .execute(&state.db)
        .await?;
    super::approvals::close_for_job(&state, &id, "rejected", &ctx, "Job deleted").await?;
    let mut entry = ctx.audit("job.deleted").target("job", &id, &job.name);
    if let Some(c) = &job.client_id {
        entry = entry.client(c);
    }
    state.audit.record_or_log(&state.db, entry).await;
    Ok(StatusCode::NO_CONTENT)
}

async fn visible_run(
    state: &AppState,
    ctx: &AuthCtx,
    run_id: &str,
    permission: &str,
) -> ApiResult<(RunRow, JobRow)> {
    let run: RunRow = sqlx::query_as(sqlx::AssertSqlSafe(format!("{RUN_SELECT} WHERE id = ?")))
        .bind(run_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| ApiError::not_found("Run"))?;
    let job = load_job(&state.db, &run.job_id)
        .await?
        .filter(|j| j.visible(&ctx.scope, VIEW))
        .ok_or_else(|| ApiError::not_found("Run"))?;
    if !job.visible(&ctx.scope, permission) {
        return Err(ApiError::forbidden(format!(
            "Missing permission: {permission}"
        )));
    }
    Ok((run, job))
}

/// `GET /api/v1/job-runs/{id}`
#[utoipa::path(get, path = "/api/v1/job-runs/{id}", tag = "Jobs", summary = "Get run", params(("id" = String, Path)), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn get_run(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let (run, job) = visible_run(&state, &ctx, &id, VIEW).await?;
    let rows: Vec<ResultRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{RESULT_SELECT} WHERE r.run_id = ? ORDER BY d.hostname COLLATE NOCASE"
    )))
    .bind(&id)
    .fetch_all(&state.db)
    .await?;
    let results: Vec<Value> = rows
        .iter()
        .filter(|r| r.visible(&ctx.scope))
        .map(ResultRow::to_json)
        .collect();
    Ok(Json(json!({
        "run": run_json(&state.db, &run).await?,
        "job": job_json(&state.db, &job, false).await?,
        "results": results,
    })))
}

/// `GET /api/v1/job-runs/{id}/results/{device_id}`
#[utoipa::path(get, path = "/api/v1/job-runs/{id}/results/{device_id}", tag = "Jobs", summary = "Get result", params(("id" = String, Path), ("device_id" = String, Path)), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn get_result(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path((id, device_id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    visible_run(&state, &ctx, &id, VIEW).await?;
    let row: Option<ResultRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{RESULT_SELECT} WHERE r.run_id = ? AND r.device_id = ?"
    )))
    .bind(&id)
    .bind(&device_id)
    .fetch_optional(&state.db)
    .await?;
    let row = row
        .filter(|r| r.visible(&ctx.scope))
        .ok_or_else(|| ApiError::not_found("Result"))?;
    let mut doc = row.to_json();
    doc["job_id"] = json!(row.job_id);
    doc["run_id"] = json!(row.run_id);
    doc["stdout"] = json!(row.stdout.clone().unwrap_or_default());
    doc["stderr"] = json!(row.stderr.clone().unwrap_or_default());
    doc["truncated"] = json!(row.truncated);
    doc["directives"] = serde_json::from_str(&row.directives).unwrap_or_else(|_| json!([]));
    Ok(Json(doc))
}

#[derive(Deserialize)]
pub struct RerunBody {
    #[serde(default = "failed_only")]
    only: String,
}

fn failed_only() -> String {
    "failed".into()
}

/// `POST /api/v1/job-runs/{id}/rerun`
#[utoipa::path(post, path = "/api/v1/job-runs/{id}/rerun", tag = "Jobs", summary = "Rerun", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn rerun(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(body): Json<RerunBody>,
) -> ApiResult<Json<Value>> {
    let (_, job) = visible_run(&state, &ctx, &id, RUN).await?;
    if job.deleted_at.is_some()
        || matches!(
            job.status.as_str(),
            "pending_approval" | "rejected" | "cancelled"
        )
    {
        return Err(ApiError::conflict(
            "invalid_state",
            format!("A {} job cannot be re-run", job.status.replace('_', " ")),
        ));
    }
    let filter = match body.only.as_str() {
        "failed" => "AND status IN ('failed', 'timed_out')",
        "all" => "",
        _ => return Err(ApiError::validation("only must be failed or all")),
    };
    let devices: Vec<String> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT device_id FROM job_results WHERE run_id = ? {filter}"
    )))
    .bind(&id)
    .fetch_all(&state.db)
    .await?;
    if devices.is_empty() {
        return Err(ApiError::conflict("nothing_to_rerun", "No device matches"));
    }
    let settings = settings::load(&state).await?;
    if devices.len() as i64 > settings.mass_action_threshold || job.risk() == "high" {
        ctx.require_step_up()?;
    }
    let active: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM job_runs WHERE job_id = ? AND status = 'running'")
            .bind(&job.id)
            .fetch_one(&state.db)
            .await?;
    if active > 0 {
        return Err(ApiError::conflict(
            "job_active",
            "The job already has an active run",
        ));
    }
    let run_id = start_run(&state, &job.id, "rerun", Some(&ctx), Some(devices)).await?;
    Ok(Json(json!({ "job_id": job.id, "run_id": run_id })))
}

/// `POST /api/v1/job-runs/{id}/cancel`
#[utoipa::path(post, path = "/api/v1/job-runs/{id}/cancel", tag = "Jobs", summary = "Cancel run", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn cancel_run(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let (run, job) = visible_run(&state, &ctx, &id, RUN).await?;
    if run.status != "running" {
        return Err(ApiError::conflict("invalid_state", "The run is not active"));
    }
    cancel_results(&state, "run_id", &id).await?;
    refresh_job_status(&state.db, &job.id).await?;
    let mut entry = ctx
        .audit("job.cancelled")
        .target("job", &job.id, &job.name)
        .details(json!({ "run_id": id }));
    if let Some(c) = &job.client_id {
        entry = entry.client(c);
    }
    state.audit.record_or_log(&state.db, entry).await;
    super::publish_job_updated(&state, &job.id, &id, true);
    get_run(State(state), ctx, Path(id)).await
}

#[derive(Deserialize)]
pub struct DeviceRunsQuery {
    limit: Option<i64>,
}

async fn device_scope(
    state: &AppState,
    ctx: &AuthCtx,
    id: &str,
    permission: &str,
) -> ApiResult<(String, String, String)> {
    let row: Option<(String, String, String, String)> = sqlx::query_as(
        "SELECT s.client_id, d.site_id, d.os_family, d.status FROM devices d JOIN sites s ON s.id = d.site_id WHERE d.id = ?",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await?;
    let (client, site, os, status) = row.ok_or_else(|| ApiError::not_found("Device"))?;
    if !ctx.scope.can_site(perm::DEVICES_VIEW, &client, &site) {
        return Err(ApiError::not_found("Device"));
    }
    if !ctx.scope.can_site(permission, &client, &site) {
        return Err(
            ApiError::forbidden(format!("Missing permission: {permission}"))
                .with_details(json!({ "permission": permission })),
        );
    }
    if permission == RUN && status != "active" {
        return Err(ApiError::conflict(
            "device_inactive",
            "The device is not active",
        ));
    }
    Ok((client, site, os))
}

/// `GET /api/v1/devices/{id}/script-runs?limit=50`
#[utoipa::path(get, path = "/api/v1/devices/{id}/script-runs", tag = "Jobs", summary = "Device runs", params(("id" = String, Path)), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn device_runs(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Query(q): Query<DeviceRunsQuery>,
) -> ApiResult<Json<Value>> {
    device_scope(&state, &ctx, &id, VIEW).await?;
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let rows: Vec<ResultRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{RESULT_SELECT} WHERE r.device_id = ? ORDER BY r.updated_at DESC LIMIT ?"
    )))
    .bind(&id)
    .bind(limit)
    .fetch_all(&state.db)
    .await?;
    let mut names: HashMap<String, (String, String)> = HashMap::new();
    let mut items = Vec::new();
    for row in rows {
        if !names.contains_key(&row.job_id)
            && let Some(job) = load_job(&state.db, &row.job_id).await?
        {
            let script = if job.adhoc_language.is_some() {
                "Ad-hoc script".to_string()
            } else {
                job.script_name.clone().unwrap_or_default()
            };
            names.insert(row.job_id.clone(), (job.name.clone(), script));
        }
        let (job_name, script_name) = names.get(&row.job_id).cloned().unwrap_or_default();
        let mut doc = row.to_json();
        doc["job_id"] = json!(row.job_id);
        doc["job_name"] = json!(job_name);
        doc["run_id"] = json!(row.run_id);
        doc["script_name"] = json!(script_name);
        items.push(doc);
    }
    Ok(Json(json!({ "items": items })))
}

#[derive(Deserialize)]
pub struct Adhoc {
    language: String,
    content: String,
}

#[derive(Deserialize)]
pub struct QuickRunBody {
    #[serde(default)]
    script_id: Option<String>,
    #[serde(default)]
    parameters: Map<String, Value>,
    #[serde(default)]
    timeout_secs: Option<i64>,
    #[serde(default)]
    adhoc: Option<Adhoc>,
    #[serde(default)]
    confirm_count: Option<i64>,
}

/// `POST /api/v1/devices/{id}/run-script` — quick run of a saved script, or ad-hoc code.
#[utoipa::path(post, path = "/api/v1/devices/{id}/run-script", tag = "Jobs", summary = "Device run script", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn device_run_script(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(body): Json<QuickRunBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let (client, site, os) = device_scope(&state, &ctx, &id, RUN).await?;
    let settings: AutomationSettings = settings::load(&state).await?;
    let target = TargetSpec {
        kind: "devices".into(),
        ids: vec![id.clone()],
    };
    let new = match (&body.adhoc, &body.script_id) {
        (Some(adhoc), _) => {
            if !ctx.scope.can_site(MANAGE, &client, &site) {
                return Err(ApiError::forbidden("Missing permission: scripts.manage")
                    .with_details(json!({ "permission": MANAGE })));
            }
            ctx.require_step_up()?;
            if !rules::known_language(&adhoc.language) {
                return Err(ApiError::validation(format!(
                    "language must be one of {}",
                    rules::LANGUAGES.join(", ")
                )));
            }
            if !rules::language_platforms(&adhoc.language).contains(&os.as_str()) {
                return Err(ApiError::validation(format!(
                    "{} scripts cannot run on {os}",
                    adhoc.language
                )));
            }
            if adhoc.content.trim().is_empty()
                || adhoc.content.len() > scripts::MAX_CONTENT_BYTES
                || adhoc.content.contains('\0')
            {
                return Err(ApiError::validation(
                    "The script must be 1 byte to 256 KiB of text",
                ));
            }
            NewJob {
                name: "Ad-hoc script".into(),
                source: Source::Adhoc {
                    language: adhoc.language.clone(),
                    content: adhoc.content.clone(),
                },
                parameters: BTreeMap::new(),
                target,
                schedule: Schedule::Now,
                offline_wait_minutes: settings.default_offline_wait_minutes,
                concurrency: 1,
                timeout_secs: body.timeout_secs.unwrap_or(600),
                confirm_count: body.confirm_count,
            }
        }
        (None, Some(script_id)) => {
            let runnable = scripts::runnable_version(&state, script_id, &settings).await?;
            let parameters = params::validate_values(
                &runnable.parameters,
                &body.parameters,
                SecretRule::Supplied,
            )
            .map_err(|e| ApiError::validation(e).with_details(json!({ "path": "parameters" })))?;
            NewJob {
                name: runnable.script.name.clone(),
                timeout_secs: body.timeout_secs.unwrap_or(runnable.script.timeout_secs),
                source: Source::Script(Box::new(runnable)),
                parameters,
                target,
                schedule: Schedule::Now,
                offline_wait_minutes: settings.default_offline_wait_minutes,
                concurrency: 1,
                confirm_count: body.confirm_count,
            }
        }
        (None, None) => return Err(ApiError::validation("Provide script_id or adhoc")),
    };
    let created = create_job(&state, &ctx, new).await?;
    Ok((
        StatusCode::CREATED,
        Json(
            json!({ "job_id": created.job_id, "run_id": created.run_id, "status": created.status }),
        ),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schedules_round_trip_and_validate() {
        let s: Schedule =
            serde_json::from_value(json!({ "type": "cron", "cron": "0 3 * * 1" })).expect("cron");
        assert_eq!(
            s,
            Schedule::Cron {
                cron: "0 3 * * 1".into(),
                timezone: "UTC".into()
            }
        );
        assert!(s.validate().is_ok());
        let bad: Schedule = serde_json::from_value(
            json!({ "type": "cron", "cron": "0 3 * * 1", "timezone": "X/Y" }),
        )
        .expect("parse");
        assert!(bad.validate().is_err());
        let past = Schedule::Once {
            at: rustrmm_common::now() - chrono::Duration::hours(1),
        };
        assert!(past.validate().is_err());
        assert_eq!(
            serde_json::to_value(Schedule::Now).expect("json"),
            json!({ "type": "now" })
        );
        let now = rustrmm_common::now();
        assert!(Schedule::Now.first_run(now).is_none());
        assert!(s.first_run(now).is_some_and(|t| t > now));
    }

    #[test]
    fn output_is_capped_on_char_boundaries() {
        assert_eq!(cap("hello", 10), ("hello".to_string(), false));
        assert_eq!(cap("héllo", 2), ("h".to_string(), true));
    }
}
