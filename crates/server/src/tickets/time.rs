//! Time entries (`/tickets/{id}/time`, `/time-entries`) with totals and CSV export.

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use chrono::{DateTime, NaiveDate, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{QueryBuilder, Sqlite};

use super::model;
use crate::auth::AuthCtx;
use crate::db::Db;
use crate::error::{ApiError, ApiResult};
use crate::rbac::perm;
use crate::state::AppState;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct EntryRow {
    pub id: String,
    pub ticket_id: String,
    pub ticket_number: i64,
    pub ticket_subject: String,
    pub client_id: String,
    pub client_name: String,
    pub site_id: Option<String>,
    pub user_id: Option<String>,
    pub user_name: String,
    pub started_at: DateTime<Utc>,
    pub minutes: i64,
    pub billable: bool,
    pub note: String,
    pub created_at: DateTime<Utc>,
}

impl EntryRow {
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id, "ticket_id": self.ticket_id, "ticket_number": self.ticket_number,
            "ticket_subject": self.ticket_subject, "client_id": self.client_id, "client_name": self.client_name,
            "user": { "id": self.user_id, "name": self.user_name }, "started_at": self.started_at,
            "minutes": self.minutes, "billable": self.billable, "note": self.note, "created_at": self.created_at,
        })
    }
}

const SELECT: &str = "SELECT te.id, te.ticket_id, t.number AS ticket_number, t.subject AS ticket_subject, t.client_id,
    c.name AS client_name, t.site_id, te.user_id, te.user_name, te.started_at, te.minutes, te.billable, te.note, te.created_at
    FROM time_entries te JOIN tickets t ON t.id = te.ticket_id JOIN clients c ON c.id = t.client_id";

pub async fn for_ticket(db: &Db, ticket_id: &str) -> anyhow::Result<Vec<Value>> {
    let rows: Vec<EntryRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{SELECT} WHERE te.ticket_id = ? ORDER BY te.started_at, te.id"
    )))
    .bind(ticket_id)
    .fetch_all(db)
    .await?;
    Ok(rows.iter().map(EntryRow::to_json).collect())
}

async fn load(db: &Db, id: &str) -> anyhow::Result<Option<EntryRow>> {
    Ok(
        sqlx::query_as(sqlx::AssertSqlSafe(format!("{SELECT} WHERE te.id = ?")))
            .bind(id)
            .fetch_optional(db)
            .await?,
    )
}

#[derive(Debug, Deserialize)]
pub struct EntryBody {
    #[serde(default)]
    started_at: Option<DateTime<Utc>>,
    minutes: i64,
    #[serde(default = "yes")]
    billable: bool,
    #[serde(default)]
    note: String,
}

fn yes() -> bool {
    true
}

impl EntryBody {
    fn validate(&mut self) -> ApiResult<DateTime<Utc>> {
        if !(1..=1440).contains(&self.minutes) {
            return Err(ApiError::validation("minutes must be between 1 and 1440"));
        }
        self.note = self.note.trim().to_string();
        if self.note.chars().count() > 2000 {
            return Err(ApiError::validation("note is at most 2000 characters"));
        }
        let now = rustrmm_common::now();
        let started = self
            .started_at
            .unwrap_or_else(|| now - chrono::Duration::minutes(self.minutes));
        if started > now + chrono::Duration::days(1) {
            return Err(ApiError::validation("started_at is in the future"));
        }
        Ok(started)
    }
}

/// `POST /api/v1/tickets/{id}/time`
#[utoipa::path(post, path = "/api/v1/tickets/{id}/time", tag = "Tickets", summary = "Create time", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn create(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(ticket_id): Path<String>,
    Json(mut body): Json<EntryBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    ctx.require(perm::TICKETS_TIME)?;
    let ticket = super::api::visible_ticket(&state, &ctx, &ticket_id, perm::TICKETS_TIME).await?;
    let started = body.validate()?;
    let id = rustrmm_common::new_id();
    let now = rustrmm_common::now();
    sqlx::query("INSERT INTO time_entries (id, ticket_id, user_id, user_name, started_at, minutes, billable, note, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(&id)
        .bind(&ticket.id)
        .bind(&ctx.user.id)
        .bind(&ctx.user.name)
        .bind(started)
        .bind(body.minutes)
        .bind(body.billable)
        .bind(&body.note)
        .bind(now)
        .bind(now)
        .execute(&state.db)
        .await?;
    model::activity(
        &state.db,
        &ticket.id,
        &model::Who::user(&ctx),
        "time_logged",
        None,
        Some(&format!("{} min", body.minutes)),
    )
    .await?;
    state.events.publish(
        "ticket.updated",
        Some(ticket.client_id.clone()),
        json!({ "ticket_id": ticket.id, "changes": { "time_entries": { "from": null, "to": id } } }),
    );
    let row = load(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("Time entry"))?;
    Ok((StatusCode::CREATED, Json(row.to_json())))
}

async fn editable(state: &AppState, ctx: &AuthCtx, id: &str) -> ApiResult<EntryRow> {
    ctx.require(perm::TICKETS_TIME)?;
    let row = load(&state.db, id)
        .await?
        .filter(|e| {
            super::visible(
                &ctx.scope,
                perm::TICKETS_TIME,
                &e.client_id,
                e.site_id.as_deref(),
            )
        })
        .ok_or_else(|| ApiError::not_found("Time entry"))?;
    let own = row.user_id.as_deref() == Some(ctx.user.id.as_str());
    if !own && !ctx.scope.can_client(perm::TICKETS_SETTINGS, &row.client_id) {
        return Err(ApiError::forbidden(
            "Only your own time entries can be changed",
        ));
    }
    Ok(row)
}

/// `PUT /api/v1/time-entries/{id}`
#[utoipa::path(put, path = "/api/v1/time-entries/{id}", tag = "Tickets", summary = "Update time entrie", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn update(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(mut body): Json<EntryBody>,
) -> ApiResult<Json<Value>> {
    let row = editable(&state, &ctx, &id).await?;
    if body.started_at.is_none() {
        body.started_at = Some(row.started_at);
    }
    let started = body.validate()?;
    sqlx::query("UPDATE time_entries SET started_at = ?, minutes = ?, billable = ?, note = ?, updated_at = ? WHERE id = ?")
        .bind(started)
        .bind(body.minutes)
        .bind(body.billable)
        .bind(&body.note)
        .bind(rustrmm_common::now())
        .bind(&id)
        .execute(&state.db)
        .await?;
    let row = load(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("Time entry"))?;
    Ok(Json(row.to_json()))
}

/// `DELETE /api/v1/time-entries/{id}`
#[utoipa::path(delete, path = "/api/v1/time-entries/{id}", tag = "Tickets", summary = "Delete time entrie", params(("id" = String, Path)), responses((status = 204, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn delete(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let row = editable(&state, &ctx, &id).await?;
    sqlx::query("DELETE FROM time_entries WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;
    model::activity(
        &state.db,
        &row.ticket_id,
        &model::Who::user(&ctx),
        "time_deleted",
        Some(&format!("{} min", row.minutes)),
        None,
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Parses `YYYY-MM-DD` (start of that UTC day, or the start of the next day for an end bound)
/// or an RFC 3339 time.
pub fn parse_bound(text: &str, end: bool) -> Option<DateTime<Utc>> {
    let text = text.trim();
    if let Ok(date) = NaiveDate::parse_from_str(text, "%Y-%m-%d") {
        let date = if end { date.succ_opt()? } else { date };
        return Some(date.and_hms_opt(0, 0, 0)?.and_utc());
    }
    DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|t| t.with_timezone(&Utc))
}

#[derive(Debug, Default, Deserialize)]
pub struct ListQuery {
    client_id: Option<String>,
    user_id: Option<String>,
    ticket_id: Option<String>,
    from: Option<String>,
    to: Option<String>,
    billable: Option<bool>,
    format: Option<String>,
}

/// Escapes one CSV cell (and defuses spreadsheet formulas).
pub fn csv_cell(value: &str) -> String {
    let value = if value.starts_with(['=', '+', '-', '@', '\t', '\r']) {
        format!("'{value}")
    } else {
        value.to_string()
    };
    if value.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value
    }
}

/// `GET /api/v1/time-entries?client_id=&user_id=&from=&to=&billable=&format=csv`
#[utoipa::path(get, path = "/api/v1/time-entries", tag = "Tickets", summary = "List time entries", responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn list(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<ListQuery>,
) -> ApiResult<Response> {
    ctx.require(perm::TICKETS_TIME)?;
    let mut qb = QueryBuilder::<Sqlite>::new(format!("{SELECT} WHERE 1 = 1"));
    super::push_scope(&mut qb, &ctx.scope, perm::TICKETS_TIME, "t");
    super::push_in(&mut qb, "t.client_id", &super::csv_param(&q.client_id));
    super::push_in(&mut qb, "te.user_id", &super::csv_param(&q.user_id));
    super::push_in(&mut qb, "te.ticket_id", &super::csv_param(&q.ticket_id));
    if let Some(from) = q.from.as_deref().filter(|s| !s.is_empty()) {
        let from = parse_bound(from, false)
            .ok_or_else(|| ApiError::validation("from must be YYYY-MM-DD or RFC 3339"))?;
        qb.push(" AND te.started_at >= ").push_bind(from);
    }
    if let Some(to) = q.to.as_deref().filter(|s| !s.is_empty()) {
        let to = parse_bound(to, true)
            .ok_or_else(|| ApiError::validation("to must be YYYY-MM-DD or RFC 3339"))?;
        qb.push(" AND te.started_at < ").push_bind(to);
    }
    if let Some(b) = q.billable {
        qb.push(" AND te.billable = ").push_bind(b);
    }
    qb.push(" ORDER BY te.started_at DESC, te.id LIMIT 20000");
    let rows: Vec<EntryRow> = qb.build_query_as().fetch_all(&state.db).await?;

    if q.format.as_deref() == Some("csv") {
        let mut out =
            String::from("date,started_at,client,ticket,subject,user,minutes,billable,note\r\n");
        for r in &rows {
            let cells = [
                r.started_at.format("%Y-%m-%d").to_string(),
                r.started_at.to_rfc3339(),
                r.client_name.clone(),
                format!("#{}", r.ticket_number),
                r.ticket_subject.clone(),
                r.user_name.clone(),
                r.minutes.to_string(),
                if r.billable { "yes" } else { "no" }.to_string(),
                r.note.clone(),
            ];
            out.push_str(
                &cells
                    .iter()
                    .map(|c| csv_cell(c))
                    .collect::<Vec<_>>()
                    .join(","),
            );
            out.push_str("\r\n");
        }
        return Ok((
            [
                (header::CONTENT_TYPE, "text/csv; charset=utf-8"),
                (
                    header::CONTENT_DISPOSITION,
                    "attachment; filename=\"time-entries.csv\"",
                ),
            ],
            out,
        )
            .into_response());
    }

    let mut by_client: Vec<(String, String, i64, i64)> = Vec::new();
    let mut by_user: Vec<(Option<String>, String, i64, i64)> = Vec::new();
    let (mut minutes, mut billable) = (0i64, 0i64);
    for r in &rows {
        let b = if r.billable { r.minutes } else { 0 };
        minutes += r.minutes;
        billable += b;
        match by_client.iter_mut().find(|c| c.0 == r.client_id) {
            Some(c) => {
                c.2 += r.minutes;
                c.3 += b;
            }
            None => by_client.push((r.client_id.clone(), r.client_name.clone(), r.minutes, b)),
        }
        match by_user.iter_mut().find(|u| u.0 == r.user_id) {
            Some(u) => {
                u.2 += r.minutes;
                u.3 += b;
            }
            None => by_user.push((r.user_id.clone(), r.user_name.clone(), r.minutes, b)),
        }
    }
    by_client.sort_by(|a, b| b.2.cmp(&a.2).then(a.1.cmp(&b.1)));
    by_user.sort_by(|a, b| b.2.cmp(&a.2).then(a.1.cmp(&b.1)));
    Ok(Json(json!({
        "items": rows.iter().map(EntryRow::to_json).collect::<Vec<_>>(),
        "totals": {
            "minutes": minutes, "billable_minutes": billable,
            "by_client": by_client.iter().map(|(id, name, m, b)| json!({ "client_id": id, "client_name": name, "minutes": m, "billable_minutes": b })).collect::<Vec<_>>(),
            "by_user": by_user.iter().map(|(id, name, m, b)| json!({ "user_id": id, "user_name": name, "minutes": m, "billable_minutes": b })).collect::<Vec<_>>(),
        },
    }))
    .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_cells_and_bounds() {
        assert_eq!(csv_cell("plain"), "plain");
        assert_eq!(csv_cell("a,b"), "\"a,b\"");
        assert_eq!(csv_cell("say \"hi\""), "\"say \"\"hi\"\"\"");
        assert_eq!(csv_cell("=SUM(A1)"), "'=SUM(A1)");
        assert_eq!(
            parse_bound("2026-11-20", false).map(|t| t.to_rfc3339()),
            Some("2026-11-20T00:00:00+00:00".into())
        );
        assert_eq!(
            parse_bound("2026-11-20", true).map(|t| t.to_rfc3339()),
            Some("2026-11-21T00:00:00+00:00".into())
        );
        assert!(parse_bound("2026-11-20T10:00:00Z", false).is_some());
        assert!(parse_bound("yesterday", false).is_none());
    }
}
