//! Customisable dashboards: personal and shared layouts of widgets on a 12-column grid, a
//! per-user default (the console's Home page), and server-side widget aggregation
//! (`GET /dashboards/widgets/{widget}?config=`).

use std::collections::{BTreeMap, HashMap};

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use utoipa::{IntoParams, ToSchema};

use crate::auth::AuthCtx;
use crate::error::{ApiError, ApiResult};
use crate::rbac::perm;
use crate::state::AppState;

pub const WIDGETS: [&str; 12] = [
    "fleet_health",
    "alerts_by_severity",
    "alerts_list",
    "patch_compliance",
    "tickets_open",
    "sla_breaches",
    "devices_offline",
    "os_mix",
    "agent_versions",
    "top_disk_usage",
    "recent_jobs",
    "custom_field_breakdown",
];
const GRID_COLUMNS: i64 = 12;
const MAX_WIDGETS: usize = 40;
/// The synthetic dashboard returned when a user has not chosen a default.
pub const BUILTIN_HOME: &str = "builtin-home";

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, PartialEq)]
pub struct WidgetPlacement {
    pub widget: String,
    pub x: i64,
    pub y: i64,
    pub w: i64,
    pub h: i64,
    /// Widget options, e.g. `{ "client_id": "…", "limit": 10, "field": "warranty_end" }`.
    #[serde(default)]
    #[schema(value_type = Object)]
    pub config: Value,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct Dashboard {
    pub id: String,
    pub name: String,
    /// `null` for the built-in Home layout.
    pub owner_id: Option<String>,
    pub owner_name: Option<String>,
    pub shared: bool,
    pub layout: Vec<WidgetPlacement>,
    /// Whether this is the caller's Home dashboard.
    pub is_default: bool,
    /// Whether the caller may edit it.
    pub editable: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(sqlx::FromRow)]
struct Row {
    id: String,
    name: String,
    owner_id: Option<String>,
    owner_name: Option<String>,
    shared: bool,
    layout: String,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

const SELECT: &str = "SELECT d.id, d.name, d.owner_id, u.name AS owner_name, d.shared, d.layout, d.created_at, d.updated_at
    FROM dashboards d LEFT JOIN users u ON u.id = d.owner_id";

fn can_edit(ctx: &AuthCtx, row: &Row) -> bool {
    if row.shared {
        ctx.scope.has_anywhere(perm::REPORTS_MANAGE)
    } else {
        row.owner_id.as_deref() == Some(ctx.user.id.as_str())
    }
}

fn can_view(ctx: &AuthCtx, row: &Row) -> bool {
    row.owner_id.as_deref() == Some(ctx.user.id.as_str())
        || (row.shared && ctx.scope.has_anywhere(perm::REPORTS_VIEW))
}

fn to_dto(ctx: &AuthCtx, row: Row, default_id: Option<&str>) -> Dashboard {
    Dashboard {
        is_default: default_id == Some(row.id.as_str()),
        editable: can_edit(ctx, &row),
        layout: serde_json::from_str(&row.layout).unwrap_or_default(),
        id: row.id,
        name: row.name,
        owner_id: row.owner_id,
        owner_name: row.owner_name,
        shared: row.shared,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

/// The built-in Home layout.
pub fn builtin_layout() -> Vec<WidgetPlacement> {
    let p = |widget: &str, x, y, w, h| WidgetPlacement {
        widget: widget.into(),
        x,
        y,
        w,
        h,
        config: json!({}),
    };
    vec![
        p("fleet_health", 0, 0, 4, 3),
        p("alerts_by_severity", 4, 0, 4, 3),
        p("patch_compliance", 8, 0, 4, 3),
        p("alerts_list", 0, 3, 8, 5),
        p("devices_offline", 8, 3, 4, 5),
        p("tickets_open", 0, 8, 4, 3),
        p("os_mix", 4, 8, 4, 3),
        p("agent_versions", 8, 8, 4, 3),
    ]
}

async fn default_id(state: &AppState, user_id: &str) -> anyhow::Result<Option<String>> {
    Ok(
        sqlx::query_scalar("SELECT dashboard_id FROM dashboard_defaults WHERE user_id = ?")
            .bind(user_id)
            .fetch_optional(&state.db)
            .await?,
    )
}

async fn load(state: &AppState, id: &str) -> anyhow::Result<Option<Row>> {
    Ok(
        sqlx::query_as(sqlx::AssertSqlSafe(format!("{SELECT} WHERE d.id = ?")))
            .bind(id)
            .fetch_optional(&state.db)
            .await?,
    )
}

#[derive(Serialize, ToSchema)]
pub struct DashboardList {
    pub items: Vec<Dashboard>,
    /// Widget names a layout may use.
    pub widgets: Vec<String>,
}

/// List dashboards
///
/// Your own dashboards and the shared ones (shared need `reports.view` to see).
#[utoipa::path(get, path = "/api/v1/dashboards", tag = "Dashboards",
    responses((status = 200, body = DashboardList)))]
pub async fn list(State(state): State<AppState>, ctx: AuthCtx) -> ApiResult<Json<DashboardList>> {
    let rows: Vec<Row> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{SELECT} WHERE d.owner_id = ? OR d.shared = 1 ORDER BY d.shared, d.name COLLATE NOCASE"
    )))
    .bind(&ctx.user.id)
    .fetch_all(&state.db)
    .await?;
    let default = default_id(&state, &ctx.user.id).await?;
    Ok(Json(DashboardList {
        items: rows
            .into_iter()
            .filter(|r| can_view(&ctx, r))
            .map(|r| to_dto(&ctx, r, default.as_deref()))
            .collect(),
        widgets: WIDGETS.iter().map(|w| w.to_string()).collect(),
    }))
}

/// The caller's Home dashboard
///
/// Their chosen default, or the built-in layout (`id: "builtin-home"`).
#[utoipa::path(get, path = "/api/v1/dashboards/default", tag = "Dashboards",
    responses((status = 200, body = Dashboard)))]
pub async fn get_default(
    State(state): State<AppState>,
    ctx: AuthCtx,
) -> ApiResult<Json<Dashboard>> {
    if let Some(id) = default_id(&state, &ctx.user.id).await?
        && let Some(row) = load(&state, &id).await?.filter(|r| can_view(&ctx, r))
    {
        return Ok(Json(to_dto(&ctx, row, Some(&id))));
    }
    let epoch = DateTime::<Utc>::from_timestamp(0, 0).unwrap_or_default();
    Ok(Json(Dashboard {
        id: BUILTIN_HOME.into(),
        name: "Home".into(),
        owner_id: None,
        owner_name: None,
        shared: true,
        layout: builtin_layout(),
        is_default: true,
        editable: false,
        created_at: epoch,
        updated_at: epoch,
    }))
}

/// Get a dashboard
#[utoipa::path(get, path = "/api/v1/dashboards/{id}", tag = "Dashboards",
    params(("id" = String, Path)), responses((status = 200, body = Dashboard)))]
pub async fn get(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Dashboard>> {
    let row = load(&state, &id)
        .await?
        .filter(|r| can_view(&ctx, r))
        .ok_or_else(|| ApiError::not_found("Dashboard"))?;
    let default = default_id(&state, &ctx.user.id).await?;
    Ok(Json(to_dto(&ctx, row, default.as_deref())))
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct DashboardBody {
    pub name: String,
    /// Shared dashboards need `reports.manage`.
    #[serde(default)]
    pub shared: bool,
    #[serde(default)]
    pub layout: Vec<WidgetPlacement>,
    /// Make this your Home dashboard.
    #[serde(default)]
    pub is_default: Option<bool>,
}

fn validate(body: &mut DashboardBody) -> ApiResult<()> {
    body.name = body.name.trim().to_string();
    if body.name.is_empty() || body.name.chars().count() > 80 {
        return Err(ApiError::validation("name must be 1–80 characters"));
    }
    if body.layout.len() > MAX_WIDGETS {
        return Err(ApiError::validation(format!(
            "At most {MAX_WIDGETS} widgets"
        )));
    }
    for (i, p) in body.layout.iter_mut().enumerate() {
        if !WIDGETS.contains(&p.widget.as_str()) {
            return Err(ApiError::validation(format!("Unknown widget {}", p.widget))
                .with_details(json!({ "widgets": WIDGETS })));
        }
        if p.x < 0
            || p.w < 1
            || p.x + p.w > GRID_COLUMNS
            || p.y < 0
            || p.y > 1000
            || p.h < 1
            || p.h > 24
        {
            return Err(ApiError::validation(format!(
                "Widget {i} is outside the 12-column grid (0 ≤ x, 1 ≤ w, x + w ≤ 12, 0 ≤ y ≤ 1000, 1 ≤ h ≤ 24)"
            )));
        }
        if p.config.is_null() {
            p.config = json!({});
        }
        if !p.config.is_object() || p.config.to_string().len() > 4096 {
            return Err(ApiError::validation(format!(
                "Widget {i}: config must be an object of at most 4 KB"
            )));
        }
    }
    Ok(())
}

async fn set_default(
    state: &AppState,
    user_id: &str,
    dashboard_id: Option<&str>,
) -> anyhow::Result<()> {
    match dashboard_id {
        Some(id) => {
            sqlx::query(
                "INSERT INTO dashboard_defaults (user_id, dashboard_id, updated_at) VALUES (?, ?, ?)
                 ON CONFLICT (user_id) DO UPDATE SET dashboard_id = excluded.dashboard_id, updated_at = excluded.updated_at",
            )
            .bind(user_id)
            .bind(id)
            .bind(rustrmm_common::now())
            .execute(&state.db)
            .await?;
        }
        None => {
            sqlx::query("DELETE FROM dashboard_defaults WHERE user_id = ?")
                .bind(user_id)
                .execute(&state.db)
                .await?;
        }
    }
    Ok(())
}

/// Create a dashboard
#[utoipa::path(post, path = "/api/v1/dashboards", tag = "Dashboards", request_body = DashboardBody,
    responses((status = 201, body = Dashboard)))]
pub async fn create(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Json(mut body): Json<DashboardBody>,
) -> ApiResult<(StatusCode, Json<Dashboard>)> {
    validate(&mut body)?;
    if body.shared {
        ctx.require(perm::REPORTS_MANAGE)?;
    }
    let id = rustrmm_common::new_id();
    let now = rustrmm_common::now();
    sqlx::query(
        "INSERT INTO dashboards (id, name, owner_id, shared, layout, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&body.name)
    .bind(&ctx.user.id)
    .bind(body.shared)
    .bind(serde_json::to_string(&body.layout)?)
    .bind(now)
    .bind(now)
    .execute(&state.db)
    .await?;
    if body.is_default == Some(true) {
        set_default(&state, &ctx.user.id, Some(&id)).await?;
    }
    if body.shared {
        state
            .audit
            .record_or_log(
                &state.db,
                ctx.audit("dashboard.created")
                    .target("dashboard", &id, &body.name)
                    .details(json!({ "shared": true, "widgets": body.layout.len() })),
            )
            .await;
    }
    let row = load(&state, &id)
        .await?
        .ok_or_else(|| ApiError::internal("dashboard vanished"))?;
    let default = default_id(&state, &ctx.user.id).await?;
    Ok((
        StatusCode::CREATED,
        Json(to_dto(&ctx, row, default.as_deref())),
    ))
}

/// Update a dashboard
#[utoipa::path(put, path = "/api/v1/dashboards/{id}", tag = "Dashboards", request_body = DashboardBody,
    params(("id" = String, Path)), responses((status = 200, body = Dashboard)))]
pub async fn update(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(mut body): Json<DashboardBody>,
) -> ApiResult<Json<Dashboard>> {
    let row = load(&state, &id)
        .await?
        .filter(|r| can_view(&ctx, r))
        .ok_or_else(|| ApiError::not_found("Dashboard"))?;
    validate(&mut body)?;
    let content_change = body.name != row.name
        || body.shared != row.shared
        || serde_json::to_string(&body.layout)? != row.layout;
    if content_change {
        if !can_edit(&ctx, &row) {
            return Err(ApiError::forbidden("Missing permission: reports.manage")
                .with_details(json!({ "permission": perm::REPORTS_MANAGE })));
        }
        if body.shared && !row.shared {
            ctx.require(perm::REPORTS_MANAGE)?;
        }
        sqlx::query(
            "UPDATE dashboards SET name = ?, shared = ?, layout = ?, updated_at = ? WHERE id = ?",
        )
        .bind(&body.name)
        .bind(body.shared)
        .bind(serde_json::to_string(&body.layout)?)
        .bind(rustrmm_common::now())
        .bind(&id)
        .execute(&state.db)
        .await?;
        if body.shared || row.shared {
            state
                .audit
                .record_or_log(
                    &state.db,
                    ctx.audit("dashboard.updated")
                        .target("dashboard", &id, &body.name)
                        .details(json!({ "shared": body.shared, "widgets": body.layout.len() })),
                )
                .await;
        }
    }
    let current_default = default_id(&state, &ctx.user.id).await?;
    match body.is_default {
        Some(true) => set_default(&state, &ctx.user.id, Some(&id)).await?,
        Some(false) if current_default.as_deref() == Some(id.as_str()) => {
            set_default(&state, &ctx.user.id, None).await?
        }
        _ => {}
    }
    let row = load(&state, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("Dashboard"))?;
    let default = default_id(&state, &ctx.user.id).await?;
    Ok(Json(to_dto(&ctx, row, default.as_deref())))
}

/// Delete a dashboard
#[utoipa::path(delete, path = "/api/v1/dashboards/{id}", tag = "Dashboards",
    params(("id" = String, Path)), responses((status = 204)))]
pub async fn delete(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let row = load(&state, &id)
        .await?
        .filter(|r| can_view(&ctx, r))
        .ok_or_else(|| ApiError::not_found("Dashboard"))?;
    if !can_edit(&ctx, &row) {
        return Err(ApiError::forbidden("Missing permission: reports.manage")
            .with_details(json!({ "permission": perm::REPORTS_MANAGE })));
    }
    sqlx::query("DELETE FROM dashboards WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;
    if row.shared {
        state
            .audit
            .record_or_log(
                &state.db,
                ctx.audit("dashboard.deleted")
                    .target("dashboard", &id, &row.name),
            )
            .await;
    }
    Ok(StatusCode::NO_CONTENT)
}

// ------------------------------------------------------------------ widgets

#[derive(Debug, Deserialize, IntoParams)]
pub struct WidgetQuery {
    /// URL-encoded JSON object: `client_id`, `site_id`, `limit`, `field` (custom field key),
    /// `days` (recent jobs window).
    config: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct WidgetConfig {
    #[serde(default)]
    client_id: Option<String>,
    #[serde(default)]
    site_id: Option<String>,
    #[serde(default)]
    limit: Option<i64>,
    #[serde(default)]
    field: Option<String>,
    #[serde(default)]
    days: Option<i64>,
}

struct Place<'a> {
    ctx: &'a AuthCtx,
    cfg: &'a WidgetConfig,
}

impl Place<'_> {
    fn allows(&self, permission: &str, client: &str, site: Option<&str>) -> bool {
        if self
            .cfg
            .client_id
            .as_deref()
            .is_some_and(|c| !c.is_empty() && c != "all" && c != client)
        {
            return false;
        }
        if let Some(s) = self.cfg.site_id.as_deref().filter(|s| !s.is_empty())
            && site != Some(s)
        {
            return false;
        }
        match site {
            Some(site) => self.ctx.scope.can_site(permission, client, site),
            None => self.ctx.scope.can_client(permission, client),
        }
    }
    fn limit(&self) -> usize {
        self.cfg.limit.unwrap_or(10).clamp(1, 100) as usize
    }
}

#[derive(sqlx::FromRow)]
struct DeviceFact {
    id: String,
    hostname: String,
    client_id: String,
    client_name: String,
    site_id: String,
    online: bool,
    os_family: String,
    os_name: String,
    health_score: Option<i64>,
    agent_version: String,
    last_seen_at: Option<DateTime<Utc>>,
    disk_pct: Option<f64>,
}

async fn device_facts(state: &AppState, place: &Place<'_>) -> anyhow::Result<Vec<DeviceFact>> {
    let rows: Vec<DeviceFact> = sqlx::query_as(
        "SELECT d.id, COALESCE(d.display_name, d.hostname) AS hostname, s.client_id, c.name AS client_name, d.site_id, d.online,
                d.os_family, d.os_name, d.health_score, d.agent_version, d.last_seen_at, d.disk_pct
         FROM devices d JOIN sites s ON s.id = d.site_id JOIN clients c ON c.id = s.client_id WHERE d.status = 'active'",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(rows
        .into_iter()
        .filter(|d| place.allows(perm::DEVICES_VIEW, &d.client_id, Some(&d.site_id)))
        .collect())
}

/// Widget data
///
/// Aggregated data for one dashboard widget. Each widget also needs the matching view
/// permission (devices, alerts, patches, tickets or scripts).
#[utoipa::path(get, path = "/api/v1/dashboards/widgets/{widget}", tag = "Dashboards",
    params(("widget" = String, Path, description = "One of the widget names"), WidgetQuery),
    responses((status = 200, description = "Widget-specific JSON; see docs/api-platform.md")))]
pub async fn widget(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(widget): Path<String>,
    Query(q): Query<WidgetQuery>,
) -> ApiResult<Json<Value>> {
    if !WIDGETS.contains(&widget.as_str()) {
        return Err(ApiError::not_found("Widget"));
    }
    let cfg: WidgetConfig = match q.config.as_deref().filter(|c| !c.trim().is_empty()) {
        Some(raw) => serde_json::from_str(raw)
            .map_err(|_| ApiError::validation("config must be a JSON object"))?,
        None => WidgetConfig::default(),
    };
    let place = Place {
        ctx: &ctx,
        cfg: &cfg,
    };
    let value = match widget.as_str() {
        "fleet_health" => {
            ctx.require(perm::DEVICES_VIEW)?;
            let devices = device_facts(&state, &place).await?;
            let online = devices.iter().filter(|d| d.online).count();
            let scores: Vec<i64> = devices.iter().filter_map(|d| d.health_score).collect();
            let avg = (!scores.is_empty()).then(|| {
                (scores.iter().sum::<i64>() as f64 / scores.len() as f64 * 10.0).round() / 10.0
            });
            json!({
                "devices": devices.len(), "online": online, "offline": devices.len() - online,
                "avg_health": avg,
                "buckets": {
                    "healthy": scores.iter().filter(|s| **s >= 80).count(),
                    "warning": scores.iter().filter(|s| (50..80).contains(*s)).count(),
                    "critical": scores.iter().filter(|s| **s < 50).count(),
                },
            })
        }
        "alerts_by_severity" | "alerts_list" => {
            ctx.require(perm::ALERTS_VIEW)?;
            let rows: Vec<crate::monitoring::alerts::AlertRow> =
                sqlx::query_as(sqlx::AssertSqlSafe(format!(
                    "{} WHERE a.status <> 'resolved' ORDER BY a.opened_at DESC",
                    crate::monitoring::alerts::ALERT_SELECT
                )))
                .fetch_all(&state.db)
                .await?;
            let rows: Vec<_> = rows
                .into_iter()
                .filter(|a| place.allows(perm::ALERTS_VIEW, &a.client_id, a.site_id.as_deref()))
                .collect();
            if widget == "alerts_list" {
                let mut rows = rows;
                rows.sort_by(|a, b| {
                    crate::monitoring::alerts::severity_rank(&b.severity)
                        .cmp(&crate::monitoring::alerts::severity_rank(&a.severity))
                        .then(b.opened_at.cmp(&a.opened_at))
                });
                json!({ "total": rows.len(), "items": rows.iter().take(place.limit()).map(|a| a.to_json()).collect::<Vec<_>>() })
            } else {
                let count = |sev: &str| rows.iter().filter(|a| a.severity == sev).count();
                json!({ "total": rows.len(), "open": { "critical": count("critical"), "warning": count("warning"), "info": count("info") },
                        "acknowledged": rows.iter().filter(|a| a.status == "acknowledged").count() })
            }
        }
        "patch_compliance" => {
            ctx.require(perm::PATCHES_VIEW)?;
            let now = rustrmm_common::now();
            let scope = ctx.scope.clone();
            let client = cfg
                .client_id
                .clone()
                .filter(|c| !c.is_empty() && c != "all");
            let site = cfg.site_id.clone().filter(|s| !s.is_empty());
            let visible = move |c: &str, s: &str| {
                scope.can_site(perm::PATCHES_VIEW, c, s)
                    && client.as_deref().is_none_or(|x| x == c)
                    && site.as_deref().is_none_or(|x| x == s)
            };
            let statuses = crate::patching::compliance::load_status(&state, &visible).await?;
            let compliant = statuses.iter().filter(|d| d.compliant(now)).count();
            let pct = (!statuses.is_empty())
                .then(|| (compliant as f64 * 1000.0 / statuses.len() as f64).round() / 10.0);
            json!({
                "devices": statuses.len(), "compliant": compliant, "non_compliant": statuses.len() - compliant,
                "compliance_pct": pct,
                "missing_critical": statuses.iter().map(|d| d.missing("Critical")).sum::<usize>(),
                "missing_important": statuses.iter().map(|d| d.missing("Important")).sum::<usize>(),
                "pending_reboot": statuses.iter().filter(|d| d.pending_reboot()).count(),
                "failed": statuses.iter().filter(|d| d.failed()).count(),
            })
        }
        "tickets_open" | "sla_breaches" => {
            ctx.require(perm::TICKETS_VIEW)?;
            let rows: Vec<(String, i64, String, String, Option<String>, String, String, bool, bool, Option<DateTime<Utc>>)> = sqlx::query_as(
                "SELECT t.id, t.number, t.subject, t.client_id, t.site_id, t.status, t.priority, t.first_response_breached,
                        t.resolution_breached, t.resolution_due
                 FROM tickets t WHERE t.status IN ('new', 'open', 'pending', 'on_hold') AND t.merged_into IS NULL
                 ORDER BY t.last_activity_at DESC",
            )
            .fetch_all(&state.db)
            .await?;
            let rows: Vec<_> = rows
                .into_iter()
                .filter(|r| place.allows(perm::TICKETS_VIEW, &r.3, r.4.as_deref()))
                .collect();
            if widget == "tickets_open" {
                let mut by_status: BTreeMap<String, usize> = BTreeMap::new();
                let mut by_priority: BTreeMap<String, usize> = BTreeMap::new();
                for r in &rows {
                    *by_status.entry(r.5.clone()).or_default() += 1;
                    *by_priority.entry(r.6.clone()).or_default() += 1;
                }
                json!({ "total": rows.len(), "by_status": by_status, "by_priority": by_priority })
            } else {
                let breached: Vec<_> = rows.iter().filter(|r| r.7 || r.8).collect();
                json!({
                    "total": breached.len(),
                    "items": breached.iter().take(place.limit()).map(|r| json!({
                        "id": r.0, "number": r.1, "subject": r.2, "client_id": r.3, "status": r.5, "priority": r.6,
                        "first_response_breached": r.7, "resolution_breached": r.8, "resolution_due": r.9,
                    })).collect::<Vec<_>>(),
                })
            }
        }
        "devices_offline" => {
            ctx.require(perm::DEVICES_VIEW)?;
            let mut offline: Vec<DeviceFact> = device_facts(&state, &place)
                .await?
                .into_iter()
                .filter(|d| !d.online)
                .collect();
            offline.sort_by_key(|d| d.last_seen_at);
            json!({
                "total": offline.len(),
                "items": offline.iter().take(place.limit()).map(|d| json!({
                    "device_id": d.id, "hostname": d.hostname, "client_id": d.client_id, "client_name": d.client_name,
                    "last_seen_at": d.last_seen_at,
                })).collect::<Vec<_>>(),
            })
        }
        "os_mix" => {
            ctx.require(perm::DEVICES_VIEW)?;
            let mut mix: BTreeMap<String, (String, usize)> = BTreeMap::new();
            for d in device_facts(&state, &place).await? {
                let name = d
                    .os_name
                    .trim()
                    .trim_start_matches("Microsoft ")
                    .to_string();
                let label = if name.is_empty() {
                    d.os_family.clone()
                } else {
                    name
                };
                mix.entry(label).or_insert((d.os_family.clone(), 0)).1 += 1;
            }
            let mut items: Vec<Value> = mix
                .into_iter()
                .map(|(os, (family, count))| json!({ "os": os, "family": family, "count": count }))
                .collect();
            items.sort_by(|a, b| b["count"].as_u64().cmp(&a["count"].as_u64()));
            json!({ "items": items })
        }
        "agent_versions" => {
            ctx.require(perm::DEVICES_VIEW)?;
            let latest = crate::reports::data::latest_agent(&state).await?;
            let mut versions: HashMap<String, usize> = HashMap::new();
            for d in device_facts(&state, &place).await? {
                *versions.entry(d.agent_version).or_default() += 1;
            }
            let mut items: Vec<(String, usize)> = versions.into_iter().collect();
            items.sort_by(|a, b| rustrmm_proto::commands::version_cmp(&b.0, &a.0));
            let outdated: usize = items
                .iter()
                .filter(|(v, _)| {
                    latest
                        .as_deref()
                        .is_some_and(|l| rustrmm_proto::commands::version_cmp(v, l).is_lt())
                })
                .map(|(_, n)| n)
                .sum();
            json!({
                "latest": latest, "outdated": outdated,
                "items": items.into_iter().map(|(version, count)| json!({ "version": version, "count": count })).collect::<Vec<_>>(),
            })
        }
        "top_disk_usage" => {
            ctx.require(perm::DEVICES_VIEW)?;
            let mut devices: Vec<DeviceFact> = device_facts(&state, &place)
                .await?
                .into_iter()
                .filter(|d| d.disk_pct.is_some())
                .collect();
            devices.sort_by(|a, b| {
                b.disk_pct
                    .partial_cmp(&a.disk_pct)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            json!({
                "items": devices.iter().take(place.limit()).map(|d| json!({
                    "device_id": d.id, "hostname": d.hostname, "client_name": d.client_name, "disk_pct": d.disk_pct,
                })).collect::<Vec<_>>(),
            })
        }
        "recent_jobs" => {
            ctx.require(perm::SCRIPTS_VIEW)?;
            let since =
                rustrmm_common::now() - chrono::Duration::days(cfg.days.unwrap_or(7).clamp(1, 90));
            let rows: Vec<(String, String, String, Option<String>, DateTime<Utc>, Option<DateTime<Utc>>, String)> = sqlx::query_as(
                "SELECT r.id, j.id, j.name, j.client_id, r.started_at, r.finished_at, r.status
                 FROM job_runs r JOIN jobs j ON j.id = r.job_id WHERE r.started_at >= ? ORDER BY r.started_at DESC LIMIT 500",
            )
            .bind(since)
            .fetch_all(&state.db)
            .await?;
            let mut items = Vec::new();
            for (run_id, job_id, name, client, started, finished, status) in rows {
                let visible = match &client {
                    Some(c) => place.allows(perm::SCRIPTS_VIEW, c, None),
                    None => {
                        ctx.scope.has_global(perm::SCRIPTS_VIEW)
                            && cfg
                                .client_id
                                .as_deref()
                                .is_none_or(|c| c.is_empty() || c == "all")
                    }
                };
                if !visible {
                    continue;
                }
                let counts = crate::automation::jobs::counts(&state.db, &run_id)
                    .await
                    .ok();
                items.push(json!({ "run_id": run_id, "job_id": job_id, "name": name, "status": status,
                                   "started_at": started, "finished_at": finished, "counts": counts }));
                if items.len() >= place.limit() {
                    break;
                }
            }
            json!({ "items": items })
        }
        "custom_field_breakdown" => {
            ctx.require(perm::DEVICES_VIEW)?;
            let key = cfg.field.clone().filter(|f| !f.is_empty()).ok_or_else(|| {
                ApiError::validation(
                    "custom_field_breakdown needs config.field (a device custom field key)",
                )
            })?;
            let field: Option<(String, String)> = sqlx::query_as(
                "SELECT id, name FROM custom_fields WHERE key = ? AND scope = 'device'",
            )
            .bind(&key)
            .fetch_optional(&state.db)
            .await?;
            let (field_id, field_name) =
                field.ok_or_else(|| ApiError::not_found("Custom field"))?;
            let values: HashMap<String, String> = sqlx::query_as::<_, (String, String)>(
                "SELECT entity_id, value FROM custom_field_values WHERE field_id = ?",
            )
            .bind(&field_id)
            .fetch_all(&state.db)
            .await?
            .into_iter()
            .collect();
            let mut counts: BTreeMap<String, usize> = BTreeMap::new();
            for d in device_facts(&state, &place).await? {
                let label = match values.get(&d.id).map(|v| serde_json::from_str::<Value>(v)) {
                    Some(Ok(Value::String(s))) => s,
                    Some(Ok(Value::Null)) | None => "(not set)".into(),
                    Some(Ok(other)) => other.to_string(),
                    Some(Err(_)) => "(invalid)".into(),
                };
                *counts.entry(label).or_default() += 1;
            }
            let mut items: Vec<(String, usize)> = counts.into_iter().collect();
            items.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
            json!({ "field": key, "field_name": field_name,
                    "items": items.into_iter().map(|(value, count)| json!({ "value": value, "count": count })).collect::<Vec<_>>() })
        }
        _ => return Err(ApiError::not_found("Widget")),
    };
    Ok(Json(
        json!({ "widget": widget, "generated_at": rustrmm_common::now(), "data": value }),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layouts_are_validated() {
        let mut ok = DashboardBody {
            name: " Ops ".into(),
            shared: false,
            layout: builtin_layout(),
            is_default: None,
        };
        assert!(validate(&mut ok).is_ok());
        assert_eq!(ok.name, "Ops");
        let mut bad = DashboardBody {
            name: "x".into(),
            shared: false,
            layout: vec![WidgetPlacement {
                widget: "fleet_health".into(),
                x: 10,
                y: 0,
                w: 4,
                h: 2,
                config: json!({}),
            }],
            is_default: None,
        };
        assert!(validate(&mut bad).is_err());
        bad.layout[0].x = 0;
        bad.layout[0].widget = "nope".into();
        assert!(validate(&mut bad).is_err());
    }
}
