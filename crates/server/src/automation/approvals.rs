//! Four-eyes approvals: a guarded job waits until another user holding `scripts.approve`
//! approves it. Pending approvals expire after seven days.

use axum::Json;
use axum::extract::{Path, Query, State};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{Value, json};

use super::jobs::{self, Schedule, scope_allows};
use crate::audit::{Actor, AuditEntry};
use crate::auth::AuthCtx;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

pub const APPROVE: &str = "scripts.approve";
const EXPIRY_DAYS: i64 = 7;

#[derive(Debug, Clone, sqlx::FromRow)]
struct ApprovalRow {
    id: String,
    kind: String,
    subject_id: String,
    status: String,
    requested_by: Option<String>,
    requested_by_name: String,
    requested_at: DateTime<Utc>,
    decided_by_name: Option<String>,
    decided_at: Option<DateTime<Utc>>,
    comment: Option<String>,
    client_id: Option<String>,
    site_id: Option<String>,
}

const SELECT: &str = "SELECT id, kind, subject_id, status, requested_by, requested_by_name, requested_at, decided_by_name,
    decided_at, comment, client_id, site_id FROM approvals";

fn changed(state: &AppState, client: Option<&str>, id: &str, status: &str) {
    state.events.publish(
        "approvals.changed",
        client.map(str::to_string),
        json!({ "id": id, "status": status }),
    );
}

/// Opens an approval request for a job.
pub async fn open(
    state: &AppState,
    ctx: &AuthCtx,
    job_id: &str,
    client_id: Option<&str>,
    site_id: Option<&str>,
) -> anyhow::Result<String> {
    let id = rustrmm_common::new_id();
    let now = rustrmm_common::now();
    sqlx::query("INSERT INTO approvals (id, kind, subject_id, status, requested_by, requested_by_name, requested_at, expires_at, client_id, site_id)
                 VALUES (?, 'job', ?, 'pending', ?, ?, ?, ?, ?, ?)")
        .bind(&id)
        .bind(job_id)
        .bind(&ctx.user.id)
        .bind(&ctx.user.name)
        .bind(now)
        .bind(now + chrono::Duration::days(EXPIRY_DAYS))
        .bind(client_id)
        .bind(site_id)
        .execute(&state.db)
        .await?;
    changed(state, client_id, &id, "pending");
    Ok(id)
}

/// Closes a job's pending approval (job cancelled or deleted).
pub async fn close_for_job(
    state: &AppState,
    job_id: &str,
    status: &str,
    ctx: &AuthCtx,
    comment: &str,
) -> anyhow::Result<()> {
    let pending: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT id, client_id FROM approvals WHERE subject_id = ? AND status = 'pending'",
    )
    .bind(job_id)
    .fetch_all(&state.db)
    .await?;
    for (id, client) in pending {
        sqlx::query("UPDATE approvals SET status = ?, decided_by = ?, decided_by_name = ?, decided_at = ?, comment = ? WHERE id = ?")
            .bind(status)
            .bind(&ctx.user.id)
            .bind(&ctx.user.name)
            .bind(rustrmm_common::now())
            .bind(comment)
            .bind(&id)
            .execute(&state.db)
            .await?;
        changed(state, client.as_deref(), &id, status);
    }
    Ok(())
}

/// Expires approvals older than seven days; their jobs are cancelled.
pub async fn expire(state: &AppState) -> anyhow::Result<()> {
    let now = rustrmm_common::now();
    let stale: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT id, subject_id, client_id FROM approvals WHERE status = 'pending' AND expires_at <= ?",
    )
    .bind(now)
    .fetch_all(&state.db)
    .await?;
    for (id, job_id, client) in stale {
        sqlx::query("UPDATE approvals SET status = 'expired', decided_at = ? WHERE id = ?")
            .bind(now)
            .bind(&id)
            .execute(&state.db)
            .await?;
        sqlx::query("UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'pending_approval'")
            .bind(now)
            .bind(&job_id)
            .execute(&state.db)
            .await?;
        state
            .audit
            .record_or_log(
                &state.db,
                AuditEntry::new(Actor::System, "job.cancelled")
                    .target("job", &job_id, "")
                    .details(json!({ "reason": "approval expired", "approval_id": id })),
            )
            .await;
        changed(state, client.as_deref(), &id, "expired");
    }
    Ok(())
}

async fn approval_json(state: &AppState, row: &ApprovalRow) -> anyhow::Result<Value> {
    let subject = match jobs::load_job(&state.db, &row.subject_id).await? {
        Some(job) => jobs::job_summary(&state.db, &job).await?,
        None => Value::Null,
    };
    Ok(json!({
        "id": row.id, "kind": row.kind, "subject": subject, "requested_by_name": row.requested_by_name,
        "requested_at": row.requested_at, "status": row.status, "decided_by_name": row.decided_by_name,
        "decided_at": row.decided_at, "comment": row.comment,
    }))
}

#[derive(Deserialize)]
pub struct ListQuery {
    status: Option<String>,
}

/// `GET /api/v1/approvals?status=pending`
#[utoipa::path(get, path = "/api/v1/approvals", tag = "Jobs", summary = "List approvals", responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn list(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Value>> {
    let status = q.status.as_deref().filter(|s| !s.is_empty() && *s != "all");
    let rows: Vec<ApprovalRow> = match status {
        Some(s) => {
            sqlx::query_as(sqlx::AssertSqlSafe(format!(
                "{SELECT} WHERE status = ? ORDER BY requested_at DESC LIMIT 500"
            )))
            .bind(s)
            .fetch_all(&state.db)
            .await?
        }
        None => {
            sqlx::query_as(sqlx::AssertSqlSafe(format!(
                "{SELECT} ORDER BY requested_at DESC LIMIT 500"
            )))
            .fetch_all(&state.db)
            .await?
        }
    };
    let mut items = Vec::new();
    for row in rows.iter().filter(|r| {
        r.requested_by.as_deref() == Some(ctx.user.id.as_str())
            || scope_allows(
                &ctx.scope,
                APPROVE,
                r.client_id.as_deref(),
                r.site_id.as_deref(),
            )
    }) {
        items.push(approval_json(&state, row).await?);
    }
    Ok(Json(json!({ "items": items })))
}

async fn load_decidable(state: &AppState, ctx: &AuthCtx, id: &str) -> ApiResult<ApprovalRow> {
    let row: ApprovalRow = sqlx::query_as(sqlx::AssertSqlSafe(format!("{SELECT} WHERE id = ?")))
        .bind(id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| ApiError::not_found("Approval"))?;
    let mine = row.requested_by.as_deref() == Some(ctx.user.id.as_str());
    let approver = scope_allows(
        &ctx.scope,
        APPROVE,
        row.client_id.as_deref(),
        row.site_id.as_deref(),
    );
    if !mine && !approver {
        return Err(ApiError::not_found("Approval"));
    }
    if !approver {
        return Err(ApiError::forbidden("Missing permission: scripts.approve")
            .with_details(json!({ "permission": APPROVE })));
    }
    if mine {
        return Err(ApiError::new(
            axum::http::StatusCode::FORBIDDEN,
            "self_approval",
            "You cannot decide on your own request; another approver must",
        ));
    }
    if row.status != "pending" {
        return Err(ApiError::conflict(
            "invalid_state",
            format!("The request is already {}", row.status),
        ));
    }
    Ok(row)
}

#[derive(Deserialize, Default)]
pub struct DecisionBody {
    #[serde(default)]
    comment: Option<String>,
}

/// `POST /api/v1/approvals/{id}/approve` (step-up)
#[utoipa::path(post, path = "/api/v1/approvals/{id}/approve", tag = "Jobs", summary = "Approve", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn approve(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    body: Option<Json<DecisionBody>>,
) -> ApiResult<Json<Value>> {
    let row = load_decidable(&state, &ctx, &id).await?;
    ctx.require_step_up()?;
    let comment = body
        .and_then(|b| b.0.comment)
        .map(|c| c.trim().chars().take(1000).collect::<String>())
        .filter(|c| !c.is_empty());
    let job = jobs::load_job(&state.db, &row.subject_id)
        .await?
        .ok_or_else(|| ApiError::not_found("Job"))?;
    if job.status != "pending_approval" {
        return Err(ApiError::conflict(
            "invalid_state",
            "The job is no longer waiting for approval",
        ));
    }
    let now = rustrmm_common::now();
    sqlx::query("UPDATE approvals SET status = 'approved', decided_by = ?, decided_by_name = ?, decided_at = ?, comment = ? WHERE id = ? AND status = 'pending'")
        .bind(&ctx.user.id)
        .bind(&ctx.user.name)
        .bind(now)
        .bind(&comment)
        .bind(&id)
        .execute(&state.db)
        .await?;
    // The schedule starts now: a cron job's next tick is computed from the approval time.
    let next = match job.schedule() {
        Schedule::Now => None,
        Schedule::Once { at } => Some(at),
        Schedule::Cron { cron, timezone } => super::cron::next_after(&cron, &timezone, now),
    };
    let due_now = next.is_none_or(|t| t <= now);
    sqlx::query("UPDATE jobs SET status = 'scheduled', approved_by = ?, approved_by_name = ?, approved_at = ?, next_run_at = ?, updated_at = ? WHERE id = ?")
        .bind(&ctx.user.id)
        .bind(&ctx.user.name)
        .bind(now)
        .bind(if due_now { None } else { next })
        .bind(now)
        .bind(&job.id)
        .execute(&state.db)
        .await?;
    let mut entry = ctx
        .audit("job.approved")
        .target("job", &job.id, &job.name)
        .details(
            json!({ "approval_id": id, "requested_by": row.requested_by_name, "comment": comment }),
        );
    if let Some(c) = &job.client_id {
        entry = entry.client(c);
    }
    state.audit.record_or_log(&state.db, entry).await;
    changed(&state, row.client_id.as_deref(), &id, "approved");
    if due_now {
        jobs::start_run(&state, &job.id, "manual", Some(&ctx), None).await?;
    }
    let row: ApprovalRow = sqlx::query_as(sqlx::AssertSqlSafe(format!("{SELECT} WHERE id = ?")))
        .bind(&id)
        .fetch_one(&state.db)
        .await?;
    Ok(Json(approval_json(&state, &row).await?))
}

/// `POST /api/v1/approvals/{id}/reject`
#[utoipa::path(post, path = "/api/v1/approvals/{id}/reject", tag = "Jobs", summary = "Reject", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn reject(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(body): Json<DecisionBody>,
) -> ApiResult<Json<Value>> {
    let row = load_decidable(&state, &ctx, &id).await?;
    let comment = body
        .comment
        .map(|c| c.trim().chars().take(1000).collect::<String>())
        .filter(|c| !c.is_empty())
        .ok_or_else(|| ApiError::validation("A comment is required to reject"))?;
    let now = rustrmm_common::now();
    sqlx::query("UPDATE approvals SET status = 'rejected', decided_by = ?, decided_by_name = ?, decided_at = ?, comment = ? WHERE id = ? AND status = 'pending'")
        .bind(&ctx.user.id)
        .bind(&ctx.user.name)
        .bind(now)
        .bind(&comment)
        .bind(&id)
        .execute(&state.db)
        .await?;
    sqlx::query("UPDATE jobs SET status = 'rejected', next_run_at = NULL, updated_at = ? WHERE id = ? AND status = 'pending_approval'")
        .bind(now)
        .bind(&row.subject_id)
        .execute(&state.db)
        .await?;
    let name: String = sqlx::query_scalar("SELECT name FROM jobs WHERE id = ?")
        .bind(&row.subject_id)
        .fetch_optional(&state.db)
        .await?
        .unwrap_or_default();
    let mut entry = ctx
        .audit("job.rejected")
        .target("job", &row.subject_id, &name)
        .details(
            json!({ "approval_id": id, "requested_by": row.requested_by_name, "comment": comment }),
        );
    if let Some(c) = &row.client_id {
        entry = entry.client(c);
    }
    state.audit.record_or_log(&state.db, entry).await;
    changed(&state, row.client_id.as_deref(), &id, "rejected");
    let row: ApprovalRow = sqlx::query_as(sqlx::AssertSqlSafe(format!("{SELECT} WHERE id = ?")))
        .bind(&id)
        .fetch_one(&state.db)
        .await?;
    Ok(Json(approval_json(&state, &row).await?))
}
