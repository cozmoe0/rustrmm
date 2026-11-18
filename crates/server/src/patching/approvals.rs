//! Patch approvals: global and per-client decisions, rule approvals with ring delays, and the
//! effective approval of a patch for one device.
//!
//! Precedence for a device in client C: a manual decision for C, then a manual global decision,
//! then a rule approval for C, then a global rule approval. An expired deferral counts as no
//! decision at its level.

use std::collections::{HashMap, HashSet};

use axum::Json;
use axum::extract::State;
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{QueryBuilder, Sqlite};

use super::policy::DelayDays;
use crate::auth::AuthCtx;
use crate::db::Db;
use crate::error::{ApiError, ApiResult};
use crate::rbac::perm;
use crate::state::AppState;

/// One stored decision.
#[derive(Debug, Clone, PartialEq)]
pub struct Approval {
    pub decision: String,
    pub until: Option<DateTime<Utc>>,
    pub source: String,
    pub at: DateTime<Utc>,
    pub by_name: String,
    pub client_id: Option<String>,
    pub delay_days: DelayDays,
}

impl Approval {
    /// The decision is in force at `now` (an expired deferral is not).
    pub fn active(&self, now: DateTime<Utc>) -> bool {
        self.decision != "deferred" || self.until.is_some_and(|u| u > now)
    }

    pub fn to_json(&self) -> Value {
        let mut v = json!({ "status": self.decision, "source": self.source, "at": self.at,
                            "by_name": self.by_name, "client_id": self.client_id });
        if self.decision == "approved" {
            v["approved_at"] = json!(self.at);
        }
        if self.decision == "deferred" {
            v["until"] = json!(self.until);
        }
        v
    }
}

/// Every decision on one patch.
#[derive(Debug, Clone, Default)]
pub struct PatchApprovals {
    pub global: Option<Approval>,
    pub clients: HashMap<String, Approval>,
}

impl PatchApprovals {
    /// The decision that applies to a client (`None` = the global view).
    pub fn effective_for(&self, client_id: Option<&str>, now: DateTime<Utc>) -> Option<&Approval> {
        let client = client_id
            .and_then(|c| self.clients.get(c))
            .filter(|a| a.active(now));
        let global = self.global.as_ref().filter(|a| a.active(now));
        let manual = |a: &&Approval| a.source == "manual";
        let rule = |a: &&Approval| a.source != "manual";
        client
            .filter(manual)
            .or(global.filter(manual))
            .or(client.filter(rule))
            .or(global.filter(rule))
    }

    /// When the patch becomes (or became) effective-approved for a device, or `None` when it is
    /// not approved. `base` is the release date (or first-seen time).
    pub fn effective_since(
        &self,
        client_id: &str,
        ring: &str,
        base: DateTime<Utc>,
        now: DateTime<Utc>,
    ) -> Option<DateTime<Utc>> {
        let approval = self.effective_for(Some(client_id), now)?;
        if approval.decision != "approved" {
            return None;
        }
        let ready = base + chrono::Duration::days(approval.delay_days.for_ring(ring));
        Some(ready.max(approval.at))
    }

    /// Approved and past the ring delay at `now`.
    pub fn effective_approved(
        &self,
        client_id: &str,
        ring: &str,
        base: DateTime<Utc>,
        now: DateTime<Utc>,
    ) -> bool {
        let Some(approval) = self.effective_for(Some(client_id), now) else {
            return false;
        };
        approval.decision == "approved"
            && now >= base + chrono::Duration::days(approval.delay_days.for_ring(ring))
    }
}

/// `release_date` when known, otherwise `first_seen_at`.
pub fn base_date(release_date: Option<&str>, first_seen: DateTime<Utc>) -> DateTime<Utc> {
    release_date.and_then(parse_date).unwrap_or(first_seen)
}

/// RFC 3339 or `YYYY-MM-DD`.
pub fn parse_date(raw: &str) -> Option<DateTime<Utc>> {
    let raw = raw.trim();
    if let Ok(t) = DateTime::parse_from_rfc3339(raw) {
        return Some(t.with_timezone(&Utc));
    }
    chrono::NaiveDate::parse_from_str(raw.get(..10)?, "%Y-%m-%d")
        .ok()
        .and_then(|d| d.and_hms_opt(0, 0, 0))
        .map(|d| d.and_utc())
}

#[derive(sqlx::FromRow)]
struct ApprovalRow {
    patch_id: String,
    client_id: Option<String>,
    decision: String,
    until: Option<DateTime<Utc>>,
    source: String,
    by_name: String,
    at: DateTime<Utc>,
    delay_days: String,
}

/// Decisions for the given patches (all patches when `None`).
pub async fn load(
    db: &Db,
    patch_ids: Option<&[String]>,
) -> anyhow::Result<HashMap<String, PatchApprovals>> {
    let mut rows: Vec<ApprovalRow> = Vec::new();
    let select = "SELECT patch_id, client_id, decision, until, source, by_name, at, delay_days FROM patch_approvals";
    match patch_ids {
        None => {
            rows = sqlx::query_as(select).fetch_all(db).await?;
        }
        Some(ids) => {
            for chunk in ids.chunks(500) {
                let mut qb = QueryBuilder::<Sqlite>::new(select);
                qb.push(" WHERE patch_id IN (");
                let mut sep = qb.separated(", ");
                for id in chunk {
                    sep.push_bind(id.clone());
                }
                qb.push(")");
                rows.extend(qb.build_query_as::<ApprovalRow>().fetch_all(db).await?);
            }
        }
    }
    let mut map: HashMap<String, PatchApprovals> = HashMap::new();
    for row in rows {
        let approval = Approval {
            decision: row.decision,
            until: row.until,
            source: row.source,
            at: row.at,
            by_name: row.by_name,
            client_id: row.client_id.clone(),
            delay_days: serde_json::from_str(&row.delay_days).unwrap_or_default(),
        };
        let entry = map.entry(row.patch_id).or_default();
        match row.client_id {
            Some(c) => {
                entry.clients.insert(c, approval);
            }
            None => entry.global = Some(approval),
        }
    }
    Ok(map)
}

/// Records a rule approval for a client unless that client already has a decision.
pub async fn insert_rule_approval(
    db: &Db,
    patch_id: &str,
    client_id: &str,
    policy_id: Option<&str>,
    delay: DelayDays,
) -> anyhow::Result<bool> {
    let inserted = sqlx::query(
        "INSERT OR IGNORE INTO patch_approvals (id, patch_id, client_id, decision, source, by_name, at, policy_id, delay_days)
         VALUES (?, ?, ?, 'approved', 'rule', 'Auto-approval rule', ?, ?, ?)",
    )
    .bind(rustrmm_common::new_id())
    .bind(patch_id)
    .bind(client_id)
    .bind(rustrmm_common::now())
    .bind(policy_id)
    .bind(serde_json::to_string(&delay)?)
    .execute(db)
    .await?
    .rows_affected();
    Ok(inserted > 0)
}

// ------------------------------------------------------------------ API

#[derive(Deserialize)]
pub struct ApproveBody {
    ids: Vec<String>,
    #[serde(default)]
    client_id: Option<String>,
    decision: String,
    #[serde(default)]
    until: Option<DateTime<Utc>>,
}

/// `POST /api/v1/patches/approve`
#[utoipa::path(post, path = "/api/v1/patches/approve", tag = "Patching", summary = "Approve", request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn approve(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Json(body): Json<ApproveBody>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::PATCHES_APPROVE)?;
    if body.ids.is_empty() || body.ids.len() > 1000 {
        return Err(ApiError::validation("ids must hold 1–1000 patch ids"));
    }
    let client_id = body.client_id.clone().filter(|c| !c.is_empty());
    match &client_id {
        None => ctx.require_global(perm::PATCHES_APPROVE)?,
        Some(c) => {
            let found: Option<String> = sqlx::query_scalar("SELECT id FROM clients WHERE id = ?")
                .bind(c)
                .fetch_optional(&state.db)
                .await?;
            if found.is_none() || !ctx.scope.can_see_client(perm::PATCHES_VIEW, c) {
                return Err(ApiError::validation("Unknown client"));
            }
            ctx.require_client(perm::PATCHES_APPROVE, c)?;
        }
    }
    let action: &'static str = match body.decision.as_str() {
        "approved" => "patch.approved",
        "declined" => "patch.declined",
        "deferred" => "patch.deferred",
        "none" => "patch.approval_cleared",
        _ => {
            return Err(ApiError::validation(
                "decision must be approved, declined, deferred or none",
            ));
        }
    };
    let now = rustrmm_common::now();
    if body.decision == "deferred" && !body.until.is_some_and(|u| u > now) {
        return Err(ApiError::validation(
            "A deferral needs a future `until` date",
        ));
    }
    let mut ids: Vec<String> = body.ids.clone();
    ids.sort();
    ids.dedup();
    let known: HashSet<String> = {
        let mut known = HashSet::new();
        for chunk in ids.chunks(500) {
            let mut qb = QueryBuilder::<Sqlite>::new("SELECT id FROM patch_catalog WHERE id IN (");
            let mut sep = qb.separated(", ");
            for id in chunk {
                sep.push_bind(id.clone());
            }
            qb.push(")");
            let rows: Vec<String> = qb.build_query_scalar().fetch_all(&state.db).await?;
            known.extend(rows);
        }
        known
    };
    if known.len() != ids.len() {
        return Err(ApiError::validation("Unknown patch id").with_details(json!({ "path": "ids" })));
    }
    let mut tx = state.db.begin().await?;
    for id in &ids {
        let scope_match = "patch_id = ? AND COALESCE(client_id, '') = COALESCE(?, '')";
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "DELETE FROM patch_approvals WHERE {scope_match}"
        )))
        .bind(id)
        .bind(&client_id)
        .execute(&mut *tx)
        .await?;
        if body.decision != "none" {
            sqlx::query(
                "INSERT INTO patch_approvals (id, patch_id, client_id, decision, until, source, by, by_name, at, delay_days)
                 VALUES (?, ?, ?, ?, ?, 'manual', ?, ?, ?, '{}')",
            )
            .bind(rustrmm_common::new_id())
            .bind(id)
            .bind(&client_id)
            .bind(&body.decision)
            .bind(if body.decision == "deferred" { body.until } else { None })
            .bind(&ctx.user.id)
            .bind(&ctx.user.name)
            .bind(now)
            .execute(&mut *tx)
            .await?;
        }
    }
    tx.commit().await?;
    let mut entry = ctx.audit(action).details(json!({
        "ids": ids.iter().take(100).collect::<Vec<_>>(), "count": ids.len(),
        "client_id": client_id, "until": body.until,
    }));
    if let Some(c) = &client_id {
        entry = entry.client(c);
    }
    state.audit.record_or_log(&state.db, entry).await;
    state
        .events
        .publish("patches.changed", client_id.clone(), json!({}));
    Ok(Json(json!({ "updated": ids.len() })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(days_ago: i64) -> DateTime<Utc> {
        rustrmm_common::now() - chrono::Duration::days(days_ago)
    }

    fn approval(decision: &str, source: &str, client: Option<&str>, delay: DelayDays) -> Approval {
        Approval {
            decision: decision.into(),
            until: None,
            source: source.into(),
            at: at(30),
            by_name: "x".into(),
            client_id: client.map(str::to_string),
            delay_days: delay,
        }
    }

    #[test]
    fn rule_approval_waits_for_the_ring_delay() {
        let now = rustrmm_common::now();
        let delay = DelayDays {
            pilot: 0,
            broad: 7,
            late: 21,
        };
        let mut approvals = PatchApprovals::default();
        approvals
            .clients
            .insert("c1".into(), approval("approved", "rule", Some("c1"), delay));
        // Released 10 days ago: pilot and broad are due, late is not.
        let released = at(10);
        assert!(approvals.effective_approved("c1", "pilot", released, now));
        assert!(approvals.effective_approved("c1", "broad", released, now));
        assert!(!approvals.effective_approved("c1", "late", released, now));
        // Released yesterday: only pilot.
        let fresh = at(1);
        assert!(approvals.effective_approved("c1", "pilot", fresh, now));
        assert!(!approvals.effective_approved("c1", "broad", fresh, now));
        // Another client has no decision at all.
        assert!(!approvals.effective_approved("c2", "pilot", released, now));
        let since = approvals
            .effective_since("c1", "broad", fresh, now)
            .expect("approved");
        assert!(since > now, "becomes effective in the future");
    }

    #[test]
    fn client_override_beats_global_and_manual_beats_rules() {
        let now = rustrmm_common::now();
        let base = at(3);
        let mut approvals = PatchApprovals {
            global: Some(approval("declined", "manual", None, DelayDays::default())),
            clients: HashMap::new(),
        };
        assert!(!approvals.effective_approved("c1", "broad", base, now));
        // A client-level approval overrides the global decline for that client only.
        approvals.clients.insert(
            "c1".into(),
            approval("approved", "manual", Some("c1"), DelayDays::default()),
        );
        assert!(approvals.effective_approved("c1", "broad", base, now));
        assert!(!approvals.effective_approved("c2", "broad", base, now));
        // A rule approval never beats a manual global decline.
        approvals.clients.insert(
            "c2".into(),
            approval("approved", "rule", Some("c2"), DelayDays::default()),
        );
        assert!(!approvals.effective_approved("c2", "broad", base, now));
        // A deferral blocks until it expires, then the next level applies.
        let mut deferred = approval("deferred", "manual", Some("c1"), DelayDays::default());
        deferred.until = Some(now + chrono::Duration::days(1));
        approvals.clients.insert("c1".into(), deferred.clone());
        assert!(!approvals.effective_approved("c1", "broad", base, now));
        deferred.until = Some(now - chrono::Duration::days(1));
        approvals.clients.insert("c1".into(), deferred);
        assert_eq!(
            approvals
                .effective_for(Some("c1"), now)
                .map(|a| a.decision.as_str()),
            Some("declined"),
            "expired deferral falls back to the global decision"
        );
        assert!(parse_date("2026-11-10").is_some());
        assert!(parse_date("2026-11-10T08:00:00Z").is_some());
        assert!(parse_date("soon").is_none());
    }
}
