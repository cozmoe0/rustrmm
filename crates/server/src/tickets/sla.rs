//! SLA policies, business-time arithmetic and the per-ticket SLA clock.
//!
//! Due times are computed in business seconds: `due = add(created_at, target + paused)`, where
//! `paused` is the business time the ticket spent in a pausing status (the policy's `pause_on`
//! plus `resolved`/`closed`). While paused the stored due times are frozen; on resume the
//! business time of the pause is added and the due times move. Breach flags are re-evaluated
//! from scratch with one rule: a target is breached when the moment it was met (or the clock
//! stopped, or now) lies after its due time.

use std::collections::HashSet;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use chrono::offset::LocalResult;
use chrono::{DateTime, Datelike, Duration, NaiveDate, TimeZone, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::auth::AuthCtx;
use crate::db::Db;
use crate::error::{ApiError, ApiResult};
use crate::rbac::perm;
use crate::state::AppState;

pub const DEFAULT_POLICY_ID: &str = "builtin-default-sla";
/// Far enough to cover any sane target plus long pauses; bounds the window walk.
const MAX_DAYS: u32 = 3700;

// ------------------------------------------------------------------ policy model

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BusinessHours {
    pub timezone: String,
    /// ISO weekdays: 1 = Monday … 7 = Sunday.
    pub days: Vec<u8>,
    /// `HH:MM` local time.
    pub start: String,
    /// `HH:MM` local time (`24:00` allowed); at or before `start` means the window ends the next day.
    pub end: String,
    #[serde(default)]
    pub holidays: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Target {
    pub first_response_minutes: i64,
    pub resolution_minutes: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Targets {
    pub urgent: Target,
    pub high: Target,
    pub normal: Target,
    pub low: Target,
}

impl Targets {
    pub fn for_priority(&self, priority: &str) -> Target {
        match priority {
            "urgent" => self.urgent,
            "high" => self.high,
            "low" => self.low,
            _ => self.normal,
        }
    }

    pub fn default_24x7() -> Self {
        let t = |first_response_minutes, resolution_minutes| Target {
            first_response_minutes,
            resolution_minutes,
        };
        Self {
            urgent: t(30, 240),
            high: t(60, 480),
            normal: t(240, 1440),
            low: t(480, 4320),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Policy {
    pub id: String,
    pub name: String,
    pub client_ids: Vec<String>,
    pub business_hours: Option<BusinessHours>,
    pub targets: Targets,
    pub pause_on: Vec<String>,
}

impl Policy {
    pub fn schedule(&self) -> Schedule {
        Schedule::from_hours(self.business_hours.as_ref()).unwrap_or(Schedule::Always)
    }

    pub fn pauses(&self, status: &str) -> bool {
        matches!(status, "resolved" | "closed") || self.pause_on.iter().any(|s| s == status)
    }
}

// ------------------------------------------------------------------ business time

/// When the SLA clock runs.
#[derive(Debug, Clone)]
pub enum Schedule {
    /// 24x7.
    Always,
    Hours(Calendar),
}

#[derive(Debug, Clone)]
pub struct Calendar {
    tz: Tz,
    /// Index 1..=7 (ISO weekday).
    days: [bool; 8],
    start: u32,
    end: u32,
    holidays: HashSet<NaiveDate>,
}

/// Parses `HH:MM` into minutes after midnight (`24:00` = 1440).
pub fn parse_hhmm(text: &str) -> Option<u32> {
    let (h, m) = text.trim().split_once(':')?;
    if h.is_empty() || h.len() > 2 || m.len() != 2 {
        return None;
    }
    let (h, m): (u32, u32) = (h.parse().ok()?, m.parse().ok()?);
    if m > 59 || h > 24 || (h == 24 && m != 0) {
        return None;
    }
    Some(h * 60 + m)
}

impl BusinessHours {
    /// Checks and normalises (sorted, de-duplicated days and holidays).
    pub fn validate(&mut self) -> Result<(), String> {
        crate::automation::cron::timezone(&self.timezone)?;
        self.days.sort_unstable();
        self.days.dedup();
        if self.days.is_empty() || self.days.iter().any(|d| !(1..=7).contains(d)) {
            return Err("business_hours.days must list weekdays 1 (Monday) to 7 (Sunday)".into());
        }
        let start = parse_hhmm(&self.start)
            .filter(|m| *m < 1440)
            .ok_or("business_hours.start must be HH:MM")?;
        let end = parse_hhmm(&self.end).ok_or("business_hours.end must be HH:MM")?;
        if start == end % 1440 && end != 1440 {
            return Err("business_hours.start and end must differ".into());
        }
        if self.holidays.len() > 400 {
            return Err("business_hours.holidays holds at most 400 dates".into());
        }
        for day in &self.holidays {
            NaiveDate::parse_from_str(day, "%Y-%m-%d")
                .map_err(|_| format!("holiday '{day}' must be YYYY-MM-DD"))?;
        }
        self.holidays.sort();
        self.holidays.dedup();
        Ok(())
    }
}

impl Schedule {
    pub fn from_hours(hours: Option<&BusinessHours>) -> Result<Self, String> {
        let Some(h) = hours else {
            return Ok(Self::Always);
        };
        let tz = crate::automation::cron::timezone(&h.timezone)?;
        let mut days = [false; 8];
        for d in &h.days {
            if (1..=7).contains(d) {
                days[*d as usize] = true;
            }
        }
        if !days.iter().any(|d| *d) {
            return Err("no business days".into());
        }
        let start = parse_hhmm(&h.start).ok_or("bad start")?;
        let end = parse_hhmm(&h.end).ok_or("bad end")?;
        let holidays = h
            .holidays
            .iter()
            .filter_map(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
            .collect();
        Ok(Self::Hours(Calendar {
            tz,
            days,
            start,
            end,
            holidays,
        }))
    }

    /// `from` plus `secs` business seconds.
    pub fn add(&self, from: DateTime<Utc>, secs: i64) -> DateTime<Utc> {
        match self {
            Self::Always => from + Duration::seconds(secs.max(0)),
            Self::Hours(cal) => cal.add(from, secs),
        }
    }

    /// Business seconds in `[a, b)`.
    pub fn between(&self, a: DateTime<Utc>, b: DateTime<Utc>) -> i64 {
        match self {
            Self::Always => (b - a).num_seconds().max(0),
            Self::Hours(cal) => cal.between(a, b),
        }
    }
}

impl Calendar {
    fn local(&self, date: NaiveDate, minutes: u32) -> Option<DateTime<Utc>> {
        let naive = date.and_hms_opt(0, 0, 0)? + Duration::minutes(i64::from(minutes));
        match self.tz.from_local_datetime(&naive) {
            LocalResult::Single(t) => Some(t.with_timezone(&Utc)),
            LocalResult::Ambiguous(a, _) => Some(a.with_timezone(&Utc)),
            // A local time skipped by a DST change: the first valid instant after it.
            LocalResult::None => self
                .tz
                .from_local_datetime(&(naive + Duration::hours(1)))
                .earliest()
                .map(|t| t.with_timezone(&Utc)),
        }
    }

    /// The business window that starts on local `date`, if any.
    fn window(&self, date: NaiveDate) -> Option<(DateTime<Utc>, DateTime<Utc>)> {
        let weekday = date.weekday().number_from_monday() as usize;
        if !self.days[weekday] || self.holidays.contains(&date) {
            return None;
        }
        let start = self.local(date, self.start)?;
        let end = if self.end > self.start {
            self.local(date, self.end)?
        } else {
            self.local(date.succ_opt()?, self.end)?
        };
        (end > start).then_some((start, end))
    }

    fn first_date(&self, at: DateTime<Utc>) -> NaiveDate {
        // Start one day early so an overnight window that began yesterday is seen.
        let date = at.with_timezone(&self.tz).date_naive();
        date.pred_opt().unwrap_or(date)
    }

    fn add(&self, from: DateTime<Utc>, secs: i64) -> DateTime<Utc> {
        if secs <= 0 {
            return from;
        }
        let mut remaining = secs;
        let mut cursor = from;
        let mut date = self.first_date(from);
        for _ in 0..MAX_DAYS {
            if let Some((ws, we)) = self.window(date)
                && we > cursor
            {
                let start = ws.max(cursor);
                let available = (we - start).num_seconds();
                if available >= remaining {
                    return start + Duration::seconds(remaining);
                }
                remaining -= available;
                cursor = we;
            }
            match date.succ_opt() {
                Some(next) => date = next,
                None => break,
            }
        }
        from + Duration::seconds(secs)
    }

    fn between(&self, a: DateTime<Utc>, b: DateTime<Utc>) -> i64 {
        if b <= a {
            return 0;
        }
        let last = b.with_timezone(&self.tz).date_naive();
        let mut date = self.first_date(a);
        let mut total = 0;
        let mut guard = 0u32;
        while date <= last && guard < 40_000 {
            if let Some((ws, we)) = self.window(date) {
                let (s, e) = (ws.max(a), we.min(b));
                if e > s {
                    total += (e - s).num_seconds();
                }
            }
            guard += 1;
            match date.succ_opt() {
                Some(next) => date = next,
                None => break,
            }
        }
        total
    }
}

// ------------------------------------------------------------------ per-ticket clock

/// The SLA columns of one ticket.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Clock {
    pub policy_id: Option<String>,
    pub first_response_due: Option<DateTime<Utc>>,
    pub first_response_at: Option<DateTime<Utc>>,
    pub first_response_breached: bool,
    pub resolution_due: Option<DateTime<Utc>>,
    pub resolved_at: Option<DateTime<Utc>>,
    pub resolution_breached: bool,
    pub paused_at: Option<DateTime<Utc>>,
    pub pause_seconds: i64,
}

fn breached(
    due: Option<DateTime<Utc>>,
    met: Option<DateTime<Utc>>,
    paused: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
) -> bool {
    due.is_some_and(|due| met.or(paused).unwrap_or(now) > due)
}

impl Clock {
    /// Recomputes due times from the creation time, the target and the pauses so far, then
    /// re-evaluates breaches.
    pub fn recompute(
        &mut self,
        policy: Option<&Policy>,
        priority: &str,
        created_at: DateTime<Utc>,
        now: DateTime<Utc>,
    ) {
        match policy {
            Some(p) => {
                let schedule = p.schedule();
                let target = p.targets.for_priority(priority);
                self.policy_id = Some(p.id.clone());
                self.first_response_due = Some(schedule.add(
                    created_at,
                    target.first_response_minutes * 60 + self.pause_seconds,
                ));
                self.resolution_due = Some(schedule.add(
                    created_at,
                    target.resolution_minutes * 60 + self.pause_seconds,
                ));
            }
            None => {
                self.policy_id = None;
                self.first_response_due = None;
                self.resolution_due = None;
            }
        }
        self.evaluate(now);
    }

    pub fn evaluate(&mut self, now: DateTime<Utc>) {
        // Both clocks stop while the ticket is paused.
        self.first_response_breached = breached(
            self.first_response_due,
            self.first_response_at,
            self.paused_at,
            now,
        );
        self.resolution_breached =
            breached(self.resolution_due, self.resolved_at, self.paused_at, now);
    }

    /// A status change: stops or restarts the clock and records resolution.
    pub fn on_status(
        &mut self,
        policy: Option<&Policy>,
        priority: &str,
        created_at: DateTime<Utc>,
        to: &str,
        now: DateTime<Utc>,
    ) {
        let will_pause = match policy {
            Some(p) => p.pauses(to),
            None => matches!(to, "resolved" | "closed"),
        };
        match (self.paused_at, will_pause) {
            (None, true) => self.paused_at = Some(now),
            (Some(since), false) => {
                let schedule = policy.map(Policy::schedule).unwrap_or(Schedule::Always);
                self.pause_seconds += schedule.between(since, now);
                self.paused_at = None;
            }
            _ => {}
        }
        if matches!(to, "resolved" | "closed") {
            self.resolved_at.get_or_insert(now);
        } else {
            self.resolved_at = None;
        }
        self.recompute(policy, priority, created_at, now);
    }

    /// The first public reply from a technician.
    pub fn on_first_response(&mut self, now: DateTime<Utc>) {
        if self.first_response_at.is_none() {
            self.first_response_at = Some(now);
            self.evaluate(now);
        }
    }
}

// ------------------------------------------------------------------ storage

#[derive(sqlx::FromRow)]
struct PolicyRow {
    id: String,
    name: String,
    client_ids: String,
    business_hours: Option<String>,
    targets: String,
    pause_on: String,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

impl PolicyRow {
    fn policy(&self) -> anyhow::Result<Policy> {
        Ok(Policy {
            id: self.id.clone(),
            name: self.name.clone(),
            client_ids: serde_json::from_str(&self.client_ids).unwrap_or_default(),
            business_hours: match &self.business_hours {
                Some(text) => serde_json::from_str(text)?,
                None => None,
            },
            targets: serde_json::from_str(&self.targets)?,
            pause_on: serde_json::from_str(&self.pause_on).unwrap_or_default(),
        })
    }

    fn to_json(&self) -> anyhow::Result<Value> {
        let p = self.policy()?;
        Ok(json!({
            "id": p.id, "name": p.name, "client_ids": p.client_ids, "business_hours": p.business_hours,
            "targets": p.targets, "pause_on": p.pause_on, "builtin": p.id == DEFAULT_POLICY_ID,
            "created_at": self.created_at, "updated_at": self.updated_at,
        }))
    }
}

const POLICY_SELECT: &str = "SELECT id, name, client_ids, business_hours, targets, pause_on, created_at, updated_at FROM sla_policies";

async fn all_rows(db: &Db) -> anyhow::Result<Vec<PolicyRow>> {
    Ok(sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{POLICY_SELECT} ORDER BY created_at, id"
    )))
    .fetch_all(db)
    .await?)
}

pub async fn load(db: &Db, id: &str) -> anyhow::Result<Option<Policy>> {
    let row: Option<PolicyRow> =
        sqlx::query_as(sqlx::AssertSqlSafe(format!("{POLICY_SELECT} WHERE id = ?")))
            .bind(id)
            .fetch_optional(db)
            .await?;
    row.map(|r| r.policy()).transpose()
}

/// The first policy listing the client, otherwise the default policy (empty `client_ids`;
/// the built-in one first).
pub async fn for_client(db: &Db, client_id: &str) -> anyhow::Result<Option<Policy>> {
    let policies: Vec<Policy> = all_rows(db)
        .await?
        .iter()
        .filter_map(|r| r.policy().ok())
        .collect();
    if let Some(p) = policies
        .iter()
        .find(|p| p.client_ids.iter().any(|c| c == client_id))
    {
        return Ok(Some(p.clone()));
    }
    Ok(policies
        .iter()
        .find(|p| p.id == DEFAULT_POLICY_ID)
        .or_else(|| policies.iter().find(|p| p.client_ids.is_empty()))
        .cloned())
}

/// Seeds the default 24x7 policy (idempotent).
pub async fn seed(db: &Db) -> anyhow::Result<()> {
    let now = rustrmm_common::now();
    sqlx::query(
        "INSERT OR IGNORE INTO sla_policies (id, name, client_ids, business_hours, targets, pause_on, created_at, updated_at)
         VALUES (?, 'Default (24x7)', '[]', NULL, ?, '[\"pending\",\"on_hold\"]', ?, ?)",
    )
    .bind(DEFAULT_POLICY_ID)
    .bind(serde_json::to_string(&Targets::default_24x7())?)
    .bind(now)
    .bind(now)
    .execute(db)
    .await?;
    Ok(())
}

// ------------------------------------------------------------------ API

#[derive(Debug, Deserialize)]
pub struct PolicyBody {
    name: String,
    #[serde(default)]
    client_ids: Vec<String>,
    #[serde(default)]
    business_hours: Option<BusinessHours>,
    targets: Targets,
    #[serde(default = "default_pause_on")]
    pause_on: Vec<String>,
}

fn default_pause_on() -> Vec<String> {
    vec!["pending".into(), "on_hold".into()]
}

impl PolicyBody {
    async fn validate(&mut self, db: &Db) -> ApiResult<()> {
        self.name = self.name.trim().to_string();
        if self.name.is_empty() || self.name.chars().count() > 120 {
            return Err(ApiError::validation("name must be 1–120 characters"));
        }
        if let Some(h) = &mut self.business_hours {
            h.validate().map_err(ApiError::validation)?;
        }
        for (label, t) in [
            ("urgent", self.targets.urgent),
            ("high", self.targets.high),
            ("normal", self.targets.normal),
            ("low", self.targets.low),
        ] {
            for v in [t.first_response_minutes, t.resolution_minutes] {
                if !(1..=525_600).contains(&v) {
                    return Err(ApiError::validation(format!(
                        "targets.{label} minutes must be between 1 and 525600"
                    )));
                }
            }
        }
        self.pause_on.sort();
        self.pause_on.dedup();
        if self
            .pause_on
            .iter()
            .any(|s| !matches!(s.as_str(), "pending" | "on_hold"))
        {
            return Err(ApiError::validation(
                "pause_on may only contain pending and on_hold",
            ));
        }
        self.client_ids.sort();
        self.client_ids.dedup();
        for id in &self.client_ids {
            let exists: Option<String> = sqlx::query_scalar("SELECT id FROM clients WHERE id = ?")
                .bind(id)
                .fetch_optional(db)
                .await?;
            if exists.is_none() {
                return Err(ApiError::validation(format!("unknown client {id}")));
            }
        }
        Ok(())
    }
}

/// `GET /api/v1/sla-policies`
#[utoipa::path(get, path = "/api/v1/sla-policies", tag = "Tickets", summary = "List sla policies", responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn list(State(state): State<AppState>, ctx: AuthCtx) -> ApiResult<Json<Value>> {
    ctx.require(perm::TICKETS_VIEW)?;
    let items: Vec<Value> = all_rows(&state.db)
        .await?
        .iter()
        .filter_map(|r| r.to_json().ok())
        .collect();
    Ok(Json(json!({ "items": items })))
}

/// `GET /api/v1/sla-policies/{id}`
#[utoipa::path(get, path = "/api/v1/sla-policies/{id}", tag = "Tickets", summary = "Get sla policie", params(("id" = String, Path)), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn get(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::TICKETS_VIEW)?;
    let row: PolicyRow =
        sqlx::query_as(sqlx::AssertSqlSafe(format!("{POLICY_SELECT} WHERE id = ?")))
            .bind(&id)
            .fetch_optional(&state.db)
            .await?
            .ok_or_else(|| ApiError::not_found("SLA policy"))?;
    Ok(Json(row.to_json()?))
}

async fn get_json(db: &Db, id: &str) -> ApiResult<Value> {
    let row: PolicyRow =
        sqlx::query_as(sqlx::AssertSqlSafe(format!("{POLICY_SELECT} WHERE id = ?")))
            .bind(id)
            .fetch_optional(db)
            .await?
            .ok_or_else(|| ApiError::not_found("SLA policy"))?;
    Ok(row.to_json()?)
}

/// `POST /api/v1/sla-policies`
#[utoipa::path(post, path = "/api/v1/sla-policies", tag = "Tickets", summary = "Create sla policie", request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn create(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Json(mut body): Json<PolicyBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    ctx.require_global(perm::TICKETS_SETTINGS)?;
    body.validate(&state.db).await?;
    let id = rustrmm_common::new_id();
    let now = rustrmm_common::now();
    sqlx::query("INSERT INTO sla_policies (id, name, client_ids, business_hours, targets, pause_on, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(&id)
        .bind(&body.name)
        .bind(serde_json::to_string(&body.client_ids)?)
        .bind(body.business_hours.as_ref().map(serde_json::to_string).transpose()?)
        .bind(serde_json::to_string(&body.targets)?)
        .bind(serde_json::to_string(&body.pause_on)?)
        .bind(now)
        .bind(now)
        .execute(&state.db)
        .await?;
    super::reassign_sla_all(&state).await?;
    let value = get_json(&state.db, &id).await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("ticket_settings.sla_created")
                .target("sla_policy", &id, &body.name)
                .details(value.clone()),
        )
        .await;
    Ok((StatusCode::CREATED, Json(value)))
}

/// `PUT /api/v1/sla-policies/{id}`
#[utoipa::path(put, path = "/api/v1/sla-policies/{id}", tag = "Tickets", summary = "Update sla policie", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn update(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(mut body): Json<PolicyBody>,
) -> ApiResult<Json<Value>> {
    ctx.require_global(perm::TICKETS_SETTINGS)?;
    let before = get_json(&state.db, &id).await?;
    body.validate(&state.db).await?;
    if id == DEFAULT_POLICY_ID && !body.client_ids.is_empty() {
        return Err(ApiError::validation(
            "the default policy cannot be limited to clients",
        ));
    }
    sqlx::query("UPDATE sla_policies SET name = ?, client_ids = ?, business_hours = ?, targets = ?, pause_on = ?, updated_at = ? WHERE id = ?")
        .bind(&body.name)
        .bind(serde_json::to_string(&body.client_ids)?)
        .bind(body.business_hours.as_ref().map(serde_json::to_string).transpose()?)
        .bind(serde_json::to_string(&body.targets)?)
        .bind(serde_json::to_string(&body.pause_on)?)
        .bind(rustrmm_common::now())
        .bind(&id)
        .execute(&state.db)
        .await?;
    super::reassign_sla_all(&state).await?;
    let value = get_json(&state.db, &id).await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("ticket_settings.sla_updated")
                .target("sla_policy", &id, &body.name)
                .details(json!({ "before": before, "after": value })),
        )
        .await;
    Ok(Json(value))
}

/// `DELETE /api/v1/sla-policies/{id}`
#[utoipa::path(delete, path = "/api/v1/sla-policies/{id}", tag = "Tickets", summary = "Delete sla policie", params(("id" = String, Path)), responses((status = 204, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn delete(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    ctx.require_global(perm::TICKETS_SETTINGS)?;
    if id == DEFAULT_POLICY_ID {
        return Err(ApiError::conflict(
            "builtin",
            "The default SLA policy cannot be deleted",
        ));
    }
    let before = get_json(&state.db, &id).await?;
    sqlx::query("DELETE FROM sla_policies WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;
    super::reassign_sla_all(&state).await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("ticket_settings.sla_deleted")
                .target(
                    "sla_policy",
                    &id,
                    before["name"].as_str().unwrap_or_default(),
                )
                .details(before),
        )
        .await;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utc(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s)
            .expect("time")
            .with_timezone(&Utc)
    }

    fn hours(tz: &str, days: &[u8], start: &str, end: &str, holidays: &[&str]) -> Schedule {
        Schedule::from_hours(Some(&BusinessHours {
            timezone: tz.into(),
            days: days.to_vec(),
            start: start.into(),
            end: end.into(),
            holidays: holidays.iter().map(|s| s.to_string()).collect(),
        }))
        .expect("schedule")
    }

    #[test]
    fn always_is_wall_clock() {
        let s = Schedule::Always;
        let t = utc("2026-11-20T10:00:00Z");
        assert_eq!(s.add(t, 3600), utc("2026-11-20T11:00:00Z"));
        assert_eq!(s.between(t, utc("2026-11-21T10:00:00Z")), 86_400);
        assert_eq!(s.between(utc("2026-11-21T10:00:00Z"), t), 0);
    }

    #[test]
    fn weekends_are_skipped() {
        let s = hours("UTC", &[1, 2, 3, 4, 5], "08:00", "18:00", &[]);
        // Friday 2026-11-20 17:00 + 2 h → Monday 09:00.
        let friday = utc("2026-11-20T17:00:00Z");
        assert_eq!(s.add(friday, 7200), utc("2026-11-23T09:00:00Z"));
        // Saturday start counts from Monday 08:00.
        assert_eq!(
            s.add(utc("2026-11-21T12:00:00Z"), 1800),
            utc("2026-11-23T08:30:00Z")
        );
        assert_eq!(s.between(friday, utc("2026-11-23T09:00:00Z")), 7200);
        // Before opening: the clock starts at 08:00.
        assert_eq!(
            s.add(utc("2026-11-23T06:00:00Z"), 60),
            utc("2026-11-23T08:01:00Z")
        );
        // Exactly the remaining minutes of a day end at closing time.
        assert_eq!(
            s.add(utc("2026-11-23T17:00:00Z"), 3600),
            utc("2026-11-23T18:00:00Z")
        );
    }

    #[test]
    fn holidays_are_skipped() {
        let s = hours(
            "UTC",
            &[1, 2, 3, 4, 5],
            "08:00",
            "18:00",
            &["2026-12-24", "2026-12-25"],
        );
        // Wednesday 23rd 17:00 + 2 h: Thu 24th and Fri 25th are holidays → Monday 28th 09:00.
        assert_eq!(
            s.add(utc("2026-12-23T17:00:00Z"), 7200),
            utc("2026-12-28T09:00:00Z")
        );
        assert_eq!(
            s.between(utc("2026-12-24T00:00:00Z"), utc("2026-12-26T00:00:00Z")),
            0
        );
    }

    #[test]
    fn overnight_windows_cross_midnight() {
        // Night shift 22:00–06:00, Monday to Friday nights.
        let s = hours("UTC", &[1, 2, 3, 4, 5], "22:00", "06:00", &[]);
        // Tuesday 05:00 is inside Monday night's window: 1 h left, then Tuesday 22:00.
        assert_eq!(
            s.add(utc("2026-11-24T05:00:00Z"), 2 * 3600),
            utc("2026-11-24T23:00:00Z")
        );
        // Daytime counts nothing.
        assert_eq!(
            s.between(utc("2026-11-24T06:00:00Z"), utc("2026-11-24T22:00:00Z")),
            0
        );
        assert_eq!(
            s.between(utc("2026-11-23T21:00:00Z"), utc("2026-11-24T07:00:00Z")),
            8 * 3600
        );
        // Friday night runs into Saturday morning; Saturday night is not a business night.
        assert_eq!(
            s.add(utc("2026-11-28T05:00:00Z"), 2 * 3600),
            utc("2026-11-30T23:00:00Z")
        );
    }

    #[test]
    fn time_zones_and_dst_apply() {
        // New York 09:00–17:00: Friday 16:30 local (21:30 UTC in November) + 60 min →
        // Monday 09:30 local = 14:30 UTC.
        let s = hours("America/New_York", &[1, 2, 3, 4, 5], "09:00", "17:00", &[]);
        assert_eq!(
            s.add(utc("2026-11-20T21:30:00Z"), 3600),
            utc("2026-11-23T14:30:00Z")
        );
        // Across the November DST change (2026-11-01): Friday Oct 30 16:00 EDT (20:00 UTC)
        // + 2 h → Monday Nov 2 10:00 EST (15:00 UTC).
        assert_eq!(
            s.add(utc("2026-10-30T20:00:00Z"), 7200),
            utc("2026-11-02T15:00:00Z")
        );
        // A full business day is 8 h on both sides of the change.
        assert_eq!(
            s.between(utc("2026-11-02T00:00:00Z"), utc("2026-11-03T00:00:00Z")),
            8 * 3600
        );
        // `24:00` ends at midnight.
        let late = hours(
            "Europe/Berlin",
            &[1, 2, 3, 4, 5, 6, 7],
            "20:00",
            "24:00",
            &[],
        );
        assert_eq!(
            late.add(utc("2026-11-20T18:00:00Z"), 4 * 3600 + 60),
            utc("2026-11-21T19:01:00Z")
        );
    }

    #[test]
    fn hours_validate() {
        let mut h = BusinessHours {
            timezone: "Europe/London".into(),
            days: vec![5, 1, 1, 3],
            start: "08:00".into(),
            end: "18:00".into(),
            holidays: vec!["2026-12-25".into(), "2026-12-25".into()],
        };
        h.validate().expect("valid");
        assert_eq!(h.days, vec![1, 3, 5]);
        assert_eq!(h.holidays.len(), 1);
        let mut bad = h.clone();
        bad.timezone = "Mars/Base".into();
        assert!(bad.validate().is_err());
        let mut bad = h.clone();
        bad.days = vec![0];
        assert!(bad.validate().is_err());
        let mut bad = h.clone();
        bad.end = "08:00".into();
        assert!(bad.validate().is_err());
        let mut bad = h;
        bad.holidays = vec!["25/12/2026".into()];
        assert!(bad.validate().is_err());
        assert_eq!(parse_hhmm("24:00"), Some(1440));
        assert_eq!(parse_hhmm("24:01"), None);
        assert_eq!(parse_hhmm("7:30"), Some(450));
        assert_eq!(parse_hhmm("07:3"), None);
    }

    fn policy(hours: Option<BusinessHours>) -> Policy {
        Policy {
            id: "p".into(),
            name: "P".into(),
            client_ids: Vec::new(),
            business_hours: hours,
            targets: Targets {
                urgent: Target {
                    first_response_minutes: 30,
                    resolution_minutes: 240,
                },
                high: Target {
                    first_response_minutes: 60,
                    resolution_minutes: 480,
                },
                normal: Target {
                    first_response_minutes: 120,
                    resolution_minutes: 240,
                },
                low: Target {
                    first_response_minutes: 480,
                    resolution_minutes: 2400,
                },
            },
            pause_on: vec!["pending".into(), "on_hold".into()],
        }
    }

    #[test]
    fn pause_and_resume_move_due_times() {
        let p = policy(Some(BusinessHours {
            timezone: "UTC".into(),
            days: vec![1, 2, 3, 4, 5],
            start: "09:00".into(),
            end: "17:00".into(),
            holidays: Vec::new(),
        }));
        let created = utc("2026-11-23T09:00:00Z"); // Monday
        let mut c = Clock::default();
        c.recompute(Some(&p), "normal", created, created);
        assert_eq!(c.first_response_due, Some(utc("2026-11-23T11:00:00Z")));
        assert_eq!(c.resolution_due, Some(utc("2026-11-23T13:00:00Z")));

        // Pending at 10:00, resumed at 15:00: 5 business hours paused.
        c.on_status(
            Some(&p),
            "normal",
            created,
            "pending",
            utc("2026-11-23T10:00:00Z"),
        );
        assert!(c.paused_at.is_some());
        // While paused nothing breaches, even past the old due time.
        c.evaluate(utc("2026-11-23T14:00:00Z"));
        assert!(!c.resolution_breached && !c.first_response_breached);
        c.on_status(
            Some(&p),
            "normal",
            created,
            "open",
            utc("2026-11-23T15:00:00Z"),
        );
        assert_eq!(c.pause_seconds, 5 * 3600);
        // 3 h remained at the pause: 15:00–17:00 plus Tuesday 09:00–10:00.
        assert_eq!(c.resolution_due, Some(utc("2026-11-24T10:00:00Z")));
        assert_eq!(c.first_response_due, Some(utc("2026-11-23T16:00:00Z")));
        assert!(!c.resolution_breached);

        // First response at 16:30 is late (due 16:00).
        c.on_first_response(utc("2026-11-23T16:30:00Z"));
        assert!(c.first_response_breached);

        // Resolved on time; reopening clears the resolution and restarts the clock.
        c.on_status(
            Some(&p),
            "normal",
            created,
            "resolved",
            utc("2026-11-24T09:30:00Z"),
        );
        assert_eq!(c.resolved_at, Some(utc("2026-11-24T09:30:00Z")));
        assert!(!c.resolution_breached);
        c.on_status(
            Some(&p),
            "normal",
            created,
            "open",
            utc("2026-11-24T09:45:00Z"),
        );
        assert_eq!(c.resolved_at, None);
        assert_eq!(c.resolution_due, Some(utc("2026-11-24T10:15:00Z")));
        c.evaluate(utc("2026-11-24T11:00:00Z"));
        assert!(c.resolution_breached);
    }

    #[test]
    fn pause_after_breach_stays_breached_and_priority_recomputes() {
        let p = policy(None);
        let created = utc("2026-11-23T09:00:00Z");
        let mut c = Clock::default();
        c.recompute(Some(&p), "urgent", created, created);
        assert_eq!(c.first_response_due, Some(utc("2026-11-23T09:30:00Z")));
        // Paused after the first-response due time: breached.
        c.on_status(
            Some(&p),
            "urgent",
            created,
            "on_hold",
            utc("2026-11-23T10:00:00Z"),
        );
        assert!(c.first_response_breached);
        c.on_status(
            Some(&p),
            "urgent",
            created,
            "open",
            utc("2026-11-23T11:00:00Z"),
        );
        assert!(c.first_response_breached, "a resume never clears a breach");
        // Lowering the priority recomputes from creation (plus the pause).
        c.recompute(Some(&p), "low", created, utc("2026-11-23T11:00:00Z"));
        assert_eq!(c.first_response_due, Some(utc("2026-11-23T18:00:00Z")));
        assert!(!c.first_response_breached);
        // Without a pause_on entry, pending does not stop the clock.
        let mut no_pause = policy(None);
        no_pause.pause_on.clear();
        let mut c = Clock::default();
        c.recompute(Some(&no_pause), "normal", created, created);
        c.on_status(Some(&no_pause), "normal", created, "pending", created);
        assert!(c.paused_at.is_none());
    }
}
