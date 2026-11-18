//! Notification rules: which alerts go to which channels, quiet hours and escalation.

use std::collections::HashSet;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use chrono::{DateTime, Datelike, Timelike, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::auth::AuthCtx;
use crate::db::Db;
use crate::error::{ApiError, ApiResult};
use crate::rbac::perm;
use crate::state::AppState;

pub const EVENTS: &[&str] = &[
    "opened",
    "severity_changed",
    "resolved",
    "escalated",
    "secret.revealed",
];

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Filters {
    pub client_ids: Vec<String>,
    pub site_ids: Vec<String>,
    pub severities: Vec<String>,
    pub sources: Vec<String>,
    pub check_types: Vec<String>,
    pub check_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QuietHours {
    #[serde(default)]
    pub enabled: bool,
    pub start: String,
    pub end: String,
    #[serde(default = "utc")]
    pub timezone: String,
    /// 0 = Sunday … 6 = Saturday; empty = every day. An overnight window belongs to the day it
    /// starts on.
    #[serde(default)]
    pub days: Vec<u8>,
    #[serde(default)]
    pub except_critical: bool,
}

fn utc() -> String {
    "UTC".into()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Escalation {
    #[serde(default)]
    pub enabled: bool,
    pub after_minutes: i64,
    #[serde(default)]
    pub channel_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Rule {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub filters: Filters,
    pub events: Vec<String>,
    pub channel_ids: Vec<String>,
    pub quiet_hours: Option<QuietHours>,
    pub escalation: Option<Escalation>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(sqlx::FromRow)]
struct RuleRow {
    id: String,
    name: String,
    enabled: bool,
    filters: String,
    events: String,
    channel_ids: String,
    quiet_hours: Option<String>,
    escalation: Option<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

impl From<RuleRow> for Rule {
    fn from(r: RuleRow) -> Self {
        Self {
            id: r.id,
            name: r.name,
            enabled: r.enabled,
            filters: serde_json::from_str(&r.filters).unwrap_or_default(),
            events: serde_json::from_str(&r.events).unwrap_or_default(),
            channel_ids: serde_json::from_str(&r.channel_ids).unwrap_or_default(),
            quiet_hours: r.quiet_hours.and_then(|q| serde_json::from_str(&q).ok()),
            escalation: r.escalation.and_then(|e| serde_json::from_str(&e).ok()),
            created_at: r.created_at,
            updated_at: r.updated_at,
        }
    }
}

const SELECT: &str = "SELECT id, name, enabled, filters, events, channel_ids, quiet_hours, escalation, created_at, updated_at FROM notification_rules";

pub async fn load_all(db: &Db) -> anyhow::Result<Vec<Rule>> {
    let rows: Vec<RuleRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{SELECT} ORDER BY name COLLATE NOCASE"
    )))
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(Rule::from).collect())
}

async fn load(db: &Db, id: &str) -> ApiResult<Rule> {
    let row: Option<RuleRow> =
        sqlx::query_as(sqlx::AssertSqlSafe(format!("{SELECT} WHERE id = ?")))
            .bind(id)
            .fetch_optional(db)
            .await?;
    row.map(Rule::from)
        .ok_or_else(|| ApiError::not_found("Notification rule"))
}

/// What a rule matches on.
pub struct AlertFacts<'a> {
    pub client_id: &'a str,
    pub site_id: Option<&'a str>,
    pub severity: &'a str,
    pub source: &'a str,
    pub check_type: &'a str,
    pub check_id: &'a str,
}

impl Filters {
    pub fn matches(&self, a: &AlertFacts<'_>) -> bool {
        let any = |list: &[String], value: &str| list.is_empty() || list.iter().any(|v| v == value);
        any(&self.client_ids, a.client_id)
            && (self.site_ids.is_empty()
                || a.site_id
                    .is_some_and(|s| self.site_ids.iter().any(|v| v == s)))
            && any(&self.severities, a.severity)
            && any(&self.sources, a.source)
            && any(&self.check_types, a.check_type)
            && any(&self.check_ids, a.check_id)
    }
}

fn minutes_of(hhmm: &str) -> Option<u32> {
    let (h, m) = hhmm.trim().split_once(':')?;
    let (h, m): (u32, u32) = (h.parse().ok()?, m.parse().ok()?);
    (h < 24 && m < 60).then_some(h * 60 + m)
}

impl QuietHours {
    /// Whether `at` falls inside the quiet window (in the window's own time zone).
    pub fn active_at(&self, at: DateTime<Utc>) -> bool {
        if !self.enabled {
            return false;
        }
        let (Some(start), Some(end)) = (minutes_of(&self.start), minutes_of(&self.end)) else {
            return false;
        };
        let tz: chrono_tz::Tz = self.timezone.parse().unwrap_or(chrono_tz::Tz::UTC);
        let local = at.with_timezone(&tz);
        let now = local.hour() * 60 + local.minute();
        let today = local.weekday().num_days_from_sunday() as u8;
        let yesterday = (today + 6) % 7;
        let on = |day: u8| self.days.is_empty() || self.days.contains(&day);
        if start == end {
            on(today)
        } else if start < end {
            on(today) && (start..end).contains(&now)
        } else if now >= start {
            on(today)
        } else if now < end {
            on(yesterday)
        } else {
            false
        }
    }

    /// Whether a notification of `severity` is held back right now.
    pub fn suppresses(&self, severity: &str, at: DateTime<Utc>) -> bool {
        self.active_at(at) && !(self.except_critical && severity == "critical")
    }
}

// ------------------------------------------------------------------ API

#[derive(Deserialize)]
pub struct RuleBody {
    name: String,
    #[serde(default = "yes")]
    enabled: bool,
    #[serde(default)]
    filters: Filters,
    #[serde(default)]
    events: Vec<String>,
    #[serde(default)]
    channel_ids: Vec<String>,
    #[serde(default)]
    quiet_hours: Option<QuietHours>,
    #[serde(default)]
    escalation: Option<Escalation>,
}

fn yes() -> bool {
    true
}

async fn validate(db: &Db, body: &mut RuleBody) -> ApiResult<()> {
    body.name = body.name.trim().to_string();
    if body.name.is_empty() || body.name.chars().count() > 120 {
        return Err(ApiError::validation("Name must be 1–120 characters"));
    }
    if body.events.is_empty() {
        body.events = vec!["opened".into(), "resolved".into()];
    }
    let mut seen = HashSet::new();
    body.events.retain(|e| seen.insert(e.clone()));
    if let Some(bad) = body.events.iter().find(|e| !EVENTS.contains(&e.as_str())) {
        return Err(ApiError::validation(format!(
            "events: '{bad}' is not one of {}",
            EVENTS.join(", ")
        ))
        .with_details(json!({ "path": "events" })));
    }
    let f = &body.filters;
    if let Some(bad) = f
        .severities
        .iter()
        .find(|s| !["info", "warning", "critical"].contains(&s.as_str()))
    {
        return Err(ApiError::validation(format!(
            "filters.severities: unknown severity '{bad}'"
        )));
    }
    if let Some(bad) = f
        .sources
        .iter()
        .find(|s| !["check", "server", "snmp"].contains(&s.as_str()))
    {
        return Err(ApiError::validation(format!(
            "filters.sources: unknown source '{bad}'"
        )));
    }
    for list in [
        &f.client_ids,
        &f.site_ids,
        &f.severities,
        &f.sources,
        &f.check_types,
        &f.check_ids,
    ] {
        if list.len() > 200 || list.iter().any(|v| v.len() > 128) {
            return Err(ApiError::validation(
                "filters hold at most 200 short values each",
            ));
        }
    }
    let mut wanted: Vec<String> = body.channel_ids.clone();
    if let Some(e) = &body.escalation {
        if !(1..=10_080).contains(&e.after_minutes) {
            return Err(ApiError::validation(
                "escalation.after_minutes must be between 1 and 10080",
            ));
        }
        if e.enabled && e.channel_ids.is_empty() && !body.events.iter().any(|x| x == "escalated") {
            return Err(ApiError::validation(
                "escalation.channel_ids is required when escalation is enabled",
            ));
        }
        wanted.extend(e.channel_ids.iter().cloned());
    }
    if body.channel_ids.len() > 20 || wanted.len() > 40 {
        return Err(ApiError::validation("A rule can use at most 20 channels"));
    }
    for id in &wanted {
        let exists: Option<String> =
            sqlx::query_scalar("SELECT id FROM notification_channels WHERE id = ?")
                .bind(id)
                .fetch_optional(db)
                .await?;
        if exists.is_none() {
            return Err(
                ApiError::validation(format!("Unknown notification channel {id}"))
                    .with_details(json!({ "path": "channel_ids" })),
            );
        }
    }
    if let Some(q) = &mut body.quiet_hours {
        if minutes_of(&q.start).is_none() || minutes_of(&q.end).is_none() {
            return Err(ApiError::validation(
                "quiet_hours.start and end must be HH:MM",
            ));
        }
        crate::automation::cron::timezone(&q.timezone)
            .map_err(|e| ApiError::validation(format!("quiet_hours.timezone: {e}")))?;
        if q.days.iter().any(|d| *d > 6) {
            return Err(ApiError::validation(
                "quiet_hours.days must be 0 (Sunday) to 6 (Saturday)",
            ));
        }
        q.days.sort_unstable();
        q.days.dedup();
    }
    Ok(())
}

/// `GET /api/v1/notification-rules`
pub async fn list(State(state): State<AppState>, ctx: AuthCtx) -> ApiResult<Json<Value>> {
    ctx.require_global(perm::NOTIFICATIONS_MANAGE)?;
    Ok(Json(json!({ "items": load_all(&state.db).await? })))
}

/// `GET /api/v1/notification-rules/{id}`
pub async fn get(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Rule>> {
    ctx.require_global(perm::NOTIFICATIONS_MANAGE)?;
    Ok(Json(load(&state.db, &id).await?))
}

fn opt_json<T: Serialize>(v: &Option<T>) -> anyhow::Result<Option<String>> {
    Ok(match v {
        Some(v) => Some(serde_json::to_string(v)?),
        None => None,
    })
}

/// `POST /api/v1/notification-rules`
pub async fn create(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Json(mut body): Json<RuleBody>,
) -> ApiResult<(StatusCode, Json<Rule>)> {
    ctx.require_global(perm::NOTIFICATIONS_MANAGE)?;
    validate(&state.db, &mut body).await?;
    let id = rustrmm_common::new_id();
    let now = rustrmm_common::now();
    sqlx::query("INSERT INTO notification_rules (id, name, enabled, filters, events, channel_ids, quiet_hours, escalation, created_by, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(&id)
        .bind(&body.name)
        .bind(body.enabled)
        .bind(serde_json::to_string(&body.filters)?)
        .bind(serde_json::to_string(&body.events)?)
        .bind(serde_json::to_string(&body.channel_ids)?)
        .bind(opt_json(&body.quiet_hours)?)
        .bind(opt_json(&body.escalation)?)
        .bind(&ctx.user.id)
        .bind(now)
        .bind(now)
        .execute(&state.db)
        .await?;
    let rule = load(&state.db, &id).await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("notifications.rule_created")
                .target("notification_rule", &id, &rule.name)
                .details(json!({ "rule": rule })),
        )
        .await;
    Ok((StatusCode::CREATED, Json(rule)))
}

/// `PUT /api/v1/notification-rules/{id}`
pub async fn update(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(mut body): Json<RuleBody>,
) -> ApiResult<Json<Rule>> {
    ctx.require_global(perm::NOTIFICATIONS_MANAGE)?;
    let before = load(&state.db, &id).await?;
    validate(&state.db, &mut body).await?;
    sqlx::query("UPDATE notification_rules SET name = ?, enabled = ?, filters = ?, events = ?, channel_ids = ?, quiet_hours = ?, escalation = ?, updated_at = ? WHERE id = ?")
        .bind(&body.name)
        .bind(body.enabled)
        .bind(serde_json::to_string(&body.filters)?)
        .bind(serde_json::to_string(&body.events)?)
        .bind(serde_json::to_string(&body.channel_ids)?)
        .bind(opt_json(&body.quiet_hours)?)
        .bind(opt_json(&body.escalation)?)
        .bind(rustrmm_common::now())
        .bind(&id)
        .execute(&state.db)
        .await?;
    let rule = load(&state.db, &id).await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("notifications.rule_updated")
                .target("notification_rule", &id, &rule.name)
                .details(json!({ "before": before, "after": rule })),
        )
        .await;
    Ok(Json(rule))
}

/// `DELETE /api/v1/notification-rules/{id}`
pub async fn delete(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    ctx.require_global(perm::NOTIFICATIONS_MANAGE)?;
    let rule = load(&state.db, &id).await?;
    sqlx::query("DELETE FROM notification_rules WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("notifications.rule_deleted")
                .target("notification_rule", &id, &rule.name),
        )
        .await;
    Ok(StatusCode::NO_CONTENT)
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

    fn quiet(start: &str, end: &str, tz: &str, days: &[u8]) -> QuietHours {
        QuietHours {
            enabled: true,
            start: start.into(),
            end: end.into(),
            timezone: tz.into(),
            days: days.to_vec(),
            except_critical: true,
        }
    }

    #[test]
    fn quiet_hours_across_midnight() {
        // 2024-01-15 is a Monday.
        let q = quiet("22:00", "07:00", "UTC", &[1, 2, 3, 4, 5]);
        assert!(q.active_at(at(2024, 1, 15, 23, 0)), "Monday night");
        assert!(
            q.active_at(at(2024, 1, 16, 3, 0)),
            "early Tuesday belongs to Monday's window"
        );
        assert!(
            !q.active_at(at(2024, 1, 16, 7, 0)),
            "the window ends at 07:00"
        );
        assert!(!q.active_at(at(2024, 1, 15, 21, 59)));
        assert!(
            q.active_at(at(2024, 1, 20, 3, 0)),
            "Saturday 03:00 belongs to Friday"
        );
        assert!(
            !q.active_at(at(2024, 1, 21, 3, 0)),
            "Sunday 03:00 belongs to Saturday (off)"
        );
        assert!(
            !q.active_at(at(2024, 1, 15, 3, 0)),
            "Monday 03:00 belongs to Sunday (off)"
        );
        assert!(q.suppresses("warning", at(2024, 1, 15, 23, 0)));
        assert!(
            !q.suppresses("critical", at(2024, 1, 15, 23, 0)),
            "except_critical"
        );
        let mut off = q.clone();
        off.enabled = false;
        assert!(!off.active_at(at(2024, 1, 15, 23, 0)));
    }

    #[test]
    fn quiet_hours_in_time_zones() {
        // 22:00–07:00 in New York (UTC−5 in January) is 03:00–12:00 UTC.
        let q = quiet("22:00", "07:00", "America/New_York", &[]);
        assert!(q.active_at(at(2024, 1, 16, 4, 0)), "23:00 in New York");
        assert!(q.active_at(at(2024, 1, 16, 11, 59)), "06:59 in New York");
        assert!(!q.active_at(at(2024, 1, 16, 12, 0)), "07:00 in New York");
        assert!(!q.active_at(at(2024, 1, 16, 2, 0)), "21:00 in New York");
        // Same-day window in Tokyo (UTC+9): 09:00–17:00 local is 00:00–08:00 UTC.
        let day = quiet("09:00", "17:00", "Asia/Tokyo", &[1]);
        assert!(
            day.active_at(at(2024, 1, 15, 1, 0)),
            "Monday 10:00 in Tokyo"
        );
        assert!(
            !day.active_at(at(2024, 1, 15, 9, 0)),
            "Monday 18:00 in Tokyo"
        );
        assert!(
            !day.active_at(at(2024, 1, 16, 1, 0)),
            "Tuesday is not listed"
        );
        // Summer time: London is UTC+1 in July.
        let london = quiet("22:00", "06:00", "Europe/London", &[]);
        assert!(london.active_at(at(2024, 7, 1, 21, 30)), "22:30 BST");
        assert!(!london.active_at(at(2024, 7, 1, 20, 30)), "21:30 BST");
    }

    #[test]
    fn filters_match_with_empty_meaning_any() {
        let facts = AlertFacts {
            client_id: "c1",
            site_id: Some("s1"),
            severity: "critical",
            source: "check",
            check_type: "disk",
            check_id: "disk-c",
        };
        assert!(Filters::default().matches(&facts));
        let f = Filters {
            client_ids: vec!["c1".into()],
            severities: vec!["critical".into()],
            ..Filters::default()
        };
        assert!(f.matches(&facts));
        let f = Filters {
            severities: vec!["warning".into()],
            ..Filters::default()
        };
        assert!(!f.matches(&facts));
        let f = Filters {
            site_ids: vec!["s2".into()],
            ..Filters::default()
        };
        assert!(!f.matches(&facts));
        let server = AlertFacts {
            site_id: None,
            ..facts
        };
        let f = Filters {
            site_ids: vec!["s1".into()],
            ..Filters::default()
        };
        assert!(!f.matches(&server));
    }
}
