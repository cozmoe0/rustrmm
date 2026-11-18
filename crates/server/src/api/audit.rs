//! Audit log browsing, verification and export.

use axum::Json;
use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{QueryBuilder, Row, Sqlite};

use crate::auth::AuthCtx;
use crate::error::{ApiError, ApiResult};
use crate::rbac::{ClientFilter, perm};
use crate::state::AppState;

#[derive(Debug, Deserialize, Default)]
pub struct AuditQuery {
    limit: Option<i64>,
    cursor: Option<String>,
    action: Option<String>,
    actor_id: Option<String>,
    client_id: Option<String>,
    from: Option<String>,
    to: Option<String>,
    q: Option<String>,
}

#[derive(Serialize)]
pub struct ActorDto {
    #[serde(rename = "type")]
    kind: String,
    id: Option<String>,
    name: Option<String>,
}

#[derive(Serialize)]
pub struct TargetDto {
    #[serde(rename = "type")]
    kind: String,
    id: Option<String>,
    name: Option<String>,
}

#[derive(Serialize)]
pub struct AuditEventDto {
    id: i64,
    at: String,
    actor: ActorDto,
    action: String,
    target: Option<TargetDto>,
    client_id: Option<String>,
    site_id: Option<String>,
    ip: Option<String>,
    user_agent: Option<String>,
    details: Value,
    hash: String,
}

fn apply_filters(builder: &mut QueryBuilder<Sqlite>, q: &AuditQuery, filter: &ClientFilter) {
    builder.push(" WHERE 1 = 1");
    if let ClientFilter::Only(ids) = filter {
        if ids.is_empty() {
            builder.push(" AND 0 = 1");
        } else {
            builder.push(" AND client_id IN (");
            let mut sep = builder.separated(", ");
            for id in ids {
                sep.push_bind(id.clone());
            }
            builder.push(")");
        }
    }
    if let Some(action) = q.action.as_deref().filter(|s| !s.is_empty()) {
        if let Some(prefix) = action
            .strip_suffix(".*")
            .or_else(|| (!action.contains('.')).then_some(action))
        {
            builder
                .push(" AND action LIKE ")
                .push_bind(format!("{prefix}.%"));
        } else {
            builder.push(" AND action = ").push_bind(action.to_string());
        }
    }
    if let Some(actor) = q.actor_id.as_deref().filter(|s| !s.is_empty()) {
        builder
            .push(" AND actor_id = ")
            .push_bind(actor.to_string());
    }
    if let Some(client) = q.client_id.as_deref().filter(|s| !s.is_empty()) {
        builder
            .push(" AND client_id = ")
            .push_bind(client.to_string());
    }
    if let Some(from) = q.from.as_deref().filter(|s| !s.is_empty()) {
        builder.push(" AND at >= ").push_bind(normalise_time(from));
    }
    if let Some(to) = q.to.as_deref().filter(|s| !s.is_empty()) {
        builder.push(" AND at <= ").push_bind(normalise_time(to));
    }
    if let Some(text) = q.q.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let like = format!("%{}%", text.replace(['%', '_'], ""));
        builder
            .push(" AND (action LIKE ")
            .push_bind(like.clone())
            .push(" OR actor_name LIKE ")
            .push_bind(like.clone())
            .push(" OR target_name LIKE ")
            .push_bind(like.clone())
            .push(" OR details LIKE ")
            .push_bind(like.clone())
            .push(" OR ip LIKE ")
            .push_bind(like)
            .push(")");
    }
}

/// Accepts RFC 3339 or a bare date and converts to the stored `...Z` millisecond format.
fn normalise_time(input: &str) -> String {
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(input) {
        return dt
            .with_timezone(&chrono::Utc)
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    }
    if let Ok(date) = chrono::NaiveDate::parse_from_str(input, "%Y-%m-%d") {
        return format!("{date}T00:00:00.000Z");
    }
    input.to_string()
}

fn row_to_dto(row: &sqlx::sqlite::SqliteRow) -> ApiResult<AuditEventDto> {
    let target_type: Option<String> = row.try_get("target_type")?;
    let details: String = row.try_get("details")?;
    Ok(AuditEventDto {
        id: row.try_get("id")?,
        at: row.try_get("at")?,
        actor: ActorDto {
            kind: row.try_get("actor_type")?,
            id: row.try_get("actor_id")?,
            name: row.try_get("actor_name")?,
        },
        action: row.try_get("action")?,
        target: target_type
            .map(|kind| -> ApiResult<TargetDto> {
                Ok(TargetDto {
                    kind,
                    id: row.try_get("target_id")?,
                    name: row.try_get("target_name")?,
                })
            })
            .transpose()?,
        client_id: row.try_get("client_id")?,
        site_id: row.try_get("site_id")?,
        ip: row.try_get("ip")?,
        user_agent: row.try_get("user_agent")?,
        details: serde_json::from_str(&details).unwrap_or(Value::Null),
        hash: row.try_get("hash")?,
    })
}

const COLUMNS: &str =
    "SELECT id, at, actor_type, actor_id, actor_name, action, target_type, target_id, target_name,
    client_id, site_id, ip, user_agent, details, hash FROM audit_log";

/// `GET /api/v1/audit`
#[utoipa::path(get, path = "/api/v1/audit", tag = "Audit", summary = "List audit", responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn list(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<AuditQuery>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::AUDIT_VIEW)?;
    let filter = ctx.scope.client_filter(perm::AUDIT_VIEW);
    let limit = q.limit.unwrap_or(50).clamp(1, 500);
    let mut builder = QueryBuilder::<Sqlite>::new(COLUMNS);
    apply_filters(&mut builder, &q, &filter);
    if let Some(cursor) = q.cursor.as_deref().and_then(|c| c.parse::<i64>().ok()) {
        builder.push(" AND id < ").push_bind(cursor);
    }
    builder
        .push(" ORDER BY id DESC LIMIT ")
        .push_bind(limit + 1);
    let rows = builder.build().fetch_all(&state.db).await?;
    let mut items = rows.iter().map(row_to_dto).collect::<ApiResult<Vec<_>>>()?;
    let next_cursor = if items.len() as i64 > limit {
        items.truncate(limit as usize);
        items.last().map(|e| e.id.to_string())
    } else {
        None
    };
    Ok(Json(json!({ "items": items, "next_cursor": next_cursor })))
}

/// `POST /api/v1/audit/verify`
#[utoipa::path(post, path = "/api/v1/audit/verify", tag = "Audit", summary = "Verify", request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn verify(
    State(state): State<AppState>,
    ctx: AuthCtx,
) -> ApiResult<Json<crate::audit::VerifyResult>> {
    ctx.require_global(perm::AUDIT_VIEW)?;
    let result = crate::audit::verify(&state.db).await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("audit.verified")
                .details(json!({ "ok": result.ok, "checked": result.checked })),
        )
        .await;
    Ok(Json(result))
}

#[derive(Debug, Deserialize)]
pub struct ExportQuery {
    format: Option<String>,
    #[serde(flatten)]
    filters: AuditQuery,
}

/// `GET /api/v1/audit/export?format=csv|json`
#[utoipa::path(get, path = "/api/v1/audit/export", tag = "Audit", summary = "Export", responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn export(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<ExportQuery>,
) -> ApiResult<Response> {
    ctx.require(perm::AUDIT_EXPORT)?;
    let filter = ctx.scope.client_filter(perm::AUDIT_EXPORT);
    let format = q.format.as_deref().unwrap_or("csv");
    if format != "csv" && format != "json" {
        return Err(ApiError::bad_request("format must be csv or json"));
    }
    let mut builder = QueryBuilder::<Sqlite>::new(COLUMNS);
    apply_filters(&mut builder, &q.filters, &filter);
    builder.push(" ORDER BY id ASC LIMIT 200000");
    let rows = builder.build().fetch_all(&state.db).await?;
    let items = rows.iter().map(row_to_dto).collect::<ApiResult<Vec<_>>>()?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("audit.exported")
                .details(json!({ "format": format, "rows": items.len() })),
        )
        .await;

    let stamp = rustrmm_common::now().format("%Y%m%d-%H%M%S");
    let (body, content_type, ext) = if format == "json" {
        (
            serde_json::to_vec_pretty(&items)?,
            "application/json",
            "json",
        )
    } else {
        let mut out = String::from(
            "id,at,actor_type,actor_id,actor_name,action,target_type,target_id,target_name,client_id,site_id,ip,user_agent,details,hash\n",
        );
        for e in &items {
            let fields = [
                e.id.to_string(),
                e.at.clone(),
                e.actor.kind.clone(),
                e.actor.id.clone().unwrap_or_default(),
                e.actor.name.clone().unwrap_or_default(),
                e.action.clone(),
                e.target
                    .as_ref()
                    .map(|t| t.kind.clone())
                    .unwrap_or_default(),
                e.target
                    .as_ref()
                    .and_then(|t| t.id.clone())
                    .unwrap_or_default(),
                e.target
                    .as_ref()
                    .and_then(|t| t.name.clone())
                    .unwrap_or_default(),
                e.client_id.clone().unwrap_or_default(),
                e.site_id.clone().unwrap_or_default(),
                e.ip.clone().unwrap_or_default(),
                e.user_agent.clone().unwrap_or_default(),
                e.details.to_string(),
                e.hash.clone(),
            ];
            out.push_str(
                &fields
                    .iter()
                    .map(|f| csv_field(f))
                    .collect::<Vec<_>>()
                    .join(","),
            );
            out.push('\n');
        }
        (out.into_bytes(), "text/csv; charset=utf-8", "csv")
    };
    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, content_type.to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"rustrmm-audit-{stamp}.{ext}\""),
            ),
        ],
        Body::from(body),
    )
        .into_response())
}

/// CSV field with quoting, and a leading `'` for values that spreadsheets would treat as formulas.
fn csv_field(value: &str) -> String {
    let mut v = value.to_string();
    if v.starts_with(['=', '+', '-', '@', '\t', '\r']) {
        v.insert(0, '\'');
    }
    if v.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", v.replace('"', "\"\""))
    } else {
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_escaping_and_formula_guard() {
        assert_eq!(csv_field("plain"), "plain");
        assert_eq!(csv_field("a,b"), "\"a,b\"");
        assert_eq!(csv_field("say \"hi\""), "\"say \"\"hi\"\"\"");
        assert_eq!(csv_field("=cmd()"), "'=cmd()");
    }

    #[test]
    fn time_normalisation() {
        assert_eq!(normalise_time("2026-01-02"), "2026-01-02T00:00:00.000Z");
        assert_eq!(
            normalise_time("2026-01-02T03:04:05+02:00"),
            "2026-01-02T01:04:05.000Z"
        );
    }
}
