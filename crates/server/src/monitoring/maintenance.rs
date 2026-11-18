//! Maintenance windows: one-off or recurring periods during which alerts are recorded without
//! notifications or remediation (`suppress: notifications`) or not raised at all
//! (`suppress: alerts`).

use std::collections::HashSet;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::auth::AuthCtx;
use crate::db::Db;
use crate::error::{ApiError, ApiResult};
use crate::rbac::{AccessScope, perm};
use crate::state::AppState;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Target {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Schedule {
    Once {
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    },
    Recurring {
        cron: String,
        duration_minutes: i64,
        #[serde(default = "utc")]
        timezone: String,
    },
}

fn utc() -> String {
    "UTC".into()
}

impl Schedule {
    pub fn validate(&self) -> Result<(), String> {
        match self {
            Self::Once { start, end } => {
                if end <= start {
                    return Err("schedule.end must be after schedule.start".into());
                }
                if *end - *start > chrono::Duration::days(31) {
                    return Err("a one-off window lasts at most 31 days".into());
                }
                Ok(())
            }
            Self::Recurring {
                cron,
                duration_minutes,
                timezone,
            } => {
                crate::automation::cron::validate(cron, timezone)?;
                if !(1..=10_080).contains(duration_minutes) {
                    return Err("schedule.duration_minutes must be between 1 and 10080".into());
                }
                Ok(())
            }
        }
    }

    /// Whether the window is open at `now`.
    pub fn active_at(&self, now: DateTime<Utc>) -> bool {
        match self {
            Self::Once { start, end } => *start <= now && now < *end,
            Self::Recurring {
                cron,
                duration_minutes,
                timezone,
            } => {
                // Open when an occurrence falls in (now − duration, now].
                let from = now - chrono::Duration::minutes(*duration_minutes);
                crate::automation::cron::next_after(cron, timezone, from).is_some_and(|t| t <= now)
            }
        }
    }

    /// The next time the window opens after `now`.
    pub fn next_start(&self, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
        match self {
            Self::Once { start, .. } => (*start > now).then_some(*start),
            Self::Recurring { cron, timezone, .. } => {
                crate::automation::cron::next_after(cron, timezone, now)
            }
        }
    }
}

#[derive(Debug, Clone)]
pub struct Window {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub targets: Vec<Target>,
    pub schedule: Schedule,
    pub suppress: String,
    pub created_by_name: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(sqlx::FromRow)]
struct WindowRow {
    id: String,
    name: String,
    enabled: bool,
    targets: String,
    schedule: String,
    suppress: String,
    created_by_name: String,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

impl WindowRow {
    fn parse(self) -> Option<Window> {
        Some(Window {
            schedule: serde_json::from_str(&self.schedule).ok()?,
            targets: serde_json::from_str(&self.targets).unwrap_or_default(),
            id: self.id,
            name: self.name,
            enabled: self.enabled,
            suppress: self.suppress,
            created_by_name: self.created_by_name,
            created_at: self.created_at,
            updated_at: self.updated_at,
        })
    }
}

const SELECT: &str = "SELECT id, name, enabled, targets, schedule, suppress, created_by_name, created_at, updated_at FROM maintenance_windows";

pub async fn load_all(db: &Db) -> anyhow::Result<Vec<Window>> {
    let rows: Vec<WindowRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{SELECT} ORDER BY name COLLATE NOCASE"
    )))
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().filter_map(WindowRow::parse).collect())
}

/// Where a device sits, for target matching.
#[derive(Debug, Clone, Default)]
pub struct DevicePlace {
    pub device_id: String,
    pub client_id: String,
    pub site_id: String,
    pub groups: HashSet<String>,
}

impl Window {
    pub fn targets_device(&self, place: &DevicePlace) -> bool {
        self.targets.iter().any(|t| {
            let id = t.id.as_deref();
            match t.kind.as_str() {
                "global" => true,
                "client" => id == Some(place.client_id.as_str()),
                "site" => id == Some(place.site_id.as_str()),
                "device" => id == Some(place.device_id.as_str()),
                "group" => id.is_some_and(|g| place.groups.contains(g)),
                _ => false,
            }
        })
    }

    pub fn to_json(
        &self,
        now: DateTime<Utc>,
        names: &std::collections::HashMap<String, String>,
    ) -> Value {
        let targets: Vec<Value> = self
            .targets
            .iter()
            .map(|t| {
                let name = t.id.as_ref().and_then(|id| names.get(id)).cloned();
                json!({ "type": t.kind, "id": t.id, "name": if t.kind == "global" { Some("All devices".to_string()) } else { name } })
            })
            .collect();
        json!({
            "id": self.id, "name": self.name, "enabled": self.enabled, "targets": targets,
            "schedule": self.schedule, "suppress": self.suppress, "created_by_name": self.created_by_name,
            "active_now": self.enabled && self.schedule.active_at(now),
            "next_start": if self.enabled { self.schedule.next_start(now) } else { None },
            "created_at": self.created_at, "updated_at": self.updated_at,
        })
    }
}

async fn device_place(
    state: &AppState,
    device_id: &str,
    need_groups: bool,
) -> anyhow::Result<Option<DevicePlace>> {
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT s.client_id, d.site_id FROM devices d JOIN sites s ON s.id = d.site_id WHERE d.id = ?",
    )
    .bind(device_id)
    .fetch_optional(&state.db)
    .await?;
    let Some((client_id, site_id)) = row else {
        return Ok(None);
    };
    let mut groups = HashSet::new();
    if need_groups {
        let ids = [device_id.to_string()];
        let index =
            crate::automation::groups::GroupIndex::load(&state.db, None, Some(&ids)).await?;
        if let Some(facts) = index.facts.iter().find(|f| f.id == device_id) {
            groups.extend(index.groups_of(facts));
        }
    }
    Ok(Some(DevicePlace {
        device_id: device_id.to_string(),
        client_id,
        site_id,
        groups,
    }))
}

/// Enabled windows open now that target the device.
pub async fn active_for_device(
    state: &AppState,
    device_id: &str,
    now: DateTime<Utc>,
) -> anyhow::Result<Vec<Window>> {
    let open: Vec<Window> = load_all(&state.db)
        .await?
        .into_iter()
        .filter(|w| w.enabled && w.schedule.active_at(now))
        .collect();
    if open.is_empty() {
        return Ok(open);
    }
    let need_groups = open
        .iter()
        .any(|w| w.targets.iter().any(|t| t.kind == "group"));
    let Some(place) = device_place(state, device_id, need_groups).await? else {
        return Ok(Vec::new());
    };
    Ok(open
        .into_iter()
        .filter(|w| w.targets_device(&place))
        .collect())
}

/// Enabled windows open now that target a site (or its client, or everything). Used for alerts
/// that name no agent device (SNMP).
pub async fn active_for_place(
    state: &AppState,
    client_id: &str,
    site_id: &str,
    now: DateTime<Utc>,
) -> anyhow::Result<Vec<Window>> {
    let place = DevicePlace {
        device_id: String::new(),
        client_id: client_id.to_string(),
        site_id: site_id.to_string(),
        groups: HashSet::new(),
    };
    Ok(load_all(&state.db)
        .await?
        .into_iter()
        .filter(|w| w.enabled && w.schedule.active_at(now) && w.targets_device(&place))
        .collect())
}

// ------------------------------------------------------------------ API

/// Client and site a target belongs to (`None` client = installation-wide).
async fn target_scope(
    db: &Db,
    target: &Target,
) -> ApiResult<(Option<String>, Option<String>, String)> {
    let id = target.id.clone().unwrap_or_default();
    let missing = || ApiError::validation(format!("Unknown {} target {id}", target.kind));
    Ok(match target.kind.as_str() {
        "global" => (None, None, "All devices".into()),
        "client" => {
            let name: Option<String> = sqlx::query_scalar("SELECT name FROM clients WHERE id = ?")
                .bind(&id)
                .fetch_optional(db)
                .await?;
            (Some(id.clone()), None, name.ok_or_else(missing)?)
        }
        "site" => {
            let row: Option<(String, String)> =
                sqlx::query_as("SELECT client_id, name FROM sites WHERE id = ?")
                    .bind(&id)
                    .fetch_optional(db)
                    .await?;
            let (client, name) = row.ok_or_else(missing)?;
            (Some(client), Some(id.clone()), name)
        }
        "group" => {
            let group = crate::automation::groups::load(db, &id)
                .await?
                .ok_or_else(missing)?;
            (group.client_id.clone(), None, group.name)
        }
        "device" => {
            let row: Option<(String, String, String)> = sqlx::query_as(
                "SELECT s.client_id, d.site_id, COALESCE(d.display_name, d.hostname) FROM devices d JOIN sites s ON s.id = d.site_id WHERE d.id = ?",
            )
            .bind(&id)
            .fetch_optional(db)
            .await?;
            let (client, site, name) = row.ok_or_else(missing)?;
            (Some(client), Some(site), name)
        }
        _ => {
            return Err(ApiError::validation(
                "targets[].type must be global, client, site, group or device",
            ));
        }
    })
}

fn allowed(
    scope: &AccessScope,
    permission: &str,
    client: Option<&str>,
    site: Option<&str>,
    view: bool,
) -> bool {
    match (client, site) {
        (Some(c), Some(s)) => scope.can_site(permission, c, s),
        (Some(c), None) if view => scope.can_see_client(permission, c),
        (Some(c), None) => scope.can_client(permission, c),
        (None, _) if view => scope.has_anywhere(permission),
        (None, _) => scope.has_global(permission),
    }
}

async fn names_of(
    db: &Db,
    windows: &[Window],
) -> anyhow::Result<std::collections::HashMap<String, String>> {
    let mut names = std::collections::HashMap::new();
    for w in windows {
        for t in &w.targets {
            if t.kind == "global" {
                continue;
            }
            if let Some(id) = &t.id
                && !names.contains_key(id)
                && let Ok((_, _, name)) = target_scope(db, t).await
            {
                names.insert(id.clone(), name);
            }
        }
    }
    Ok(names)
}

async fn visible(db: &Db, scope: &AccessScope, w: &Window, permission: &str, view: bool) -> bool {
    for t in &w.targets {
        let ok = match target_scope(db, t).await {
            Ok((client, site, _)) => {
                allowed(scope, permission, client.as_deref(), site.as_deref(), view)
            }
            Err(_) => !view && scope.has_global(permission),
        };
        if view && ok {
            return true;
        }
        if !view && !ok {
            return false;
        }
    }
    !view || w.targets.is_empty() && scope.has_global(permission)
}

/// `GET /api/v1/maintenance-windows`
#[utoipa::path(get, path = "/api/v1/maintenance-windows", tag = "Monitoring", summary = "List maintenance windows", responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn list(State(state): State<AppState>, ctx: AuthCtx) -> ApiResult<Json<Value>> {
    ctx.require(perm::ALERTS_VIEW)?;
    let now = rustrmm_common::now();
    let mut shown = Vec::new();
    for w in load_all(&state.db).await? {
        if visible(&state.db, &ctx.scope, &w, perm::ALERTS_VIEW, true).await {
            shown.push(w);
        }
    }
    let names = names_of(&state.db, &shown).await?;
    Ok(Json(
        json!({ "items": shown.iter().map(|w| w.to_json(now, &names)).collect::<Vec<_>>() }),
    ))
}

#[derive(Deserialize)]
pub struct WindowBody {
    name: String,
    #[serde(default = "yes")]
    enabled: bool,
    targets: Vec<Target>,
    schedule: Schedule,
    #[serde(default = "notifications")]
    suppress: String,
}

fn yes() -> bool {
    true
}

fn notifications() -> String {
    "notifications".into()
}

async fn check_body(state: &AppState, ctx: &AuthCtx, body: &mut WindowBody) -> ApiResult<()> {
    body.name = body.name.trim().to_string();
    if body.name.is_empty() || body.name.chars().count() > 120 {
        return Err(ApiError::validation("Name must be 1–120 characters"));
    }
    if !matches!(body.suppress.as_str(), "notifications" | "alerts") {
        return Err(ApiError::validation(
            "suppress must be notifications or alerts",
        ));
    }
    body.schedule
        .validate()
        .map_err(|e| ApiError::validation(e).with_details(json!({ "path": "schedule" })))?;
    if body.targets.is_empty() || body.targets.len() > 100 {
        return Err(ApiError::validation("targets must hold 1–100 entries"));
    }
    let mut seen = HashSet::new();
    body.targets
        .retain(|t| seen.insert((t.kind.clone(), t.id.clone())));
    for t in &mut body.targets {
        if t.kind == "global" {
            t.id = None;
        } else if t.id.as_deref().is_none_or(str::is_empty) {
            return Err(ApiError::validation("targets[].id is required"));
        }
        let (client, site, _) = target_scope(&state.db, t).await?;
        if !allowed(
            &ctx.scope,
            perm::MONITORS_MANAGE,
            client.as_deref(),
            site.as_deref(),
            false,
        ) {
            return Err(ApiError::forbidden(
                "Missing monitors.manage on a maintenance window target",
            ));
        }
    }
    Ok(())
}

async fn load_one(db: &Db, id: &str) -> ApiResult<Window> {
    let row: Option<WindowRow> =
        sqlx::query_as(sqlx::AssertSqlSafe(format!("{SELECT} WHERE id = ?")))
            .bind(id)
            .fetch_optional(db)
            .await?;
    row.and_then(WindowRow::parse)
        .ok_or_else(|| ApiError::not_found("Maintenance window"))
}

async fn respond(state: &AppState, w: &Window) -> ApiResult<Value> {
    let names = names_of(&state.db, std::slice::from_ref(w)).await?;
    Ok(w.to_json(rustrmm_common::now(), &names))
}

/// `POST /api/v1/maintenance-windows`
#[utoipa::path(post, path = "/api/v1/maintenance-windows", tag = "Monitoring", summary = "Create maintenance window", request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn create(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Json(mut body): Json<WindowBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    ctx.require(perm::MONITORS_MANAGE)?;
    check_body(&state, &ctx, &mut body).await?;
    let id = rustrmm_common::new_id();
    let now = rustrmm_common::now();
    sqlx::query("INSERT INTO maintenance_windows (id, name, enabled, targets, schedule, suppress, created_by, created_by_name, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(&id)
        .bind(&body.name)
        .bind(body.enabled)
        .bind(serde_json::to_string(&body.targets)?)
        .bind(serde_json::to_string(&body.schedule)?)
        .bind(&body.suppress)
        .bind(&ctx.user.id)
        .bind(&ctx.user.name)
        .bind(now)
        .bind(now)
        .execute(&state.db)
        .await?;
    let window = load_one(&state.db, &id).await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("maintenance.created")
                .target("maintenance_window", &id, &window.name)
                .details(json!({ "targets": window.targets, "schedule": window.schedule, "suppress": window.suppress })),
        )
        .await;
    Ok((StatusCode::CREATED, Json(respond(&state, &window).await?)))
}

/// `PUT /api/v1/maintenance-windows/{id}`
#[utoipa::path(put, path = "/api/v1/maintenance-windows/{id}", tag = "Monitoring", summary = "Update maintenance window", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn update(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(mut body): Json<WindowBody>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::MONITORS_MANAGE)?;
    let current = load_one(&state.db, &id).await?;
    if !visible(
        &state.db,
        &ctx.scope,
        &current,
        perm::MONITORS_MANAGE,
        false,
    )
    .await
    {
        return Err(ApiError::forbidden(
            "The window has targets outside your scope",
        ));
    }
    check_body(&state, &ctx, &mut body).await?;
    sqlx::query("UPDATE maintenance_windows SET name = ?, enabled = ?, targets = ?, schedule = ?, suppress = ?, updated_at = ? WHERE id = ?")
        .bind(&body.name)
        .bind(body.enabled)
        .bind(serde_json::to_string(&body.targets)?)
        .bind(serde_json::to_string(&body.schedule)?)
        .bind(&body.suppress)
        .bind(rustrmm_common::now())
        .bind(&id)
        .execute(&state.db)
        .await?;
    let window = load_one(&state.db, &id).await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("maintenance.updated")
                .target("maintenance_window", &id, &window.name)
                .details(json!({ "enabled": window.enabled, "targets": window.targets, "schedule": window.schedule, "suppress": window.suppress })),
        )
        .await;
    Ok(Json(respond(&state, &window).await?))
}

/// `DELETE /api/v1/maintenance-windows/{id}`
#[utoipa::path(delete, path = "/api/v1/maintenance-windows/{id}", tag = "Monitoring", summary = "Delete maintenance window", params(("id" = String, Path)), responses((status = 204, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn delete(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    ctx.require(perm::MONITORS_MANAGE)?;
    let current = load_one(&state.db, &id).await?;
    if !visible(
        &state.db,
        &ctx.scope,
        &current,
        perm::MONITORS_MANAGE,
        false,
    )
    .await
    {
        return Err(ApiError::forbidden(
            "The window has targets outside your scope",
        ));
    }
    sqlx::query("DELETE FROM maintenance_windows WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("maintenance.deleted")
                .target("maintenance_window", &id, &current.name),
        )
        .await;
    Ok(StatusCode::NO_CONTENT)
}

/// `GET /api/v1/devices/{id}/maintenance`
#[utoipa::path(get, path = "/api/v1/devices/{id}/maintenance", tag = "Monitoring", summary = "Device windows", params(("id" = String, Path)), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn device_windows(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::ALERTS_VIEW)?;
    super::device_scope(&state, &ctx, &id, perm::ALERTS_VIEW).await?;
    let now = rustrmm_common::now();
    let windows = load_all(&state.db).await?;
    let need_groups = windows
        .iter()
        .any(|w| w.targets.iter().any(|t| t.kind == "group"));
    let place = device_place(&state, &id, need_groups)
        .await?
        .ok_or_else(|| ApiError::not_found("Device"))?;
    let mine: Vec<Window> = windows
        .into_iter()
        .filter(|w| w.enabled && w.targets_device(&place))
        .collect();
    let names = names_of(&state.db, &mine).await?;
    let horizon = now + chrono::Duration::days(30);
    let active: Vec<Value> = mine
        .iter()
        .filter(|w| w.schedule.active_at(now))
        .map(|w| w.to_json(now, &names))
        .collect();
    let mut upcoming: Vec<(DateTime<Utc>, Value)> = mine
        .iter()
        .filter_map(|w| {
            w.schedule
                .next_start(now)
                .filter(|t| *t <= horizon)
                .map(|t| (t, w.to_json(now, &names)))
        })
        .collect();
    upcoming.sort_by_key(|(t, _)| *t);
    Ok(Json(
        json!({ "active": active, "upcoming": upcoming.into_iter().map(|(_, v)| v).collect::<Vec<_>>() }),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(y: i32, m: u32, d: u32, h: u32, min: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(y, m, d, h, min, 0)
            .single()
            .expect("time")
    }

    #[test]
    fn once_windows() {
        let s = Schedule::Once {
            start: at(2024, 1, 15, 22, 0),
            end: at(2024, 1, 16, 2, 0),
        };
        assert!(s.validate().is_ok());
        assert!(!s.active_at(at(2024, 1, 15, 21, 59)));
        assert!(s.active_at(at(2024, 1, 15, 22, 0)));
        assert!(s.active_at(at(2024, 1, 16, 1, 59)));
        assert!(!s.active_at(at(2024, 1, 16, 2, 0)), "the end is exclusive");
        assert_eq!(
            s.next_start(at(2024, 1, 15, 12, 0)),
            Some(at(2024, 1, 15, 22, 0))
        );
        assert_eq!(s.next_start(at(2024, 1, 15, 23, 0)), None);
        let backwards = Schedule::Once {
            start: at(2024, 1, 16, 2, 0),
            end: at(2024, 1, 15, 22, 0),
        };
        assert!(backwards.validate().is_err());
    }

    #[test]
    fn recurring_windows_cross_midnight_and_time_zones() {
        // Every Wednesday 22:00 UTC for three hours; 2024-01-17 is a Wednesday.
        let s = Schedule::Recurring {
            cron: "0 22 * * 3".into(),
            duration_minutes: 180,
            timezone: "UTC".into(),
        };
        assert!(s.validate().is_ok());
        assert!(!s.active_at(at(2024, 1, 17, 21, 59)));
        assert!(s.active_at(at(2024, 1, 17, 22, 0)));
        assert!(s.active_at(at(2024, 1, 18, 0, 30)), "past midnight");
        assert!(
            !s.active_at(at(2024, 1, 18, 1, 0)),
            "ends after 180 minutes"
        );
        assert!(!s.active_at(at(2024, 1, 18, 22, 30)), "Thursday");
        assert_eq!(
            s.next_start(at(2024, 1, 18, 12, 0)),
            Some(at(2024, 1, 24, 22, 0))
        );
        // 02:00 New York (UTC−5 in January) is 07:00 UTC.
        let ny = Schedule::Recurring {
            cron: "0 2 * * *".into(),
            duration_minutes: 60,
            timezone: "America/New_York".into(),
        };
        assert!(ny.active_at(at(2024, 1, 17, 7, 30)));
        assert!(!ny.active_at(at(2024, 1, 17, 2, 30)));
        let bad = Schedule::Recurring {
            cron: "not cron".into(),
            duration_minutes: 60,
            timezone: "UTC".into(),
        };
        assert!(bad.validate().is_err());
    }

    #[test]
    fn targets_match_devices() {
        let place = DevicePlace {
            device_id: "d1".into(),
            client_id: "c1".into(),
            site_id: "s1".into(),
            groups: HashSet::from(["g1".to_string()]),
        };
        let window = |targets: Vec<Target>| Window {
            id: "w".into(),
            name: "w".into(),
            enabled: true,
            targets,
            schedule: Schedule::Once {
                start: at(2024, 1, 1, 0, 0),
                end: at(2024, 1, 2, 0, 0),
            },
            suppress: "notifications".into(),
            created_by_name: String::new(),
            created_at: at(2024, 1, 1, 0, 0),
            updated_at: at(2024, 1, 1, 0, 0),
        };
        let t = |kind: &str, id: Option<&str>| Target {
            kind: kind.into(),
            id: id.map(str::to_string),
        };
        assert!(window(vec![t("global", None)]).targets_device(&place));
        assert!(window(vec![t("client", Some("c1"))]).targets_device(&place));
        assert!(window(vec![t("site", Some("s2")), t("group", Some("g1"))]).targets_device(&place));
        assert!(window(vec![t("device", Some("d1"))]).targets_device(&place));
        assert!(
            !window(vec![t("client", Some("c2")), t("site", Some("s2"))]).targets_device(&place)
        );
    }
}
