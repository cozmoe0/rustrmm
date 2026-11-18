//! Device groups: static lists and dynamic rules evaluated whenever they are used (listing
//! members, resolving job targets, applying policies).

use std::collections::{HashMap, HashSet};

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{QueryBuilder, Sqlite};

use super::rules::{self, CompiledRule, DeviceFacts, FactsFilter, RuleDocument};
use crate::auth::AuthCtx;
use crate::db::Db;
use crate::error::{ApiError, ApiResult};
use crate::rbac::{AccessScope, perm};
use crate::state::AppState;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct GroupRow {
    pub id: String,
    pub name: String,
    pub description: String,
    pub kind: String,
    pub client_id: Option<String>,
    pub client_name: Option<String>,
    pub rules: Option<String>,
    pub created_by_name: String,
    pub updated_at: DateTime<Utc>,
}

const SELECT: &str =
    "SELECT g.id, g.name, g.description, g.kind, g.client_id, c.name AS client_name, g.rules,
    g.created_by_name, g.updated_at FROM device_groups g LEFT JOIN clients c ON c.id = g.client_id";

impl GroupRow {
    pub fn rule_document(&self) -> Option<RuleDocument> {
        self.rules
            .as_deref()
            .and_then(|r| serde_json::from_str(r).ok())
    }

    fn to_json(&self, member_count: usize) -> Value {
        json!({
            "id": self.id, "name": self.name, "description": self.description, "kind": self.kind,
            "client_id": self.client_id, "client_name": self.client_name,
            "rules": if self.kind == "dynamic" { self.rule_document().map(|r| json!(r)).unwrap_or(Value::Null) } else { Value::Null },
            "member_count": member_count, "created_by_name": self.created_by_name, "updated_at": self.updated_at,
        })
    }

    /// Whether the caller can see this group at all.
    pub fn visible(&self, scope: &AccessScope) -> bool {
        match &self.client_id {
            None => scope.has_anywhere(perm::DEVICES_VIEW),
            Some(client) => scope.can_see_client(perm::DEVICES_VIEW, client),
        }
    }

    /// Whether the caller can change this group.
    pub fn manageable(&self, scope: &AccessScope) -> bool {
        match &self.client_id {
            None => scope.has_global(perm::DEVICES_MANAGE),
            Some(client) => scope.can_client(perm::DEVICES_MANAGE, client),
        }
    }
}

pub async fn load(db: &Db, id: &str) -> anyhow::Result<Option<GroupRow>> {
    Ok(
        sqlx::query_as(sqlx::AssertSqlSafe(format!("{SELECT} WHERE g.id = ?")))
            .bind(id)
            .fetch_optional(db)
            .await?,
    )
}

/// Group memberships resolved for a set of devices in one pass.
pub struct GroupIndex {
    pub facts: Vec<DeviceFacts>,
    groups: Vec<GroupRow>,
    statics: HashMap<String, HashSet<String>>,
    compiled: HashMap<String, CompiledRule>,
}

impl GroupIndex {
    /// Loads `groups` (all when `None`) and facts for `devices` (all active devices when `None`).
    pub async fn load(
        db: &Db,
        groups: Option<&[String]>,
        devices: Option<&[String]>,
    ) -> anyhow::Result<Self> {
        let mut qb = QueryBuilder::<Sqlite>::new(SELECT);
        if let Some(ids) = groups {
            if ids.is_empty() {
                qb.push(" WHERE 1 = 0");
            } else {
                qb.push(" WHERE g.id IN (");
                let mut sep = qb.separated(", ");
                for id in ids {
                    sep.push_bind(id.clone());
                }
                qb.push(")");
            }
        }
        let group_rows: Vec<GroupRow> = qb.build_query_as().fetch_all(db).await?;
        let facts = if group_rows.is_empty() {
            Vec::new()
        } else {
            rules::load_facts(
                db,
                FactsFilter {
                    client_id: None,
                    device_ids: devices,
                },
            )
            .await?
        };
        let defs = rules::custom_defs(db).await?;
        let mut compiled = HashMap::new();
        let mut static_ids = Vec::new();
        for group in &group_rows {
            if group.kind == "dynamic" {
                match group.rule_document().map(|doc| rules::compile(&doc, &defs)) {
                    Some(Ok(rule)) => {
                        compiled.insert(group.id.clone(), rule);
                    }
                    _ => {
                        tracing::warn!(group = %group.id, "dynamic group has an invalid rule; it matches nothing")
                    }
                }
            } else {
                static_ids.push(group.id.clone());
            }
        }
        let mut statics: HashMap<String, HashSet<String>> = HashMap::new();
        if !static_ids.is_empty() {
            let mut qb = QueryBuilder::<Sqlite>::new(
                "SELECT group_id, device_id FROM device_group_members WHERE group_id IN (",
            );
            let mut sep = qb.separated(", ");
            for id in &static_ids {
                sep.push_bind(id.clone());
            }
            qb.push(")");
            let rows: Vec<(String, String)> = qb.build_query_as().fetch_all(db).await?;
            for (group, device) in rows {
                statics.entry(group).or_default().insert(device);
            }
        }
        Ok(Self {
            facts,
            groups: group_rows,
            statics,
            compiled,
        })
    }

    pub fn groups(&self) -> &[GroupRow] {
        &self.groups
    }

    fn contains(&self, group: &GroupRow, device: &DeviceFacts) -> bool {
        if group
            .client_id
            .as_ref()
            .is_some_and(|c| c != &device.client_id)
        {
            return false;
        }
        if group.kind == "dynamic" {
            self.compiled
                .get(&group.id)
                .is_some_and(|rule| rule.matches(device))
        } else {
            self.statics
                .get(&group.id)
                .is_some_and(|members| members.contains(&device.id))
        }
    }

    /// Active members of a group.
    pub fn members(&self, group_id: &str) -> Vec<&DeviceFacts> {
        let Some(group) = self.groups.iter().find(|g| g.id == group_id) else {
            return Vec::new();
        };
        self.facts
            .iter()
            .filter(|d| self.contains(group, d))
            .collect()
    }

    /// Ids of the groups a device belongs to.
    pub fn groups_of(&self, device: &DeviceFacts) -> Vec<String> {
        self.groups
            .iter()
            .filter(|g| self.contains(g, device))
            .map(|g| g.id.clone())
            .collect()
    }
}

/// Active member ids of one group.
pub async fn member_ids(db: &Db, group_id: &str) -> anyhow::Result<Vec<String>> {
    let index = GroupIndex::load(db, Some(&[group_id.to_string()]), None).await?;
    Ok(index
        .members(group_id)
        .into_iter()
        .map(|d| d.id.clone())
        .collect())
}

fn visible_device(scope: &AccessScope, d: &DeviceFacts) -> bool {
    scope.can_site(perm::DEVICES_VIEW, &d.client_id, &d.site_id)
}

// ------------------------------------------------------------------ API

#[derive(Deserialize)]
pub struct ListQuery {
    client_id: Option<String>,
}

/// `GET /api/v1/groups?client_id=`
pub async fn list(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::DEVICES_VIEW)?;
    let index = GroupIndex::load(&state.db, None, None).await?;
    let mut items: Vec<Value> = index
        .groups()
        .iter()
        .filter(|g| g.visible(&ctx.scope))
        .filter(|g| {
            q.client_id
                .as_deref()
                .filter(|c| !c.is_empty())
                .is_none_or(|c| g.client_id.as_deref() == Some(c) || g.client_id.is_none())
        })
        .map(|g| {
            let count = index
                .members(&g.id)
                .into_iter()
                .filter(|d| visible_device(&ctx.scope, d))
                .count();
            g.to_json(count)
        })
        .collect();
    items.sort_by_key(|g| g["name"].as_str().unwrap_or_default().to_lowercase());
    Ok(Json(json!({ "items": items })))
}

#[derive(Deserialize)]
pub struct GroupBody {
    name: String,
    #[serde(default)]
    description: String,
    kind: String,
    #[serde(default)]
    client_id: Option<String>,
    #[serde(default)]
    rules: Option<RuleDocument>,
}

async fn validate_body(state: &AppState, body: &GroupBody) -> ApiResult<(String, Option<String>)> {
    let name = body.name.trim().to_string();
    if name.is_empty() || name.chars().count() > 120 {
        return Err(ApiError::validation("Name must be 1–120 characters"));
    }
    if body.description.chars().count() > 1000 {
        return Err(ApiError::validation("Description is too long"));
    }
    let rules = match body.kind.as_str() {
        "static" => None,
        "dynamic" => {
            let doc = body
                .rules
                .as_ref()
                .ok_or_else(|| ApiError::validation("Dynamic groups need rules"))?;
            let defs = rules::custom_defs(&state.db).await?;
            rules::compile(doc, &defs).map_err(|e| {
                ApiError::validation(format!("Invalid rule: {e}"))
                    .with_details(json!({ "path": e.split(':').next() }))
            })?;
            Some(serde_json::to_string(doc)?)
        }
        _ => return Err(ApiError::validation("kind must be static or dynamic")),
    };
    Ok((name, rules))
}

async fn group_json(state: &AppState, ctx: &AuthCtx, id: &str) -> ApiResult<Value> {
    let index = GroupIndex::load(&state.db, Some(&[id.to_string()]), None).await?;
    let group = index
        .groups()
        .first()
        .ok_or_else(|| ApiError::not_found("Group"))?;
    let count = index
        .members(id)
        .into_iter()
        .filter(|d| visible_device(&ctx.scope, d))
        .count();
    Ok(group.to_json(count))
}

/// `POST /api/v1/groups`
pub async fn create(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Json(body): Json<GroupBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let client_id = body.client_id.clone().filter(|c| !c.is_empty());
    match &client_id {
        None => ctx.require_global(perm::DEVICES_MANAGE)?,
        Some(client) => {
            let exists: Option<String> = sqlx::query_scalar("SELECT id FROM clients WHERE id = ?")
                .bind(client)
                .fetch_optional(&state.db)
                .await?;
            if exists.is_none() {
                return Err(ApiError::validation("Unknown client"));
            }
            ctx.require_client(perm::DEVICES_MANAGE, client)?;
        }
    }
    let (name, rules) = validate_body(&state, &body).await?;
    let id = rustrmm_common::new_id();
    let now = rustrmm_common::now();
    sqlx::query("INSERT INTO device_groups (id, name, description, kind, client_id, rules, created_by, created_by_name, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(&id)
        .bind(&name)
        .bind(body.description.trim())
        .bind(&body.kind)
        .bind(&client_id)
        .bind(&rules)
        .bind(&ctx.user.id)
        .bind(&ctx.user.name)
        .bind(now)
        .bind(now)
        .execute(&state.db)
        .await?;
    let mut entry = ctx
        .audit("group.created")
        .target("group", &id, &name)
        .details(json!({ "kind": body.kind }));
    if let Some(client) = &client_id {
        entry = entry.client(client);
    }
    state.audit.record_or_log(&state.db, entry).await;
    Ok((
        StatusCode::CREATED,
        Json(group_json(&state, &ctx, &id).await?),
    ))
}

async fn load_manageable(state: &AppState, ctx: &AuthCtx, id: &str) -> ApiResult<GroupRow> {
    let group = load(&state.db, id)
        .await?
        .filter(|g| g.visible(&ctx.scope))
        .ok_or_else(|| ApiError::not_found("Group"))?;
    if !group.manageable(&ctx.scope) {
        return Err(ApiError::forbidden("Missing permission: devices.manage"));
    }
    Ok(group)
}

/// `PUT /api/v1/groups/{id}`
pub async fn update(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(body): Json<GroupBody>,
) -> ApiResult<Json<Value>> {
    let group = load_manageable(&state, &ctx, &id).await?;
    if body.client_id.as_deref().filter(|c| !c.is_empty()) != group.client_id.as_deref() {
        return Err(ApiError::validation("A group's client cannot change"));
    }
    let (name, rules) = validate_body(&state, &body).await?;
    let mut tx = state.db.begin().await?;
    sqlx::query("UPDATE device_groups SET name = ?, description = ?, kind = ?, rules = ?, updated_at = ? WHERE id = ?")
        .bind(&name)
        .bind(body.description.trim())
        .bind(&body.kind)
        .bind(&rules)
        .bind(rustrmm_common::now())
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    if body.kind == "dynamic" {
        sqlx::query("DELETE FROM device_group_members WHERE group_id = ?")
            .bind(&id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("group.updated").target("group", &id, &name),
        )
        .await;
    super::policies::push_settings_soon(&state);
    Ok(Json(group_json(&state, &ctx, &id).await?))
}

/// `DELETE /api/v1/groups/{id}` — refused while a policy assignment or a scheduled job uses it.
pub async fn delete(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let group = load_manageable(&state, &ctx, &id).await?;
    let assigned: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM policy_assignments WHERE target_type = 'group' AND target_id = ?",
    )
    .bind(&id)
    .fetch_one(&state.db)
    .await?;
    let jobs: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM jobs WHERE target_type = 'group' AND deleted_at IS NULL
           AND status IN ('pending_approval', 'scheduled', 'running')
           AND EXISTS (SELECT 1 FROM json_each(jobs.target_ids) WHERE value = ?)",
    )
    .bind(&id)
    .fetch_one(&state.db)
    .await?;
    if assigned > 0 || jobs > 0 {
        return Err(ApiError::conflict(
            "group_in_use",
            "The group is used by a policy assignment or a scheduled job",
        )
        .with_details(json!({ "policy_assignments": assigned, "jobs": jobs })));
    }
    sqlx::query("DELETE FROM device_groups WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("group.deleted").target("group", &id, &group.name),
        )
        .await;
    Ok(StatusCode::NO_CONTENT)
}

/// `GET /api/v1/groups/{id}/members`
pub async fn members(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::DEVICES_VIEW)?;
    let group = load(&state.db, &id)
        .await?
        .filter(|g| g.visible(&ctx.scope))
        .ok_or_else(|| ApiError::not_found("Group"))?;
    let ids = member_ids(&state.db, &group.id).await?;
    let items = crate::api::devices::summaries(&state, &ctx.scope, &ids).await?;
    Ok(Json(json!({ "items": items })))
}

#[derive(Deserialize)]
pub struct MembersBody {
    device_ids: Vec<String>,
}

async fn change_members(
    state: &AppState,
    ctx: &AuthCtx,
    id: &str,
    body: MembersBody,
    add: bool,
) -> ApiResult<StatusCode> {
    let group = load_manageable(state, ctx, id).await?;
    if group.kind != "static" {
        return Err(ApiError::conflict(
            "dynamic_group",
            "Members of a dynamic group come from its rules",
        ));
    }
    if body.device_ids.is_empty() || body.device_ids.len() > 5000 {
        return Err(ApiError::validation("device_ids must hold 1–5000 ids"));
    }
    let mut ids = body.device_ids.clone();
    ids.sort();
    ids.dedup();
    let mut qb = QueryBuilder::<Sqlite>::new(
        "SELECT d.id, s.client_id, d.site_id FROM devices d JOIN sites s ON s.id = d.site_id WHERE d.id IN (",
    );
    let mut sep = qb.separated(", ");
    for d in &ids {
        sep.push_bind(d.clone());
    }
    qb.push(")");
    let rows: Vec<(String, String, String)> = qb.build_query_as().fetch_all(&state.db).await?;
    if rows.len() != ids.len() {
        return Err(ApiError::validation("Unknown device id"));
    }
    for (device, client, site) in &rows {
        if !ctx.scope.can_site(perm::DEVICES_MANAGE, client, site) {
            return Err(ApiError::forbidden(format!(
                "Missing devices.manage on device {device}"
            )));
        }
        if add && group.client_id.as_ref().is_some_and(|c| c != client) {
            return Err(ApiError::validation(
                "Devices must belong to the group's client",
            ));
        }
    }
    let now = rustrmm_common::now();
    let mut tx = state.db.begin().await?;
    for device in &ids {
        if add {
            sqlx::query("INSERT OR IGNORE INTO device_group_members (group_id, device_id, added_at) VALUES (?, ?, ?)")
                .bind(id)
                .bind(device)
                .bind(now)
                .execute(&mut *tx)
                .await?;
        } else {
            sqlx::query("DELETE FROM device_group_members WHERE group_id = ? AND device_id = ?")
                .bind(id)
                .bind(device)
                .execute(&mut *tx)
                .await?;
        }
    }
    sqlx::query("UPDATE device_groups SET updated_at = ? WHERE id = ?")
        .bind(now)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit(if add {
                "group.members_added"
            } else {
                "group.members_removed"
            })
            .target("group", id, &group.name)
            .details(json!({ "device_ids": ids })),
        )
        .await;
    super::policies::push_settings_soon(state);
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /api/v1/groups/{id}/members`
pub async fn add_members(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(body): Json<MembersBody>,
) -> ApiResult<StatusCode> {
    change_members(&state, &ctx, &id, body, true).await
}

/// `DELETE /api/v1/groups/{id}/members`
pub async fn remove_members(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(body): Json<MembersBody>,
) -> ApiResult<StatusCode> {
    change_members(&state, &ctx, &id, body, false).await
}

#[derive(Deserialize)]
pub struct PreviewBody {
    rules: RuleDocument,
    #[serde(default)]
    client_id: Option<String>,
}

/// `POST /api/v1/groups/preview` — `{ count, items: [first 25] }` for the rule builder.
pub async fn preview(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Json(body): Json<PreviewBody>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::DEVICES_VIEW)?;
    let defs = rules::custom_defs(&state.db).await?;
    let rule = rules::compile(&body.rules, &defs).map_err(|e| {
        ApiError::validation(format!("Invalid rule: {e}"))
            .with_details(json!({ "path": e.split(':').next() }))
    })?;
    let client = body.client_id.as_deref().filter(|c| !c.is_empty());
    let facts = rules::load_facts(
        &state.db,
        FactsFilter {
            client_id: client,
            device_ids: None,
        },
    )
    .await?;
    let matched: Vec<String> = facts
        .iter()
        .filter(|d| visible_device(&ctx.scope, d) && rule.matches(d))
        .map(|d| d.id.clone())
        .collect();
    let first: Vec<String> = matched.iter().take(25).cloned().collect();
    let items = crate::api::devices::summaries(&state, &ctx.scope, &first).await?;
    Ok(Json(json!({ "count": matched.len(), "items": items })))
}

/// `GET /api/v1/devices/{id}/groups`
pub async fn device_groups(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT s.client_id, d.site_id FROM devices d JOIN sites s ON s.id = d.site_id WHERE d.id = ?",
    )
    .bind(&id)
    .fetch_optional(&state.db)
    .await?;
    let (client, site) = row.ok_or_else(|| ApiError::not_found("Device"))?;
    if !ctx.scope.can_site(perm::DEVICES_VIEW, &client, &site) {
        return Err(ApiError::not_found("Device"));
    }
    let index = GroupIndex::load(&state.db, None, None).await?;
    let Some(device) = index.facts.iter().find(|d| d.id == id) else {
        return Ok(Json(json!({ "items": [] })));
    };
    let ids: HashSet<String> = index.groups_of(device).into_iter().collect();
    let items: Vec<Value> = index
        .groups()
        .iter()
        .filter(|g| ids.contains(&g.id) && g.visible(&ctx.scope))
        .map(|g| {
            let count = index
                .members(&g.id)
                .into_iter()
                .filter(|d| visible_device(&ctx.scope, d))
                .count();
            g.to_json(count)
        })
        .collect();
    Ok(Json(json!({ "items": items })))
}
