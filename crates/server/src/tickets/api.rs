//! Ticket routes: list, create, read, update, merge, links, bulk actions, device tickets,
//! statistics and delete.

use std::collections::HashMap;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{QueryBuilder, Sqlite};

use super::model::{self, Changes, NewTicket, TicketRow, Who};
use super::{
    ACTIVE_STATUSES, PRIORITIES, STATUSES, TYPES, clean_cc, clean_tags, csv_param, push_in,
};
use crate::auth::AuthCtx;
use crate::error::{ApiError, ApiResult};
use crate::rbac::perm;
use crate::state::AppState;

fn missing(permission: &str) -> ApiError {
    ApiError::forbidden(format!("Missing permission: {permission}"))
        .with_details(json!({ "permission": permission }))
}

/// Loads a ticket the caller can see (404 otherwise) and checks `permission` on it (403).
pub async fn visible_ticket(
    state: &AppState,
    ctx: &AuthCtx,
    id: &str,
    permission: &str,
) -> ApiResult<TicketRow> {
    let ticket = model::load(&state.db, id)
        .await?
        .filter(|t| t.visible(&ctx.scope, perm::TICKETS_VIEW) || t.visible(&ctx.scope, permission))
        .ok_or_else(|| ApiError::not_found("Ticket"))?;
    if !ticket.visible(&ctx.scope, permission) {
        return Err(missing(permission));
    }
    Ok(ticket)
}

fn can_manage_place(ctx: &AuthCtx, client_id: &str, site_id: Option<&str>) -> bool {
    super::visible(&ctx.scope, perm::TICKETS_MANAGE, client_id, site_id)
}

// ------------------------------------------------------------------ list

#[derive(Debug, Default, Deserialize)]
pub struct ListQuery {
    status: Option<String>,
    priority: Option<String>,
    queue_id: Option<String>,
    assignee: Option<String>,
    client_id: Option<String>,
    site_id: Option<String>,
    device_id: Option<String>,
    /// Comma-separated contact ids.
    contact_id: Option<String>,
    #[serde(rename = "type")]
    kind: Option<String>,
    source: Option<String>,
    tag: Option<String>,
    q: Option<String>,
    sla: Option<String>,
    sort: Option<String>,
    cursor: Option<String>,
    limit: Option<i64>,
}

const LIST_FROM: &str = " FROM tickets t JOIN clients c ON c.id = t.client_id LEFT JOIN contacts ct ON ct.id = t.contact_id";

/// Filters shared by the list and its counts (everything except `status`).
fn push_filters(qb: &mut QueryBuilder<Sqlite>, ctx: &AuthCtx, q: &ListQuery) -> ApiResult<()> {
    super::push_scope(qb, &ctx.scope, perm::TICKETS_VIEW, "t");
    push_in(qb, "t.priority", &csv_param(&q.priority));
    push_in(qb, "t.queue_id", &csv_param(&q.queue_id));
    push_in(qb, "t.client_id", &csv_param(&q.client_id));
    push_in(qb, "t.site_id", &csv_param(&q.site_id));
    push_in(qb, "t.contact_id", &csv_param(&q.contact_id));
    push_in(qb, "t.type", &csv_param(&q.kind));
    push_in(qb, "t.source", &csv_param(&q.source));
    let devices = csv_param(&q.device_id);
    if !devices.is_empty() {
        qb.push(" AND t.id IN (SELECT ticket_id FROM ticket_links WHERE kind = 'device'");
        push_in(qb, "target_id", &devices);
        qb.push(")");
    }
    if let Some(tag) = q.tag.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        qb.push(" AND EXISTS (SELECT 1 FROM json_each(t.tags) WHERE value = ")
            .push_bind(tag.to_string())
            .push(" COLLATE NOCASE)");
    }
    match q.assignee.as_deref() {
        None | Some("") => {}
        Some("me") => {
            qb.push(" AND t.assignee_id = ")
                .push_bind(ctx.user.id.clone());
        }
        Some("none") => {
            qb.push(" AND t.assignee_id IS NULL");
        }
        Some(user) => {
            qb.push(" AND t.assignee_id = ").push_bind(user.to_string());
        }
    }
    let now = rustrmm_common::now();
    match q.sla.as_deref() {
        None | Some("") => {}
        Some("breached") => {
            qb.push(" AND (t.first_response_breached = 1 OR t.resolution_breached = 1)");
        }
        Some("due_soon") => {
            let soon = now + Duration::minutes(60);
            qb.push(" AND t.sla_paused_at IS NULL AND t.status IN ('new', 'open', 'pending', 'on_hold') AND ((t.first_response_at IS NULL AND t.first_response_breached = 0 AND t.first_response_due <= ")
                .push_bind(soon)
                .push(") OR (t.resolved_at IS NULL AND t.resolution_breached = 0 AND t.resolution_due <= ")
                .push_bind(soon)
                .push("))");
        }
        Some(_) => return Err(ApiError::validation("sla must be breached or due_soon")),
    }
    if let Some(text) = q.q.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        let like = super::like_pattern(text);
        qb.push(" AND (t.subject LIKE ")
            .push_bind(like.clone())
            .push(" ESCAPE '\\' OR t.description LIKE ")
            .push_bind(like.clone())
            .push(" ESCAPE '\\' OR c.name LIKE ")
            .push_bind(like.clone())
            .push(" ESCAPE '\\' OR ct.name LIKE ")
            .push_bind(like.clone())
            .push(" ESCAPE '\\' OR ct.email LIKE ")
            .push_bind(like)
            .push(" ESCAPE '\\'");
        if let Ok(number) = text.trim_start_matches('#').parse::<i64>() {
            qb.push(" OR t.number = ").push_bind(number);
        }
        qb.push(")");
    }
    Ok(())
}

async fn list_tickets(state: &AppState, ctx: &AuthCtx, q: &ListQuery) -> ApiResult<Value> {
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let offset: i64 = q
        .cursor
        .as_deref()
        .and_then(|c| c.parse().ok())
        .unwrap_or(0)
        .max(0);
    let statuses = {
        let s = csv_param(&q.status);
        if s.is_empty() {
            ACTIVE_STATUSES.iter().map(|s| s.to_string()).collect()
        } else if s.iter().any(|x| x == "all") {
            Vec::new()
        } else {
            s
        }
    };
    let mut qb = QueryBuilder::<Sqlite>::new(format!("{} WHERE 1 = 1", model::TICKET_SELECT));
    push_filters(&mut qb, ctx, q)?;
    push_in(&mut qb, "t.status", &statuses);
    let order = match q.sort.as_deref().unwrap_or("last_activity") {
        "last_activity" => "t.last_activity_at DESC",
        "created" => "t.created_at DESC",
        "oldest" => "t.created_at ASC",
        "updated" => "t.updated_at DESC",
        "number" => "t.number DESC",
        "priority" => {
            "CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, t.last_activity_at DESC"
        }
        "due" => "t.resolution_due IS NULL, t.resolution_due ASC",
        _ => {
            return Err(ApiError::validation(
                "sort must be last_activity, created, oldest, updated, number, priority or due",
            ));
        }
    };
    qb.push(format!(" ORDER BY {order}, t.id DESC LIMIT "))
        .push_bind(limit + 1)
        .push(" OFFSET ")
        .push_bind(offset);
    let mut rows: Vec<TicketRow> = qb.build_query_as().fetch_all(&state.db).await?;
    let next_cursor = (rows.len() as i64 > limit).then(|| (offset + limit).to_string());
    rows.truncate(limit as usize);
    let items = model::hydrate(&state.db, &rows).await?;

    // Counts over the same filters (every status; the active-only counters say so).
    let soon = rustrmm_common::now() + Duration::minutes(60);
    let mut cq = QueryBuilder::<Sqlite>::new(
        "SELECT COALESCE(SUM(t.status = 'new'), 0), COALESCE(SUM(t.status = 'open'), 0),
                COALESCE(SUM(t.status = 'pending'), 0), COALESCE(SUM(t.status = 'on_hold'), 0),
                COALESCE(SUM(t.status IN ('new', 'open', 'pending', 'on_hold') AND t.assignee_id = ",
    );
    cq.push_bind(ctx.user.id.clone());
    cq.push(
        "), 0), COALESCE(SUM(t.status IN ('new', 'open', 'pending', 'on_hold') AND t.assignee_id IS NULL), 0),
                COALESCE(SUM(t.status IN ('new', 'open', 'pending', 'on_hold')
                             AND (t.first_response_breached = 1 OR t.resolution_breached = 1)), 0),
                COALESCE(SUM(t.status = 'resolved'), 0),
                COALESCE(SUM(t.status IN ('new', 'open', 'pending', 'on_hold') AND t.sla_paused_at IS NULL
                             AND ((t.first_response_at IS NULL AND t.first_response_breached = 0 AND t.first_response_due <= ",
    );
    cq.push_bind(soon);
    cq.push(") OR (t.resolved_at IS NULL AND t.resolution_breached = 0 AND t.resolution_due <= ");
    cq.push_bind(soon);
    cq.push("))), 0)");
    cq.push(LIST_FROM);
    cq.push(" WHERE t.status IN ('new', 'open', 'pending', 'on_hold', 'resolved')");
    push_filters(&mut cq, ctx, q)?;
    let (new, open, pending, on_hold, mine, unassigned, breached, resolved, due_soon): (
        i64,
        i64,
        i64,
        i64,
        i64,
        i64,
        i64,
        i64,
        i64,
    ) = cq.build_query_as().fetch_one(&state.db).await?;
    Ok(json!({
        "items": items,
        "next_cursor": next_cursor,
        "counts": { "new": new, "open": open, "pending": pending, "on_hold": on_hold, "mine": mine,
                    "unassigned": unassigned, "breached": breached, "resolved": resolved, "due_soon": due_soon },
    }))
}

/// `GET /api/v1/tickets`
#[utoipa::path(get, path = "/api/v1/tickets", tag = "Tickets", summary = "List tickets", responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn list(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::TICKETS_VIEW)?;
    Ok(Json(list_tickets(&state, &ctx, &q).await?))
}

#[derive(Debug, Default, Deserialize)]
pub struct DeviceTicketsQuery {
    status: Option<String>,
    cursor: Option<String>,
    limit: Option<i64>,
}

/// `GET /api/v1/devices/{id}/tickets` (every status unless `status` is given).
#[utoipa::path(get, path = "/api/v1/devices/{id}/tickets", tag = "Tickets", summary = "Device tickets", params(("id" = String, Path)), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn device_tickets(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Query(dq): Query<DeviceTicketsQuery>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::TICKETS_VIEW)?;
    crate::monitoring::device_scope(&state, &ctx, &id, perm::TICKETS_VIEW).await?;
    let q = ListQuery {
        status: Some(dq.status.unwrap_or_else(|| "all".into())),
        device_id: Some(id),
        cursor: dq.cursor,
        limit: dq.limit,
        ..ListQuery::default()
    };
    Ok(Json(list_tickets(&state, &ctx, &q).await?))
}

// ------------------------------------------------------------------ create and read

#[derive(Debug, Deserialize)]
pub struct CreateBody {
    subject: String,
    #[serde(default)]
    description: String,
    client_id: String,
    #[serde(default)]
    site_id: Option<String>,
    #[serde(default)]
    contact_id: Option<String>,
    #[serde(default)]
    priority: Option<String>,
    #[serde(default, rename = "type")]
    kind: Option<String>,
    #[serde(default)]
    queue_id: Option<String>,
    #[serde(default)]
    assignee_id: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    cc: Vec<String>,
    #[serde(default)]
    device_ids: Vec<String>,
    #[serde(default)]
    alert_ids: Vec<String>,
}

pub fn validate_subject(subject: &str) -> ApiResult<String> {
    let subject = subject.trim().to_string();
    if subject.is_empty() || subject.chars().count() > 200 || subject.contains(['\r', '\n']) {
        return Err(ApiError::validation(
            "subject must be 1–200 characters on one line",
        ));
    }
    Ok(subject)
}

fn validate_description(description: &str) -> ApiResult<()> {
    if description.chars().count() > 100_000 {
        return Err(ApiError::validation(
            "description is at most 100000 characters",
        ));
    }
    Ok(())
}

pub async fn check_site(state: &AppState, client_id: &str, site_id: &str) -> ApiResult<()> {
    let ok: Option<String> =
        sqlx::query_scalar("SELECT id FROM sites WHERE id = ? AND client_id = ?")
            .bind(site_id)
            .bind(client_id)
            .fetch_optional(&state.db)
            .await?;
    ok.map(|_| ())
        .ok_or_else(|| ApiError::validation("site_id is not a site of the ticket's client"))
}

async fn check_contact(state: &AppState, client_id: &str, contact_id: &str) -> ApiResult<()> {
    let ok: Option<String> =
        sqlx::query_scalar("SELECT id FROM contacts WHERE id = ? AND client_id = ?")
            .bind(contact_id)
            .bind(client_id)
            .fetch_optional(&state.db)
            .await?;
    ok.map(|_| ())
        .ok_or_else(|| ApiError::validation("contact_id is not a contact of the ticket's client"))
}

pub async fn check_queue(state: &AppState, queue_id: &str) -> ApiResult<()> {
    super::queues::row(&state.db, queue_id)
        .await?
        .map(|_| ())
        .ok_or_else(|| ApiError::validation("Unknown queue"))
}

pub async fn check_assignee(state: &AppState, user_id: &str) -> ApiResult<()> {
    let ok: Option<String> =
        sqlx::query_scalar("SELECT id FROM users WHERE id = ? AND status = 'active'")
            .bind(user_id)
            .fetch_optional(&state.db)
            .await?;
    ok.map(|_| ())
        .ok_or_else(|| ApiError::validation("Unknown or inactive assignee"))
}

fn check_enum(value: &str, allowed: &[&str], field: &str) -> ApiResult<()> {
    if allowed.contains(&value) {
        Ok(())
    } else {
        Err(ApiError::validation(format!(
            "{field} must be one of {}",
            allowed.join(", ")
        )))
    }
}

/// Devices and alerts must belong to the ticket's client.
async fn check_targets(
    state: &AppState,
    client_id: &str,
    device_ids: &[String],
    alert_ids: &[String],
) -> ApiResult<()> {
    for id in device_ids {
        let client: Option<String> = sqlx::query_scalar(
            "SELECT s.client_id FROM devices d JOIN sites s ON s.id = d.site_id WHERE d.id = ?",
        )
        .bind(id)
        .fetch_optional(&state.db)
        .await?;
        if client.as_deref() != Some(client_id) {
            return Err(ApiError::validation(format!(
                "device {id} is not a device of the ticket's client"
            )));
        }
    }
    for id in alert_ids {
        let client: Option<String> =
            sqlx::query_scalar("SELECT client_id FROM alerts WHERE id = ?")
                .bind(id)
                .fetch_optional(&state.db)
                .await?;
        if client.as_deref() != Some(client_id) {
            return Err(ApiError::validation(format!(
                "alert {id} is not an alert of the ticket's client"
            )));
        }
    }
    Ok(())
}

/// `POST /api/v1/tickets`
#[utoipa::path(post, path = "/api/v1/tickets", tag = "Tickets", summary = "Create ticket", request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn create(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Json(body): Json<CreateBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    ctx.require(perm::TICKETS_MANAGE)?;
    let subject = validate_subject(&body.subject)?;
    validate_description(&body.description)?;
    let exists: Option<String> = sqlx::query_scalar("SELECT id FROM clients WHERE id = ?")
        .bind(&body.client_id)
        .fetch_optional(&state.db)
        .await?;
    if exists.is_none()
        || !ctx
            .scope
            .can_see_client(perm::TICKETS_VIEW, &body.client_id)
            && !ctx
                .scope
                .can_see_client(perm::TICKETS_MANAGE, &body.client_id)
    {
        return Err(ApiError::not_found("Client"));
    }
    let site_id = body.site_id.clone().filter(|s| !s.is_empty());
    if let Some(site) = &site_id {
        check_site(&state, &body.client_id, site).await?;
    }
    if !can_manage_place(&ctx, &body.client_id, site_id.as_deref()) {
        return Err(missing(perm::TICKETS_MANAGE));
    }
    let contact_id = body.contact_id.clone().filter(|s| !s.is_empty());
    if let Some(contact) = &contact_id {
        check_contact(&state, &body.client_id, contact).await?;
    }
    if let Some(p) = &body.priority {
        check_enum(p, &PRIORITIES, "priority")?;
    }
    let kind = body.kind.clone().unwrap_or_else(|| "incident".into());
    check_enum(&kind, &TYPES, "type")?;
    let queue_id = body.queue_id.clone().filter(|s| !s.is_empty());
    if let Some(q) = &queue_id {
        check_queue(&state, q).await?;
    }
    let assignee_id = body.assignee_id.clone().filter(|s| !s.is_empty());
    if let Some(a) = &assignee_id {
        check_assignee(&state, a).await?;
    }
    let tags = clean_tags(&body.tags).map_err(ApiError::validation)?;
    let cc = clean_cc(&body.cc).map_err(ApiError::validation)?;
    if body.device_ids.len() > 50 || body.alert_ids.len() > 50 {
        return Err(ApiError::validation("at most 50 devices and 50 alerts"));
    }
    check_targets(&state, &body.client_id, &body.device_ids, &body.alert_ids).await?;
    let row = model::create(
        &state,
        NewTicket {
            subject,
            description: body.description,
            client_id: body.client_id,
            site_id,
            contact_id,
            priority: body.priority,
            kind,
            queue_id,
            assignee_id,
            tags,
            cc,
            source: "console",
            device_ids: body.device_ids,
            alert_ids: body.alert_ids,
            ..NewTicket::default()
        },
        &Who::user(&ctx),
    )
    .await?;
    Ok((
        StatusCode::CREATED,
        Json(model::ticket_json(&state.db, &row).await?),
    ))
}

/// `GET /api/v1/tickets/{id}`
#[utoipa::path(get, path = "/api/v1/tickets/{id}", tag = "Tickets", summary = "Get ticket", params(("id" = String, Path)), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn get(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::TICKETS_VIEW)?;
    let ticket = visible_ticket(&state, &ctx, &id, perm::TICKETS_VIEW).await?;
    Ok(Json(json!({
        "ticket": model::ticket_json(&state.db, &ticket).await?,
        "comments": model::load_comments(&state.db, &ticket.id).await?,
        "activity": model::load_activity(&state.db, &ticket.id).await?,
        "time_entries": super::time::for_ticket(&state.db, &ticket.id).await?,
    })))
}

// ------------------------------------------------------------------ update

fn double_option<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<Option<String>>, D::Error> {
    Ok(Some(Option::<String>::deserialize(d)?))
}

#[derive(Debug, Default, Deserialize)]
pub struct PatchBody {
    #[serde(default)]
    subject: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    priority: Option<String>,
    #[serde(default, rename = "type")]
    kind: Option<String>,
    #[serde(default)]
    queue_id: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    assignee_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    contact_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    site_id: Option<Option<String>>,
    #[serde(default)]
    client_id: Option<String>,
    #[serde(default)]
    tags: Option<Vec<String>>,
    #[serde(default)]
    cc: Option<Vec<String>>,
}

/// Validates a patch against the ticket and turns it into [`Changes`].
async fn changes_for(
    state: &AppState,
    ctx: &AuthCtx,
    t: &TicketRow,
    body: PatchBody,
) -> ApiResult<Changes> {
    let mut ch = Changes::default();
    if let Some(s) = body.subject {
        ch.subject = Some(validate_subject(&s)?);
    }
    if let Some(d) = body.description {
        validate_description(&d)?;
        ch.description = Some(d);
    }
    if let Some(s) = body.status {
        check_enum(&s, &STATUSES, "status")?;
        ch.status = Some(s);
    }
    if let Some(p) = body.priority {
        check_enum(&p, &PRIORITIES, "priority")?;
        ch.priority = Some(p);
    }
    if let Some(k) = body.kind {
        check_enum(&k, &TYPES, "type")?;
        ch.kind = Some(k);
    }
    if let Some(q) = body.queue_id.filter(|q| !q.is_empty()) {
        check_queue(state, &q).await?;
        ch.queue_id = Some(q);
    }
    if let Some(a) = body.assignee_id {
        let a = a.filter(|a| !a.is_empty());
        if let Some(user) = &a {
            check_assignee(state, user).await?;
        }
        ch.assignee_id = Some(a);
    }
    let client_id = match body
        .client_id
        .filter(|c| !c.is_empty() && *c != t.client_id)
    {
        Some(c) => {
            let exists: Option<String> = sqlx::query_scalar("SELECT id FROM clients WHERE id = ?")
                .bind(&c)
                .fetch_optional(&state.db)
                .await?;
            if exists.is_none() {
                return Err(ApiError::validation("Unknown client"));
            }
            ch.client_id = Some(c.clone());
            c
        }
        None => t.client_id.clone(),
    };
    let site_id = match body.site_id {
        Some(s) => s.filter(|s| !s.is_empty()),
        None if ch.client_id.is_some() => None,
        None => t.site_id.clone(),
    };
    if let Some(site) = &site_id {
        check_site(state, &client_id, site).await?;
    }
    if site_id != t.site_id {
        ch.site_id = Some(site_id.clone());
    }
    let contact_id = match body.contact_id {
        Some(c) => c.filter(|c| !c.is_empty()),
        None if ch.client_id.is_some() => None,
        None => t.contact_id.clone(),
    };
    if let Some(contact) = &contact_id {
        check_contact(state, &client_id, contact).await?;
    }
    if contact_id != t.contact_id {
        ch.contact_id = Some(contact_id);
    }
    if (ch.client_id.is_some() || ch.site_id.is_some())
        && !can_manage_place(ctx, &client_id, site_id.as_deref())
    {
        return Err(missing(perm::TICKETS_MANAGE));
    }
    if let Some(tags) = body.tags {
        ch.tags = Some(clean_tags(&tags).map_err(ApiError::validation)?);
    }
    if let Some(cc) = body.cc {
        ch.cc = Some(clean_cc(&cc).map_err(ApiError::validation)?);
    }
    Ok(ch)
}

/// `PATCH /api/v1/tickets/{id}` → the updated Ticket.
#[utoipa::path(patch, path = "/api/v1/tickets/{id}", tag = "Tickets", summary = "Update ticket", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn update(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(body): Json<PatchBody>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::TICKETS_MANAGE)?;
    let ticket = visible_ticket(&state, &ctx, &id, perm::TICKETS_MANAGE).await?;
    let changes = changes_for(&state, &ctx, &ticket, body).await?;
    model::apply_changes(&state, &ticket, changes, &Who::user(&ctx)).await?;
    let row = model::load(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("Ticket"))?;
    Ok(Json(model::ticket_json(&state.db, &row).await?))
}

// ------------------------------------------------------------------ merge

#[derive(Debug, Deserialize)]
pub struct MergeBody {
    into_ticket_id: String,
}

/// `POST /api/v1/tickets/{id}/merge`: comments, attachments, time, links and e-mail threads
/// move to the target; this ticket is closed with `merged_into` set.
#[utoipa::path(post, path = "/api/v1/tickets/{id}/merge", tag = "Tickets", summary = "Merge", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn merge(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(body): Json<MergeBody>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::TICKETS_MANAGE)?;
    let source = visible_ticket(&state, &ctx, &id, perm::TICKETS_MANAGE).await?;
    let target = visible_ticket(&state, &ctx, &body.into_ticket_id, perm::TICKETS_MANAGE).await?;
    if source.id == target.id {
        return Err(ApiError::validation(
            "a ticket cannot be merged into itself",
        ));
    }
    if source.client_id != target.client_id {
        return Err(ApiError::validation(
            "tickets of different clients cannot be merged",
        ));
    }
    if source.merged_into.is_some() {
        return Err(ApiError::conflict(
            "already_merged",
            "This ticket was already merged",
        ));
    }
    if target.merged_into.is_some() {
        return Err(ApiError::conflict(
            "already_merged",
            "The target ticket was merged into another ticket",
        ));
    }
    let db = &state.db;
    let mut tx = db.begin().await?;
    for table in [
        "ticket_comments",
        "ticket_attachments",
        "time_entries",
        "email_threads",
    ] {
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "UPDATE {table} SET ticket_id = ? WHERE ticket_id = ?"
        )))
        .bind(&target.id)
        .bind(&source.id)
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query(
        "INSERT OR IGNORE INTO ticket_links (ticket_id, kind, target_id, created_at)
         SELECT ?, kind, target_id, created_at FROM ticket_links
         WHERE ticket_id = ? AND NOT (kind = 'ticket' AND target_id = ?)",
    )
    .bind(&target.id)
    .bind(&source.id)
    .bind(&target.id)
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM ticket_links WHERE ticket_id = ?")
        .bind(&source.id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE alerts SET ticket_id = ? WHERE ticket_id = ?")
        .bind(&target.id)
        .bind(&source.id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE tickets SET merged_into = ? WHERE id = ?")
        .bind(&target.id)
        .bind(&source.id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    model::link(db, &target.id, "ticket", &source.id).await?;
    let who = Who::user(&ctx);
    if let Some(fresh) = model::load(db, &source.id).await? {
        model::apply_changes(
            &state,
            &fresh,
            Changes {
                status: Some("closed".into()),
                ..Changes::default()
            },
            &who,
        )
        .await?;
    }
    model::activity(
        db,
        &source.id,
        &who,
        "merged",
        None,
        Some(&format!("#{}", target.number)),
    )
    .await?;
    model::activity(
        db,
        &target.id,
        &who,
        "merged",
        Some(&format!("#{}", source.number)),
        None,
    )
    .await?;
    state.events.publish(
        "ticket.updated",
        Some(target.client_id.clone()),
        json!({ "ticket_id": target.id, "changes": { "merged_from": { "from": null, "to": source.id } } }),
    );
    state
        .audit
        .record_or_log(
            db,
            ctx.audit("ticket.merged")
                .target("ticket", &source.id, format!("#{} {}", source.number, source.subject))
                .client(&source.client_id)
                .details(json!({ "from": source.number, "into": target.number, "into_ticket_id": target.id })),
        )
        .await;
    let row = model::load(db, &target.id)
        .await?
        .ok_or_else(|| ApiError::not_found("Ticket"))?;
    Ok(Json(
        json!({ "ticket": model::ticket_json(db, &row).await? }),
    ))
}

// ------------------------------------------------------------------ links

#[derive(Debug, Default, Deserialize)]
pub struct LinksBody {
    #[serde(default)]
    device_ids: Vec<String>,
    #[serde(default)]
    alert_ids: Vec<String>,
    #[serde(default)]
    ticket_ids: Vec<String>,
}

async fn change_links(
    state: AppState,
    ctx: AuthCtx,
    id: String,
    body: LinksBody,
    add: bool,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::TICKETS_MANAGE)?;
    let ticket = visible_ticket(&state, &ctx, &id, perm::TICKETS_MANAGE).await?;
    if body.device_ids.len() + body.alert_ids.len() + body.ticket_ids.len() > 100 {
        return Err(ApiError::validation("at most 100 links per request"));
    }
    let db = &state.db;
    let who = Who::user(&ctx);
    if add {
        check_targets(&state, &ticket.client_id, &body.device_ids, &body.alert_ids).await?;
    }
    for device in &body.device_ids {
        let hostname: Option<String> =
            sqlx::query_scalar("SELECT hostname FROM devices WHERE id = ?")
                .bind(device)
                .fetch_optional(db)
                .await?;
        let label = format!("device {}", hostname.unwrap_or_else(|| device.clone()));
        if add {
            if model::link(db, &ticket.id, "device", device).await? {
                model::activity(db, &ticket.id, &who, "linked", None, Some(&label)).await?;
            }
        } else if unlink(db, &ticket.id, "device", device).await? {
            model::activity(db, &ticket.id, &who, "unlinked", Some(&label), None).await?;
        }
    }
    for alert in &body.alert_ids {
        let title: Option<String> = sqlx::query_scalar("SELECT title FROM alerts WHERE id = ?")
            .bind(alert)
            .fetch_optional(db)
            .await?;
        let label = format!("alert {}", title.unwrap_or_else(|| alert.clone()));
        if add {
            if model::link(db, &ticket.id, "alert", alert).await? {
                let claimed = sqlx::query(
                    "UPDATE alerts SET ticket_id = ? WHERE id = ? AND ticket_id IS NULL",
                )
                .bind(&ticket.id)
                .bind(alert)
                .execute(db)
                .await?
                .rows_affected();
                if claimed == 1 {
                    crate::monitoring::alerts::add_event(
                        db,
                        alert,
                        "ticket_created",
                        Some((ctx.user.id.as_str(), ctx.user.name.as_str())),
                        &format!("Linked to ticket #{}", ticket.number),
                        json!({ "ticket_id": ticket.id, "number": ticket.number, "rule_id": null }),
                    )
                    .await?;
                    crate::monitoring::alerts::publish(&state, alert, false).await;
                }
                model::activity(db, &ticket.id, &who, "linked", None, Some(&label)).await?;
            }
        } else if unlink(db, &ticket.id, "alert", alert).await? {
            sqlx::query("UPDATE alerts SET ticket_id = NULL WHERE id = ? AND ticket_id = ?")
                .bind(alert)
                .bind(&ticket.id)
                .execute(db)
                .await?;
            model::activity(db, &ticket.id, &who, "unlinked", Some(&label), None).await?;
        }
    }
    for other_id in &body.ticket_ids {
        if *other_id == ticket.id {
            continue;
        }
        let other = visible_ticket(&state, &ctx, other_id, perm::TICKETS_VIEW).await?;
        let label = format!("ticket #{}", other.number);
        if add {
            let a = model::link(db, &ticket.id, "ticket", &other.id).await?;
            model::link(db, &other.id, "ticket", &ticket.id).await?;
            if a {
                model::activity(db, &ticket.id, &who, "linked", None, Some(&label)).await?;
            }
        } else {
            let a = unlink(db, &ticket.id, "ticket", &other.id).await?;
            unlink(db, &other.id, "ticket", &ticket.id).await?;
            if a {
                model::activity(db, &ticket.id, &who, "unlinked", Some(&label), None).await?;
            }
        }
    }
    state.events.publish(
        "ticket.updated",
        Some(ticket.client_id.clone()),
        json!({ "ticket_id": ticket.id, "changes": { "links": { "from": null, "to": null } } }),
    );
    let row = model::load(db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("Ticket"))?;
    Ok(Json(model::ticket_json(db, &row).await?))
}

async fn unlink(
    db: &crate::db::Db,
    ticket_id: &str,
    kind: &str,
    target: &str,
) -> anyhow::Result<bool> {
    Ok(
        sqlx::query("DELETE FROM ticket_links WHERE ticket_id = ? AND kind = ? AND target_id = ?")
            .bind(ticket_id)
            .bind(kind)
            .bind(target)
            .execute(db)
            .await?
            .rows_affected()
            == 1,
    )
}

/// `POST /api/v1/tickets/{id}/links`
#[utoipa::path(post, path = "/api/v1/tickets/{id}/links", tag = "Tickets", summary = "Add links", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn add_links(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(body): Json<LinksBody>,
) -> ApiResult<Json<Value>> {
    change_links(state, ctx, id, body, true).await
}

/// `DELETE /api/v1/tickets/{id}/links`
#[utoipa::path(delete, path = "/api/v1/tickets/{id}/links", tag = "Tickets", summary = "Remove links", params(("id" = String, Path)), responses((status = 204, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn remove_links(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(body): Json<LinksBody>,
) -> ApiResult<Json<Value>> {
    change_links(state, ctx, id, body, false).await
}

// ------------------------------------------------------------------ bulk

#[derive(Debug, Deserialize)]
pub struct BulkBody {
    ids: Vec<String>,
    action: String,
    #[serde(default)]
    value: Value,
}

/// `POST /api/v1/tickets/bulk`
#[utoipa::path(post, path = "/api/v1/tickets/bulk", tag = "Tickets", summary = "Bulk", request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn bulk(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Json(body): Json<BulkBody>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::TICKETS_MANAGE)?;
    if body.ids.is_empty() || body.ids.len() > 500 {
        return Err(ApiError::validation("ids must hold 1–500 ticket ids"));
    }
    let text = body.value.as_str().map(str::trim).map(str::to_string);
    enum Tag {
        Add(String),
        Remove(String),
    }
    let mut tag: Option<Tag> = None;
    let mut template = Changes::default();
    match body.action.as_str() {
        "assign" => {
            let user = text.filter(|t| !t.is_empty());
            if let Some(u) = &user {
                check_assignee(&state, u).await?;
            }
            template.assignee_id = Some(user);
        }
        "status" => {
            let s = text.ok_or_else(|| ApiError::validation("value must be a status"))?;
            check_enum(&s, &STATUSES, "value")?;
            template.status = Some(s);
        }
        "priority" => {
            let p = text.ok_or_else(|| ApiError::validation("value must be a priority"))?;
            check_enum(&p, &PRIORITIES, "value")?;
            template.priority = Some(p);
        }
        "queue" => {
            let q = text.ok_or_else(|| ApiError::validation("value must be a queue id"))?;
            check_queue(&state, &q).await?;
            template.queue_id = Some(q);
        }
        "tag" => {
            let t = text
                .filter(|t| !t.is_empty())
                .ok_or_else(|| ApiError::validation("value must be a tag"))?;
            tag = Some(match t.strip_prefix('-') {
                Some(rest) => Tag::Remove(rest.trim().to_string()),
                None => Tag::Add(t),
            });
        }
        _ => {
            return Err(ApiError::validation(
                "action must be assign, status, priority, queue or tag",
            ));
        }
    }
    let mut ids = body.ids.clone();
    ids.sort();
    ids.dedup();
    let who = Who::user(&ctx);
    let (mut updated, mut skipped) = (Vec::new(), Vec::new());
    for id in &ids {
        let ticket = match model::load(&state.db, id).await? {
            Some(t) if t.visible(&ctx.scope, perm::TICKETS_MANAGE) => t,
            _ => {
                skipped.push(id.clone());
                continue;
            }
        };
        let mut ch = template.clone();
        if let Some(t) = &tag {
            let mut tags = ticket.tags();
            match t {
                Tag::Add(v) => tags.push(v.clone()),
                Tag::Remove(v) => tags.retain(|x| !x.eq_ignore_ascii_case(v)),
            }
            ch.tags = Some(clean_tags(&tags).map_err(ApiError::validation)?);
        }
        let changes = model::apply_changes(&state, &ticket, ch, &who).await?;
        if changes.as_object().is_some_and(|o| !o.is_empty()) {
            updated.push(id.clone());
        } else {
            skipped.push(id.clone());
        }
    }
    Ok(Json(json!({
        "updated": updated.len(), "skipped": skipped.len(), "updated_ids": updated, "skipped_ids": skipped,
    })))
}

// ------------------------------------------------------------------ delete

/// `DELETE /api/v1/tickets/{id}` (`tickets.settings`).
#[utoipa::path(delete, path = "/api/v1/tickets/{id}", tag = "Tickets", summary = "Delete ticket", params(("id" = String, Path)), responses((status = 204, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn delete(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let ticket = visible_ticket(&state, &ctx, &id, perm::TICKETS_VIEW).await?;
    ctx.require_client(perm::TICKETS_SETTINGS, &ticket.client_id)?;
    sqlx::query("UPDATE alerts SET ticket_id = NULL WHERE ticket_id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;
    sqlx::query("DELETE FROM ticket_links WHERE kind = 'ticket' AND target_id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;
    sqlx::query("UPDATE tickets SET merged_into = NULL WHERE merged_into = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;
    sqlx::query("DELETE FROM tickets WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;
    let mut entry = ctx
        .audit("ticket.deleted")
        .target(
            "ticket",
            &id,
            format!("#{} {}", ticket.number, ticket.subject),
        )
        .client(&ticket.client_id)
        .details(
            json!({ "number": ticket.number, "subject": ticket.subject, "status": ticket.status }),
        );
    if let Some(site) = &ticket.site_id {
        entry = entry.site(site);
    }
    state.audit.record_or_log(&state.db, entry).await;
    state.events.publish(
        "ticket.updated",
        Some(ticket.client_id.clone()),
        json!({ "ticket_id": id, "changes": { "deleted": { "from": false, "to": true } } }),
    );
    super::publish_counts(&state, &ticket.client_id);
    Ok(StatusCode::NO_CONTENT)
}

// ------------------------------------------------------------------ stats

#[derive(Debug, Default, Deserialize)]
pub struct StatsQuery {
    client_id: Option<String>,
    from: Option<String>,
    to: Option<String>,
}

#[derive(sqlx::FromRow)]
struct StatRow {
    client_id: String,
    site_id: Option<String>,
    priority: String,
    queue_id: Option<String>,
    queue_name: Option<String>,
    created_at: DateTime<Utc>,
    first_response_at: Option<DateTime<Utc>>,
    resolved_at: Option<DateTime<Utc>>,
    closed_at: Option<DateTime<Utc>>,
    sla_policy_id: Option<String>,
    first_response_breached: bool,
    resolution_breached: bool,
    merged_into: Option<String>,
}

/// `GET /api/v1/tickets/stats?client_id=&from=&to=` (default: the last 30 days).
#[utoipa::path(get, path = "/api/v1/tickets/stats", tag = "Tickets", summary = "Stats", responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn stats(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<StatsQuery>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::TICKETS_VIEW)?;
    let now = rustrmm_common::now();
    let to = match q.to.as_deref().filter(|s| !s.is_empty()) {
        Some(t) => super::time::parse_bound(t, true)
            .ok_or_else(|| ApiError::validation("to must be YYYY-MM-DD or RFC 3339"))?,
        None => now,
    };
    let from = match q.from.as_deref().filter(|s| !s.is_empty()) {
        Some(f) => super::time::parse_bound(f, false)
            .ok_or_else(|| ApiError::validation("from must be YYYY-MM-DD or RFC 3339"))?,
        None => to - Duration::days(30),
    };
    if from >= to || to - from > Duration::days(366) {
        return Err(ApiError::validation(
            "from must be before to, at most 366 days apart",
        ));
    }
    let mut qb = QueryBuilder::<Sqlite>::new(
        "SELECT t.client_id, t.site_id, t.priority, t.queue_id, q.name AS queue_name, t.created_at, t.first_response_at,
                t.resolved_at, t.closed_at, t.sla_policy_id, t.first_response_breached, t.resolution_breached, t.merged_into
         FROM tickets t LEFT JOIN ticket_queues q ON q.id = t.queue_id WHERE t.created_at < ",
    );
    qb.push_bind(to);
    super::push_scope(&mut qb, &ctx.scope, perm::TICKETS_VIEW, "t");
    push_in(&mut qb, "t.client_id", &csv_param(&q.client_id));
    let rows: Vec<StatRow> = qb.build_query_as().fetch_all(&state.db).await?;
    let rows: Vec<&StatRow> = rows
        .iter()
        .filter(|r| {
            super::visible(
                &ctx.scope,
                perm::TICKETS_VIEW,
                &r.client_id,
                r.site_id.as_deref(),
            )
        })
        .collect();
    let in_range = |t: DateTime<Utc>| t >= from && t < to;
    let opened: Vec<&&StatRow> = rows.iter().filter(|r| in_range(r.created_at)).collect();
    let resolved: Vec<&&StatRow> = rows
        .iter()
        .filter(|r| r.merged_into.is_none() && r.resolved_at.is_some_and(in_range))
        .collect();
    let avg = |values: Vec<i64>| -> Option<f64> {
        (!values.is_empty()).then(|| values.iter().sum::<i64>() as f64 / values.len() as f64)
    };
    let avg_first_response = avg(opened
        .iter()
        .filter_map(|r| {
            r.first_response_at
                .map(|f| (f - r.created_at).num_minutes())
        })
        .collect());
    let avg_resolution = avg(resolved
        .iter()
        .filter_map(|r| r.resolved_at.map(|f| (f - r.created_at).num_minutes()))
        .collect());
    let with_sla: Vec<&&&StatRow> = resolved
        .iter()
        .filter(|r| r.sla_policy_id.is_some())
        .collect();
    let sla_met_pct = (!with_sla.is_empty()).then(|| {
        let met = with_sla
            .iter()
            .filter(|r| !r.first_response_breached && !r.resolution_breached)
            .count();
        (met as f64 * 1000.0 / with_sla.len() as f64).round() / 10.0
    });
    let by_priority: Vec<Value> = PRIORITIES
        .iter()
        .rev()
        .map(|p| {
            json!({
                "priority": p,
                "opened": opened.iter().filter(|r| r.priority == *p).count(),
                "resolved": resolved.iter().filter(|r| r.priority == *p).count(),
            })
        })
        .collect();
    let mut queues: HashMap<Option<String>, (Option<String>, usize, usize)> = HashMap::new();
    for r in &opened {
        queues
            .entry(r.queue_id.clone())
            .or_insert((r.queue_name.clone(), 0, 0))
            .1 += 1;
    }
    for r in &resolved {
        queues
            .entry(r.queue_id.clone())
            .or_insert((r.queue_name.clone(), 0, 0))
            .2 += 1;
    }
    let mut by_queue: Vec<Value> = queues
        .into_iter()
        .map(|(id, (name, o, r))| json!({ "queue_id": id, "queue_name": name, "opened": o, "resolved": r }))
        .collect();
    by_queue.sort_by(|a, b| b["opened"].as_u64().cmp(&a["opened"].as_u64()));
    // Open tickets at the end of each day.
    let mut backlog = Vec::new();
    let first: NaiveDate = from.date_naive();
    let last: NaiveDate = (to - Duration::seconds(1)).date_naive();
    let mut day = first;
    while day <= last && backlog.len() <= 367 {
        let end = day
            .succ_opt()
            .and_then(|d| d.and_hms_opt(0, 0, 0))
            .map(|d| d.and_utc())
            .unwrap_or(to);
        let open = rows
            .iter()
            .filter(|r| {
                let done = r.resolved_at.or(r.closed_at);
                r.created_at < end && done.is_none_or(|d| d >= end)
            })
            .count();
        backlog.push(json!({ "date": day.format("%Y-%m-%d").to_string(), "open": open }));
        match day.succ_opt() {
            Some(next) => day = next,
            None => break,
        }
    }
    Ok(Json(json!({
        "from": from, "to": to,
        "opened": opened.len(), "resolved": resolved.len(),
        "avg_first_response_minutes": avg_first_response, "avg_resolution_minutes": avg_resolution,
        "sla_met_pct": sla_met_pct, "by_priority": by_priority, "by_queue": by_queue,
        "backlog_trend": backlog,
    })))
}
