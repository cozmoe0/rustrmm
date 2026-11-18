//! Ticket queues (`/ticket-queues`). The built-in "Support" queue always exists.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{QueryBuilder, Sqlite};

use crate::auth::AuthCtx;
use crate::db::Db;
use crate::error::{ApiError, ApiResult};
use crate::rbac::{AccessScope, perm};
use crate::state::AppState;

pub const DEFAULT_QUEUE_ID: &str = "builtin-support-queue";
/// Holding queue for mail from unknown senders (created on first use).
pub const HOLDING_QUEUE_ID: &str = "builtin-holding-queue";

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct QueueRow {
    pub id: String,
    pub name: String,
    pub description: String,
    pub default_assignee_id: Option<String>,
    pub default_priority: String,
    pub email_address: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl QueueRow {
    pub fn to_json(&self, open: i64) -> Value {
        json!({
            "id": self.id, "name": self.name, "description": self.description,
            "default_assignee_id": self.default_assignee_id, "default_priority": self.default_priority,
            "email_address": self.email_address,
            "builtin": self.id == DEFAULT_QUEUE_ID || self.id == HOLDING_QUEUE_ID,
            "open_tickets": open, "created_at": self.created_at, "updated_at": self.updated_at,
        })
    }
}

const SELECT: &str = "SELECT id, name, description, default_assignee_id, default_priority, email_address, created_at, updated_at FROM ticket_queues";

pub async fn row(db: &Db, id: &str) -> anyhow::Result<Option<QueueRow>> {
    Ok(
        sqlx::query_as(sqlx::AssertSqlSafe(format!("{SELECT} WHERE id = ?")))
            .bind(id)
            .fetch_optional(db)
            .await?,
    )
}

/// The queue whose e-mail address is one of `addresses` (case-insensitive).
pub async fn by_email(db: &Db, addresses: &[String]) -> anyhow::Result<Option<String>> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT id, email_address FROM ticket_queues WHERE email_address IS NOT NULL AND email_address <> '' ORDER BY created_at",
    )
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .find(|(_, e)| addresses.iter().any(|a| a.eq_ignore_ascii_case(e)))
        .map(|(id, _)| id))
}

pub async fn seed(db: &Db) -> anyhow::Result<()> {
    let now = rustrmm_common::now();
    sqlx::query(
        "INSERT OR IGNORE INTO ticket_queues (id, name, description, default_priority, created_at, updated_at)
         VALUES (?, 'Support', 'Default queue for new tickets', 'normal', ?, ?)",
    )
    .bind(DEFAULT_QUEUE_ID)
    .bind(now)
    .bind(now)
    .execute(db)
    .await?;
    Ok(())
}

/// Creates the holding queue on first use.
pub async fn ensure_holding(db: &Db) -> anyhow::Result<String> {
    let now = rustrmm_common::now();
    sqlx::query(
        "INSERT OR IGNORE INTO ticket_queues (id, name, description, default_priority, created_at, updated_at)
         VALUES (?, 'Unassigned e-mail', 'Mail from unknown senders, waiting for triage', 'normal', ?, ?)",
    )
    .bind(HOLDING_QUEUE_ID)
    .bind(now)
    .bind(now)
    .execute(db)
    .await?;
    Ok(row(db, HOLDING_QUEUE_ID)
        .await?
        .map(|q| q.id)
        .unwrap_or_else(|| DEFAULT_QUEUE_ID.to_string()))
}

#[derive(Debug, Deserialize)]
pub struct QueueBody {
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    default_assignee_id: Option<String>,
    #[serde(default = "normal")]
    default_priority: String,
    #[serde(default)]
    email_address: Option<String>,
}

fn normal() -> String {
    "normal".into()
}

impl QueueBody {
    async fn validate(&mut self, db: &Db) -> ApiResult<()> {
        self.name = self.name.trim().to_string();
        if self.name.is_empty() || self.name.chars().count() > 80 {
            return Err(ApiError::validation("name must be 1–80 characters"));
        }
        if self.description.chars().count() > 1000 {
            return Err(ApiError::validation(
                "description is at most 1000 characters",
            ));
        }
        if !super::PRIORITIES.contains(&self.default_priority.as_str()) {
            return Err(ApiError::validation(
                "default_priority must be low, normal, high or urgent",
            ));
        }
        self.email_address = self
            .email_address
            .as_deref()
            .map(str::trim)
            .filter(|e| !e.is_empty())
            .map(str::to_string);
        if let Some(e) = &self.email_address
            && !crate::monitoring::settings::valid_email(e)
        {
            return Err(ApiError::validation(
                "email_address is not a valid e-mail address",
            ));
        }
        self.default_assignee_id = self.default_assignee_id.take().filter(|a| !a.is_empty());
        if let Some(a) = &self.default_assignee_id {
            let ok: Option<String> =
                sqlx::query_scalar("SELECT id FROM users WHERE id = ? AND status = 'active'")
                    .bind(a)
                    .fetch_optional(db)
                    .await?;
            if ok.is_none() {
                return Err(ApiError::validation("Unknown or inactive default assignee"));
            }
        }
        Ok(())
    }
}

/// Open tickets per queue among the tickets the caller can see.
async fn open_counts(
    db: &Db,
    scope: &AccessScope,
) -> anyhow::Result<std::collections::HashMap<String, i64>> {
    let mut qb = QueryBuilder::<Sqlite>::new(
        "SELECT t.queue_id, COUNT(*) FROM tickets t WHERE t.queue_id IS NOT NULL
           AND t.status IN ('new', 'open', 'pending', 'on_hold')",
    );
    super::push_scope(&mut qb, scope, perm::TICKETS_VIEW, "t");
    qb.push(" GROUP BY t.queue_id");
    let rows: Vec<(String, i64)> = qb.build_query_as().fetch_all(db).await?;
    Ok(rows.into_iter().collect())
}

async fn get_json(db: &Db, scope: &AccessScope, id: &str) -> ApiResult<Value> {
    let q = row(db, id)
        .await?
        .ok_or_else(|| ApiError::not_found("Queue"))?;
    let counts = open_counts(db, scope).await?;
    Ok(q.to_json(counts.get(id).copied().unwrap_or(0)))
}

/// `GET /api/v1/ticket-queues`
#[utoipa::path(get, path = "/api/v1/ticket-queues", tag = "Tickets", summary = "List ticket queues", responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn list(State(state): State<AppState>, ctx: AuthCtx) -> ApiResult<Json<Value>> {
    ctx.require(perm::TICKETS_VIEW)?;
    let rows: Vec<QueueRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{SELECT} ORDER BY CASE id WHEN '{DEFAULT_QUEUE_ID}' THEN 0 ELSE 1 END, name COLLATE NOCASE"
    )))
    .fetch_all(&state.db)
    .await?;
    let counts = open_counts(&state.db, &ctx.scope).await?;
    let items: Vec<Value> = rows
        .iter()
        .map(|q| q.to_json(counts.get(&q.id).copied().unwrap_or(0)))
        .collect();
    Ok(Json(json!({ "items": items })))
}

/// `GET /api/v1/ticket-queues/{id}`
#[utoipa::path(get, path = "/api/v1/ticket-queues/{id}", tag = "Tickets", summary = "Get ticket queue", params(("id" = String, Path)), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn get(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::TICKETS_VIEW)?;
    Ok(Json(get_json(&state.db, &ctx.scope, &id).await?))
}

/// `POST /api/v1/ticket-queues`
#[utoipa::path(post, path = "/api/v1/ticket-queues", tag = "Tickets", summary = "Create ticket queue", request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn create(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Json(mut body): Json<QueueBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    ctx.require_global(perm::TICKETS_SETTINGS)?;
    body.validate(&state.db).await?;
    let id = rustrmm_common::new_id();
    let now = rustrmm_common::now();
    sqlx::query("INSERT INTO ticket_queues (id, name, description, default_assignee_id, default_priority, email_address, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(&id)
        .bind(&body.name)
        .bind(&body.description)
        .bind(&body.default_assignee_id)
        .bind(&body.default_priority)
        .bind(&body.email_address)
        .bind(now)
        .bind(now)
        .execute(&state.db)
        .await?;
    let value = get_json(&state.db, &ctx.scope, &id).await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("ticket_settings.queue_created")
                .target("ticket_queue", &id, &body.name)
                .details(value.clone()),
        )
        .await;
    Ok((StatusCode::CREATED, Json(value)))
}

/// `PUT /api/v1/ticket-queues/{id}`
#[utoipa::path(put, path = "/api/v1/ticket-queues/{id}", tag = "Tickets", summary = "Update ticket queue", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn update(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(mut body): Json<QueueBody>,
) -> ApiResult<Json<Value>> {
    ctx.require_global(perm::TICKETS_SETTINGS)?;
    let before = get_json(&state.db, &ctx.scope, &id).await?;
    body.validate(&state.db).await?;
    sqlx::query("UPDATE ticket_queues SET name = ?, description = ?, default_assignee_id = ?, default_priority = ?, email_address = ?, updated_at = ? WHERE id = ?")
        .bind(&body.name)
        .bind(&body.description)
        .bind(&body.default_assignee_id)
        .bind(&body.default_priority)
        .bind(&body.email_address)
        .bind(rustrmm_common::now())
        .bind(&id)
        .execute(&state.db)
        .await?;
    let value = get_json(&state.db, &ctx.scope, &id).await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("ticket_settings.queue_updated")
                .target("ticket_queue", &id, &body.name)
                .details(json!({ "before": before, "after": value })),
        )
        .await;
    Ok(Json(value))
}

/// `DELETE /api/v1/ticket-queues/{id}`: tickets in the queue move to "Support".
#[utoipa::path(delete, path = "/api/v1/ticket-queues/{id}", tag = "Tickets", summary = "Delete ticket queue", params(("id" = String, Path)), responses((status = 204, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn delete(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    ctx.require_global(perm::TICKETS_SETTINGS)?;
    if id == DEFAULT_QUEUE_ID {
        return Err(ApiError::conflict(
            "builtin",
            "The Support queue cannot be deleted",
        ));
    }
    let before = get_json(&state.db, &ctx.scope, &id).await?;
    let moved = sqlx::query("UPDATE tickets SET queue_id = ?, updated_at = ? WHERE queue_id = ?")
        .bind(DEFAULT_QUEUE_ID)
        .bind(rustrmm_common::now())
        .bind(&id)
        .execute(&state.db)
        .await?
        .rows_affected();
    sqlx::query("DELETE FROM ticket_queues WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("ticket_settings.queue_deleted")
                .target(
                    "ticket_queue",
                    &id,
                    before["name"].as_str().unwrap_or_default(),
                )
                .details(json!({ "queue": before, "tickets_moved": moved })),
        )
        .await;
    Ok(StatusCode::NO_CONTENT)
}
