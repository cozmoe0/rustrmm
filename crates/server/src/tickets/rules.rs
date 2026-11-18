//! Alert-to-ticket rules (`/alert-ticket-rules`), evaluated from the alert lifecycle (open,
//! resolve) and by a sweep for delayed rules, plus the manual `POST /alerts/{id}/ticket`.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::model::{self, Changes, NewComment, NewTicket, TicketRow, Who};
use crate::auth::AuthCtx;
use crate::db::Db;
use crate::error::{ApiError, ApiResult};
use crate::monitoring::alerts::{self, AlertRow};
use crate::rbac::perm;
use crate::state::AppState;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Filters {
    pub client_ids: Vec<String>,
    pub severities: Vec<String>,
    pub check_types: Vec<String>,
    pub sources: Vec<String>,
}

/// The alert facts a rule matches on.
#[derive(Debug, Clone, Copy)]
pub struct Facts<'a> {
    pub client_id: &'a str,
    pub severity: &'a str,
    pub check_type: &'a str,
    pub source: &'a str,
}

impl Filters {
    /// Every non-empty list must contain the alert's value.
    pub fn matches(&self, f: &Facts<'_>) -> bool {
        let ok = |list: &[String], v: &str| list.is_empty() || list.iter().any(|x| x == v);
        ok(&self.client_ids, f.client_id)
            && ok(&self.severities, f.severity)
            && ok(&self.check_types, f.check_type)
            && ok(&self.sources, f.source)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TicketSpec {
    #[serde(default)]
    pub queue_id: Option<String>,
    #[serde(default = "high")]
    pub priority: String,
    #[serde(default)]
    pub assignee_id: Option<String>,
}

fn high() -> String {
    "high".into()
}

#[derive(Debug, Clone)]
pub struct Rule {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub filters: Filters,
    pub after_minutes: i64,
    pub ticket: TicketSpec,
    pub close_ticket_on_resolve: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl Rule {
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id, "name": self.name, "enabled": self.enabled, "filters": self.filters,
            "after_minutes": self.after_minutes, "ticket": self.ticket,
            "close_ticket_on_resolve": self.close_ticket_on_resolve,
            "created_at": self.created_at, "updated_at": self.updated_at,
        })
    }
}

fn facts(a: &AlertRow) -> Facts<'_> {
    Facts {
        client_id: &a.client_id,
        severity: &a.severity,
        check_type: &a.check_type,
        source: &a.source,
    }
}

type RuleRow = (
    String,
    String,
    bool,
    String,
    i64,
    String,
    bool,
    DateTime<Utc>,
    DateTime<Utc>,
);

fn from_row(r: RuleRow) -> Rule {
    Rule {
        id: r.0,
        name: r.1,
        enabled: r.2,
        filters: serde_json::from_str(&r.3).unwrap_or_default(),
        after_minutes: r.4,
        ticket: serde_json::from_str(&r.5).unwrap_or(TicketSpec {
            queue_id: None,
            priority: high(),
            assignee_id: None,
        }),
        close_ticket_on_resolve: r.6,
        created_at: r.7,
        updated_at: r.8,
    }
}

const SELECT: &str = "SELECT id, name, enabled, filters, after_minutes, ticket, close_ticket_on_resolve, created_at, updated_at FROM alert_ticket_rules";

pub async fn all(db: &Db) -> anyhow::Result<Vec<Rule>> {
    let rows: Vec<RuleRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{SELECT} ORDER BY created_at, id"
    )))
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(from_row).collect())
}

async fn one(db: &Db, id: &str) -> anyhow::Result<Option<Rule>> {
    let row: Option<RuleRow> =
        sqlx::query_as(sqlx::AssertSqlSafe(format!("{SELECT} WHERE id = ?")))
            .bind(id)
            .fetch_optional(db)
            .await?;
    Ok(row.map(from_row))
}

fn priority_for(severity: &str) -> &'static str {
    match severity {
        "critical" => "high",
        "warning" => "normal",
        _ => "low",
    }
}

/// Manual overrides for a ticket created from an alert.
#[derive(Debug, Default, Clone, Deserialize)]
pub struct Overrides {
    #[serde(default)]
    pub subject: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub priority: Option<String>,
    #[serde(default)]
    pub queue_id: Option<String>,
    #[serde(default)]
    pub assignee_id: Option<String>,
}

/// Creates the one ticket an alert may have: the alert is claimed first, so concurrent rules
/// or clicks never produce a second ticket. Returns `None` when the alert already has one.
pub async fn create_for_alert(
    state: &AppState,
    alert: &AlertRow,
    rule: Option<&Rule>,
    overrides: Overrides,
    who: &Who,
) -> anyhow::Result<Option<TicketRow>> {
    let id = rustrmm_common::new_id();
    let claimed = sqlx::query("UPDATE alerts SET ticket_id = ? WHERE id = ? AND ticket_id IS NULL")
        .bind(&id)
        .bind(&alert.id)
        .execute(&state.db)
        .await?
        .rows_affected();
    if claimed == 0 {
        return Ok(None);
    }
    let host = alert.hostname.clone().unwrap_or_else(|| "—".into());
    let default_subject: String = match &alert.hostname {
        Some(h) => format!("{} ({h})", alert.title),
        None => alert.title.clone(),
    }
    .chars()
    .take(200)
    .collect();
    let description = format!(
        "{}\n\n| | |\n|---|---|\n| Device | {host} |\n| Severity | {} |\n| Check | {} ({}) |\n| Opened | {} |\n| Alert | {} |",
        alert.message,
        alert.severity,
        alert.check_id,
        alert.check_type,
        alert.opened_at.format("%Y-%m-%d %H:%M UTC"),
        alert.id
    );
    let mut assignee = overrides
        .assignee_id
        .clone()
        .or_else(|| rule.and_then(|r| r.ticket.assignee_id.clone()))
        .filter(|a| !a.is_empty());
    if let Some(a) = &assignee {
        let active: Option<String> =
            sqlx::query_scalar("SELECT id FROM users WHERE id = ? AND status = 'active'")
                .bind(a)
                .fetch_optional(&state.db)
                .await?;
        assignee = active;
    }
    let new = NewTicket {
        id: Some(id.clone()),
        subject: overrides.subject.clone().unwrap_or(default_subject),
        description: overrides.description.clone().unwrap_or(description),
        client_id: alert.client_id.clone(),
        site_id: alert.site_id.clone(),
        contact_id: None,
        priority: Some(
            overrides
                .priority
                .clone()
                .or_else(|| rule.map(|r| r.ticket.priority.clone()))
                .unwrap_or_else(|| priority_for(&alert.severity).to_string()),
        ),
        kind: "alert".into(),
        queue_id: overrides
            .queue_id
            .clone()
            .or_else(|| rule.and_then(|r| r.ticket.queue_id.clone())),
        assignee_id: assignee,
        source: "alert",
        device_ids: alert.device_id.iter().cloned().collect(),
        alert_ids: vec![alert.id.clone()],
        alert_rule: rule.map(|r| (r.id.clone(), r.close_ticket_on_resolve)),
        ..NewTicket::default()
    };
    match model::create(state, new, who).await {
        Ok(row) => Ok(Some(row)),
        Err(e) => {
            sqlx::query("UPDATE alerts SET ticket_id = NULL WHERE id = ? AND ticket_id = ?")
                .bind(&alert.id)
                .bind(&id)
                .execute(&state.db)
                .await?;
            Err(e)
        }
    }
}

fn eligible(alert: &AlertRow) -> bool {
    alert.status == "open" && alert.ticket_id.is_none() && !alert.in_maintenance
}

/// Alert lifecycle hook: an alert opened (or reopened). Immediate rules apply now.
pub async fn alert_opened(state: &AppState, alert_id: &str) {
    if let Err(e) = evaluate_opened(state, alert_id).await {
        tracing::warn!(alert = alert_id, error = %format!("{e:#}"), "alert-to-ticket rule failed");
    }
}

async fn evaluate_opened(state: &AppState, alert_id: &str) -> anyhow::Result<()> {
    let Some(alert) = alerts::load(&state.db, alert_id).await? else {
        return Ok(());
    };
    if !eligible(&alert) {
        return Ok(());
    }
    let rules = all(&state.db).await?;
    if let Some(rule) = rules
        .iter()
        .find(|r| r.enabled && r.after_minutes == 0 && r.filters.matches(&facts(&alert)))
    {
        create_for_alert(
            state,
            &alert,
            Some(rule),
            Overrides::default(),
            &Who::system(),
        )
        .await?;
    }
    Ok(())
}

/// Delayed rules: alerts still open and unacknowledged `after_minutes` after opening.
pub async fn sweep(state: &AppState) -> anyhow::Result<()> {
    let rules: Vec<Rule> = all(&state.db)
        .await?
        .into_iter()
        .filter(|r| r.enabled && r.after_minutes > 0)
        .collect();
    if rules.is_empty() {
        return Ok(());
    }
    let now = rustrmm_common::now();
    for rule in &rules {
        let cutoff = now - chrono::Duration::minutes(rule.after_minutes);
        let ids: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM alerts WHERE status = 'open' AND ticket_id IS NULL AND in_maintenance = 0
               AND opened_at <= ? AND opened_at >= ? ORDER BY opened_at LIMIT 200",
        )
        .bind(cutoff)
        .bind(rule.created_at)
        .fetch_all(&state.db)
        .await?;
        for id in ids {
            let Some(alert) = alerts::load(&state.db, &id).await? else {
                continue;
            };
            if eligible(&alert) && rule.filters.matches(&facts(&alert)) {
                create_for_alert(
                    state,
                    &alert,
                    Some(rule),
                    Overrides::default(),
                    &Who::system(),
                )
                .await?;
            }
        }
    }
    Ok(())
}

/// Alert lifecycle hook: an alert resolved. A ticket created by a rule with
/// `close_ticket_on_resolve` is resolved too.
pub async fn alert_resolved(state: &AppState, alert_id: &str) {
    if let Err(e) = evaluate_resolved(state, alert_id).await {
        tracing::warn!(alert = alert_id, error = %format!("{e:#}"), "closing the alert's ticket failed");
    }
}

async fn evaluate_resolved(state: &AppState, alert_id: &str) -> anyhow::Result<()> {
    let Some(alert) = alerts::load(&state.db, alert_id).await? else {
        return Ok(());
    };
    let Some(ticket_id) = &alert.ticket_id else {
        return Ok(());
    };
    let Some(ticket) = model::load(&state.db, ticket_id).await? else {
        return Ok(());
    };
    if !ticket.close_on_alert_resolve || !ticket.is_active() {
        return Ok(());
    }
    model::add_comment(
        state,
        &ticket,
        NewComment {
            author: Who::system(),
            visibility: "internal".into(),
            body: format!(
                "The alert \"{}\" resolved, so this ticket was resolved.",
                alert.title
            ),
            source: "system",
            email_message_id: None,
            files: Vec::new(),
        },
    )
    .await?;
    if let Some(fresh) = model::load(&state.db, ticket_id).await? {
        model::apply_changes(
            state,
            &fresh,
            Changes {
                status: Some("resolved".into()),
                ..Changes::default()
            },
            &Who::system(),
        )
        .await?;
    }
    Ok(())
}

// ------------------------------------------------------------------ manual

/// `POST /api/v1/alerts/{id}/ticket` — a ticket prefilled from the alert.
#[utoipa::path(post, path = "/api/v1/alerts/{id}/ticket", tag = "Tickets", summary = "Create from alert", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn create_from_alert(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    body: Option<Json<Overrides>>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    ctx.require(perm::TICKETS_MANAGE)?;
    let alert = alerts::load(&state.db, &id)
        .await?
        .filter(|a| {
            a.visible(&ctx.scope, perm::ALERTS_VIEW) || a.visible(&ctx.scope, perm::TICKETS_VIEW)
        })
        .ok_or_else(|| ApiError::not_found("Alert"))?;
    if !alert.visible(&ctx.scope, perm::TICKETS_MANAGE) {
        return Err(ApiError::forbidden("Missing permission: tickets.manage")
            .with_details(json!({ "permission": perm::TICKETS_MANAGE })));
    }
    if let Some(existing) = &alert.ticket_id {
        return Err(
            ApiError::conflict("ticket_exists", "The alert already has a ticket")
                .with_details(json!({ "ticket_id": existing })),
        );
    }
    let overrides = body.map(|b| b.0).unwrap_or_default();
    if let Some(s) = &overrides.subject {
        super::api::validate_subject(s)?;
    }
    if let Some(p) = &overrides.priority
        && !super::PRIORITIES.contains(&p.as_str())
    {
        return Err(ApiError::validation(
            "priority must be low, normal, high or urgent",
        ));
    }
    if let Some(q) = overrides.queue_id.as_deref().filter(|q| !q.is_empty()) {
        super::api::check_queue(&state, q).await?;
    }
    if let Some(a) = overrides.assignee_id.as_deref().filter(|a| !a.is_empty()) {
        super::api::check_assignee(&state, a).await?;
    }
    let row = create_for_alert(&state, &alert, None, overrides, &Who::user(&ctx))
        .await?
        .ok_or_else(|| ApiError::conflict("ticket_exists", "The alert already has a ticket"))?;
    Ok((
        StatusCode::CREATED,
        Json(model::ticket_json(&state.db, &row).await?),
    ))
}

// ------------------------------------------------------------------ CRUD

#[derive(Debug, Deserialize)]
pub struct RuleBody {
    name: String,
    #[serde(default = "yes")]
    enabled: bool,
    #[serde(default)]
    filters: Filters,
    #[serde(default)]
    after_minutes: i64,
    ticket: TicketSpec,
    #[serde(default)]
    close_ticket_on_resolve: bool,
}

fn yes() -> bool {
    true
}

impl RuleBody {
    async fn validate(&mut self, state: &AppState) -> ApiResult<()> {
        self.name = self.name.trim().to_string();
        if self.name.is_empty() || self.name.chars().count() > 120 {
            return Err(ApiError::validation("name must be 1–120 characters"));
        }
        if !(0..=10_080).contains(&self.after_minutes) {
            return Err(ApiError::validation(
                "after_minutes must be between 0 and 10080",
            ));
        }
        let f = &mut self.filters;
        for list in [
            &mut f.client_ids,
            &mut f.severities,
            &mut f.check_types,
            &mut f.sources,
        ] {
            list.iter_mut().for_each(|v| *v = v.trim().to_string());
            list.retain(|v| !v.is_empty());
            list.sort();
            list.dedup();
            if list.len() > 100 {
                return Err(ApiError::validation("filters hold at most 100 values each"));
            }
        }
        if f.severities
            .iter()
            .any(|s| !matches!(s.as_str(), "info" | "warning" | "critical"))
        {
            return Err(ApiError::validation(
                "severities may be info, warning or critical",
            ));
        }
        if f.sources
            .iter()
            .any(|s| !matches!(s.as_str(), "check" | "server" | "snmp"))
        {
            return Err(ApiError::validation("sources may be check or server"));
        }
        for client in &f.client_ids {
            let ok: Option<String> = sqlx::query_scalar("SELECT id FROM clients WHERE id = ?")
                .bind(client)
                .fetch_optional(&state.db)
                .await?;
            if ok.is_none() {
                return Err(ApiError::validation(format!("unknown client {client}")));
            }
        }
        if !super::PRIORITIES.contains(&self.ticket.priority.as_str()) {
            return Err(ApiError::validation(
                "ticket.priority must be low, normal, high or urgent",
            ));
        }
        self.ticket.queue_id = self.ticket.queue_id.take().filter(|q| !q.is_empty());
        if let Some(q) = &self.ticket.queue_id {
            super::api::check_queue(state, q).await?;
        }
        self.ticket.assignee_id = self.ticket.assignee_id.take().filter(|a| !a.is_empty());
        if let Some(a) = &self.ticket.assignee_id {
            super::api::check_assignee(state, a).await?;
        }
        Ok(())
    }
}

/// `GET /api/v1/alert-ticket-rules`
#[utoipa::path(get, path = "/api/v1/alert-ticket-rules", tag = "Tickets", summary = "List alert ticket rules", responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn list(State(state): State<AppState>, ctx: AuthCtx) -> ApiResult<Json<Value>> {
    ctx.require_global(perm::TICKETS_SETTINGS)?;
    let items: Vec<Value> = all(&state.db).await?.iter().map(Rule::to_json).collect();
    Ok(Json(json!({ "items": items })))
}

/// `GET /api/v1/alert-ticket-rules/{id}`
#[utoipa::path(get, path = "/api/v1/alert-ticket-rules/{id}", tag = "Tickets", summary = "Get alert ticket rule", params(("id" = String, Path)), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn get(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    ctx.require_global(perm::TICKETS_SETTINGS)?;
    let rule = one(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("Rule"))?;
    Ok(Json(rule.to_json()))
}

/// `POST /api/v1/alert-ticket-rules`
#[utoipa::path(post, path = "/api/v1/alert-ticket-rules", tag = "Tickets", summary = "Create alert ticket rule", request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn create(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Json(mut body): Json<RuleBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    ctx.require_global(perm::TICKETS_SETTINGS)?;
    body.validate(&state).await?;
    let id = rustrmm_common::new_id();
    let now = rustrmm_common::now();
    sqlx::query("INSERT INTO alert_ticket_rules (id, name, enabled, filters, after_minutes, ticket, close_ticket_on_resolve, created_by, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(&id)
        .bind(&body.name)
        .bind(body.enabled)
        .bind(serde_json::to_string(&body.filters)?)
        .bind(body.after_minutes)
        .bind(serde_json::to_string(&body.ticket)?)
        .bind(body.close_ticket_on_resolve)
        .bind(&ctx.user.id)
        .bind(now)
        .bind(now)
        .execute(&state.db)
        .await?;
    let rule = one(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("Rule"))?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("ticket_settings.alert_rule_created")
                .target("alert_ticket_rule", &id, &body.name)
                .details(rule.to_json()),
        )
        .await;
    Ok((StatusCode::CREATED, Json(rule.to_json())))
}

/// `PUT /api/v1/alert-ticket-rules/{id}`
#[utoipa::path(put, path = "/api/v1/alert-ticket-rules/{id}", tag = "Tickets", summary = "Update alert ticket rule", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn update(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(mut body): Json<RuleBody>,
) -> ApiResult<Json<Value>> {
    ctx.require_global(perm::TICKETS_SETTINGS)?;
    let before = one(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("Rule"))?;
    body.validate(&state).await?;
    sqlx::query("UPDATE alert_ticket_rules SET name = ?, enabled = ?, filters = ?, after_minutes = ?, ticket = ?, close_ticket_on_resolve = ?, updated_at = ? WHERE id = ?")
        .bind(&body.name)
        .bind(body.enabled)
        .bind(serde_json::to_string(&body.filters)?)
        .bind(body.after_minutes)
        .bind(serde_json::to_string(&body.ticket)?)
        .bind(body.close_ticket_on_resolve)
        .bind(rustrmm_common::now())
        .bind(&id)
        .execute(&state.db)
        .await?;
    let rule = one(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("Rule"))?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("ticket_settings.alert_rule_updated")
                .target("alert_ticket_rule", &id, &body.name)
                .details(json!({ "before": before.to_json(), "after": rule.to_json() })),
        )
        .await;
    Ok(Json(rule.to_json()))
}

/// `DELETE /api/v1/alert-ticket-rules/{id}`
#[utoipa::path(delete, path = "/api/v1/alert-ticket-rules/{id}", tag = "Tickets", summary = "Delete alert ticket rule", params(("id" = String, Path)), responses((status = 204, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn delete(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    ctx.require_global(perm::TICKETS_SETTINGS)?;
    let before = one(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("Rule"))?;
    sqlx::query("DELETE FROM alert_ticket_rules WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("ticket_settings.alert_rule_deleted")
                .target("alert_ticket_rule", &id, &before.name)
                .details(before.to_json()),
        )
        .await;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_match_on_every_non_empty_list() {
        let alert = Facts {
            client_id: "c1",
            severity: "critical",
            check_type: "disk",
            source: "check",
        };
        assert!(
            Filters::default().matches(&alert),
            "empty filters match everything"
        );
        let critical = Filters {
            severities: vec!["critical".into()],
            ..Filters::default()
        };
        assert!(critical.matches(&alert));
        assert!(!critical.matches(&Facts {
            severity: "warning",
            ..alert
        }));
        let narrow = Filters {
            client_ids: vec!["c1".into(), "c2".into()],
            severities: vec!["warning".into(), "critical".into()],
            check_types: vec!["disk".into()],
            sources: vec!["check".into()],
        };
        assert!(narrow.matches(&alert));
        assert!(!narrow.matches(&Facts {
            client_id: "c3",
            ..alert
        }));
        assert!(!narrow.matches(&Facts {
            check_type: "cpu",
            ..alert
        }));
        assert!(!narrow.matches(&Facts {
            source: "server",
            ..alert
        }));
        assert_eq!(priority_for("critical"), "high");
        assert_eq!(priority_for("info"), "low");
    }
}
