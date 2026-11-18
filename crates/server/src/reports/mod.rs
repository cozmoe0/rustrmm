//! Phase 11 reports: the nine built-in report types, the `Section` model shared by the console
//! and the renderers, JSON/CSV/PDF output, report runs (with `202` + polling for large runs),
//! scheduled delivery by e-mail (optionally one branded PDF per client) and the daily health
//! snapshot behind the executive summary trend (`docs/api-platform.md`).

pub mod data;
pub mod pdf;

use std::time::Duration as StdDuration;

use axum::Json;
use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use utoipa::{IntoParams, ToSchema};

use crate::auth::AuthCtx;
use crate::error::{ApiError, ApiResult};
use crate::rbac::{AccessScope, perm};
use crate::state::AppState;

/// Generation (data + rendering) is cut off after this long.
pub const RUN_TIMEOUT: StdDuration = StdDuration::from_secs(120);
/// Runs over more active devices than this are queued (`202`) instead of answered inline.
pub const ASYNC_DEVICE_THRESHOLD: i64 = 500;

// ------------------------------------------------------------------ model

/// A rendered report: what the console shows and what CSV/PDF are built from.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Report {
    #[serde(rename = "type")]
    pub kind: String,
    pub title: String,
    pub subtitle: Option<String>,
    pub generated_at: DateTime<Utc>,
    pub period: Period,
    pub client: Option<ClientRef>,
    pub sections: Vec<Section>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Period {
    pub from: DateTime<Utc>,
    pub to: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ClientRef {
    pub id: String,
    pub name: String,
}

/// One block of a report. `kind` selects the shape.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Section {
    /// Headline numbers.
    Kpis { title: String, items: Vec<Kpi> },
    /// Rows are arrays aligned with `columns`.
    Table {
        title: String,
        columns: Vec<Column>,
        #[schema(value_type = Vec<Vec<Object>>)]
        rows: Vec<Vec<Value>>,
        /// Set when `rows` was truncated.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        total_rows: Option<usize>,
    },
    /// `chart`: `bar` | `line` | `donut`. Each series has one value per label.
    Chart {
        title: String,
        chart: String,
        labels: Vec<String>,
        series: Vec<Series>,
        #[serde(default)]
        unit: Option<String>,
    },
    /// Plain text (paragraphs separated by blank lines; no markup).
    Text { title: String, body: String },
    /// Bulleted items (e.g. recommendations).
    List { title: String, items: Vec<String> },
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Kpi {
    pub label: String,
    /// A number, string or `null` (no data).
    #[schema(value_type = Object)]
    pub value: Value,
    #[serde(default)]
    pub unit: Option<String>,
    /// `good` | `warn` | `bad` | `neutral`
    #[serde(default)]
    pub tone: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Column {
    pub key: String,
    pub label: String,
    /// `left` (default) | `right`
    #[serde(default)]
    pub align: Option<String>,
    /// `text` | `number` | `percent` | `date` | `datetime` | `bytes` | `duration` (minutes)
    #[serde(default)]
    pub format: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Series {
    pub name: String,
    pub values: Vec<f64>,
}

/// Report parameters (every type takes the first four; the rest are type-specific).
#[derive(Debug, Clone, Default, Serialize, Deserialize, ToSchema)]
pub struct ReportParams {
    /// A client id, or `"all"`/omitted for every client you can see.
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub site_id: Option<String>,
    /// Defaults to 30 days before `to`.
    #[serde(default)]
    pub from: Option<DateTime<Utc>>,
    /// Defaults to now.
    #[serde(default)]
    pub to: Option<DateTime<Utc>>,
    /// `software_inventory`: products to count licences for.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub products: Vec<String>,
    /// `audit`: action prefix, e.g. `auth.` or `script.run`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
    /// `audit`: actor id or part of the actor name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor: Option<String>,
    /// `alert_history`: `critical` | `warning` | `info`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub severity: Option<String>,
}

pub struct TypeDef {
    pub kind: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub permission: &'static str,
    pub extra: &'static [(&'static str, &'static str, &'static str)],
}

pub static TYPES: &[TypeDef] = &[
    TypeDef {
        kind: "executive_summary",
        name: "Executive summary",
        description: "Fleet size and OS mix, health trend, alerts with MTTA/MTTR, patch compliance, tickets and SLA, security posture, top issues and recommendations",
        permission: perm::DEVICES_VIEW,
        extra: &[],
    },
    TypeDef {
        kind: "hardware_inventory",
        name: "Hardware inventory",
        description: "Devices with model, serial, CPU, RAM, disks, warranty custom fields and age",
        permission: perm::DEVICES_VIEW,
        extra: &[],
    },
    TypeDef {
        kind: "software_inventory",
        name: "Software inventory",
        description: "Products with versions and device counts; licence counts for selected products",
        permission: perm::SOFTWARE_VIEW,
        extra: &[("products", "array", "Product names to count licences for")],
    },
    TypeDef {
        kind: "patch_compliance",
        name: "Patch compliance",
        description: "Compliance per client and site, and the devices missing critical or important patches with their age",
        permission: perm::PATCHES_VIEW,
        extra: &[],
    },
    TypeDef {
        kind: "alert_history",
        name: "Alert history",
        description: "Alerts over the period with severity, duration and resolution",
        permission: perm::ALERTS_VIEW,
        extra: &[(
            "severity",
            "string",
            "Only this severity: critical, warning or info",
        )],
    },
    TypeDef {
        kind: "security_posture",
        name: "Security posture",
        description: "Devices against the security checks (antivirus, firewall, encryption, local admins, UAC, SMBv1, auto-logon) with the failing items",
        permission: perm::DEVICES_VIEW,
        extra: &[],
    },
    TypeDef {
        kind: "agent_status",
        name: "Agent status",
        description: "Agent versions, offline devices and devices pending approval",
        permission: perm::DEVICES_VIEW,
        extra: &[],
    },
    TypeDef {
        kind: "tickets_time",
        name: "Tickets and time",
        description: "Tickets opened and resolved, SLA results, time logged by client and user, billable totals",
        permission: perm::TICKETS_VIEW,
        extra: &[],
    },
    TypeDef {
        kind: "audit",
        name: "Audit log",
        description: "The audit log for the period, with action and actor filters",
        permission: perm::AUDIT_VIEW,
        extra: &[
            (
                "action",
                "string",
                "Action prefix, e.g. auth. or script.run",
            ),
            ("actor", "string", "Actor id or part of the actor name"),
        ],
    },
];

fn type_def(kind: &str) -> ApiResult<&'static TypeDef> {
    TYPES
        .iter()
        .find(|t| t.kind == kind)
        .ok_or_else(|| ApiError::validation(format!("Unknown report type {kind}")))
}

// ------------------------------------------------------------------ types route

#[derive(Serialize, ToSchema)]
pub struct ParamSchema {
    pub name: String,
    /// `string` | `datetime` | `array`
    #[serde(rename = "type")]
    pub kind: String,
    pub required: bool,
    pub description: String,
}

#[derive(Serialize, ToSchema)]
pub struct ReportType {
    #[serde(rename = "type")]
    pub kind: String,
    pub name: String,
    pub description: String,
    /// The view permission the report's data needs (besides `reports.view`).
    pub permission: String,
    pub parameters: Vec<ParamSchema>,
}

#[derive(Serialize, ToSchema)]
pub struct ReportTypes {
    pub items: Vec<ReportType>,
}

/// List report types
#[utoipa::path(get, path = "/api/v1/reports/types", tag = "Reports",
    responses((status = 200, body = ReportTypes)))]
pub async fn types(ctx: AuthCtx) -> ApiResult<Json<ReportTypes>> {
    ctx.require(perm::REPORTS_VIEW)?;
    let common = [
        ("client_id", "string", "Client id or \"all\""),
        ("site_id", "string", "Site id (within the client)"),
        (
            "from",
            "datetime",
            "Start of the period (default: 30 days ago)",
        ),
        ("to", "datetime", "End of the period (default: now)"),
    ];
    Ok(Json(ReportTypes {
        items: TYPES
            .iter()
            .filter(|t| ctx.scope.has_anywhere(t.permission))
            .map(|t| ReportType {
                kind: t.kind.into(),
                name: t.name.into(),
                description: t.description.into(),
                permission: t.permission.into(),
                parameters: common
                    .iter()
                    .chain(t.extra.iter())
                    .map(|(name, kind, description)| ParamSchema {
                        name: (*name).into(),
                        kind: (*kind).into(),
                        required: false,
                        description: (*description).into(),
                    })
                    .collect(),
            })
            .collect(),
    }))
}

// ------------------------------------------------------------------ resolving parameters

/// Validated parameters.
#[derive(Debug, Clone)]
pub struct Resolved {
    pub from: DateTime<Utc>,
    pub to: DateTime<Utc>,
    pub client: Option<String>,
    pub site: Option<String>,
}

async fn resolve(
    state: &AppState,
    scope: &AccessScope,
    def: &TypeDef,
    p: &ReportParams,
) -> ApiResult<Resolved> {
    let now = rustrmm_common::now();
    let to = p.to.unwrap_or(now).min(now + Duration::days(1));
    let from = p.from.unwrap_or(to - Duration::days(30));
    if from >= to {
        return Err(ApiError::validation("from must be before to"));
    }
    if to - from > Duration::days(800) {
        return Err(ApiError::validation("The period is at most 800 days"));
    }
    let client = p.client_id.clone().filter(|c| !c.is_empty() && c != "all");
    if let Some(c) = &client {
        let exists: Option<String> = sqlx::query_scalar("SELECT id FROM clients WHERE id = ?")
            .bind(c)
            .fetch_optional(&state.db)
            .await?;
        if exists.is_none() || !scope.can_see_client(def.permission, c) {
            return Err(ApiError::not_found("Client"));
        }
    }
    let site = p.site_id.clone().filter(|s| !s.is_empty());
    if let Some(s) = &site {
        let owner: Option<String> = sqlx::query_scalar("SELECT client_id FROM sites WHERE id = ?")
            .bind(s)
            .fetch_optional(&state.db)
            .await?;
        match (&owner, &client) {
            (Some(o), Some(c)) if o == c => {}
            (Some(o), None) if scope.can_site(def.permission, o, s) => {}
            _ => {
                return Err(ApiError::validation(
                    "site_id is not a site of the selected client",
                ));
            }
        }
        if let Some(o) = &owner
            && !scope.can_site(def.permission, o, s)
        {
            return Err(ApiError::not_found("Site"));
        }
    }
    if let Some(sev) = p.severity.as_deref().filter(|s| !s.is_empty())
        && !matches!(sev, "critical" | "warning" | "info")
    {
        return Err(ApiError::validation(
            "severity must be critical, warning or info",
        ));
    }
    if p.products.len() > 50 {
        return Err(ApiError::validation("At most 50 products"));
    }
    Ok(Resolved {
        from,
        to,
        client,
        site,
    })
}

/// Generates and renders, within [`RUN_TIMEOUT`]; rendering runs on the blocking pool.
pub async fn produce(
    state: &AppState,
    scope: &AccessScope,
    kind: &str,
    params: &ReportParams,
    resolved: &Resolved,
    format: &str,
) -> anyhow::Result<(Report, Vec<u8>)> {
    let work = async {
        let ctx = data::Ctx {
            state,
            scope,
            params,
            from: resolved.from,
            to: resolved.to,
            client: resolved.client.clone(),
            site: resolved.site.clone(),
        };
        let report = data::generate(&ctx, kind).await?;
        let bytes = render(state, &report, format).await?;
        anyhow::Ok((report, bytes))
    };
    tokio::time::timeout(RUN_TIMEOUT, work)
        .await
        .map_err(|_| anyhow::anyhow!("report generation took longer than 120 seconds"))?
}

/// Renders a report in `json`, `csv` or `pdf`.
pub async fn render(state: &AppState, report: &Report, format: &str) -> anyhow::Result<Vec<u8>> {
    match format {
        "json" => Ok(serde_json::to_vec(report)?),
        "csv" => {
            let report = report.clone();
            Ok(tokio::task::spawn_blocking(move || csv(&report)).await?)
        }
        "pdf" => {
            let settings = crate::branding::load(state).await?;
            let brand = pdf::Brand {
                product_name: settings.product_name.clone(),
                accent: crate::branding::accent_rgb(&settings),
                msp_logo_png: crate::branding::msp_png(state, &settings).await,
                client_logo_png: match &report.client {
                    Some(c) => crate::branding::client_png(state, &c.id).await,
                    None => None,
                },
            };
            let report = report.clone();
            Ok(tokio::task::spawn_blocking(move || pdf::render(&report, &brand)).await?)
        }
        other => anyhow::bail!("unknown format {other}"),
    }
}

fn csv_cell(v: &str) -> String {
    // Spreadsheet formula injection guard.
    let v = if v.starts_with(['=', '+', '-', '@', '\t', '\r']) && v.parse::<f64>().is_err() {
        format!("'{v}")
    } else {
        v.to_string()
    };
    if v.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", v.replace('"', "\"\""))
    } else {
        v
    }
}

fn csv_value(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        other => other.to_string(),
    }
}

/// CSV: every section in order, each preceded by a one-cell title row and separated by a blank
/// line. KPI sections become `Metric,Value` tables; charts become one column per series.
pub fn csv(report: &Report) -> Vec<u8> {
    let mut out = String::from("\u{feff}");
    let mut row = |cells: Vec<String>| {
        out.push_str(
            &cells
                .iter()
                .map(|c| csv_cell(c))
                .collect::<Vec<_>>()
                .join(","),
        );
        out.push_str("\r\n");
    };
    row(vec![report.title.clone()]);
    row(vec![format!(
        "{} · {} to {}",
        report.subtitle.clone().unwrap_or_default(),
        report.period.from.format("%Y-%m-%d"),
        report.period.to.format("%Y-%m-%d")
    )]);
    for section in &report.sections {
        row(Vec::new());
        match section {
            Section::Kpis { title, items } => {
                row(vec![title.clone()]);
                row(vec!["Metric".into(), "Value".into(), "Unit".into()]);
                for k in items {
                    row(vec![
                        k.label.clone(),
                        csv_value(&k.value),
                        k.unit.clone().unwrap_or_default(),
                    ]);
                }
            }
            Section::Table {
                title,
                columns,
                rows,
                ..
            } => {
                row(vec![title.clone()]);
                row(columns.iter().map(|c| c.label.clone()).collect());
                for r in rows {
                    row(r.iter().map(csv_value).collect());
                }
            }
            Section::Chart {
                title,
                labels,
                series,
                ..
            } => {
                row(vec![title.clone()]);
                let mut header = vec!["Label".to_string()];
                header.extend(series.iter().map(|s| s.name.clone()));
                row(header);
                for (i, label) in labels.iter().enumerate() {
                    let mut cells = vec![label.clone()];
                    cells.extend(
                        series
                            .iter()
                            .map(|s| s.values.get(i).map(|v| v.to_string()).unwrap_or_default()),
                    );
                    row(cells);
                }
            }
            Section::Text { title, body } => {
                row(vec![title.clone()]);
                row(vec![body.clone()]);
            }
            Section::List { title, items } => {
                row(vec![title.clone()]);
                for item in items {
                    row(vec![item.clone()]);
                }
            }
        }
    }
    out.into_bytes()
}

fn content_type(format: &str) -> &'static str {
    match format {
        "csv" => "text/csv; charset=utf-8",
        "pdf" => "application/pdf",
        _ => "application/json",
    }
}

fn file_name(report: &Report, format: &str) -> String {
    let client = report
        .client
        .as_ref()
        .map(|c| format!("-{}", rustrmm_common::slugify(&c.name)))
        .unwrap_or_default();
    format!(
        "{}{client}-{}.{format}",
        report.kind.replace('_', "-"),
        report.generated_at.format("%Y%m%d-%H%M")
    )
}

fn file_response(bytes: Vec<u8>, format: &str, name: &str, run_id: &str) -> Response {
    let mut response = Response::new(Body::from(bytes));
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(content_type(format)),
    );
    if let Ok(v) = HeaderValue::from_str(&format!("attachment; filename=\"{name}\"")) {
        headers.insert(header::CONTENT_DISPOSITION, v);
    }
    if let Ok(v) = HeaderValue::from_str(run_id) {
        headers.insert("x-report-run-id", v);
    }
    response
}

// ------------------------------------------------------------------ runs

#[derive(Debug, Deserialize, ToSchema)]
pub struct RunBody {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub parameters: ReportParams,
    /// `json` (default) | `csv` | `pdf`
    #[serde(default)]
    pub format: Option<String>,
    /// Queue the run (`202 { run_id }`) even when it is small.
    #[serde(default, rename = "async")]
    pub run_async: bool,
}

/// `POST /reports/run` with `format: "json"`.
#[derive(Serialize, ToSchema)]
pub struct RunResponse {
    pub report: Report,
    pub run_id: String,
}

#[derive(Serialize, ToSchema)]
pub struct QueuedRun {
    pub run_id: String,
    pub status: String,
}

struct NewRun<'a> {
    kind: &'a str,
    title: &'a str,
    params: &'a ReportParams,
    format: &'a str,
    status: &'a str,
    trigger: &'a str,
    schedule_id: Option<&'a str>,
    client_id: Option<&'a str>,
    user_id: Option<&'a str>,
    user_name: &'a str,
}

async fn insert_run(state: &AppState, r: NewRun<'_>) -> anyhow::Result<String> {
    let id = rustrmm_common::new_id();
    let now = rustrmm_common::now();
    sqlx::query(
        "INSERT INTO report_runs (id, type, title, parameters, format, status, trigger_kind, schedule_id, client_id, user_id,
             user_name, created_at, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(r.kind)
    .bind(r.title)
    .bind(serde_json::to_string(r.params)?)
    .bind(r.format)
    .bind(r.status)
    .bind(r.trigger)
    .bind(r.schedule_id)
    .bind(r.client_id)
    .bind(r.user_id)
    .bind(r.user_name)
    .bind(now)
    .bind((r.status == "running").then_some(now))
    .execute(&state.db)
    .await?;
    Ok(id)
}

async fn finish_run(
    state: &AppState,
    id: &str,
    result: &anyhow::Result<(Report, Vec<u8>)>,
    format: &str,
) -> anyhow::Result<()> {
    let now = rustrmm_common::now();
    match result {
        Ok((report, bytes)) => {
            sqlx::query(
                "UPDATE report_runs SET status = 'completed', title = ?, file_name = ?, content_type = ?, size_bytes = ?, output = ?,
                     finished_at = ?, started_at = COALESCE(started_at, ?) WHERE id = ?",
            )
            .bind(&report.title)
            .bind(file_name(report, format))
            .bind(content_type(format))
            .bind(bytes.len() as i64)
            .bind(bytes)
            .bind(now)
            .bind(now)
            .bind(id)
            .execute(&state.db)
            .await?;
        }
        Err(e) => {
            sqlx::query(
                "UPDATE report_runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?",
            )
            .bind(format!("{e:#}").chars().take(1000).collect::<String>())
            .bind(now)
            .bind(id)
            .execute(&state.db)
            .await?;
        }
    }
    Ok(())
}

async fn active_devices_in_scope(
    state: &AppState,
    scope: &AccessScope,
    def: &TypeDef,
    r: &Resolved,
) -> anyhow::Result<i64> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT s.client_id, d.site_id FROM devices d JOIN sites s ON s.id = d.site_id WHERE d.status = 'active'",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(rows
        .iter()
        .filter(|(c, s)| {
            scope.can_site(def.permission, c, s)
                && r.client.as_deref().is_none_or(|x| x == c)
                && r.site.as_deref().is_none_or(|x| x == s)
        })
        .count() as i64)
}

/// Run a report
///
/// JSON answers `{ report, run_id }`; CSV and PDF stream a file (header `X-Report-Run-Id`).
/// Large runs (more than 500 active devices in scope, or `async: true`) answer
/// `202 { run_id }`: poll `GET /report-runs/{id}` and download the result.
#[utoipa::path(post, path = "/api/v1/reports/run", tag = "Reports", request_body = RunBody,
    responses((status = 200, body = RunResponse, description = "JSON; CSV and PDF answer with the file"),
              (status = 202, body = QueuedRun)))]
pub async fn run(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Json(body): Json<RunBody>,
) -> ApiResult<Response> {
    ctx.require(perm::REPORTS_VIEW)?;
    let def = type_def(&body.kind)?;
    ctx.require(def.permission)?;
    let format = body.format.clone().unwrap_or_else(|| "json".into());
    if !matches!(format.as_str(), "json" | "csv" | "pdf") {
        return Err(ApiError::validation("format must be json, csv or pdf"));
    }
    let resolved = resolve(&state, &ctx.scope, def, &body.parameters).await?;
    let queue = body.run_async
        || active_devices_in_scope(&state, &ctx.scope, def, &resolved).await?
            > ASYNC_DEVICE_THRESHOLD;
    let run_id = insert_run(
        &state,
        NewRun {
            kind: def.kind,
            title: def.name,
            params: &body.parameters,
            format: &format,
            status: if queue { "queued" } else { "running" },
            trigger: "manual",
            schedule_id: None,
            client_id: resolved.client.as_deref(),
            user_id: Some(&ctx.user.id),
            user_name: &ctx.user.name,
        },
    )
    .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("report.run")
                .target("report_run", &run_id, def.name)
                .details(json!({ "type": def.kind, "format": format, "parameters": body.parameters, "async": queue })),
        )
        .await;
    if queue {
        let state2 = state.clone();
        let scope = ctx.scope.clone();
        let kind = def.kind.to_string();
        let params = body.parameters.clone();
        let id = run_id.clone();
        let fmt = format.clone();
        tokio::spawn(async move {
            let _ = sqlx::query(
                "UPDATE report_runs SET status = 'running', started_at = ? WHERE id = ?",
            )
            .bind(rustrmm_common::now())
            .bind(&id)
            .execute(&state2.db)
            .await;
            let result = produce(&state2, &scope, &kind, &params, &resolved, &fmt).await;
            if let Err(e) = finish_run(&state2, &id, &result, &fmt).await {
                tracing::warn!(run = %id, error = %format!("{e:#}"), "could not record report run");
            }
        });
        return Ok((
            StatusCode::ACCEPTED,
            Json(QueuedRun {
                run_id,
                status: "queued".into(),
            }),
        )
            .into_response());
    }
    let result = produce(
        &state,
        &ctx.scope,
        def.kind,
        &body.parameters,
        &resolved,
        &format,
    )
    .await;
    finish_run(&state, &run_id, &result, &format).await?;
    let (report, bytes) = result.map_err(|e| ApiError::internal(format!("{e:#}")))?;
    if format == "json" {
        return Ok(Json(RunResponse { report, run_id }).into_response());
    }
    Ok(file_response(
        bytes,
        &format,
        &file_name(&report, &format),
        &run_id,
    ))
}

#[derive(Debug, Serialize, ToSchema, sqlx::FromRow)]
pub struct ReportRun {
    pub id: String,
    #[serde(rename = "type")]
    #[sqlx(rename = "type")]
    pub kind: String,
    pub title: String,
    /// `json` | `csv` | `pdf`
    pub format: String,
    /// `queued` | `running` | `completed` | `failed`
    pub status: String,
    /// `manual` | `schedule`
    #[sqlx(rename = "trigger_kind")]
    pub trigger: String,
    pub schedule_id: Option<String>,
    pub client_id: Option<String>,
    pub user_id: Option<String>,
    pub user_name: String,
    pub file_name: Option<String>,
    pub size_bytes: Option<i64>,
    pub error: Option<String>,
    /// Addresses a scheduled run was e-mailed to (JSON array).
    #[schema(value_type = Vec<String>)]
    #[sqlx(skip)]
    pub emailed_to: Vec<String>,
    pub created_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    /// Whether `GET /report-runs/{id}/download` has a file.
    #[sqlx(skip)]
    pub downloadable: bool,
    #[schema(value_type = Object)]
    #[sqlx(skip)]
    pub parameters: Value,
}

const RUN_COLUMNS: &str = "id, type, title, format, status, trigger_kind, schedule_id, client_id, user_id, user_name, file_name,
    size_bytes, error, created_at, started_at, finished_at, parameters, emailed_to, output IS NOT NULL AS has_output";

fn run_from_row(row: &sqlx::sqlite::SqliteRow) -> Result<ReportRun, sqlx::Error> {
    use sqlx::{FromRow, Row};
    let mut r = ReportRun::from_row(row)?;
    let params: String = row.try_get("parameters")?;
    let emailed: String = row.try_get("emailed_to")?;
    r.parameters = serde_json::from_str(&params).unwrap_or(Value::Null);
    r.emailed_to = serde_json::from_str(&emailed).unwrap_or_default();
    r.downloadable = row.try_get::<bool, _>("has_output")? && r.status == "completed";
    Ok(r)
}

fn can_see_run(ctx: &AuthCtx, run: &ReportRun) -> bool {
    run.user_id.as_deref() == Some(ctx.user.id.as_str())
        || ctx.scope.has_global(perm::REPORTS_MANAGE)
}

#[derive(Debug, Deserialize, IntoParams)]
pub struct RunsQuery {
    limit: Option<i64>,
    /// Only runs of this schedule.
    schedule_id: Option<String>,
}

#[derive(Serialize, ToSchema)]
pub struct RunList {
    pub items: Vec<ReportRun>,
}

/// List report runs
///
/// Your own runs; `reports.manage` (installation-wide) also sees everyone's and scheduled runs.
#[utoipa::path(get, path = "/api/v1/report-runs", tag = "Reports", params(RunsQuery),
    responses((status = 200, body = RunList)))]
pub async fn list_runs(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<RunsQuery>,
) -> ApiResult<Json<RunList>> {
    ctx.require(perm::REPORTS_VIEW)?;
    let limit = q.limit.unwrap_or(50).clamp(1, 500);
    let all = ctx.scope.has_global(perm::REPORTS_MANAGE);
    let mut qb = sqlx::QueryBuilder::<sqlx::Sqlite>::new(format!(
        "SELECT {RUN_COLUMNS} FROM report_runs WHERE 1 = 1"
    ));
    if !all {
        qb.push(" AND user_id = ").push_bind(ctx.user.id.clone());
    }
    if let Some(s) = q.schedule_id.filter(|s| !s.is_empty()) {
        qb.push(" AND schedule_id = ").push_bind(s);
    }
    qb.push(" ORDER BY created_at DESC, id DESC LIMIT ")
        .push_bind(limit);
    let rows = qb.build().fetch_all(&state.db).await?;
    let items = rows
        .iter()
        .map(run_from_row)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Json(RunList { items }))
}

async fn load_run(state: &AppState, ctx: &AuthCtx, id: &str) -> ApiResult<ReportRun> {
    ctx.require(perm::REPORTS_VIEW)?;
    let row = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT {RUN_COLUMNS} FROM report_runs WHERE id = ?"
    )))
    .bind(id)
    .fetch_optional(&state.db)
    .await?;
    let run = row
        .as_ref()
        .map(run_from_row)
        .transpose()?
        .filter(|r| can_see_run(ctx, r))
        .ok_or_else(|| ApiError::not_found("Report run"))?;
    Ok(run)
}

/// Get a report run
#[utoipa::path(get, path = "/api/v1/report-runs/{id}", tag = "Reports",
    params(("id" = String, Path)), responses((status = 200, body = ReportRun)))]
pub async fn get_run(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<ReportRun>> {
    Ok(Json(load_run(&state, &ctx, &id).await?))
}

/// Download a report run
///
/// The rendered file (JSON, CSV or PDF). `409 not_ready` while queued or running.
#[utoipa::path(get, path = "/api/v1/report-runs/{id}/download", tag = "Reports",
    params(("id" = String, Path)), responses((status = 200, description = "The file"), (status = 409)))]
pub async fn download_run(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    let run = load_run(&state, &ctx, &id).await?;
    if run.status != "completed" {
        return Err(ApiError::conflict(
            "not_ready",
            format!("The run is {}", run.status),
        ));
    }
    let output: Option<Vec<u8>> = sqlx::query_scalar("SELECT output FROM report_runs WHERE id = ?")
        .bind(&id)
        .fetch_one(&state.db)
        .await?;
    let output =
        output.ok_or_else(|| ApiError::not_found("Report file (expired after 30 days)"))?;
    let name = run
        .file_name
        .clone()
        .unwrap_or_else(|| format!("report.{}", run.format));
    Ok(file_response(output, &run.format, &name, &id))
}

// ------------------------------------------------------------------ schedules

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct Schedule {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub parameters: ReportParams,
    /// `pdf` | `csv`
    pub format: String,
    pub cron: String,
    pub timezone: String,
    pub recipients: Vec<String>,
    /// One branded report per client, sent to that client's primary contacts plus `recipients`.
    pub per_client: bool,
    pub enabled: bool,
    pub next_run_at: Option<DateTime<Utc>>,
    pub last_run_at: Option<DateTime<Utc>>,
    pub last_status: Option<String>,
    pub last_error: Option<String>,
    pub created_by: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(sqlx::FromRow)]
struct ScheduleRow {
    id: String,
    name: String,
    #[sqlx(rename = "type")]
    kind: String,
    parameters: String,
    format: String,
    cron: String,
    timezone: String,
    recipients: String,
    per_client: bool,
    enabled: bool,
    next_run_at: Option<DateTime<Utc>>,
    last_run_at: Option<DateTime<Utc>>,
    last_status: Option<String>,
    last_error: Option<String>,
    created_by: Option<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

impl From<ScheduleRow> for Schedule {
    fn from(r: ScheduleRow) -> Self {
        Self {
            id: r.id,
            name: r.name,
            kind: r.kind,
            parameters: serde_json::from_str(&r.parameters).unwrap_or_default(),
            format: r.format,
            cron: r.cron,
            timezone: r.timezone,
            recipients: serde_json::from_str(&r.recipients).unwrap_or_default(),
            per_client: r.per_client,
            enabled: r.enabled,
            next_run_at: r.next_run_at,
            last_run_at: r.last_run_at,
            last_status: r.last_status,
            last_error: r.last_error,
            created_by: r.created_by,
            created_at: r.created_at,
            updated_at: r.updated_at,
        }
    }
}

const SCHEDULE_COLUMNS: &str = "id, name, type, parameters, format, cron, timezone, recipients, per_client, enabled, next_run_at,
    last_run_at, last_status, last_error, created_by, created_at, updated_at";

async fn load_schedule(state: &AppState, id: &str) -> anyhow::Result<Option<Schedule>> {
    let row: Option<ScheduleRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {SCHEDULE_COLUMNS} FROM report_schedules WHERE id = ?"
    )))
    .bind(id)
    .fetch_optional(&state.db)
    .await?;
    Ok(row.map(Schedule::from))
}

fn schedule_visible(ctx: &AuthCtx, s: &Schedule) -> bool {
    if ctx.scope.has_global(perm::REPORTS_MANAGE) {
        return true;
    }
    match s.parameters.client_id.as_deref().filter(|c| *c != "all") {
        Some(c) => ctx.scope.can_client(perm::REPORTS_MANAGE, c),
        None => false,
    }
}

#[derive(Serialize, ToSchema)]
pub struct ScheduleList {
    pub items: Vec<Schedule>,
}

/// List report schedules
#[utoipa::path(get, path = "/api/v1/report-schedules", tag = "Reports",
    responses((status = 200, body = ScheduleList)))]
pub async fn list_schedules(
    State(state): State<AppState>,
    ctx: AuthCtx,
) -> ApiResult<Json<ScheduleList>> {
    ctx.require(perm::REPORTS_MANAGE)?;
    let rows: Vec<ScheduleRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {SCHEDULE_COLUMNS} FROM report_schedules ORDER BY name COLLATE NOCASE"
    )))
    .fetch_all(&state.db)
    .await?;
    Ok(Json(ScheduleList {
        items: rows
            .into_iter()
            .map(Schedule::from)
            .filter(|s| schedule_visible(&ctx, s))
            .collect(),
    }))
}

/// Get a report schedule
#[utoipa::path(get, path = "/api/v1/report-schedules/{id}", tag = "Reports",
    params(("id" = String, Path)), responses((status = 200, body = Schedule)))]
pub async fn get_schedule(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Schedule>> {
    ctx.require(perm::REPORTS_MANAGE)?;
    let s = load_schedule(&state, &id)
        .await?
        .filter(|s| schedule_visible(&ctx, s))
        .ok_or_else(|| ApiError::not_found("Report schedule"))?;
    Ok(Json(s))
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct ScheduleBody {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub parameters: ReportParams,
    /// `pdf` | `csv`
    pub format: String,
    /// Five-field cron expression.
    pub cron: String,
    #[serde(default = "utc")]
    pub timezone: String,
    #[serde(default)]
    pub recipients: Vec<String>,
    #[serde(default)]
    pub per_client: bool,
    #[serde(default = "yes")]
    pub enabled: bool,
}

fn utc() -> String {
    "UTC".into()
}

fn yes() -> bool {
    true
}

async fn validate_schedule(
    state: &AppState,
    ctx: &AuthCtx,
    body: &mut ScheduleBody,
) -> ApiResult<DateTime<Utc>> {
    body.name = body.name.trim().to_string();
    if body.name.is_empty() || body.name.chars().count() > 100 {
        return Err(ApiError::validation("name must be 1–100 characters"));
    }
    let def = type_def(&body.kind)?;
    ctx.require(def.permission)?;
    if !matches!(body.format.as_str(), "pdf" | "csv") {
        return Err(ApiError::validation("format must be pdf or csv"));
    }
    crate::automation::cron::validate(&body.cron, &body.timezone).map_err(ApiError::validation)?;
    // Relative periods: a schedule always reports on the window before each run.
    if body.parameters.from.is_some() || body.parameters.to.is_some() {
        return Err(ApiError::validation(
            "Schedules report on the 30 days before each run; omit from and to",
        ));
    }
    resolve(state, &ctx.scope, def, &body.parameters).await?;
    let client_scoped = body
        .parameters
        .client_id
        .as_deref()
        .filter(|c| *c != "all")
        .map(str::to_string);
    match &client_scoped {
        Some(c) => ctx.require_client(perm::REPORTS_MANAGE, c)?,
        None => ctx.require_global(perm::REPORTS_MANAGE)?,
    }
    let mut recipients: Vec<String> = body
        .recipients
        .iter()
        .map(|r| r.trim().to_lowercase())
        .filter(|r| !r.is_empty())
        .collect();
    recipients.sort();
    recipients.dedup();
    if recipients.len() > 50 {
        return Err(ApiError::validation("At most 50 recipients"));
    }
    if let Some(bad) = recipients
        .iter()
        .find(|r| !crate::monitoring::settings::valid_email(r))
    {
        return Err(ApiError::validation(format!(
            "{bad} is not a valid e-mail address"
        )));
    }
    if recipients.is_empty() && !body.per_client {
        return Err(ApiError::validation(
            "Add at least one recipient (or send per client to primary contacts)",
        ));
    }
    body.recipients = recipients;
    crate::automation::cron::next_after(&body.cron, &body.timezone, rustrmm_common::now())
        .ok_or_else(|| ApiError::validation("The schedule never fires"))
}

/// Create a report schedule
#[utoipa::path(post, path = "/api/v1/report-schedules", tag = "Reports", request_body = ScheduleBody,
    responses((status = 201, body = Schedule)))]
pub async fn create_schedule(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Json(mut body): Json<ScheduleBody>,
) -> ApiResult<(StatusCode, Json<Schedule>)> {
    ctx.require(perm::REPORTS_MANAGE)?;
    let next = validate_schedule(&state, &ctx, &mut body).await?;
    let id = rustrmm_common::new_id();
    let now = rustrmm_common::now();
    sqlx::query(
        "INSERT INTO report_schedules (id, name, type, parameters, format, cron, timezone, recipients, per_client, enabled,
             next_run_at, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&body.name)
    .bind(&body.kind)
    .bind(serde_json::to_string(&body.parameters)?)
    .bind(&body.format)
    .bind(body.cron.trim())
    .bind(body.timezone.trim())
    .bind(serde_json::to_string(&body.recipients)?)
    .bind(body.per_client)
    .bind(body.enabled)
    .bind(body.enabled.then_some(next))
    .bind(&ctx.user.id)
    .bind(now)
    .bind(now)
    .execute(&state.db)
    .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("report_schedule.created")
                .target("report_schedule", &id, &body.name)
                .details(json!({ "type": body.kind, "format": body.format, "cron": body.cron, "timezone": body.timezone,
                                 "recipients": body.recipients, "per_client": body.per_client })),
        )
        .await;
    let s = load_schedule(&state, &id)
        .await?
        .ok_or_else(|| ApiError::internal("schedule vanished"))?;
    Ok((StatusCode::CREATED, Json(s)))
}

/// Update a report schedule
#[utoipa::path(put, path = "/api/v1/report-schedules/{id}", tag = "Reports", request_body = ScheduleBody,
    params(("id" = String, Path)), responses((status = 200, body = Schedule)))]
pub async fn update_schedule(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(mut body): Json<ScheduleBody>,
) -> ApiResult<Json<Schedule>> {
    ctx.require(perm::REPORTS_MANAGE)?;
    load_schedule(&state, &id)
        .await?
        .filter(|s| schedule_visible(&ctx, s))
        .ok_or_else(|| ApiError::not_found("Report schedule"))?;
    let next = validate_schedule(&state, &ctx, &mut body).await?;
    sqlx::query(
        "UPDATE report_schedules SET name = ?, type = ?, parameters = ?, format = ?, cron = ?, timezone = ?, recipients = ?,
             per_client = ?, enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?",
    )
    .bind(&body.name)
    .bind(&body.kind)
    .bind(serde_json::to_string(&body.parameters)?)
    .bind(&body.format)
    .bind(body.cron.trim())
    .bind(body.timezone.trim())
    .bind(serde_json::to_string(&body.recipients)?)
    .bind(body.per_client)
    .bind(body.enabled)
    .bind(body.enabled.then_some(next))
    .bind(rustrmm_common::now())
    .bind(&id)
    .execute(&state.db)
    .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("report_schedule.updated")
                .target("report_schedule", &id, &body.name)
                .details(json!({ "type": body.kind, "format": body.format, "cron": body.cron, "enabled": body.enabled,
                                 "recipients": body.recipients, "per_client": body.per_client })),
        )
        .await;
    Ok(Json(
        load_schedule(&state, &id)
            .await?
            .ok_or_else(|| ApiError::not_found("Report schedule"))?,
    ))
}

/// Delete a report schedule
#[utoipa::path(delete, path = "/api/v1/report-schedules/{id}", tag = "Reports",
    params(("id" = String, Path)), responses((status = 204)))]
pub async fn delete_schedule(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    ctx.require(perm::REPORTS_MANAGE)?;
    let s = load_schedule(&state, &id)
        .await?
        .filter(|s| schedule_visible(&ctx, s))
        .ok_or_else(|| ApiError::not_found("Report schedule"))?;
    sqlx::query("DELETE FROM report_schedules WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("report_schedule.deleted")
                .target("report_schedule", &id, &s.name),
        )
        .await;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize, ToSchema)]
pub struct ScheduleRunResult {
    /// The runs created (one per client with `per_client`).
    pub run_ids: Vec<String>,
}

/// Run a schedule now
///
/// Generates and e-mails the schedule immediately (the regular schedule is unchanged).
#[utoipa::path(post, path = "/api/v1/report-schedules/{id}/run-now", tag = "Reports",
    params(("id" = String, Path)), responses((status = 200, body = ScheduleRunResult)))]
pub async fn run_schedule_now(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<ScheduleRunResult>> {
    ctx.require(perm::REPORTS_MANAGE)?;
    let s = load_schedule(&state, &id)
        .await?
        .filter(|s| schedule_visible(&ctx, s))
        .ok_or_else(|| ApiError::not_found("Report schedule"))?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("report_schedule.run_now")
                .target("report_schedule", &id, &s.name),
        )
        .await;
    let run_ids = execute_schedule(&state, &s).await?;
    Ok(Json(ScheduleRunResult { run_ids }))
}

// ------------------------------------------------------------------ scheduled delivery

/// Runs one schedule: generates (per client when asked), stores the runs and e-mails them.
pub async fn execute_schedule(state: &AppState, s: &Schedule) -> anyhow::Result<Vec<String>> {
    let def = TYPES
        .iter()
        .find(|t| t.kind == s.kind)
        .ok_or_else(|| anyhow::anyhow!("unknown report type {}", s.kind))?;
    let owner = match &s.created_by {
        Some(u) => {
            sqlx::query_as::<_, (String, String)>(
                "SELECT id, name FROM users WHERE id = ? AND status = 'active'",
            )
            .bind(u)
            .fetch_optional(&state.db)
            .await?
        }
        None => None,
    };
    let Some((owner_id, owner_name)) = owner else {
        anyhow::bail!("the schedule's owner no longer exists or is disabled");
    };
    let scope = AccessScope::load(&state.db, &owner_id).await?;
    let mut params = s.parameters.clone();
    let now = rustrmm_common::now();
    params.to = Some(now);
    params.from = Some(now - Duration::days(30));
    let targets: Vec<Option<String>> = if s.per_client {
        match params
            .client_id
            .clone()
            .filter(|c| !c.is_empty() && c != "all")
        {
            Some(c) => vec![Some(c)],
            None => {
                let clients: Vec<String> =
                    sqlx::query_scalar("SELECT id FROM clients ORDER BY name COLLATE NOCASE")
                        .fetch_all(&state.db)
                        .await?;
                clients
                    .into_iter()
                    .filter(|c| scope.can_see_client(def.permission, c))
                    .map(Some)
                    .collect()
            }
        }
    } else {
        vec![params.client_id.clone().filter(|c| c != "all")]
    };
    let settings = crate::branding::load(state).await?;
    let mut run_ids = Vec::new();
    let mut errors = Vec::new();
    for target in targets {
        let mut p = params.clone();
        p.client_id = target.clone();
        let resolved = match resolve(state, &scope, def, &p).await {
            Ok(r) => r,
            Err(e) => {
                errors.push(e.message);
                continue;
            }
        };
        let run_id = insert_run(
            state,
            NewRun {
                kind: def.kind,
                title: def.name,
                params: &p,
                format: &s.format,
                status: "running",
                trigger: "schedule",
                schedule_id: Some(&s.id),
                client_id: target.as_deref(),
                user_id: Some(&owner_id),
                user_name: &owner_name,
            },
        )
        .await?;
        let result = produce(state, &scope, def.kind, &p, &resolved, &s.format).await;
        finish_run(state, &run_id, &result, &s.format).await?;
        run_ids.push(run_id.clone());
        let (report, bytes) = match result {
            Ok(r) => r,
            Err(e) => {
                errors.push(format!("{e:#}"));
                continue;
            }
        };
        let mut recipients = s.recipients.clone();
        if s.per_client
            && let Some(c) = &target
        {
            let contacts: Vec<String> = sqlx::query_scalar(
                "SELECT LOWER(email) FROM contacts WHERE client_id = ? AND is_primary = 1 AND email <> ''",
            )
            .bind(c)
            .fetch_all(&state.db)
            .await?;
            recipients.extend(contacts);
        }
        recipients.sort();
        recipients.dedup();
        if recipients.is_empty() {
            errors.push(format!(
                "{}: no recipients",
                report.subtitle.clone().unwrap_or_default()
            ));
            continue;
        }
        match send_report(state, &settings, &report, &bytes, &s.format, &recipients).await {
            Ok(()) => {
                sqlx::query("UPDATE report_runs SET emailed_to = ? WHERE id = ?")
                    .bind(serde_json::to_string(&recipients)?)
                    .bind(&run_id)
                    .execute(&state.db)
                    .await?;
            }
            Err(e) => {
                let msg = format!("e-mail failed: {e:#}");
                sqlx::query("UPDATE report_runs SET status = 'failed', error = ? WHERE id = ?")
                    .bind(&msg)
                    .bind(&run_id)
                    .execute(&state.db)
                    .await?;
                errors.push(msg);
            }
        }
    }
    let (status, error) = if errors.is_empty() {
        ("ok", None)
    } else {
        (
            "failed",
            Some(errors.join("; ").chars().take(1000).collect::<String>()),
        )
    };
    sqlx::query(
        "UPDATE report_schedules SET last_run_at = ?, last_status = ?, last_error = ? WHERE id = ?",
    )
    .bind(rustrmm_common::now())
    .bind(status)
    .bind(&error)
    .bind(&s.id)
    .execute(&state.db)
    .await?;
    Ok(run_ids)
}

async fn send_report(
    state: &AppState,
    settings: &crate::branding::BrandingSettings,
    report: &Report,
    bytes: &[u8],
    format: &str,
    recipients: &[String],
) -> anyhow::Result<()> {
    let smtp = crate::monitoring::settings::load_smtp(state).await?;
    if !smtp.configured() {
        anyhow::bail!("SMTP is not configured");
    }
    let password = smtp.password(state)?;
    let place = report.subtitle.clone().unwrap_or_default();
    let subject = format!(
        "{}: {} – {} – {}",
        settings.product_name,
        report.title,
        place,
        report.generated_at.format("%Y-%m-%d")
    );
    let esc = |s: &str| {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    };
    let html = format!(
        "<html><body style=\"font-family:sans-serif\"><h2 style=\"margin:0 0 8px 0\">{}</h2><p>{}</p>\
         <p>The report for {} to {} is attached.</p></body></html>",
        esc(&report.title),
        esc(&place),
        report.period.from.format("%Y-%m-%d"),
        report.period.to.format("%Y-%m-%d")
    );
    let email = crate::monitoring::notify::smtp::Email {
        to: recipients.to_vec(),
        subject,
        text: format!(
            "{}\n{}\nThe report for {} to {} is attached.\n",
            report.title,
            place,
            report.period.from.format("%Y-%m-%d"),
            report.period.to.format("%Y-%m-%d")
        ),
        html: crate::branding::brand_email_html(state, settings, &html),
        attachments: vec![crate::monitoring::notify::smtp::Attachment {
            file_name: file_name(report, format),
            content_type: content_type(format)
                .split(';')
                .next()
                .unwrap_or("application/octet-stream")
                .to_string(),
            data: bytes.to_vec(),
        }],
        ..Default::default()
    };
    crate::monitoring::notify::smtp::send(&smtp, password.as_deref(), &email).await
}

/// One scheduler pass: due schedules run, then move to their next occurrence.
pub async fn tick(state: &AppState) -> anyhow::Result<()> {
    let now = rustrmm_common::now();
    let due: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM report_schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?",
    )
    .bind(now)
    .fetch_all(&state.db)
    .await?;
    for id in due {
        let Some(s) = load_schedule(state, &id).await? else {
            continue;
        };
        let next = crate::automation::cron::next_after(&s.cron, &s.timezone, now);
        // Advance first so a crash never re-sends the same occurrence.
        sqlx::query("UPDATE report_schedules SET next_run_at = ? WHERE id = ?")
            .bind(next)
            .bind(&id)
            .execute(&state.db)
            .await?;
        if let Err(e) = execute_schedule(state, &s).await {
            tracing::warn!(schedule = %id, error = %format!("{e:#}"), "scheduled report failed");
            let _ = sqlx::query("UPDATE report_schedules SET last_run_at = ?, last_status = 'failed', last_error = ? WHERE id = ?")
                .bind(now)
                .bind(format!("{e:#}"))
                .bind(&id)
                .execute(&state.db)
                .await;
        }
    }
    // Retention: files after 30 days, run records after 180 days.
    sqlx::query("UPDATE report_runs SET output = NULL WHERE output IS NOT NULL AND created_at < ?")
        .bind(now - Duration::days(30))
        .execute(&state.db)
        .await?;
    sqlx::query("DELETE FROM report_runs WHERE created_at < ?")
        .bind(now - Duration::days(180))
        .execute(&state.db)
        .await?;
    Ok(())
}

/// Starts the report scheduler and the hourly health snapshot; marks runs interrupted by a
/// restart as failed.
pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        let _ = sqlx::query(
            "UPDATE report_runs SET status = 'failed', error = 'Interrupted by a server restart' WHERE status IN ('queued', 'running')",
        )
        .execute(&state.db)
        .await;
        let mut minute = tokio::time::interval(StdDuration::from_secs(60));
        let mut last_snapshot: Option<std::time::Instant> = None;
        loop {
            minute.tick().await;
            if last_snapshot.is_none_or(|t| t.elapsed() >= StdDuration::from_secs(3600)) {
                if let Err(e) = data::snapshot_health(&state).await {
                    tracing::warn!(error = %format!("{e:#}"), "health snapshot failed");
                }
                last_snapshot = Some(std::time::Instant::now());
            }
            if let Err(e) = tick(&state).await {
                tracing::warn!(error = %format!("{e:#}"), "report scheduler pass failed");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_escapes_and_guards_formulas() {
        assert_eq!(csv_cell("plain"), "plain");
        assert_eq!(csv_cell("a,b"), "\"a,b\"");
        assert_eq!(csv_cell("say \"hi\""), "\"say \"\"hi\"\"\"");
        assert_eq!(csv_cell("=HYPERLINK(\"x\")"), "\"'=HYPERLINK(\"\"x\"\")\"");
        assert_eq!(csv_cell("-5"), "-5", "negative numbers stay numbers");
        assert_eq!(csv_cell("@cmd"), "'@cmd");
    }

    #[test]
    fn every_type_has_a_known_permission() {
        for t in TYPES {
            assert!(crate::rbac::is_known(t.permission), "{}", t.kind);
        }
        assert_eq!(TYPES.len(), 9);
    }
}
