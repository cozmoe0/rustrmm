//! Ticket rows and their JSON shape, creation, changes (with activity, SLA, e-mail and
//! events), comments and the activity log.

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde_json::{Map, Value, json};
use sqlx::{QueryBuilder, Sqlite};

use super::sla::{self, Clock};
use super::{email, publish_counts, queues};
use crate::auth::AuthCtx;
use crate::db::Db;
use crate::rbac::AccessScope;
use crate::state::AppState;

/// Who performed a ticket action.
#[derive(Debug, Clone)]
pub struct Who {
    /// `user` | `contact` | `system`
    pub kind: &'static str,
    pub id: Option<String>,
    pub name: String,
}

impl Who {
    pub fn system() -> Self {
        Self {
            kind: "system",
            id: None,
            name: "System".into(),
        }
    }

    pub fn user(ctx: &AuthCtx) -> Self {
        Self {
            kind: "user",
            id: Some(ctx.user.id.clone()),
            name: ctx.user.name.clone(),
        }
    }

    pub fn contact(id: Option<String>, name: impl Into<String>) -> Self {
        Self {
            kind: "contact",
            id,
            name: name.into(),
        }
    }

    pub fn user_id(&self) -> Option<&str> {
        (self.kind == "user")
            .then_some(self.id.as_deref())
            .flatten()
    }
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct TicketRow {
    pub id: String,
    pub number: i64,
    pub subject: String,
    pub description: String,
    pub client_id: String,
    pub client_name: String,
    pub site_id: Option<String>,
    pub site_name: Option<String>,
    pub contact_id: Option<String>,
    pub contact_name: Option<String>,
    pub contact_email: Option<String>,
    pub contact_notify: Option<bool>,
    pub status: String,
    pub priority: String,
    pub kind: String,
    pub queue_id: Option<String>,
    pub queue_name: Option<String>,
    pub assignee_id: Option<String>,
    pub assignee_name: Option<String>,
    pub assignee_email: Option<String>,
    pub tags: String,
    pub cc: String,
    pub source: String,
    pub sla_policy_id: Option<String>,
    pub sla_policy_name: Option<String>,
    pub first_response_due: Option<DateTime<Utc>>,
    pub first_response_at: Option<DateTime<Utc>>,
    pub first_response_breached: bool,
    pub resolution_due: Option<DateTime<Utc>>,
    pub resolved_at: Option<DateTime<Utc>>,
    pub resolution_breached: bool,
    pub sla_paused_at: Option<DateTime<Utc>>,
    pub sla_pause_seconds: i64,
    pub alert_rule_id: Option<String>,
    pub close_on_alert_resolve: bool,
    pub merged_into: Option<String>,
    pub merged_number: Option<i64>,
    pub created_by: Option<String>,
    pub created_by_name: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub last_activity_at: DateTime<Utc>,
    pub closed_at: Option<DateTime<Utc>>,
    pub time_spent: i64,
    pub billable: i64,
}

pub const TICKET_SELECT: &str = "SELECT t.id, t.number, t.subject, t.description, t.client_id, c.name AS client_name,
    t.site_id, s.name AS site_name, t.contact_id, ct.name AS contact_name, ct.email AS contact_email, ct.notify AS contact_notify,
    t.status, t.priority, t.type AS kind, t.queue_id, q.name AS queue_name, t.assignee_id, u.name AS assignee_name,
    u.email AS assignee_email, t.tags, t.cc, t.source, t.sla_policy_id, sp.name AS sla_policy_name, t.first_response_due,
    t.first_response_at, t.first_response_breached, t.resolution_due, t.resolved_at, t.resolution_breached, t.sla_paused_at,
    t.sla_pause_seconds, t.alert_rule_id, t.close_on_alert_resolve, t.merged_into, m.number AS merged_number, t.created_by,
    t.created_by_name, t.created_at, t.updated_at, t.last_activity_at, t.closed_at,
    COALESCE((SELECT SUM(te.minutes) FROM time_entries te WHERE te.ticket_id = t.id), 0) AS time_spent,
    COALESCE((SELECT SUM(te.minutes) FROM time_entries te WHERE te.ticket_id = t.id AND te.billable = 1), 0) AS billable
    FROM tickets t JOIN clients c ON c.id = t.client_id LEFT JOIN sites s ON s.id = t.site_id
    LEFT JOIN contacts ct ON ct.id = t.contact_id LEFT JOIN ticket_queues q ON q.id = t.queue_id
    LEFT JOIN users u ON u.id = t.assignee_id LEFT JOIN sla_policies sp ON sp.id = t.sla_policy_id
    LEFT JOIN tickets m ON m.id = t.merged_into";

impl TicketRow {
    pub fn visible(&self, scope: &AccessScope, permission: &str) -> bool {
        super::visible(scope, permission, &self.client_id, self.site_id.as_deref())
    }

    pub fn clock(&self) -> Clock {
        Clock {
            policy_id: self.sla_policy_id.clone(),
            first_response_due: self.first_response_due,
            first_response_at: self.first_response_at,
            first_response_breached: self.first_response_breached,
            resolution_due: self.resolution_due,
            resolved_at: self.resolved_at,
            resolution_breached: self.resolution_breached,
            paused_at: self.sla_paused_at,
            pause_seconds: self.sla_pause_seconds,
        }
    }

    pub fn tags(&self) -> Vec<String> {
        super::json_strings(&self.tags)
    }

    pub fn cc(&self) -> Vec<String> {
        super::json_strings(&self.cc)
    }

    pub fn is_active(&self) -> bool {
        super::ACTIVE_STATUSES.contains(&self.status.as_str())
    }

    pub fn to_json(&self, links: Option<&Links>) -> Value {
        let empty = Links::default();
        let links = links.unwrap_or(&empty);
        let sla = self.sla_policy_id.as_ref().map(|policy_id| {
            json!({
                "policy_id": policy_id, "policy_name": self.sla_policy_name,
                "first_response_due": self.first_response_due, "first_response_at": self.first_response_at,
                "first_response_breached": self.first_response_breached,
                "resolution_due": self.resolution_due, "resolved_at": self.resolved_at,
                "resolution_breached": self.resolution_breached,
                "paused": self.sla_paused_at.is_some() && self.is_active(),
            })
        });
        json!({
            "id": self.id, "number": self.number, "subject": self.subject, "description": self.description,
            "client_id": self.client_id, "client_name": self.client_name,
            "site_id": self.site_id, "site_name": self.site_name,
            "contact": self.contact_id.as_ref().map(|id| json!({ "id": id, "name": self.contact_name, "email": self.contact_email })),
            "status": self.status, "priority": self.priority, "type": self.kind,
            "queue": self.queue_id.as_ref().map(|id| json!({ "id": id, "name": self.queue_name })),
            "assignee": self.assignee_id.as_ref().map(|id| json!({ "id": id, "name": self.assignee_name })),
            "tags": self.tags(), "cc": self.cc(),
            "devices": links.devices, "alerts": links.alerts, "tickets": links.tickets,
            "source": self.source, "sla": sla,
            "time_spent_minutes": self.time_spent, "billable_minutes": self.billable,
            "created_by_name": self.created_by_name, "created_at": self.created_at,
            "updated_at": self.updated_at, "last_activity_at": self.last_activity_at, "closed_at": self.closed_at,
            "merged_into": self.merged_into.as_ref().map(|id| json!({ "id": id, "number": self.merged_number })),
        })
    }
}

pub async fn load(db: &Db, id: &str) -> anyhow::Result<Option<TicketRow>> {
    Ok(sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{TICKET_SELECT} WHERE t.id = ?"
    )))
    .bind(id)
    .fetch_optional(db)
    .await?)
}

pub async fn load_by_number(db: &Db, number: i64) -> anyhow::Result<Option<TicketRow>> {
    Ok(sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{TICKET_SELECT} WHERE t.number = ?"
    )))
    .bind(number)
    .fetch_optional(db)
    .await?)
}

/// Follows `merged_into` to the surviving ticket (at most 10 hops).
pub async fn resolve_merged(db: &Db, mut ticket: TicketRow) -> anyhow::Result<TicketRow> {
    for _ in 0..10 {
        let Some(next) = ticket.merged_into.clone() else {
            break;
        };
        match load(db, &next).await? {
            Some(t) => ticket = t,
            None => break,
        }
    }
    Ok(ticket)
}

/// Linked devices, alerts and tickets of one ticket.
#[derive(Debug, Clone, Default)]
pub struct Links {
    pub devices: Vec<Value>,
    pub alerts: Vec<Value>,
    pub tickets: Vec<Value>,
}

pub async fn load_links(db: &Db, ids: &[String]) -> anyhow::Result<HashMap<String, Links>> {
    let mut out: HashMap<String, Links> = HashMap::new();
    if ids.is_empty() {
        return Ok(out);
    }
    let mut qb = QueryBuilder::<Sqlite>::new(
        "SELECT l.ticket_id, l.kind, l.target_id, d.hostname, a.title, a.status, o.number, o.subject, o.status
         FROM ticket_links l
         LEFT JOIN devices d ON l.kind = 'device' AND d.id = l.target_id
         LEFT JOIN alerts a ON l.kind = 'alert' AND a.id = l.target_id
         LEFT JOIN tickets o ON l.kind = 'ticket' AND o.id = l.target_id
         WHERE l.ticket_id IN (",
    );
    {
        let mut sep = qb.separated(", ");
        for id in ids {
            sep.push_bind(id.clone());
        }
    }
    qb.push(") ORDER BY l.created_at, l.target_id");
    let rows: Vec<(
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<i64>,
        Option<String>,
        Option<String>,
    )> = qb.build_query_as().fetch_all(db).await?;
    for (ticket_id, kind, target, hostname, title, alert_status, number, subject, status) in rows {
        let entry = out.entry(ticket_id).or_default();
        match kind.as_str() {
            "device" if hostname.is_some() => entry
                .devices
                .push(json!({ "id": target, "hostname": hostname })),
            "alert" if title.is_some() => entry
                .alerts
                .push(json!({ "id": target, "title": title, "status": alert_status })),
            "ticket" if number.is_some() => entry.tickets.push(
                json!({ "id": target, "number": number, "subject": subject, "status": status }),
            ),
            _ => {}
        }
    }
    Ok(out)
}

/// Ticket JSON for a page of rows (links fetched in one query).
pub async fn hydrate(db: &Db, rows: &[TicketRow]) -> anyhow::Result<Vec<Value>> {
    let ids: Vec<String> = rows.iter().map(|r| r.id.clone()).collect();
    let links = load_links(db, &ids).await?;
    Ok(rows.iter().map(|r| r.to_json(links.get(&r.id))).collect())
}

pub async fn ticket_json(db: &Db, row: &TicketRow) -> anyhow::Result<Value> {
    Ok(hydrate(db, std::slice::from_ref(row))
        .await?
        .pop()
        .unwrap_or(Value::Null))
}

// ------------------------------------------------------------------ activity

pub async fn activity(
    db: &Db,
    ticket_id: &str,
    who: &Who,
    kind: &str,
    from: Option<&str>,
    to: Option<&str>,
) -> anyhow::Result<()> {
    let clip = |s: Option<&str>| s.map(|v| v.chars().take(500).collect::<String>());
    sqlx::query("INSERT INTO ticket_activity (ticket_id, at, actor_id, actor_name, kind, from_value, to_value) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(ticket_id)
        .bind(rustrmm_common::now())
        .bind(&who.id)
        .bind(&who.name)
        .bind(kind)
        .bind(clip(from))
        .bind(clip(to))
        .execute(db)
        .await?;
    Ok(())
}

pub async fn load_activity(db: &Db, ticket_id: &str) -> anyhow::Result<Vec<Value>> {
    let rows: Vec<(DateTime<Utc>, String, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT at, actor_name, kind, from_value, to_value FROM ticket_activity WHERE ticket_id = ? ORDER BY id LIMIT 2000",
    )
    .bind(ticket_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(at, actor_name, kind, from, to)| {
            json!({ "at": at, "actor_name": actor_name, "kind": kind, "from": from, "to": to })
        })
        .collect())
}

pub async fn save_clock(db: &Db, ticket_id: &str, c: &Clock) -> anyhow::Result<()> {
    sqlx::query(
        "UPDATE tickets SET sla_policy_id = ?, first_response_due = ?, first_response_at = ?, first_response_breached = ?,
                resolution_due = ?, resolved_at = ?, resolution_breached = ?, sla_paused_at = ?, sla_pause_seconds = ?,
                updated_at = ? WHERE id = ?",
    )
    .bind(&c.policy_id)
    .bind(c.first_response_due)
    .bind(c.first_response_at)
    .bind(c.first_response_breached)
    .bind(c.resolution_due)
    .bind(c.resolved_at)
    .bind(c.resolution_breached)
    .bind(c.paused_at)
    .bind(c.pause_seconds)
    .bind(rustrmm_common::now())
    .bind(ticket_id)
    .execute(db)
    .await?;
    Ok(())
}

// ------------------------------------------------------------------ creation

/// A ticket to create. Callers validate references and scope first.
#[derive(Debug, Clone, Default)]
pub struct NewTicket {
    /// Pre-assigned id (alert rules claim the alert with it first).
    pub id: Option<String>,
    pub subject: String,
    pub description: String,
    pub client_id: String,
    pub site_id: Option<String>,
    pub contact_id: Option<String>,
    /// Defaults to the queue's priority.
    pub priority: Option<String>,
    pub kind: String,
    pub queue_id: Option<String>,
    /// Defaults to the queue's default assignee.
    pub assignee_id: Option<String>,
    pub tags: Vec<String>,
    pub cc: Vec<String>,
    pub source: &'static str,
    pub device_ids: Vec<String>,
    pub alert_ids: Vec<String>,
    /// (rule id, close the ticket when the alert resolves)
    pub alert_rule: Option<(String, bool)>,
}

pub async fn next_number(db: &Db) -> anyhow::Result<i64> {
    Ok(sqlx::query_scalar(
        "UPDATE ticket_sequence SET value = value + 1 WHERE id = 1 RETURNING value",
    )
    .fetch_one(db)
    .await?)
}

/// Creates a ticket: number, queue defaults, SLA, links, activity, e-mail and events.
pub async fn create(state: &AppState, new: NewTicket, who: &Who) -> anyhow::Result<TicketRow> {
    let db = &state.db;
    let now = rustrmm_common::now();
    let id = new.id.clone().unwrap_or_else(rustrmm_common::new_id);
    let queue = match &new.queue_id {
        Some(q) => queues::row(db, q).await?,
        None => None,
    };
    let queue = match queue {
        Some(q) => q,
        None => queues::row(db, queues::DEFAULT_QUEUE_ID)
            .await?
            .ok_or_else(|| anyhow::anyhow!("the default ticket queue is missing"))?,
    };
    let priority = new
        .priority
        .clone()
        .unwrap_or_else(|| queue.default_priority.clone());
    let mut assignee = new.assignee_id.clone();
    if assignee.is_none()
        && let Some(default) = &queue.default_assignee_id
    {
        let active: Option<String> =
            sqlx::query_scalar("SELECT id FROM users WHERE id = ? AND status = 'active'")
                .bind(default)
                .fetch_optional(db)
                .await?;
        assignee = active;
    }
    let policy = sla::for_client(db, &new.client_id).await?;
    let mut clock = Clock::default();
    clock.recompute(policy.as_ref(), &priority, now, now);
    let number = next_number(db).await?;
    let (rule_id, close_on_resolve) = match &new.alert_rule {
        Some((r, c)) => (Some(r.clone()), *c),
        None => (None, false),
    };
    sqlx::query(
        "INSERT INTO tickets (id, number, subject, description, client_id, site_id, contact_id, status, priority, type, queue_id,
            assignee_id, tags, cc, source, sla_policy_id, first_response_due, resolution_due, first_response_breached,
            resolution_breached, alert_rule_id, close_on_alert_resolve, created_by, created_by_name, created_at, updated_at,
            last_activity_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(number)
    .bind(&new.subject)
    .bind(&new.description)
    .bind(&new.client_id)
    .bind(&new.site_id)
    .bind(&new.contact_id)
    .bind(&priority)
    .bind(&new.kind)
    .bind(&queue.id)
    .bind(&assignee)
    .bind(serde_json::to_string(&new.tags)?)
    .bind(serde_json::to_string(&new.cc)?)
    .bind(new.source)
    .bind(&clock.policy_id)
    .bind(clock.first_response_due)
    .bind(clock.resolution_due)
    .bind(clock.first_response_breached)
    .bind(clock.resolution_breached)
    .bind(&rule_id)
    .bind(close_on_resolve)
    .bind(who.user_id())
    .bind(&who.name)
    .bind(now)
    .bind(now)
    .bind(now)
    .execute(db)
    .await?;
    for device in &new.device_ids {
        link(db, &id, "device", device).await?;
    }
    let mut claimed_alerts = Vec::new();
    for alert in &new.alert_ids {
        link(db, &id, "alert", alert).await?;
        let claimed = sqlx::query(
            "UPDATE alerts SET ticket_id = ? WHERE id = ? AND (ticket_id IS NULL OR ticket_id = ?)",
        )
        .bind(&id)
        .bind(alert)
        .bind(&id)
        .execute(db)
        .await?
        .rows_affected();
        if claimed == 1 {
            claimed_alerts.push(alert.clone());
        }
    }
    activity(db, &id, who, "created", None, Some(new.source)).await?;
    for alert in &claimed_alerts {
        let actor = who.user_id().map(|uid| (uid, who.name.as_str()));
        crate::monitoring::alerts::add_event(
            db,
            alert,
            "ticket_created",
            actor,
            &format!("Ticket #{number} created"),
            json!({ "ticket_id": id, "number": number, "rule_id": rule_id }),
        )
        .await?;
        crate::monitoring::alerts::publish(state, alert, false).await;
    }
    let row = load(db, &id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("ticket vanished after insert"))?;
    email::on_created(state, &row).await;
    if let Some(a) = &row.assignee_id
        && who.user_id() != Some(a.as_str())
    {
        email::on_assigned(state, &row).await;
    }
    let value = ticket_json(db, &row).await?;
    state.events.publish(
        "ticket.created",
        Some(row.client_id.clone()),
        json!({ "ticket": value }),
    );
    publish_counts(state, &row.client_id);
    Ok(row)
}

pub async fn link(db: &Db, ticket_id: &str, kind: &str, target: &str) -> anyhow::Result<bool> {
    let done = sqlx::query(
        "INSERT OR IGNORE INTO ticket_links (ticket_id, kind, target_id, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(ticket_id)
    .bind(kind)
    .bind(target)
    .bind(rustrmm_common::now())
    .execute(db)
    .await?;
    Ok(done.rows_affected() == 1)
}

// ------------------------------------------------------------------ changes

/// A partial update. `Some(None)` clears a nullable reference.
#[derive(Debug, Clone, Default)]
pub struct Changes {
    pub subject: Option<String>,
    pub description: Option<String>,
    pub status: Option<String>,
    pub priority: Option<String>,
    pub kind: Option<String>,
    pub queue_id: Option<String>,
    pub assignee_id: Option<Option<String>>,
    pub contact_id: Option<Option<String>>,
    pub site_id: Option<Option<String>>,
    pub client_id: Option<String>,
    pub tags: Option<Vec<String>>,
    pub cc: Option<Vec<String>>,
}

async fn name_of(db: &Db, table: &str, id: Option<&str>) -> anyhow::Result<Option<String>> {
    let Some(id) = id else {
        return Ok(None);
    };
    // `table` is one of a fixed set of internal names.
    Ok(sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT name FROM {table} WHERE id = ?"
    )))
    .bind(id)
    .fetch_optional(db)
    .await?)
}

struct Recorder {
    changes: Map<String, Value>,
    activity: Vec<(&'static str, Option<String>, Option<String>)>,
}

impl Recorder {
    fn record(
        &mut self,
        field: &'static str,
        from: Value,
        to: Value,
        shown_from: Option<String>,
        shown_to: Option<String>,
    ) {
        self.changes
            .insert(field.to_string(), json!({ "from": from, "to": to }));
        self.activity.push((field, shown_from, shown_to));
    }
}

/// Applies a partial update: records activity, moves the SLA clock, sends e-mail and publishes
/// events. Returns the `changes` object (empty when nothing changed).
pub async fn apply_changes(
    state: &AppState,
    t: &TicketRow,
    ch: Changes,
    who: &Who,
) -> anyhow::Result<Value> {
    let db = &state.db;
    let now = rustrmm_common::now();
    let mut rec = Recorder {
        changes: Map::new(),
        activity: Vec::new(),
    };
    let mut subject = t.subject.clone();
    if let Some(v) = ch.subject.filter(|v| *v != t.subject) {
        rec.record(
            "subject",
            json!(t.subject),
            json!(v),
            Some(t.subject.clone()),
            Some(v.clone()),
        );
        subject = v;
    }
    let mut description = t.description.clone();
    if let Some(v) = ch.description.filter(|v| *v != t.description) {
        rec.changes
            .insert("description".into(), json!({ "from": null, "to": null }));
        rec.activity.push(("description", None, None));
        description = v;
    }
    let mut status = t.status.clone();
    if let Some(v) = ch.status.filter(|v| *v != t.status) {
        rec.record(
            "status",
            json!(t.status),
            json!(v),
            Some(t.status.clone()),
            Some(v.clone()),
        );
        status = v;
    }
    let mut priority = t.priority.clone();
    if let Some(v) = ch.priority.filter(|v| *v != t.priority) {
        rec.record(
            "priority",
            json!(t.priority),
            json!(v),
            Some(t.priority.clone()),
            Some(v.clone()),
        );
        priority = v;
    }
    let mut kind = t.kind.clone();
    if let Some(v) = ch.kind.filter(|v| *v != t.kind) {
        rec.record(
            "type",
            json!(t.kind),
            json!(v),
            Some(t.kind.clone()),
            Some(v.clone()),
        );
        kind = v;
    }
    let mut queue_id = t.queue_id.clone();
    if let Some(v) = ch.queue_id.filter(|v| Some(v) != t.queue_id.as_ref()) {
        let to = name_of(db, "ticket_queues", Some(&v)).await?;
        rec.record(
            "queue",
            json!(t.queue_id),
            json!(v),
            t.queue_name.clone(),
            to,
        );
        queue_id = Some(v);
    }
    let mut assignee_id = t.assignee_id.clone();
    if let Some(v) = ch.assignee_id.filter(|v| *v != t.assignee_id) {
        let to = name_of(db, "users", v.as_deref()).await?;
        rec.record(
            "assignee",
            json!(t.assignee_id),
            json!(v),
            t.assignee_name.clone(),
            to,
        );
        assignee_id = v;
    }
    let mut contact_id = t.contact_id.clone();
    if let Some(v) = ch.contact_id.filter(|v| *v != t.contact_id) {
        let to = name_of(db, "contacts", v.as_deref()).await?;
        rec.record(
            "contact",
            json!(t.contact_id),
            json!(v),
            t.contact_name.clone(),
            to,
        );
        contact_id = v;
    }
    let mut site_id = t.site_id.clone();
    if let Some(v) = ch.site_id.filter(|v| *v != t.site_id) {
        let to = name_of(db, "sites", v.as_deref()).await?;
        rec.record("site", json!(t.site_id), json!(v), t.site_name.clone(), to);
        site_id = v;
    }
    let mut client_id = t.client_id.clone();
    if let Some(v) = ch.client_id.filter(|v| *v != t.client_id) {
        let to = name_of(db, "clients", Some(&v)).await?;
        rec.record(
            "client",
            json!(t.client_id),
            json!(v),
            Some(t.client_name.clone()),
            to,
        );
        client_id = v;
    }
    let mut tags = t.tags();
    if let Some(v) = ch.tags.filter(|v| *v != tags) {
        rec.record(
            "tags",
            json!(tags),
            json!(v),
            Some(tags.join(", ")),
            Some(v.join(", ")),
        );
        tags = v;
    }
    let mut cc = t.cc();
    if let Some(v) = ch.cc.filter(|v| *v != cc) {
        rec.record(
            "cc",
            json!(cc),
            json!(v),
            Some(cc.join(", ")),
            Some(v.join(", ")),
        );
        cc = v;
    }
    if rec.changes.is_empty() {
        return Ok(Value::Object(rec.changes));
    }

    // SLA clock.
    let mut clock = t.clock();
    let client_changed = client_id != t.client_id;
    let policy = if client_changed {
        sla::for_client(db, &client_id).await?
    } else {
        match &clock.policy_id {
            Some(id) => sla::load(db, id).await?,
            None => sla::for_client(db, &client_id).await?,
        }
    };
    if status != t.status {
        clock.on_status(policy.as_ref(), &priority, t.created_at, &status, now);
    } else if priority != t.priority || client_changed {
        clock.recompute(policy.as_ref(), &priority, t.created_at, now);
    }
    let closed_at = if status == "closed" {
        t.closed_at.or(Some(now))
    } else {
        None
    };
    sqlx::query(
        "UPDATE tickets SET subject = ?, description = ?, status = ?, priority = ?, type = ?, queue_id = ?, assignee_id = ?,
                contact_id = ?, site_id = ?, client_id = ?, tags = ?, cc = ?, sla_policy_id = ?, first_response_due = ?,
                first_response_at = ?, first_response_breached = ?, resolution_due = ?, resolved_at = ?,
                resolution_breached = ?, sla_paused_at = ?, sla_pause_seconds = ?, closed_at = ?, updated_at = ?,
                last_activity_at = ?
         WHERE id = ?",
    )
    .bind(&subject)
    .bind(&description)
    .bind(&status)
    .bind(&priority)
    .bind(&kind)
    .bind(&queue_id)
    .bind(&assignee_id)
    .bind(&contact_id)
    .bind(&site_id)
    .bind(&client_id)
    .bind(serde_json::to_string(&tags)?)
    .bind(serde_json::to_string(&cc)?)
    .bind(&clock.policy_id)
    .bind(clock.first_response_due)
    .bind(clock.first_response_at)
    .bind(clock.first_response_breached)
    .bind(clock.resolution_due)
    .bind(clock.resolved_at)
    .bind(clock.resolution_breached)
    .bind(clock.paused_at)
    .bind(clock.pause_seconds)
    .bind(closed_at)
    .bind(now)
    .bind(now)
    .bind(&t.id)
    .execute(db)
    .await?;
    for (kind, from, to) in &rec.activity {
        activity(db, &t.id, who, kind, from.as_deref(), to.as_deref()).await?;
    }
    if let Some(row) = load(db, &t.id).await? {
        if status != t.status && status == "resolved" {
            email::on_resolved(state, &row).await;
        }
        if assignee_id != t.assignee_id
            && let Some(a) = &assignee_id
            && who.user_id() != Some(a.as_str())
        {
            email::on_assigned(state, &row).await;
        }
    }
    let changes = Value::Object(rec.changes);
    state.events.publish(
        "ticket.updated",
        Some(client_id.clone()),
        json!({ "ticket_id": t.id, "changes": changes }),
    );
    publish_counts(state, &client_id);
    if client_changed {
        state.events.publish(
            "ticket.updated",
            Some(t.client_id.clone()),
            json!({ "ticket_id": t.id, "changes": changes }),
        );
        publish_counts(state, &t.client_id);
    }
    Ok(changes)
}

// ------------------------------------------------------------------ comments

/// A file already in the blob store.
#[derive(Debug, Clone)]
pub struct StoredFile {
    pub sha256: String,
    pub size: u64,
    pub file_name: String,
    pub content_type: String,
}

#[derive(Debug, Clone)]
pub struct NewComment {
    pub author: Who,
    /// `public` | `internal`
    pub visibility: String,
    pub body: String,
    /// `console` | `email` | `agent` | `system`
    pub source: &'static str,
    pub email_message_id: Option<String>,
    pub files: Vec<StoredFile>,
}

/// Adds a comment with its attachments. A technician's public comment counts as the first
/// response, moves a `new` ticket to `open` and is e-mailed to the contact and CCs; a contact's
/// comment reopens a pending, on-hold or resolved ticket.
pub async fn add_comment(state: &AppState, t: &TicketRow, c: NewComment) -> anyhow::Result<Value> {
    let db = &state.db;
    let now = rustrmm_common::now();
    let id = rustrmm_common::new_id();
    sqlx::query(
        "INSERT INTO ticket_comments (id, ticket_id, author_type, author_id, author_name, visibility, body, source, email_message_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&t.id)
    .bind(c.author.kind)
    .bind(&c.author.id)
    .bind(&c.author.name)
    .bind(&c.visibility)
    .bind(&c.body)
    .bind(c.source)
    .bind(&c.email_message_id)
    .bind(now)
    .execute(db)
    .await?;
    let mut attachment_ids = Vec::new();
    for f in &c.files {
        let aid = rustrmm_common::new_id();
        sqlx::query(
            "INSERT INTO ticket_attachments (id, ticket_id, comment_id, sha256, size_bytes, file_name, content_type, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&aid)
        .bind(&t.id)
        .bind(&id)
        .bind(&f.sha256)
        .bind(f.size as i64)
        .bind(&f.file_name)
        .bind(&f.content_type)
        .bind(c.author.user_id())
        .bind(now)
        .execute(db)
        .await?;
        attachment_ids.push(aid);
    }
    sqlx::query("UPDATE tickets SET last_activity_at = ?, updated_at = ? WHERE id = ?")
        .bind(now)
        .bind(now)
        .bind(&t.id)
        .execute(db)
        .await?;
    let public = c.visibility == "public";
    if c.author.kind == "user" && public {
        if t.first_response_at.is_none() {
            let mut clock = t.clock();
            clock.on_first_response(now);
            save_clock(db, &t.id, &clock).await?;
        }
        if t.status == "new"
            && let Some(fresh) = load(db, &t.id).await?
        {
            apply_changes(
                state,
                &fresh,
                Changes {
                    status: Some("open".into()),
                    ..Changes::default()
                },
                &c.author,
            )
            .await?;
        }
        if let Some(row) = load(db, &t.id).await? {
            email::on_public_comment(state, &row, &c.author, &c.body, &attachment_ids).await;
        }
    } else if c.author.kind == "contact"
        && matches!(t.status.as_str(), "pending" | "on_hold" | "resolved")
    {
        apply_changes(
            state,
            t,
            Changes {
                status: Some("open".into()),
                ..Changes::default()
            },
            &c.author,
        )
        .await?;
    }
    state.events.publish(
        "ticket.comment",
        Some(t.client_id.clone()),
        json!({ "ticket_id": t.id, "comment_id": id, "visibility": c.visibility }),
    );
    load_comment(db, &id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("comment vanished after insert"))
}

#[derive(sqlx::FromRow)]
pub struct CommentRow {
    pub id: String,
    pub ticket_id: String,
    pub author_type: String,
    pub author_id: Option<String>,
    pub author_name: String,
    pub visibility: String,
    pub body: String,
    pub source: String,
    pub created_at: DateTime<Utc>,
    pub edited_at: Option<DateTime<Utc>>,
}

const COMMENT_SELECT: &str = "SELECT id, ticket_id, author_type, author_id, author_name, visibility, body, source, created_at, edited_at FROM ticket_comments";

async fn attachments_by_comment(
    db: &Db,
    ticket_id: Option<&str>,
    comment_id: Option<&str>,
) -> anyhow::Result<HashMap<String, Vec<Value>>> {
    let rows: Vec<(String, Option<String>, String, i64, String)> = sqlx::query_as(
        "SELECT id, comment_id, file_name, size_bytes, content_type FROM ticket_attachments
         WHERE (? IS NULL OR ticket_id = ?) AND (? IS NULL OR comment_id = ?) ORDER BY created_at, id",
    )
    .bind(ticket_id)
    .bind(ticket_id)
    .bind(comment_id)
    .bind(comment_id)
    .fetch_all(db)
    .await?;
    let mut out: HashMap<String, Vec<Value>> = HashMap::new();
    for (id, comment, file_name, size, content_type) in rows {
        out.entry(comment.unwrap_or_default()).or_default().push(
            json!({ "id": id, "file_name": file_name, "size_bytes": size, "content_type": content_type }),
        );
    }
    Ok(out)
}

impl CommentRow {
    fn to_json(&self, attachments: &HashMap<String, Vec<Value>>) -> Value {
        json!({
            "id": self.id, "ticket_id": self.ticket_id,
            "author": { "type": self.author_type, "id": self.author_id, "name": self.author_name },
            "visibility": self.visibility, "body": self.body, "source": self.source,
            "attachments": attachments.get(&self.id).cloned().unwrap_or_default(),
            "created_at": self.created_at, "edited_at": self.edited_at,
        })
    }
}

pub async fn load_comment_row(db: &Db, id: &str) -> anyhow::Result<Option<CommentRow>> {
    Ok(sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{COMMENT_SELECT} WHERE id = ?"
    )))
    .bind(id)
    .fetch_optional(db)
    .await?)
}

pub async fn load_comment(db: &Db, id: &str) -> anyhow::Result<Option<Value>> {
    let Some(row) = load_comment_row(db, id).await? else {
        return Ok(None);
    };
    let attachments = attachments_by_comment(db, None, Some(id)).await?;
    Ok(Some(row.to_json(&attachments)))
}

pub async fn load_comments(db: &Db, ticket_id: &str) -> anyhow::Result<Vec<Value>> {
    let rows: Vec<CommentRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{COMMENT_SELECT} WHERE ticket_id = ? ORDER BY created_at, id"
    )))
    .bind(ticket_id)
    .fetch_all(db)
    .await?;
    let attachments = attachments_by_comment(db, Some(ticket_id), None).await?;
    Ok(rows.iter().map(|r| r.to_json(&attachments)).collect())
}
