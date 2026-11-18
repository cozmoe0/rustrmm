//! Canned responses (`/canned-responses`): shared ones are managed with `tickets.settings`,
//! private ones by their owner with `tickets.manage`. Bodies support placeholders.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{Value, json};

use super::model::{self, TicketRow};
use crate::auth::AuthCtx;
use crate::error::{ApiError, ApiResult};
use crate::rbac::perm;
use crate::state::AppState;

/// Values substituted into a canned response or signature.
#[derive(Debug, Clone, Default)]
pub struct Placeholders {
    pub contact_name: Option<String>,
    pub ticket_number: Option<i64>,
    pub ticket_subject: Option<String>,
    pub technician_name: Option<String>,
    pub client_name: Option<String>,
}

impl Placeholders {
    pub fn for_ticket(t: &TicketRow, technician: Option<&str>) -> Self {
        Self {
            contact_name: t.contact_name.clone(),
            ticket_number: Some(t.number),
            ticket_subject: Some(t.subject.clone()),
            technician_name: technician.map(str::to_string),
            client_name: Some(t.client_name.clone()),
        }
    }

    fn value(&self, key: &str) -> Option<String> {
        match key {
            "contact.first_name" => Some(
                self.contact_name
                    .as_deref()
                    .and_then(|n| n.split_whitespace().next())
                    .unwrap_or_default()
                    .to_string(),
            ),
            "contact.name" => Some(self.contact_name.clone().unwrap_or_default()),
            "ticket.number" => Some(
                self.ticket_number
                    .map(|n| n.to_string())
                    .unwrap_or_default(),
            ),
            "ticket.subject" => Some(self.ticket_subject.clone().unwrap_or_default()),
            "technician.name" => Some(self.technician_name.clone().unwrap_or_default()),
            "client.name" => Some(self.client_name.clone().unwrap_or_default()),
            _ => None,
        }
    }
}

/// Replaces `{{ key }}` placeholders; unknown keys are left untouched.
pub fn render(template: &str, values: &Placeholders) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        match after.find("}}") {
            Some(end) => {
                let key = after[..end].trim();
                match values.value(key) {
                    Some(v) if key.len() <= 40 => out.push_str(&v),
                    _ => out.push_str(&rest[start..start + 2 + end + 2]),
                }
                rest = &after[end + 2..];
            }
            None => {
                out.push_str(&rest[start..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

#[derive(sqlx::FromRow)]
struct CannedRow {
    id: String,
    name: String,
    body: String,
    visibility: String,
    shared: bool,
    owner_id: Option<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

impl CannedRow {
    fn to_json(&self) -> Value {
        json!({
            "id": self.id, "name": self.name, "body": self.body, "visibility": self.visibility,
            "shared": self.shared, "owner_id": self.owner_id,
            "created_at": self.created_at, "updated_at": self.updated_at,
        })
    }

    fn readable_by(&self, ctx: &AuthCtx) -> bool {
        self.shared || self.owner_id.as_deref() == Some(ctx.user.id.as_str())
    }

    fn check_write(&self, ctx: &AuthCtx) -> ApiResult<()> {
        if self.shared {
            ctx.require_global(perm::TICKETS_SETTINGS)
        } else if self.owner_id.as_deref() == Some(ctx.user.id.as_str()) {
            ctx.require(perm::TICKETS_MANAGE)
        } else {
            Err(ApiError::not_found("Canned response"))
        }
    }
}

const SELECT: &str = "SELECT id, name, body, visibility, shared, owner_id, created_at, updated_at FROM canned_responses";

fn require_read(ctx: &AuthCtx) -> ApiResult<()> {
    if ctx.scope.has_anywhere(perm::TICKETS_MANAGE) || ctx.scope.has_global(perm::TICKETS_SETTINGS)
    {
        Ok(())
    } else {
        ctx.require(perm::TICKETS_MANAGE)
    }
}

async fn load(state: &AppState, ctx: &AuthCtx, id: &str) -> ApiResult<CannedRow> {
    let row: Option<CannedRow> =
        sqlx::query_as(sqlx::AssertSqlSafe(format!("{SELECT} WHERE id = ?")))
            .bind(id)
            .fetch_optional(&state.db)
            .await?;
    row.filter(|r| r.readable_by(ctx))
        .ok_or_else(|| ApiError::not_found("Canned response"))
}

/// `GET /api/v1/canned-responses`
#[utoipa::path(get, path = "/api/v1/canned-responses", tag = "Tickets", summary = "List canned responses", responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn list(State(state): State<AppState>, ctx: AuthCtx) -> ApiResult<Json<Value>> {
    require_read(&ctx)?;
    let rows: Vec<CannedRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{SELECT} WHERE shared = 1 OR owner_id = ? ORDER BY name COLLATE NOCASE"
    )))
    .bind(&ctx.user.id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(
        json!({ "items": rows.iter().map(CannedRow::to_json).collect::<Vec<_>>() }),
    ))
}

/// `GET /api/v1/canned-responses/{id}`
#[utoipa::path(get, path = "/api/v1/canned-responses/{id}", tag = "Tickets", summary = "Get canned response", params(("id" = String, Path)), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn get(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    require_read(&ctx)?;
    Ok(Json(load(&state, &ctx, &id).await?.to_json()))
}

#[derive(Debug, Deserialize)]
pub struct CannedBody {
    name: String,
    body: String,
    #[serde(default = "public")]
    visibility: String,
    #[serde(default)]
    shared: bool,
}

fn public() -> String {
    "public".into()
}

impl CannedBody {
    fn validate(&mut self) -> ApiResult<()> {
        self.name = self.name.trim().to_string();
        if self.name.is_empty() || self.name.chars().count() > 120 {
            return Err(ApiError::validation("name must be 1–120 characters"));
        }
        if self.body.trim().is_empty() || self.body.chars().count() > 20_000 {
            return Err(ApiError::validation("body must be 1–20000 characters"));
        }
        if !matches!(self.visibility.as_str(), "public" | "internal") {
            return Err(ApiError::validation(
                "visibility must be public or internal",
            ));
        }
        Ok(())
    }
}

/// `POST /api/v1/canned-responses`
#[utoipa::path(post, path = "/api/v1/canned-responses", tag = "Tickets", summary = "Create canned response", request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn create(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Json(mut body): Json<CannedBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    if body.shared {
        ctx.require_global(perm::TICKETS_SETTINGS)?;
    } else {
        ctx.require(perm::TICKETS_MANAGE)?;
    }
    body.validate()?;
    let id = rustrmm_common::new_id();
    let now = rustrmm_common::now();
    sqlx::query("INSERT INTO canned_responses (id, name, body, visibility, shared, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(&id)
        .bind(&body.name)
        .bind(&body.body)
        .bind(&body.visibility)
        .bind(body.shared)
        .bind(&ctx.user.id)
        .bind(now)
        .bind(now)
        .execute(&state.db)
        .await?;
    if body.shared {
        state
            .audit
            .record_or_log(
                &state.db,
                ctx.audit("ticket_settings.canned_created").target(
                    "canned_response",
                    &id,
                    &body.name,
                ),
            )
            .await;
    }
    Ok((
        StatusCode::CREATED,
        Json(load(&state, &ctx, &id).await?.to_json()),
    ))
}

/// `PUT /api/v1/canned-responses/{id}`
#[utoipa::path(put, path = "/api/v1/canned-responses/{id}", tag = "Tickets", summary = "Update canned response", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn update(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(mut body): Json<CannedBody>,
) -> ApiResult<Json<Value>> {
    let row = load(&state, &ctx, &id).await?;
    row.check_write(&ctx)?;
    if body.shared != row.shared {
        // Sharing or un-sharing touches the shared set.
        ctx.require_global(perm::TICKETS_SETTINGS)?;
    }
    body.validate()?;
    sqlx::query("UPDATE canned_responses SET name = ?, body = ?, visibility = ?, shared = ?, updated_at = ? WHERE id = ?")
        .bind(&body.name)
        .bind(&body.body)
        .bind(&body.visibility)
        .bind(body.shared)
        .bind(rustrmm_common::now())
        .bind(&id)
        .execute(&state.db)
        .await?;
    if body.shared || row.shared {
        state
            .audit
            .record_or_log(
                &state.db,
                ctx.audit("ticket_settings.canned_updated").target(
                    "canned_response",
                    &id,
                    &body.name,
                ),
            )
            .await;
    }
    Ok(Json(load(&state, &ctx, &id).await?.to_json()))
}

/// `DELETE /api/v1/canned-responses/{id}`
#[utoipa::path(delete, path = "/api/v1/canned-responses/{id}", tag = "Tickets", summary = "Delete canned response", params(("id" = String, Path)), responses((status = 204, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn delete(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let row = load(&state, &ctx, &id).await?;
    row.check_write(&ctx)?;
    sqlx::query("DELETE FROM canned_responses WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;
    if row.shared {
        state
            .audit
            .record_or_log(
                &state.db,
                ctx.audit("ticket_settings.canned_deleted").target(
                    "canned_response",
                    &id,
                    &row.name,
                ),
            )
            .await;
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
pub struct RenderBody {
    ticket_id: String,
}

/// `POST /api/v1/canned-responses/{id}/render` → `{ body, visibility }` with the placeholders
/// filled for a ticket and the caller.
#[utoipa::path(post, path = "/api/v1/canned-responses/{id}/render", tag = "Tickets", summary = "Render for ticket", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn render_for_ticket(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(body): Json<RenderBody>,
) -> ApiResult<Json<Value>> {
    require_read(&ctx)?;
    let row = load(&state, &ctx, &id).await?;
    let ticket = model::load(&state.db, &body.ticket_id)
        .await?
        .filter(|t| t.visible(&ctx.scope, perm::TICKETS_VIEW))
        .ok_or_else(|| ApiError::not_found("Ticket"))?;
    let values = Placeholders::for_ticket(&ticket, Some(&ctx.user.name));
    Ok(Json(
        json!({ "body": render(&row.body, &values), "visibility": row.visibility }),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholders_render() {
        let values = Placeholders {
            contact_name: Some("Dana Reyes".into()),
            ticket_number: Some(1042),
            ticket_subject: Some("Printer".into()),
            technician_name: Some("Tom Tech".into()),
            client_name: Some("Acme Dental".into()),
        };
        assert_eq!(
            render(
                "Hi {{contact.first_name}}, ticket #{{ ticket.number }} for {{client.name}} is with {{technician.name}}.",
                &values
            ),
            "Hi Dana, ticket #1042 for Acme Dental is with Tom Tech."
        );
        // Unknown keys and unterminated braces stay as written.
        assert_eq!(
            render("{{unknown}} {{ticket.number", &values),
            "{{unknown}} {{ticket.number"
        );
        // Missing values render empty.
        assert_eq!(
            render("Hi {{contact.first_name}}!", &Placeholders::default()),
            "Hi !"
        );
        // Values are not re-expanded.
        let tricky = Placeholders {
            contact_name: Some("{{client.name}}".into()),
            client_name: Some("X".into()),
            ..Placeholders::default()
        };
        assert_eq!(render("{{contact.name}}", &tricky), "{{client.name}}");
    }
}
