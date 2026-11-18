//! Patch routes: catalog, device patches, scans, immediate installs, approval rules and runs.

use std::collections::{HashMap, HashSet};

use axum::Json;
use axum::extract::{Path, Query, State};
use chrono::{DateTime, Utc};
use rustrmm_proto::patching::RebootSpec;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{QueryBuilder, Sqlite};

use super::approvals::{self, Approval, PatchApprovals};
use super::runs;
use crate::auth::AuthCtx;
use crate::error::{ApiError, ApiResult};
use crate::rbac::perm;
use crate::state::AppState;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct CatalogRow {
    pub id: String,
    pub platform: String,
    pub key: String,
    pub kb: Option<String>,
    pub title: String,
    pub classification: String,
    pub severity: Option<String>,
    pub size_bytes: Option<i64>,
    pub reboot_required: bool,
    pub release_date: Option<String>,
    pub description: String,
    pub support_url: Option<String>,
    pub cves: String,
    pub first_seen_at: DateTime<Utc>,
}

const CATALOG_SELECT: &str =
    "SELECT id, platform, key, kb, title, classification, severity, size_bytes, reboot_required,
    release_date, description, support_url, cves, first_seen_at FROM patch_catalog";

/// Device counts of one patch.
#[derive(Debug, Clone, Copy, Default)]
pub struct StateCounts {
    pub missing: i64,
    pub installed: i64,
    pub failed: i64,
    pub pending_reboot: i64,
    pub any: i64,
}

impl StateCounts {
    fn add(&mut self, state: &str, n: i64) {
        self.any += n;
        match state {
            "missing" | "downloaded" | "installing" => self.missing += n,
            "installed" | "superseded" => self.installed += n,
            "failed" => self.failed += n,
            "pending_reboot" => self.pending_reboot += n,
            _ => {}
        }
    }
}

fn approval_json(approval: Option<&Approval>) -> Value {
    approval
        .map(Approval::to_json)
        .unwrap_or_else(|| json!({ "status": "none" }))
}

pub fn patch_json(row: &CatalogRow, approval: Option<&Approval>, counts: StateCounts) -> Value {
    json!({
        "id": row.id, "platform": row.platform, "key": row.key, "kb": row.kb, "title": row.title,
        "classification": row.classification, "severity": row.severity, "size_bytes": row.size_bytes,
        "reboot_required": row.reboot_required, "release_date": row.release_date, "first_seen_at": row.first_seen_at,
        "description": row.description, "support_url": row.support_url,
        "cves": serde_json::from_str::<Value>(&row.cves).unwrap_or_else(|_| json!([])),
        "approval": approval_json(approval),
        "devices": { "missing": counts.missing, "installed": counts.installed, "failed": counts.failed,
                     "pending_reboot": counts.pending_reboot },
    })
}

/// Device counts per patch over the devices the caller can see (optionally one client).
async fn device_counts(
    state: &AppState,
    ctx: &AuthCtx,
    client_id: Option<&str>,
    patch_ids: Option<&[String]>,
) -> anyhow::Result<HashMap<String, StateCounts>> {
    let mut qb = QueryBuilder::<Sqlite>::new(
        "SELECT dp.patch_id, s.client_id, d.site_id, dp.state, COUNT(*) FROM device_patches dp
         JOIN devices d ON d.id = dp.device_id JOIN sites s ON s.id = d.site_id WHERE d.status = 'active'",
    );
    if let Some(c) = client_id {
        qb.push(" AND s.client_id = ").push_bind(c.to_string());
    }
    if let Some(ids) = patch_ids {
        if ids.is_empty() {
            return Ok(HashMap::new());
        }
        qb.push(" AND dp.patch_id IN (");
        let mut sep = qb.separated(", ");
        for id in ids.iter().take(5000) {
            sep.push_bind(id.clone());
        }
        qb.push(")");
    }
    qb.push(" GROUP BY dp.patch_id, s.client_id, d.site_id, dp.state");
    let rows: Vec<(String, String, String, String, i64)> =
        qb.build_query_as().fetch_all(&state.db).await?;
    let mut out: HashMap<String, StateCounts> = HashMap::new();
    for (patch_id, client, site, st, n) in rows {
        if ctx.scope.can_site(perm::PATCHES_VIEW, &client, &site) {
            out.entry(patch_id).or_default().add(&st, n);
        }
    }
    Ok(out)
}

#[derive(Deserialize)]
pub struct ListQuery {
    platform: Option<String>,
    classification: Option<String>,
    severity: Option<String>,
    approval: Option<String>,
    status: Option<String>,
    client_id: Option<String>,
    q: Option<String>,
    cursor: Option<String>,
    limit: Option<i64>,
}

/// `GET /api/v1/patches`
#[utoipa::path(get, path = "/api/v1/patches", tag = "Patching", summary = "List patches", responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn list(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::PATCHES_VIEW)?;
    let limit = q.limit.unwrap_or(100).clamp(1, 500) as usize;
    let offset: usize = q
        .cursor
        .as_deref()
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    let client_id = q.client_id.clone().filter(|c| !c.is_empty());
    if let Some(c) = &client_id
        && !ctx.scope.can_see_client(perm::PATCHES_VIEW, c)
    {
        return Err(ApiError::not_found("Client"));
    }
    let status = q.status.as_deref().unwrap_or("missing");
    if !matches!(status, "missing" | "any") {
        return Err(ApiError::validation("status must be missing or any"));
    }
    let counts = device_counts(&state, &ctx, client_id.as_deref(), None).await?;
    let mut qb = QueryBuilder::<Sqlite>::new(CATALOG_SELECT);
    qb.push(" WHERE 1 = 1");
    let text = |v: &Option<String>| v.clone().filter(|s| !s.trim().is_empty());
    if let Some(p) = text(&q.platform) {
        qb.push(" AND platform = ").push_bind(p);
    }
    if let Some(c) = text(&q.classification) {
        qb.push(" AND classification = ").push_bind(c);
    }
    if let Some(s) = text(&q.severity) {
        if s == "none" {
            qb.push(" AND severity IS NULL");
        } else {
            qb.push(" AND severity = ").push_bind(s);
        }
    }
    if let Some(search) = text(&q.q) {
        let like = format!(
            "%{}%",
            search.trim().replace('%', "\\%").replace('_', "\\_")
        );
        qb.push(" AND (title LIKE ")
            .push_bind(like.clone())
            .push(" ESCAPE '\\' OR kb LIKE ")
            .push_bind(like.clone())
            .push(" ESCAPE '\\' OR key LIKE ")
            .push_bind(like)
            .push(" ESCAPE '\\')");
    }
    let rows: Vec<CatalogRow> = qb.build_query_as().fetch_all(&state.db).await?;
    let ids: Vec<String> = rows.iter().map(|r| r.id.clone()).collect();
    let approvals = approvals::load(&state.db, Some(&ids)).await?;
    let now = rustrmm_common::now();
    let global_viewer = ctx.scope.has_global(perm::PATCHES_VIEW) && client_id.is_none();
    let empty = PatchApprovals::default();
    let mut matched: Vec<(&CatalogRow, StateCounts, Option<&Approval>, RuleSummary)> = rows
        .iter()
        .filter_map(|row| {
            let c = counts.get(&row.id).copied().unwrap_or_default();
            if status == "missing" && c.missing + c.failed == 0 {
                return None;
            }
            if c.any == 0 && !global_viewer {
                return None;
            }
            let decisions = approvals.get(&row.id).unwrap_or(&empty);
            let approval = decisions.effective_for(client_id.as_deref(), now);
            let rules = rule_summary(decisions, &ctx, now);
            if let Some(wanted) = q.approval.as_deref().filter(|a| !a.is_empty()) {
                // In the all-clients view, client rule approvals count as "approved".
                let actual = match approval {
                    Some(a) => a.decision.as_str(),
                    None if client_id.is_none() && rules.clients > 0 => "approved",
                    None => "none",
                };
                if actual != wanted {
                    return None;
                }
            }
            Some((row, c, approval, rules))
        })
        .collect();
    matched.sort_by(|a, b| {
        (b.1.missing + b.1.failed)
            .cmp(&(a.1.missing + a.1.failed))
            .then(b.0.first_seen_at.cmp(&a.0.first_seen_at))
            .then(a.0.id.cmp(&b.0.id))
    });
    let items: Vec<Value> = matched
        .iter()
        .skip(offset)
        .take(limit)
        .map(|(row, c, a, rules)| {
            with_rules(patch_json(row, *a, *c), *a, rules, client_id.is_none())
        })
        .collect();
    let next_cursor = (offset + limit < matched.len()).then(|| (offset + limit).to_string());
    Ok(Json(json!({ "items": items, "next_cursor": next_cursor })))
}

/// Client rule approvals of one patch over the clients the caller can see.
#[derive(Debug, Clone, Copy, Default)]
pub struct RuleSummary {
    pub clients: usize,
    pub first_at: Option<DateTime<Utc>>,
}

fn rule_summary(decisions: &PatchApprovals, ctx: &AuthCtx, now: DateTime<Utc>) -> RuleSummary {
    let mut out = RuleSummary::default();
    for (client, a) in &decisions.clients {
        if a.source != "manual"
            && a.decision == "approved"
            && a.active(now)
            && ctx.scope.can_see_client(perm::PATCHES_VIEW, client)
        {
            out.clients += 1;
            out.first_at = Some(out.first_at.map_or(a.at, |t| t.min(a.at)));
        }
    }
    out
}

/// Adds `rule_approved_clients`; in the all-clients view a patch without a global decision but
/// with client rule approvals shows `{ status: "approved", source: "rule", scope: "clients",
/// clients: n }`.
fn with_rules(
    mut v: Value,
    approval: Option<&Approval>,
    rules: &RuleSummary,
    all_clients: bool,
) -> Value {
    v["rule_approved_clients"] = json!(rules.clients);
    if all_clients && approval.is_none() && rules.clients > 0 {
        v["approval"] = json!({
            "status": "approved", "source": "rule", "scope": "clients", "clients": rules.clients,
            "at": rules.first_at, "approved_at": rules.first_at, "by_name": "Auto-approval rule", "client_id": null,
        });
    }
    v
}

async fn load_patch(state: &AppState, id: &str) -> ApiResult<CatalogRow> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{CATALOG_SELECT} WHERE id = ?"
    )))
    .bind(id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| ApiError::not_found("Patch"))
}

/// `GET /api/v1/patches/{id}`
#[utoipa::path(get, path = "/api/v1/patches/{id}", tag = "Patching", summary = "Get patche", params(("id" = String, Path)), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn get(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::PATCHES_VIEW)?;
    let patch = load_patch(&state, &id).await?;
    let counts = device_counts(&state, &ctx, None, Some(std::slice::from_ref(&id)))
        .await?
        .remove(&id)
        .unwrap_or_default();
    if counts.any == 0 && !ctx.scope.has_global(perm::PATCHES_VIEW) {
        return Err(ApiError::not_found("Patch"));
    }
    let approvals = approvals::load(&state.db, Some(std::slice::from_ref(&id)))
        .await?
        .remove(&id)
        .unwrap_or_default();
    let now = rustrmm_common::now();
    let rows: Vec<(
        String,
        String,
        String,
        String,
        String,
        String,
        DateTime<Utc>,
        Option<DateTime<Utc>>,
        Option<String>,
    )> = sqlx::query_as(
        "SELECT d.id, COALESCE(d.display_name, d.hostname), s.client_id, d.site_id, c.name, dp.state, dp.detected_at,
                dp.installed_at, dp.last_error
         FROM device_patches dp JOIN devices d ON d.id = dp.device_id JOIN sites s ON s.id = d.site_id
         JOIN clients c ON c.id = s.client_id WHERE dp.patch_id = ? AND d.status = 'active' ORDER BY d.hostname COLLATE NOCASE",
    )
    .bind(&id)
    .fetch_all(&state.db)
    .await?;
    let devices: Vec<Value> = rows
        .into_iter()
        .filter(|r| ctx.scope.can_site(perm::PATCHES_VIEW, &r.2, &r.3))
        .map(|(device_id, hostname, _, _, client_name, st, detected, installed, error)| {
            json!({ "device_id": device_id, "hostname": hostname, "client_name": client_name, "state": st,
                    "detected_at": detected, "installed_at": installed, "last_error": error })
        })
        .collect();
    let global = approvals.effective_for(None, now);
    let rules = rule_summary(&approvals, &ctx, now);
    Ok(Json(json!({
        "patch": with_rules(patch_json(&patch, global, counts), global, &rules, true),
        "devices": devices,
    })))
}

/// `GET /api/v1/patch-approval-rules` — the auto-approval rules of every policy (read-only).
#[utoipa::path(get, path = "/api/v1/patch-approval-rules", tag = "Patching", summary = "Approval rules", responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn approval_rules(State(state): State<AppState>, ctx: AuthCtx) -> ApiResult<Json<Value>> {
    ctx.require(perm::PATCHES_VIEW)?;
    let policies: Vec<(String, String, String)> =
        sqlx::query_as("SELECT id, name, document FROM policies ORDER BY name COLLATE NOCASE")
            .fetch_all(&state.db)
            .await?;
    let mut items = Vec::new();
    for (id, name, document) in policies {
        let doc: Value = serde_json::from_str(&document).unwrap_or_default();
        let Some(rules) = doc
            .pointer("/patching/auto_approve")
            .and_then(Value::as_array)
        else {
            continue;
        };
        for (index, rule) in rules.iter().enumerate() {
            let rule: super::policy::Rule = match serde_json::from_value(rule.clone()) {
                Ok(r) => r,
                Err(_) => continue,
            };
            items.push(json!({
                "policy_id": id, "policy_name": name, "index": index, "platform": rule.platform,
                "classifications": rule.classifications, "severities": rule.severities,
                "delay_days": rule.delay_days,
            }));
        }
    }
    Ok(Json(json!({ "items": items })))
}

#[derive(Deserialize)]
pub struct DeviceQuery {
    state: Option<String>,
}

/// `GET /api/v1/devices/{id}/patches?state=`
#[utoipa::path(get, path = "/api/v1/devices/{id}/patches", tag = "Patching", summary = "Device patches", params(("id" = String, Path)), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn device_patches(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Query(q): Query<DeviceQuery>,
) -> ApiResult<Json<Value>> {
    let (client_id, _) = super::device_scope(&state, &ctx, &id, perm::PATCHES_VIEW).await?;
    let status: Option<(Option<DateTime<Utc>>, Option<String>, bool, String)> = sqlx::query_as(
        "SELECT scanned_at, source, pending_reboot, reboot_reasons FROM device_patch_status WHERE device_id = ?",
    )
    .bind(&id)
    .fetch_optional(&state.db)
    .await?;
    let config = super::device_config(&state.db, &id).await?;
    let mut qb = QueryBuilder::<Sqlite>::new(
        "SELECT c.id, c.platform, c.key, c.kb, c.title, c.classification, c.severity, c.size_bytes, c.reboot_required,
                c.release_date, c.description, c.support_url, c.cves, c.first_seen_at,
                dp.state, dp.detected_at, dp.installed_at, dp.last_error
         FROM device_patches dp JOIN patch_catalog c ON c.id = dp.patch_id WHERE dp.device_id = ",
    );
    qb.push_bind(id.clone());
    if let Some(wanted) = q.state.as_deref().filter(|s| !s.is_empty()) {
        if wanted == "missing" {
            qb.push(" AND dp.state IN ('missing', 'downloaded', 'installing', 'failed')");
        } else {
            qb.push(" AND dp.state = ").push_bind(wanted.to_string());
        }
    }
    qb.push(" ORDER BY c.title COLLATE NOCASE");
    let rows = qb.build().fetch_all(&state.db).await?;
    use sqlx::Row;
    let mut entries = Vec::new();
    for row in &rows {
        let catalog = CatalogRow {
            id: row.try_get(0)?,
            platform: row.try_get(1)?,
            key: row.try_get(2)?,
            kb: row.try_get(3)?,
            title: row.try_get(4)?,
            classification: row.try_get(5)?,
            severity: row.try_get(6)?,
            size_bytes: row.try_get(7)?,
            reboot_required: row.try_get(8)?,
            release_date: row.try_get(9)?,
            description: row.try_get(10)?,
            support_url: row.try_get(11)?,
            cves: row.try_get(12)?,
            first_seen_at: row.try_get(13)?,
        };
        let st: String = row.try_get(14)?;
        let detected: DateTime<Utc> = row.try_get(15)?;
        let installed: Option<DateTime<Utc>> = row.try_get(16)?;
        let error: Option<String> = row.try_get(17)?;
        entries.push((catalog, st, detected, installed, error));
    }
    let ids: Vec<String> = entries.iter().map(|e| e.0.id.clone()).collect();
    let counts = device_counts(&state, &ctx, None, Some(&ids)).await?;
    let approvals = approvals::load(&state.db, Some(&ids)).await?;
    let now = rustrmm_common::now();
    let empty = PatchApprovals::default();
    let items: Vec<Value> = entries
        .iter()
        .map(|(catalog, st, detected, installed, error)| {
            let decisions = approvals.get(&catalog.id).unwrap_or(&empty);
            let base = approvals::base_date(catalog.release_date.as_deref(), catalog.first_seen_at);
            json!({
                "patch": patch_json(catalog, decisions.effective_for(Some(&client_id), now),
                                    counts.get(&catalog.id).copied().unwrap_or_default()),
                "state": st, "detected_at": detected, "installed_at": installed, "last_error": error,
                "effective_approved": decisions.effective_approved(&client_id, &config.ring, base, now),
            })
        })
        .collect();
    let (scanned_at, source, pending_reboot, reasons) =
        status.unwrap_or((None, None, false, "[]".into()));
    Ok(Json(json!({
        "scanned_at": scanned_at, "source": source, "pending_reboot": pending_reboot,
        "reboot_reasons": serde_json::from_str::<Value>(&reasons).unwrap_or_else(|_| json!([])),
        "items": items,
    })))
}

fn device_offline() -> ApiError {
    ApiError::conflict("device_offline", "The device is offline")
}

/// `POST /api/v1/devices/{id}/patches/scan`
#[utoipa::path(post, path = "/api/v1/devices/{id}/patches/scan", tag = "Patching", summary = "Scan", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn scan(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    super::device_scope(&state, &ctx, &id, perm::PATCHES_VIEW).await?;
    if !state.agents.is_online(&id) {
        return Err(device_offline());
    }
    let config = super::device_config(&state.db, &id).await?;
    let cmd_id = runs::send_scan(&state, &id, &config, Some(&ctx.user.id), true)
        .await
        .map_err(|e| ApiError::conflict("device_offline", format!("{e:#}")))?;
    Ok(Json(json!({ "cmd_id": cmd_id })))
}

#[derive(Deserialize)]
pub struct RebootBody {
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    deferrals: Option<u32>,
    #[serde(default)]
    message: Option<String>,
}

#[derive(Deserialize)]
pub struct InstallBody {
    patch_ids: Value,
    #[serde(default)]
    reboot: Option<RebootBody>,
}

/// `POST /api/v1/devices/{id}/patches/install` (step-up) — immediate install outside the window.
#[utoipa::path(post, path = "/api/v1/devices/{id}/patches/install", tag = "Patching", summary = "Install", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn install(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(body): Json<InstallBody>,
) -> ApiResult<Json<Value>> {
    let (client_id, site_id) =
        super::device_scope(&state, &ctx, &id, perm::PATCHES_APPROVE).await?;
    ctx.require_step_up()?;
    if !state.agents.is_online(&id) {
        return Err(device_offline());
    }
    let ids = [id.clone()];
    let device = super::load_devices(&state, Some(&ids))
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| ApiError::not_found("Device"))?;
    let missing = runs::missing_patches(&state.db, &id).await?;
    let selected: Vec<runs::MissingPatch> = match &body.patch_ids {
        Value::String(s) if s == "approved" => {
            let approvals = approvals::load(&state.db, None).await?;
            // Explicitly requested: platform switches still apply, the retry limit does not.
            let all: Vec<runs::MissingPatch> = missing
                .iter()
                .cloned()
                .map(|mut p| {
                    p.attempts = 0;
                    p
                })
                .collect();
            runs::installable(
                &client_id,
                &device.config,
                &all,
                &approvals,
                rustrmm_common::now(),
            )
        }
        Value::Array(list) => {
            let wanted: HashSet<&str> = list.iter().filter_map(Value::as_str).collect();
            if wanted.is_empty() || wanted.len() > 1000 || wanted.len() != list.len() {
                return Err(ApiError::validation(
                    "patch_ids must be \"approved\" or a list of 1–1000 patch ids",
                ));
            }
            let found: Vec<runs::MissingPatch> = missing
                .iter()
                .filter(|p| wanted.contains(p.patch_id.as_str()))
                .cloned()
                .collect();
            if found.len() != wanted.len() {
                return Err(
                    ApiError::validation("Every patch must be missing on this device")
                        .with_details(json!({ "path": "patch_ids" })),
                );
            }
            found
        }
        _ => {
            return Err(ApiError::validation(
                "patch_ids must be \"approved\" or a list of patch ids",
            ));
        }
    };
    if selected.is_empty() {
        return Err(ApiError::conflict(
            "nothing_to_install",
            "No approved patch is missing on this device",
        ));
    }
    let reboot_body = body.reboot.unwrap_or(RebootBody {
        mode: None,
        deferrals: None,
        message: None,
    });
    let mode = reboot_body
        .mode
        .unwrap_or_else(|| device.config.reboot.mode.clone());
    if !rustrmm_proto::patching::REBOOT_MODES.contains(&mode.as_str()) {
        return Err(ApiError::validation(
            "reboot.mode must be never, prompt or force",
        ));
    }
    let message = reboot_body
        .message
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| device.config.reboot.message.clone());
    if message.chars().count() > 500 {
        return Err(ApiError::validation("reboot.message is too long"));
    }
    let reboot = RebootSpec {
        mode: mode.clone(),
        deferrals: reboot_body
            .deferrals
            .unwrap_or(device.config.reboot.prompt_deferrals)
            .min(10),
        message,
        deadline_unix: None,
    };
    let (run_id, dispatch) = runs::install_now(&state, &device, &selected, reboot, &ctx.user.id)
        .await
        .map_err(|e| ApiError::conflict("device_offline", format!("{e:#}")))?;
    let (cmd_id, count) = match dispatch {
        runs::Dispatch::Sent { cmd_id, count } => (Some(cmd_id), count),
        runs::Dispatch::Nothing => (None, 0),
    };
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("patch.install_requested")
                .target("device", &id, &device.hostname)
                .client(&client_id)
                .site(&site_id)
                .details(json!({ "run_id": run_id, "count": count, "reboot_mode": mode,
                                 "keys": selected.iter().take(100).map(|p| p.key.clone()).collect::<Vec<_>>() })),
        )
        .await;
    Ok(Json(
        json!({ "cmd_id": cmd_id, "run_id": run_id, "count": count }),
    ))
}

#[derive(Debug, Default, Deserialize, utoipa::ToSchema)]
pub struct RunNowBody {
    /// Window length; defaults to the policy window's duration (15–1440).
    #[serde(default)]
    pub duration_minutes: Option<i64>,
    /// Only devices of this client.
    #[serde(default)]
    pub client_id: Option<String>,
    /// Only devices of this site.
    #[serde(default)]
    pub site_id: Option<String>,
}

/// Run a patch window now
///
/// Opens a manual run for the devices whose install window comes from this policy (within
/// your scope): online devices install their effective-approved patches at once, offline ones
/// wait until the run's window ends. Needs `patches.approve` and step-up.
#[utoipa::path(post, path = "/api/v1/patching/policies/{id}/run-now", tag = "Patching",
    params(("id" = String, Path, description = "Policy id")), request_body = RunNowBody,
    responses((status = 200, description = "`{ run_id, devices, online, window_end }`"),
              (status = 409, description = "no_devices")))]
pub async fn run_window_now(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(policy_id): Path<String>,
    body: Option<Json<RunNowBody>>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::PATCHES_APPROVE)?;
    ctx.require_step_up()?;
    let body = body.map(|Json(b)| b).unwrap_or_default();
    let policy_name: String = sqlx::query_scalar("SELECT name FROM policies WHERE id = ?")
        .bind(&policy_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| ApiError::not_found("Policy"))?;
    let client = body.client_id.clone().filter(|c| !c.is_empty());
    let site = body.site_id.clone().filter(|s| !s.is_empty());
    let devices: Vec<super::DeviceCtx> = super::load_devices(&state, None)
        .await?
        .into_iter()
        .filter(|d| {
            d.config.enabled
                && d.config.window_policy.as_deref() == Some(policy_id.as_str())
                && ctx
                    .scope
                    .can_site(perm::PATCHES_APPROVE, &d.client_id, &d.site_id)
                && client.as_deref().is_none_or(|c| c == d.client_id)
                && site.as_deref().is_none_or(|s| s == d.site_id)
        })
        .collect();
    if devices.is_empty() {
        return Err(ApiError::conflict(
            "no_devices",
            "No device in your scope takes its patch window from this policy",
        ));
    }
    let minutes = body
        .duration_minutes
        .or_else(|| {
            devices
                .iter()
                .find_map(|d| d.config.window.as_ref().map(|w| w.duration_minutes))
        })
        .unwrap_or(120);
    if !(15..=1440).contains(&minutes) {
        return Err(ApiError::validation("duration_minutes must be 15–1440"));
    }
    let run_id = runs::run_window_now(&state, &policy_id, &policy_name, &devices, minutes).await?;
    let online = devices.iter().filter(|d| d.online).count();
    let mut entry = ctx
        .audit("patch_run.started")
        .target("patch_run", &run_id, &policy_name)
        .details(json!({ "policy_id": policy_id, "trigger": "manual", "devices": devices.len(), "online": online,
                         "duration_minutes": minutes, "client_id": client, "site_id": site }));
    if let Some(c) = &client {
        entry = entry.client(c.clone());
    }
    state.audit.record_or_log(&state.db, entry).await;
    Ok(Json(json!({
        "run_id": run_id, "devices": devices.len(), "online": online,
        "window_end": rustrmm_common::now() + chrono::Duration::minutes(minutes),
    })))
}

#[derive(Deserialize)]
pub struct RunsQuery {
    limit: Option<i64>,
}

#[derive(sqlx::FromRow)]
struct RunRow {
    id: String,
    policy_id: Option<String>,
    policy_name: String,
    window_start: DateTime<Utc>,
    window_end: DateTime<Utc>,
    status: String,
    trigger_kind: String,
}

/// Results of a run visible to the caller: (device, hostname, client, site, status, …).
async fn visible_results(
    state: &AppState,
    ctx: &AuthCtx,
    run_id: &str,
) -> anyhow::Result<Vec<(String, String, String, i64, i64, bool, Option<String>)>> {
    let rows: Vec<(String, String, String, String, String, i64, i64, bool, Option<String>)> =
        sqlx::query_as(
            "SELECT r.device_id, COALESCE(d.display_name, d.hostname), s.client_id, d.site_id, r.status, r.installed, r.failed,
                    r.rebooted, r.error
             FROM patch_run_results r JOIN devices d ON d.id = r.device_id JOIN sites s ON s.id = d.site_id
             WHERE r.run_id = ? ORDER BY d.hostname COLLATE NOCASE",
        )
        .bind(run_id)
        .fetch_all(&state.db)
        .await?;
    Ok(rows
        .into_iter()
        .filter(|r| ctx.scope.can_site(perm::PATCHES_VIEW, &r.2, &r.3))
        .map(|(d, h, _, _, st, i, f, rb, e)| (d, h, st, i, f, rb, e))
        .collect())
}

fn run_json(
    run: &RunRow,
    results: &[(String, String, String, i64, i64, bool, Option<String>)],
) -> Value {
    let mut counts = runs::RunCounts::default();
    for r in results {
        counts.add(&r.2);
    }
    json!({
        "id": run.id, "policy_id": run.policy_id, "policy_name": run.policy_name,
        "window_start": run.window_start, "window_end": run.window_end, "status": run.status,
        "trigger": run.trigger_kind,
        "total": counts.total, "succeeded": counts.succeeded, "failed": counts.failed,
        "pending_reboot": counts.pending_reboot, "pending": counts.pending, "skipped": counts.skipped,
    })
}

const RUN_SELECT: &str = "SELECT id, policy_id, policy_name, window_start, window_end, status, trigger_kind FROM patch_runs";

/// `GET /api/v1/patch-runs?limit=`
#[utoipa::path(get, path = "/api/v1/patch-runs", tag = "Patching", summary = "List runs", responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn list_runs(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<RunsQuery>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::PATCHES_VIEW)?;
    let limit = q.limit.unwrap_or(50).clamp(1, 500) as usize;
    let runs: Vec<RunRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{RUN_SELECT} ORDER BY created_at DESC, id DESC LIMIT 2000"
    )))
    .fetch_all(&state.db)
    .await?;
    let global = ctx.scope.has_global(perm::PATCHES_VIEW);
    let mut items = Vec::new();
    for run in &runs {
        if items.len() >= limit {
            break;
        }
        let results = visible_results(&state, &ctx, &run.id).await?;
        if results.is_empty() && !global {
            continue;
        }
        items.push(run_json(run, &results));
    }
    Ok(Json(json!({ "items": items })))
}

/// `GET /api/v1/patch-runs/{id}`
#[utoipa::path(get, path = "/api/v1/patch-runs/{id}", tag = "Patching", summary = "Get run", params(("id" = String, Path)), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn get_run(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::PATCHES_VIEW)?;
    let run: RunRow = sqlx::query_as(sqlx::AssertSqlSafe(format!("{RUN_SELECT} WHERE id = ?")))
        .bind(&id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| ApiError::not_found("Patch run"))?;
    let results = visible_results(&state, &ctx, &id).await?;
    if results.is_empty() && !ctx.scope.has_global(perm::PATCHES_VIEW) {
        return Err(ApiError::not_found("Patch run"));
    }
    Ok(Json(json!({
        "run": run_json(&run, &results),
        "results": results.iter().map(runs::result_json).collect::<Vec<_>>(),
    })))
}
