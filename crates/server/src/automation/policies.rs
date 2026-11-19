//! Policies: versioned JSON documents assigned to targets and merged into an effective policy
//! per device (global → client → site → groups by priority → device; later layers win).

use std::collections::{BTreeMap, HashMap, HashSet};

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use rustrmm_proto::messages::AgentSettings;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use super::groups::GroupIndex;
use super::rules::DeviceFacts;
use crate::auth::AuthCtx;
use crate::db::Db;
use crate::error::{ApiError, ApiResult};
use crate::rbac::{AccessScope, perm};
use crate::state::AppState;

pub const SECTIONS: &[&str] = &[
    "agent",
    "remote_access",
    "tasks",
    "monitoring",
    "patching",
    "escrow",
];
const AGENT_KEYS: &[(&str, i64, i64)] = &[
    ("heartbeat_secs", 10, 300),
    ("metrics_secs", 10, 600),
    ("inventory_minutes", 15, 1440),
];
/// Boolean `remote_access` switches.
const REMOTE_KEYS: &[&str] = &[
    "shell",
    "files",
    "system",
    "power",
    "desktop",
    "desktop_banner",
    "desktop_view_only",
];
/// `remote_access.desktop_consent` values.
const CONSENT_MODES: &[&str] = &["never", "always", "when_user_present"];
/// Bounds of `remote_access.consent_timeout_secs`.
const CONSENT_TIMEOUT: (i64, i64) = (5, 300);
const TASK_KEYS: &[&str] = &[
    "id",
    "name",
    "script_id",
    "parameters",
    "cron",
    "timezone",
    "enabled",
    "offline_wait_minutes",
];
pub const MAX_TASKS: usize = 50;

/// A validation failure pointing at a document path (`tasks[0].cron`).
#[derive(Debug, Clone, PartialEq)]
pub struct DocError {
    pub path: String,
    pub message: String,
}

fn err(path: impl Into<String>, message: impl Into<String>) -> DocError {
    DocError {
        path: path.into(),
        message: message.into(),
    }
}

/// A policy task after structural validation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PolicyTask {
    pub id: String,
    pub name: String,
    pub script_id: String,
    pub parameters: Map<String, Value>,
    pub cron: String,
    pub timezone: String,
    pub enabled: bool,
    pub offline_wait_minutes: i64,
}

fn valid_task_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Structural validation of a policy document (sections, keys, types and ranges). Returns the
/// document's tasks for the checks that need the database.
pub fn validate_structure(doc: &Value) -> Result<Vec<PolicyTask>, DocError> {
    let obj = doc
        .as_object()
        .ok_or_else(|| err("", "The policy document must be an object"))?;
    let mut tasks = Vec::new();
    for (section, value) in obj {
        match section.as_str() {
            "agent" => {
                let agent = value
                    .as_object()
                    .ok_or_else(|| err("agent", "must be an object"))?;
                for (key, v) in agent {
                    let path = format!("agent.{key}");
                    let (_, min, max) = AGENT_KEYS
                        .iter()
                        .find(|(k, _, _)| k == key)
                        .ok_or_else(|| err(&path, "unknown setting"))?;
                    match v.as_i64() {
                        Some(n) if (*min..=*max).contains(&n) => {}
                        _ => {
                            return Err(err(
                                path,
                                format!("must be a whole number from {min} to {max}"),
                            ));
                        }
                    }
                }
            }
            "remote_access" => {
                let remote = value
                    .as_object()
                    .ok_or_else(|| err("remote_access", "must be an object"))?;
                for (key, v) in remote {
                    let path = format!("remote_access.{key}");
                    match key.as_str() {
                        "desktop_consent" => {
                            if !v.as_str().is_some_and(|m| CONSENT_MODES.contains(&m)) {
                                return Err(err(
                                    path,
                                    "must be never, always or when_user_present",
                                ));
                            }
                        }
                        "consent_timeout_secs" => {
                            let (min, max) = CONSENT_TIMEOUT;
                            if !v.as_i64().is_some_and(|n| (min..=max).contains(&n)) {
                                return Err(err(
                                    path,
                                    format!("must be a whole number from {min} to {max}"),
                                ));
                            }
                        }
                        k if REMOTE_KEYS.contains(&k) => {
                            if !v.is_boolean() {
                                return Err(err(path, "must be true or false"));
                            }
                        }
                        _ => return Err(err(path, "unknown setting")),
                    }
                }
            }
            "tasks" => {
                let list = value
                    .as_array()
                    .ok_or_else(|| err("tasks", "must be a list"))?;
                if list.len() > MAX_TASKS {
                    return Err(err("tasks", format!("at most {MAX_TASKS} tasks")));
                }
                let mut ids = HashSet::new();
                for (i, item) in list.iter().enumerate() {
                    let base = format!("tasks[{i}]");
                    let task = item
                        .as_object()
                        .ok_or_else(|| err(&base, "must be an object"))?;
                    for key in task.keys() {
                        if !TASK_KEYS.contains(&key.as_str()) {
                            return Err(err(format!("{base}.{key}"), "unknown setting"));
                        }
                    }
                    let text = |key: &str| task.get(key).and_then(Value::as_str).map(str::trim);
                    let id = text("id").unwrap_or_default().to_string();
                    if !valid_task_id(&id) {
                        return Err(err(
                            format!("{base}.id"),
                            "must be 1–64 letters, digits, - or _",
                        ));
                    }
                    if !ids.insert(id.clone()) {
                        return Err(err(format!("{base}.id"), "is used by another task"));
                    }
                    let name = text("name").unwrap_or(&id).to_string();
                    if name.is_empty() || name.chars().count() > 120 {
                        return Err(err(format!("{base}.name"), "must be 1–120 characters"));
                    }
                    let script_id = text("script_id").unwrap_or_default().to_string();
                    if script_id.is_empty() {
                        return Err(err(format!("{base}.script_id"), "is required"));
                    }
                    let parameters = match task.get("parameters") {
                        None | Some(Value::Null) => Map::new(),
                        Some(Value::Object(m)) => m.clone(),
                        Some(_) => {
                            return Err(err(format!("{base}.parameters"), "must be an object"));
                        }
                    };
                    let cron = text("cron").unwrap_or_default().to_string();
                    super::cron::parse(&cron).map_err(|e| err(format!("{base}.cron"), e))?;
                    let timezone = text("timezone").unwrap_or("UTC").to_string();
                    super::cron::timezone(&timezone)
                        .map_err(|e| err(format!("{base}.timezone"), e))?;
                    let enabled = match task.get("enabled") {
                        None => true,
                        Some(Value::Bool(b)) => *b,
                        Some(_) => {
                            return Err(err(format!("{base}.enabled"), "must be true or false"));
                        }
                    };
                    let offline_wait_minutes = match task.get("offline_wait_minutes") {
                        None => 60,
                        Some(v) => match v.as_i64() {
                            Some(n) if (0..=10_080).contains(&n) => n,
                            _ => {
                                return Err(err(
                                    format!("{base}.offline_wait_minutes"),
                                    "must be a whole number from 0 to 10080",
                                ));
                            }
                        },
                    };
                    tasks.push(PolicyTask {
                        id,
                        name,
                        script_id,
                        parameters,
                        cron,
                        timezone,
                        enabled,
                        offline_wait_minutes,
                    });
                }
            }
            "monitoring" => crate::monitoring::policy::validate_section(value)?,
            "patching" => crate::patching::policy::validate_section(value)?,
            "escrow" => crate::escrow::policy::validate_section(value)?,
            other => {
                return Err(err(
                    other,
                    format!(
                        "unknown section '{other}' (allowed: {})",
                        SECTIONS.join(", ")
                    ),
                ));
            }
        }
    }
    Ok(tasks)
}

/// Full validation: structure, then each task's script and parameters.
pub async fn validate(state: &AppState, doc: &Value) -> Result<Vec<PolicyTask>, DocError> {
    let tasks = validate_structure(doc)?;
    let settings = super::settings::load(state)
        .await
        .map_err(|_| err("", "could not load settings"))?;
    for (i, task) in tasks.iter().enumerate() {
        let base = format!("tasks[{i}]");
        let script = super::scripts::runnable_version(state, &task.script_id, &settings)
            .await
            .map_err(|e| err(format!("{base}.script_id"), e.message))?;
        super::params::validate_values(
            &script.parameters,
            &task.parameters,
            super::params::SecretRule::FromVariables,
        )
        .map_err(|e| err(format!("{base}.parameters"), e))?;
    }
    crate::monitoring::policy::validate_scripts(state, doc).await?;
    Ok(tasks)
}

// ------------------------------------------------------------------ merging

/// One policy document in merge order.
pub struct Layer<'a> {
    pub policy_id: &'a str,
    pub document: &'a Value,
}

/// Deep-merges layers in order: objects merge key by key, other values replace, `tasks` lists
/// concatenate with later tasks replacing earlier ones that share an `id`, and
/// `monitoring.checks` merge by `id` with field-level overrides. Returns the merged document
/// and, for every leaf path, the policy that set it.
pub fn merge(layers: &[Layer<'_>]) -> (Value, BTreeMap<String, String>) {
    let mut result = Value::Object(Map::new());
    let mut origins = BTreeMap::new();
    for layer in layers {
        let Some(doc) = layer.document.as_object() else {
            continue;
        };
        for (key, value) in doc {
            if key == "tasks" {
                merge_tasks(&mut result, value, layer.policy_id, &mut origins);
            } else if key == "monitoring" {
                merge_monitoring(&mut result, value, layer.policy_id, &mut origins);
            } else {
                let slot = result
                    .as_object_mut()
                    .map(|m| m.entry(key.clone()).or_insert(Value::Null));
                if let Some(slot) = slot {
                    merge_value(slot, value, key, layer.policy_id, &mut origins);
                }
            }
        }
    }
    (result, origins)
}

fn clear_origins(origins: &mut BTreeMap<String, String>, path: &str) {
    let prefix = format!("{path}.");
    origins.retain(|k, _| k != path && !k.starts_with(&prefix));
}

fn merge_value(
    target: &mut Value,
    source: &Value,
    path: &str,
    policy_id: &str,
    origins: &mut BTreeMap<String, String>,
) {
    match source {
        Value::Object(src) => {
            if !target.is_object() {
                clear_origins(origins, path);
                *target = Value::Object(Map::new());
            }
            if let Some(map) = target.as_object_mut() {
                for (key, value) in src {
                    let slot = map.entry(key.clone()).or_insert(Value::Null);
                    merge_value(slot, value, &format!("{path}.{key}"), policy_id, origins);
                }
            }
        }
        Value::Null => {}
        other => {
            clear_origins(origins, path);
            *target = other.clone();
            origins.insert(path.to_string(), policy_id.to_string());
        }
    }
}

fn merge_tasks(
    result: &mut Value,
    source: &Value,
    policy_id: &str,
    origins: &mut BTreeMap<String, String>,
) {
    let Some(src) = source.as_array() else {
        return;
    };
    let Some(map) = result.as_object_mut() else {
        return;
    };
    let tasks = map
        .entry("tasks".to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    let Some(list) = tasks.as_array_mut() else {
        return;
    };
    for task in src {
        let Some(id) = task.get("id").and_then(Value::as_str) else {
            continue;
        };
        match list
            .iter()
            .position(|t| t.get("id").and_then(Value::as_str) == Some(id))
        {
            Some(i) => list[i] = task.clone(),
            None => list.push(task.clone()),
        }
        origins.insert(format!("tasks.{id}"), policy_id.to_string());
    }
}

fn merge_monitoring(
    result: &mut Value,
    source: &Value,
    policy_id: &str,
    origins: &mut BTreeMap<String, String>,
) {
    let Some(src) = source.as_object() else {
        return;
    };
    let Some(map) = result.as_object_mut() else {
        return;
    };
    let slot = map
        .entry("monitoring".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !slot.is_object() {
        *slot = Value::Object(Map::new());
    }
    let Some(monitoring) = slot.as_object_mut() else {
        return;
    };
    for (key, value) in src {
        if key == "checks" {
            let list = monitoring
                .entry("checks".to_string())
                .or_insert_with(|| Value::Array(Vec::new()));
            if !list.is_array() {
                *list = Value::Array(Vec::new());
            }
            if let Some(list) = list.as_array_mut() {
                crate::monitoring::policy::merge_checks(list, value, policy_id, origins);
            }
        } else {
            let slot = monitoring.entry(key.clone()).or_insert(Value::Null);
            merge_value(
                slot,
                value,
                &format!("monitoring.{key}"),
                policy_id,
                origins,
            );
        }
    }
}

/// Agent settings from a merged document (defaults for anything unset).
pub fn agent_settings(doc: &Value) -> AgentSettings {
    let mut settings = AgentSettings::default();
    let get = |key: &str| {
        doc.pointer(&format!("/agent/{key}"))
            .and_then(Value::as_u64)
            .and_then(|v| u32::try_from(v).ok())
    };
    if let Some(v) = get("heartbeat_secs") {
        settings.heartbeat_secs = v.clamp(10, 300);
    }
    if let Some(v) = get("metrics_secs") {
        settings.metrics_secs = v.clamp(10, 600);
    }
    if let Some(v) = get("inventory_minutes") {
        settings.inventory_minutes = v.clamp(15, 1440);
    }
    settings
}

// ------------------------------------------------------------------ effective policy

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct AssignmentRow {
    pub id: String,
    pub policy_id: String,
    pub target_type: String,
    pub target_id: Option<String>,
    pub priority: i64,
    pub created_at: DateTime<Utc>,
    pub target_name: Option<String>,
    pub target_client_id: Option<String>,
    pub target_site_id: Option<String>,
}

const ASSIGNMENT_SELECT: &str = "SELECT a.id, a.policy_id, a.target_type, a.target_id, a.priority, a.created_at,
    CASE a.target_type
      WHEN 'client' THEN (SELECT name FROM clients WHERE id = a.target_id)
      WHEN 'site' THEN (SELECT name FROM sites WHERE id = a.target_id)
      WHEN 'group' THEN (SELECT name FROM device_groups WHERE id = a.target_id)
      WHEN 'device' THEN (SELECT COALESCE(display_name, hostname) FROM devices WHERE id = a.target_id)
      ELSE 'All devices' END AS target_name,
    CASE a.target_type
      WHEN 'client' THEN a.target_id
      WHEN 'site' THEN (SELECT client_id FROM sites WHERE id = a.target_id)
      WHEN 'group' THEN (SELECT client_id FROM device_groups WHERE id = a.target_id)
      WHEN 'device' THEN (SELECT s.client_id FROM devices d JOIN sites s ON s.id = d.site_id WHERE d.id = a.target_id)
      ELSE NULL END AS target_client_id,
    CASE a.target_type
      WHEN 'site' THEN a.target_id
      WHEN 'device' THEN (SELECT site_id FROM devices WHERE id = a.target_id)
      ELSE NULL END AS target_site_id
    FROM policy_assignments a";

impl AssignmentRow {
    fn to_json(&self) -> Value {
        json!({ "id": self.id, "target_type": self.target_type, "target_id": self.target_id,
                "target_name": self.target_name, "priority": self.priority })
    }

    fn visible(&self, scope: &AccessScope) -> bool {
        target_allowed(
            scope,
            perm::DEVICES_VIEW,
            &self.target_type,
            self.target_client_id.as_deref(),
            self.target_site_id.as_deref(),
            true,
        )
    }

    fn manageable(&self, scope: &AccessScope) -> bool {
        target_allowed(
            scope,
            perm::POLICIES_MANAGE,
            &self.target_type,
            self.target_client_id.as_deref(),
            self.target_site_id.as_deref(),
            false,
        )
    }
}

/// Permission over an assignment target. Global targets (and installation-wide groups) need a
/// global grant to manage; anyone holding `perm` can see them.
fn target_allowed(
    scope: &AccessScope,
    permission: &str,
    target_type: &str,
    client: Option<&str>,
    site: Option<&str>,
    view: bool,
) -> bool {
    match (target_type, client, site) {
        ("site" | "device", Some(c), Some(s)) => scope.can_site(permission, c, s),
        (_, Some(c), _) if view => scope.can_see_client(permission, c),
        (_, Some(c), _) => scope.can_client(permission, c),
        (_, None, _) if view => scope.has_anywhere(permission),
        (_, None, _) => scope.has_global(permission),
    }
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct PolicyRow {
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: i64,
    pub document: String,
    pub updated_at: DateTime<Utc>,
    pub updated_by_name: String,
}

const POLICY_SELECT: &str =
    "SELECT id, name, description, version, document, updated_at, updated_by_name FROM policies";

impl PolicyRow {
    pub fn document(&self) -> Value {
        serde_json::from_str(&self.document).unwrap_or_else(|_| json!({}))
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Source {
    pub policy_id: String,
    pub policy_name: String,
    pub version: i64,
    pub target_type: String,
    pub target_name: Option<String>,
    pub priority: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Effective {
    pub document: Value,
    pub sources: Vec<Source>,
    pub origins: BTreeMap<String, String>,
}

/// Policies, assignments and group memberships loaded once to resolve many devices.
pub struct PolicyContext {
    policies: HashMap<String, (PolicyRow, Value)>,
    assignments: Vec<AssignmentRow>,
    pub index: GroupIndex,
}

impl PolicyContext {
    /// `devices`: restrict facts to these devices (all active devices when `None`).
    pub async fn load(db: &Db, devices: Option<&[String]>) -> anyhow::Result<Self> {
        let rows: Vec<PolicyRow> = sqlx::query_as(POLICY_SELECT).fetch_all(db).await?;
        let policies = rows
            .into_iter()
            .map(|p| {
                let doc = p.document();
                (p.id.clone(), (p, doc))
            })
            .collect();
        let assignments: Vec<AssignmentRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "{ASSIGNMENT_SELECT} ORDER BY a.priority, a.created_at, a.id"
        )))
        .fetch_all(db)
        .await?;
        let group_ids: Vec<String> = assignments
            .iter()
            .filter(|a| a.target_type == "group")
            .filter_map(|a| a.target_id.clone())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        let mut index = GroupIndex::load(db, Some(&group_ids), devices).await?;
        if index.facts.is_empty() {
            // No group assignments: facts were not needed for groups, but callers still use them.
            index.facts = super::rules::load_facts(
                db,
                super::rules::FactsFilter {
                    client_id: None,
                    device_ids: devices,
                },
            )
            .await?;
        }
        Ok(Self {
            policies,
            assignments,
            index,
        })
    }

    pub fn facts(&self, device_id: &str) -> Option<&DeviceFacts> {
        self.index.facts.iter().find(|d| d.id == device_id)
    }

    pub fn effective(&self, device: &DeviceFacts) -> Effective {
        let groups: HashSet<String> = self.index.groups_of(device).into_iter().collect();
        let applies = |a: &AssignmentRow| -> Option<u8> {
            let target = a.target_id.as_deref();
            match a.target_type.as_str() {
                "global" => Some(0),
                "client" if target == Some(device.client_id.as_str()) => Some(1),
                "site" if target == Some(device.site_id.as_str()) => Some(2),
                "group" if target.is_some_and(|g| groups.contains(g)) => Some(3),
                "device" if target == Some(device.id.as_str()) => Some(4),
                _ => None,
            }
        };
        let mut chosen: Vec<(u8, &AssignmentRow)> = self
            .assignments
            .iter()
            .filter_map(|a| applies(a).map(|layer| (layer, a)))
            .collect();
        // Assignments are pre-sorted by priority; a stable sort keeps that order inside a layer.
        chosen.sort_by_key(|(layer, _)| *layer);
        let mut layers = Vec::new();
        let mut sources = Vec::new();
        for (_, a) in &chosen {
            if let Some((policy, doc)) = self.policies.get(&a.policy_id) {
                layers.push(Layer {
                    policy_id: &policy.id,
                    document: doc,
                });
                sources.push(Source {
                    policy_id: policy.id.clone(),
                    policy_name: policy.name.clone(),
                    version: policy.version,
                    target_type: a.target_type.clone(),
                    target_name: a.target_name.clone(),
                    priority: a.priority,
                });
            }
        }
        let (document, origins) = merge(&layers);
        Effective {
            document,
            sources,
            origins,
        }
    }
}

/// Effective policy of one device (`None` when the device is not active).
pub async fn effective_for_device(db: &Db, device_id: &str) -> anyhow::Result<Option<Effective>> {
    let ids = [device_id.to_string()];
    let ctx = PolicyContext::load(db, Some(&ids)).await?;
    Ok(ctx.facts(device_id).map(|f| ctx.effective(f)))
}

/// Agent settings for a connecting device (defaults if anything goes wrong).
pub async fn agent_settings_for(db: &Db, device_id: &str) -> AgentSettings {
    match effective_for_device(db, device_id).await {
        Ok(Some(effective)) => agent_settings(&effective.document),
        Ok(None) => AgentSettings::default(),
        Err(e) => {
            tracing::warn!(device = device_id, error = %format!("{e:#}"), "effective policy failed; using default settings");
            AgentSettings::default()
        }
    }
}

/// When the effective policy disables a remote feature (`shell`, `files`, `system`, `power`),
/// returns the policy that disabled it.
pub async fn remote_disabled_by(
    db: &Db,
    device_id: &str,
    feature: &str,
) -> anyhow::Result<Option<String>> {
    let Some(effective) = effective_for_device(db, device_id).await? else {
        return Ok(None);
    };
    let path = format!("remote_access.{feature}");
    if effective
        .document
        .pointer(&format!("/remote_access/{feature}"))
        == Some(&Value::Bool(false))
    {
        return Ok(Some(
            effective.origins.get(&path).cloned().unwrap_or_default(),
        ));
    }
    Ok(None)
}

/// The effective remote desktop settings of a device (`remote_access.desktop*`).
#[derive(Debug, Clone, PartialEq)]
pub struct DesktopPolicy {
    /// The policy that switched remote desktop off (`remote_access.desktop = false`).
    pub disabled_by: Option<String>,
    pub consent: rustrmm_proto::desktop::ConsentMode,
    pub consent_timeout_secs: u32,
    pub banner: bool,
    /// Every session on the device is view-only.
    pub view_only: bool,
}

impl Default for DesktopPolicy {
    fn default() -> Self {
        Self {
            disabled_by: None,
            consent: rustrmm_proto::desktop::ConsentMode::Never,
            consent_timeout_secs: 30,
            banner: true,
            view_only: false,
        }
    }
}

/// Reads the desktop keys of an effective document; absent keys take the documented defaults
/// (desktop on, no consent prompt, 30 s timeout, banner on, not view-only).
pub fn desktop_policy(document: &Value, origins: &BTreeMap<String, String>) -> DesktopPolicy {
    let remote = document.get("remote_access");
    let get = |key: &str| remote.and_then(|r| r.get(key));
    let mut policy = DesktopPolicy::default();
    if get("desktop") == Some(&Value::Bool(false)) {
        policy.disabled_by = Some(
            origins
                .get("remote_access.desktop")
                .cloned()
                .unwrap_or_default(),
        );
    }
    if let Some(mode) = get("desktop_consent")
        .and_then(Value::as_str)
        .and_then(rustrmm_proto::desktop::ConsentMode::parse)
    {
        policy.consent = mode;
    }
    if let Some(secs) = get("consent_timeout_secs").and_then(Value::as_i64) {
        let (min, max) = CONSENT_TIMEOUT;
        policy.consent_timeout_secs = secs.clamp(min, max) as u32;
    }
    if let Some(banner) = get("desktop_banner").and_then(Value::as_bool) {
        policy.banner = banner;
    }
    if let Some(view_only) = get("desktop_view_only").and_then(Value::as_bool) {
        policy.view_only = view_only;
    }
    policy
}

/// The device's effective desktop settings (defaults when the device has no policy).
pub async fn desktop_policy_for(db: &Db, device_id: &str) -> anyhow::Result<DesktopPolicy> {
    Ok(match effective_for_device(db, device_id).await? {
        Some(effective) => desktop_policy(&effective.document, &effective.origins),
        None => DesktopPolicy::default(),
    })
}

/// Sends current agent settings to every connected device.
pub async fn push_settings_all(state: &AppState) -> anyhow::Result<usize> {
    let online: Vec<String> =
        sqlx::query_scalar("SELECT id FROM devices WHERE online = 1 AND status = 'active'")
            .fetch_all(&state.db)
            .await?;
    let online: Vec<String> = online
        .into_iter()
        .filter(|d| state.agents.is_online(d))
        .collect();
    if online.is_empty() {
        return Ok(0);
    }
    let ctx = PolicyContext::load(&state.db, Some(&online)).await?;
    let mut sent = 0;
    for device in &ctx.index.facts {
        let settings = agent_settings(&ctx.effective(device).document);
        if let Ok(frame) = rustrmm_proto::encode(&settings)
            && state.agents.send(&device.id, frame)
        {
            sent += 1;
        }
    }
    Ok(sent)
}

/// Pushes settings and monitoring configurations in the background (after a policy,
/// assignment or group change).
pub fn push_settings_soon(state: &AppState) {
    let state = state.clone();
    tokio::spawn(async move {
        match push_settings_all(&state).await {
            Ok(n) if n > 0 => tracing::debug!(devices = n, "pushed agent settings"),
            Ok(_) => {}
            Err(e) => tracing::warn!(error = %format!("{e:#}"), "pushing agent settings failed"),
        }
        match crate::monitoring::policy::push_all(&state).await {
            Ok(n) if n > 0 => tracing::debug!(devices = n, "pushed monitoring configurations"),
            Ok(_) => {}
            Err(e) => {
                tracing::warn!(error = %format!("{e:#}"), "pushing monitoring configurations failed")
            }
        }
    });
}

/// Devices whose effective policy currently contains `task_id` from `policy_id`.
pub async fn devices_with_task(
    db: &Db,
    policy_id: &str,
    task_id: &str,
) -> anyhow::Result<Vec<String>> {
    let ctx = PolicyContext::load(db, None).await?;
    let key = format!("tasks.{task_id}");
    Ok(ctx
        .index
        .facts
        .iter()
        .filter(|d| {
            let effective = ctx.effective(d);
            effective.origins.get(&key).map(String::as_str) == Some(policy_id)
                && effective
                    .document
                    .get("tasks")
                    .and_then(Value::as_array)
                    .and_then(|tasks| {
                        tasks
                            .iter()
                            .find(|t| t.get("id").and_then(Value::as_str) == Some(task_id))
                    })
                    .is_some_and(|t| t.get("enabled").and_then(Value::as_bool) != Some(false))
        })
        .map(|d| d.id.clone())
        .collect())
}

// ------------------------------------------------------------------ API

async fn load_policy(db: &Db, id: &str) -> ApiResult<PolicyRow> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!("{POLICY_SELECT} WHERE id = ?")))
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| ApiError::not_found("Policy"))
}

async fn assignments_of(db: &Db, policy_id: &str) -> anyhow::Result<Vec<AssignmentRow>> {
    Ok(sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{ASSIGNMENT_SELECT} WHERE a.policy_id = ? ORDER BY a.priority, a.created_at"
    )))
    .bind(policy_id)
    .fetch_all(db)
    .await?)
}

fn policy_json(policy: &PolicyRow, assignments: &[AssignmentRow], scope: &AccessScope) -> Value {
    json!({
        "id": policy.id, "name": policy.name, "description": policy.description, "version": policy.version,
        "document": policy.document(),
        "assignments": assignments.iter().filter(|a| a.visible(scope)).map(AssignmentRow::to_json).collect::<Vec<_>>(),
        "updated_at": policy.updated_at, "updated_by_name": policy.updated_by_name,
    })
}

fn doc_error(e: DocError) -> ApiError {
    ApiError::validation(if e.path.is_empty() {
        e.message
    } else {
        format!("{}: {}", e.path, e.message)
    })
    .with_details(json!({ "path": e.path }))
}

/// `GET /api/v1/policies`
pub async fn list(State(state): State<AppState>, ctx: AuthCtx) -> ApiResult<Json<Value>> {
    ctx.require(perm::DEVICES_VIEW)?;
    let policies: Vec<PolicyRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{POLICY_SELECT} ORDER BY name COLLATE NOCASE"
    )))
    .fetch_all(&state.db)
    .await?;
    let all: Vec<AssignmentRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{ASSIGNMENT_SELECT} ORDER BY a.priority, a.created_at"
    )))
    .fetch_all(&state.db)
    .await?;
    let items: Vec<Value> = policies
        .iter()
        .map(|p| {
            let mine: Vec<AssignmentRow> = all
                .iter()
                .filter(|a| a.policy_id == p.id)
                .cloned()
                .collect();
            policy_json(p, &mine, &ctx.scope)
        })
        .collect();
    Ok(Json(json!({ "items": items })))
}

/// `GET /api/v1/policies/{id}`
pub async fn get(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    ctx.require(perm::DEVICES_VIEW)?;
    let policy = load_policy(&state.db, &id).await?;
    let assignments = assignments_of(&state.db, &id).await?;
    Ok(Json(policy_json(&policy, &assignments, &ctx.scope)))
}

#[derive(Deserialize)]
pub struct PolicyBody {
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default = "empty_doc")]
    document: Value,
}

fn empty_doc() -> Value {
    json!({})
}

fn check_body(body: &PolicyBody) -> ApiResult<String> {
    let name = body.name.trim().to_string();
    if name.is_empty() || name.chars().count() > 120 {
        return Err(ApiError::validation("Name must be 1–120 characters"));
    }
    if body.description.chars().count() > 2000 {
        return Err(ApiError::validation("Description is too long"));
    }
    if serde_json::to_string(&body.document)?.len() > 256 * 1024 {
        return Err(ApiError::validation("The policy document is too large"));
    }
    Ok(name)
}

/// The caller must be able to manage every target the policy is assigned to.
fn require_manage_all(ctx: &AuthCtx, assignments: &[AssignmentRow]) -> ApiResult<()> {
    ctx.require(perm::POLICIES_MANAGE)?;
    if assignments.iter().all(|a| a.manageable(&ctx.scope)) {
        Ok(())
    } else {
        Err(ApiError::forbidden(
            "The policy is assigned to targets outside your scope",
        ))
    }
}

/// The `monitoring` section also needs `monitors.manage` over every target the policy is
/// assigned to.
fn require_monitors_all(ctx: &AuthCtx, assignments: &[AssignmentRow]) -> ApiResult<()> {
    require_section_all(ctx, assignments, perm::MONITORS_MANAGE)
}

/// The `patching` section (auto-approval rules approve patches) also needs `patches.approve`
/// over every target the policy is assigned to.
fn require_patches_all(ctx: &AuthCtx, assignments: &[AssignmentRow]) -> ApiResult<()> {
    require_section_all(ctx, assignments, perm::PATCHES_APPROVE)
}

/// The `escrow` section (password rotation) also needs `secrets.manage` over every target the
/// policy is assigned to.
fn require_secrets_all(ctx: &AuthCtx, assignments: &[AssignmentRow]) -> ApiResult<()> {
    require_section_all(ctx, assignments, perm::SECRETS_MANAGE)
}

fn require_section_all(
    ctx: &AuthCtx,
    assignments: &[AssignmentRow],
    permission: &'static str,
) -> ApiResult<()> {
    ctx.require(permission)?;
    let ok = assignments.iter().all(|a| {
        target_allowed(
            &ctx.scope,
            permission,
            &a.target_type,
            a.target_client_id.as_deref(),
            a.target_site_id.as_deref(),
            false,
        )
    });
    if ok {
        Ok(())
    } else {
        Err(ApiError::forbidden(format!(
            "Missing {permission} on a target of this policy"
        )))
    }
}

/// `POST /api/v1/policies`
pub async fn create(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Json(body): Json<PolicyBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    ctx.require(perm::POLICIES_MANAGE)?;
    if body.document.get("monitoring").is_some() {
        ctx.require(perm::MONITORS_MANAGE)?;
    }
    if body.document.get("patching").is_some() {
        ctx.require(perm::PATCHES_APPROVE)?;
    }
    if body.document.get("escrow").is_some() {
        ctx.require(perm::SECRETS_MANAGE)?;
    }
    let name = check_body(&body)?;
    validate(&state, &body.document).await.map_err(doc_error)?;
    let id = rustrmm_common::new_id();
    let now = rustrmm_common::now();
    sqlx::query("INSERT INTO policies (id, name, description, version, document, created_by, updated_by, updated_by_name, created_at, updated_at)
                 VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)")
        .bind(&id)
        .bind(&name)
        .bind(body.description.trim())
        .bind(serde_json::to_string(&body.document)?)
        .bind(&ctx.user.id)
        .bind(&ctx.user.id)
        .bind(&ctx.user.name)
        .bind(now)
        .bind(now)
        .execute(&state.db)
        .await?;
    super::jobs::sync_policy_jobs(&state, &id, &ctx.user.name).await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("policy.created").target("policy", &id, &name),
        )
        .await;
    let policy = load_policy(&state.db, &id).await?;
    Ok((
        StatusCode::CREATED,
        Json(policy_json(&policy, &[], &ctx.scope)),
    ))
}

/// `PUT /api/v1/policies/{id}` — increments `version`.
pub async fn update(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(body): Json<PolicyBody>,
) -> ApiResult<Json<Value>> {
    let current = load_policy(&state.db, &id).await?;
    let assignments = assignments_of(&state.db, &id).await?;
    require_manage_all(&ctx, &assignments)?;
    if current.document().get("monitoring") != body.document.get("monitoring") {
        require_monitors_all(&ctx, &assignments)?;
    }
    if current.document().get("patching") != body.document.get("patching") {
        require_patches_all(&ctx, &assignments)?;
    }
    if current.document().get("escrow") != body.document.get("escrow") {
        require_secrets_all(&ctx, &assignments)?;
    }
    let name = check_body(&body)?;
    validate(&state, &body.document).await.map_err(doc_error)?;
    sqlx::query("UPDATE policies SET name = ?, description = ?, document = ?, version = version + 1, updated_by = ?, updated_by_name = ?, updated_at = ? WHERE id = ?")
        .bind(&name)
        .bind(body.description.trim())
        .bind(serde_json::to_string(&body.document)?)
        .bind(&ctx.user.id)
        .bind(&ctx.user.name)
        .bind(rustrmm_common::now())
        .bind(&id)
        .execute(&state.db)
        .await?;
    super::jobs::sync_policy_jobs(&state, &id, &ctx.user.name).await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("policy.updated")
                .target("policy", &id, &name)
                .details(json!({ "version": current.version + 1 })),
        )
        .await;
    push_settings_soon(&state);
    let policy = load_policy(&state.db, &id).await?;
    Ok(Json(policy_json(&policy, &assignments, &ctx.scope)))
}

/// `DELETE /api/v1/policies/{id}` (step-up)
pub async fn delete(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let current = load_policy(&state.db, &id).await?;
    let assignments = assignments_of(&state.db, &id).await?;
    require_manage_all(&ctx, &assignments)?;
    if current.document().get("monitoring").is_some() {
        require_monitors_all(&ctx, &assignments)?;
    }
    if current.document().get("patching").is_some() {
        require_patches_all(&ctx, &assignments)?;
    }
    if current.document().get("escrow").is_some() {
        require_secrets_all(&ctx, &assignments)?;
    }
    ctx.require_step_up()?;
    sqlx::query("DELETE FROM policies WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;
    super::jobs::sync_policy_jobs(&state, &id, &ctx.user.name).await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("policy.deleted")
                .target("policy", &id, &current.name),
        )
        .await;
    push_settings_soon(&state);
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct AssignBody {
    target_type: String,
    #[serde(default)]
    target_id: Option<String>,
    #[serde(default)]
    priority: Option<i64>,
}

/// `POST /api/v1/policies/{id}/assignments`
pub async fn assign(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(body): Json<AssignBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    ctx.require(perm::POLICIES_MANAGE)?;
    let policy = load_policy(&state.db, &id).await?;
    let target_id = body.target_id.clone().filter(|t| !t.is_empty());
    let priority = body.priority.unwrap_or(0);
    if !(-1000..=1000).contains(&priority) {
        return Err(ApiError::validation(
            "priority must be between -1000 and 1000",
        ));
    }
    let (client, site): (Option<String>, Option<String>) = match (
        body.target_type.as_str(),
        &target_id,
    ) {
        ("global", None) => (None, None),
        ("global", Some(_)) => {
            return Err(ApiError::validation("Global assignments have no target_id"));
        }
        (_, None) => return Err(ApiError::validation("target_id is required")),
        ("client", Some(t)) => {
            let found: Option<String> = sqlx::query_scalar("SELECT id FROM clients WHERE id = ?")
                .bind(t)
                .fetch_optional(&state.db)
                .await?;
            (
                Some(found.ok_or_else(|| ApiError::validation("Unknown client"))?),
                None,
            )
        }
        ("site", Some(t)) => {
            let client: Option<String> =
                sqlx::query_scalar("SELECT client_id FROM sites WHERE id = ?")
                    .bind(t)
                    .fetch_optional(&state.db)
                    .await?;
            (
                Some(client.ok_or_else(|| ApiError::validation("Unknown site"))?),
                Some(t.clone()),
            )
        }
        ("group", Some(t)) => {
            let group = super::groups::load(&state.db, t)
                .await?
                .ok_or_else(|| ApiError::validation("Unknown group"))?;
            (group.client_id, None)
        }
        ("device", Some(t)) => {
            let row: Option<(String, String)> = sqlx::query_as(
                "SELECT s.client_id, d.site_id FROM devices d JOIN sites s ON s.id = d.site_id WHERE d.id = ?",
            )
            .bind(t)
            .fetch_optional(&state.db)
            .await?;
            let (c, s) = row.ok_or_else(|| ApiError::validation("Unknown device"))?;
            (Some(c), Some(s))
        }
        _ => {
            return Err(ApiError::validation(
                "target_type must be global, client, site, group or device",
            ));
        }
    };
    if !target_allowed(
        &ctx.scope,
        perm::POLICIES_MANAGE,
        &body.target_type,
        client.as_deref(),
        site.as_deref(),
        false,
    ) {
        return Err(ApiError::forbidden(
            "Missing policies.manage on the assignment target",
        ));
    }
    if policy.document().get("monitoring").is_some()
        && !target_allowed(
            &ctx.scope,
            perm::MONITORS_MANAGE,
            &body.target_type,
            client.as_deref(),
            site.as_deref(),
            false,
        )
    {
        return Err(ApiError::forbidden(
            "Missing monitors.manage on the assignment target (the policy has monitoring checks)",
        ));
    }
    if policy.document().get("patching").is_some()
        && !target_allowed(
            &ctx.scope,
            perm::PATCHES_APPROVE,
            &body.target_type,
            client.as_deref(),
            site.as_deref(),
            false,
        )
    {
        return Err(ApiError::forbidden(
            "Missing patches.approve on the assignment target (the policy has patching settings)",
        ));
    }
    if policy.document().get("escrow").is_some()
        && !target_allowed(
            &ctx.scope,
            perm::SECRETS_MANAGE,
            &body.target_type,
            client.as_deref(),
            site.as_deref(),
            false,
        )
    {
        return Err(ApiError::forbidden(
            "Missing secrets.manage on the assignment target (the policy has escrow settings)",
        ));
    }
    let assignment_id = rustrmm_common::new_id();
    sqlx::query("INSERT INTO policy_assignments (id, policy_id, target_type, target_id, priority, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(&assignment_id)
        .bind(&id)
        .bind(&body.target_type)
        .bind(&target_id)
        .bind(priority)
        .bind(&ctx.user.id)
        .bind(rustrmm_common::now())
        .execute(&state.db)
        .await?;
    let mut entry = ctx
        .audit("policy.assigned")
        .target("policy", &id, &policy.name)
        .details(json!({ "assignment_id": assignment_id, "target_type": body.target_type, "target_id": target_id, "priority": priority }));
    if let Some(c) = &client {
        entry = entry.client(c);
    }
    state.audit.record_or_log(&state.db, entry).await;
    push_settings_soon(&state);
    let assignments = assignments_of(&state.db, &id).await?;
    Ok((
        StatusCode::CREATED,
        Json(policy_json(&policy, &assignments, &ctx.scope)),
    ))
}

/// `DELETE /api/v1/policy-assignments/{id}`
pub async fn unassign(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    ctx.require(perm::POLICIES_MANAGE)?;
    let row: Option<AssignmentRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{ASSIGNMENT_SELECT} WHERE a.id = ?"
    )))
    .bind(&id)
    .fetch_optional(&state.db)
    .await?;
    let row = row
        .filter(|a| a.visible(&ctx.scope))
        .ok_or_else(|| ApiError::not_found("Assignment"))?;
    if !row.manageable(&ctx.scope) {
        return Err(ApiError::forbidden(
            "Missing policies.manage on the assignment target",
        ));
    }
    let document = load_policy(&state.db, &row.policy_id).await?.document();
    if document.get("monitoring").is_some() {
        require_monitors_all(&ctx, std::slice::from_ref(&row))?;
    }
    if document.get("patching").is_some() {
        require_patches_all(&ctx, std::slice::from_ref(&row))?;
    }
    if document.get("escrow").is_some() {
        require_secrets_all(&ctx, std::slice::from_ref(&row))?;
    }
    sqlx::query("DELETE FROM policy_assignments WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("policy.unassigned")
                .target("policy", &row.policy_id, row.target_name.clone().unwrap_or_default())
                .details(json!({ "assignment_id": id, "target_type": row.target_type, "target_id": row.target_id })),
        )
        .await;
    push_settings_soon(&state);
    Ok(StatusCode::NO_CONTENT)
}

/// `GET /api/v1/devices/{id}/effective-policy`
pub async fn device_effective(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<Json<Effective>> {
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
    let effective = effective_for_device(&state.db, &id)
        .await?
        .unwrap_or(Effective {
            document: json!({}),
            sources: Vec::new(),
            origins: BTreeMap::new(),
        });
    Ok(Json(effective))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn structure_validation_points_at_paths() {
        assert!(validate_structure(&json!({})).is_ok());
        let ok = json!({
            "agent": { "heartbeat_secs": 30, "metrics_secs": 60, "inventory_minutes": 240 },
            "remote_access": { "shell": false, "files": true },
            "tasks": [{ "id": "weekly-cleanup", "name": "Weekly cleanup", "script_id": "s1", "cron": "0 3 * * 0",
                        "timezone": "Europe/London", "enabled": true, "offline_wait_minutes": 720, "parameters": {} }]
        });
        let tasks = validate_structure(&ok).expect("valid");
        assert_eq!(tasks[0].offline_wait_minutes, 720);
        let cases = [
            (json!({ "billing": {} }), "billing"),
            (json!({ "patching": { "ring": "early" } }), "patching.ring"),
            (
                json!({ "monitoring": { "checks": [{ "id": "x", "type": "cpu", "config": { "warn_pct": 0 } }] } }),
                "monitoring.checks[0].config.warn_pct",
            ),
            (
                json!({ "agent": { "heartbeat_secs": 5 } }),
                "agent.heartbeat_secs",
            ),
            (json!({ "agent": { "colour": 1 } }), "agent.colour"),
            (
                json!({ "remote_access": { "shell": "no" } }),
                "remote_access.shell",
            ),
            (
                json!({ "remote_access": { "desktop": "yes" } }),
                "remote_access.desktop",
            ),
            (
                json!({ "remote_access": { "desktop_consent": "sometimes" } }),
                "remote_access.desktop_consent",
            ),
            (
                json!({ "remote_access": { "consent_timeout_secs": 2 } }),
                "remote_access.consent_timeout_secs",
            ),
            (
                json!({ "remote_access": { "desktop_banner": 1 } }),
                "remote_access.desktop_banner",
            ),
            (
                json!({ "remote_access": { "screen": true } }),
                "remote_access.screen",
            ),
            (json!({ "tasks": {} }), "tasks"),
            (
                json!({ "tasks": [{ "id": "a", "script_id": "s", "cron": "bad" }] }),
                "tasks[0].cron",
            ),
            (
                json!({ "tasks": [{ "id": "a", "script_id": "s", "cron": "0 3 * * *", "timezone": "Nowhere" }] }),
                "tasks[0].timezone",
            ),
            (
                json!({ "tasks": [{ "id": "a b", "script_id": "s", "cron": "0 3 * * *" }] }),
                "tasks[0].id",
            ),
            (
                json!({ "tasks": [{ "id": "a", "cron": "0 3 * * *" }] }),
                "tasks[0].script_id",
            ),
            (
                json!({ "tasks": [{ "id": "a", "script_id": "s", "cron": "0 3 * * *" }, { "id": "a", "script_id": "s", "cron": "0 3 * * *" }] }),
                "tasks[1].id",
            ),
            (
                json!({ "tasks": [{ "id": "a", "script_id": "s", "cron": "0 3 * * *", "extra": 1 }] }),
                "tasks[0].extra",
            ),
        ];
        for (doc, path) in cases {
            assert_eq!(
                validate_structure(&doc).expect_err("invalid").path,
                path,
                "{doc}"
            );
        }
    }

    #[test]
    fn desktop_policy_keys_validate_and_merge() {
        let doc = json!({ "remote_access": {
            "desktop": true, "desktop_consent": "always", "consent_timeout_secs": 45,
            "desktop_banner": false, "desktop_view_only": true
        }});
        assert!(validate_structure(&doc).is_ok());
        let policy = desktop_policy(&doc, &BTreeMap::new());
        assert_eq!(policy.disabled_by, None);
        assert_eq!(policy.consent, rustrmm_proto::desktop::ConsentMode::Always);
        assert_eq!(policy.consent_timeout_secs, 45);
        assert!(!policy.banner);
        assert!(policy.view_only);

        // Defaults when nothing is set.
        assert_eq!(
            desktop_policy(&json!({}), &BTreeMap::new()),
            DesktopPolicy::default()
        );
        let defaults = DesktopPolicy::default();
        assert_eq!(defaults.consent, rustrmm_proto::desktop::ConsentMode::Never);
        assert_eq!(defaults.consent_timeout_secs, 30);
        assert!(defaults.banner && !defaults.view_only);

        // A later layer switches desktop off; the origin names the policy that did it.
        let global = json!({ "remote_access": { "desktop": true, "desktop_consent": "always" } });
        let site = json!({ "remote_access": { "desktop": false } });
        let (merged, origins) = merge(&[
            Layer {
                policy_id: "pg",
                document: &global,
            },
            Layer {
                policy_id: "ps",
                document: &site,
            },
        ]);
        let policy = desktop_policy(&merged, &origins);
        assert_eq!(policy.disabled_by.as_deref(), Some("ps"));
        assert_eq!(policy.consent, rustrmm_proto::desktop::ConsentMode::Always);
        for ok in ["never", "always", "when_user_present"] {
            assert!(
                validate_structure(&json!({ "remote_access": { "desktop_consent": ok } })).is_ok()
            );
        }
        for (secs, valid) in [(5, true), (300, true), (4, false), (301, false)] {
            assert_eq!(
                validate_structure(&json!({ "remote_access": { "consent_timeout_secs": secs } }))
                    .is_ok(),
                valid,
                "{secs}"
            );
        }
    }

    #[test]
    fn merge_layers_with_origins() {
        let global = json!({
            "agent": { "heartbeat_secs": 60, "metrics_secs": 120 },
            "remote_access": { "shell": true, "files": true },
            "tasks": [{ "id": "cleanup", "cron": "0 3 * * 0" }, { "id": "inventory", "cron": "0 4 * * *" }]
        });
        let client = json!({
            "agent": { "heartbeat_secs": 30 },
            "remote_access": { "shell": false },
            "tasks": [{ "id": "cleanup", "cron": "0 2 * * 0" }, { "id": "audit", "cron": "0 5 * * 1" }]
        });
        let device = json!({ "agent": { "inventory_minutes": 60 } });
        let (doc, origins) = merge(&[
            Layer {
                policy_id: "pg",
                document: &global,
            },
            Layer {
                policy_id: "pc",
                document: &client,
            },
            Layer {
                policy_id: "pd",
                document: &device,
            },
        ]);
        assert_eq!(
            doc["agent"],
            json!({ "heartbeat_secs": 30, "metrics_secs": 120, "inventory_minutes": 60 })
        );
        assert_eq!(
            doc["remote_access"],
            json!({ "shell": false, "files": true })
        );
        let tasks = doc["tasks"].as_array().expect("tasks");
        assert_eq!(tasks.len(), 3, "concatenated and de-duplicated by id");
        assert_eq!(
            tasks[0]["cron"], "0 2 * * 0",
            "the later layer replaces a task with the same id"
        );
        assert_eq!(tasks[2]["id"], "audit");
        assert_eq!(origins["agent.heartbeat_secs"], "pc");
        assert_eq!(origins["agent.metrics_secs"], "pg");
        assert_eq!(origins["agent.inventory_minutes"], "pd");
        assert_eq!(origins["remote_access.shell"], "pc");
        assert_eq!(origins["remote_access.files"], "pg");
        assert_eq!(origins["tasks.cleanup"], "pc");
        assert_eq!(origins["tasks.inventory"], "pg");
        assert_eq!(origins["tasks.audit"], "pc");

        let settings = agent_settings(&doc);
        assert_eq!(settings.heartbeat_secs, 30);
        assert_eq!(settings.metrics_secs, 120);
        assert_eq!(settings.inventory_minutes, 60);
        assert_eq!(agent_settings(&json!({})), AgentSettings::default());
    }

    #[test]
    fn merge_replaces_scalars_with_objects_and_back() {
        let a = json!({ "agent": 5 });
        let b = json!({ "agent": { "heartbeat_secs": 20 } });
        let (doc, origins) = merge(&[
            Layer {
                policy_id: "a",
                document: &a,
            },
            Layer {
                policy_id: "b",
                document: &b,
            },
        ]);
        assert_eq!(doc["agent"]["heartbeat_secs"], 20);
        assert!(!origins.contains_key("agent"));
        let (doc, origins) = merge(&[
            Layer {
                policy_id: "b",
                document: &b,
            },
            Layer {
                policy_id: "a",
                document: &a,
            },
        ]);
        assert_eq!(doc["agent"], 5);
        assert_eq!(origins.get("agent").map(String::as_str), Some("a"));
        assert!(!origins.contains_key("agent.heartbeat_secs"));
    }

    #[test]
    fn target_permissions() {
        let scope = AccessScope::default();
        assert!(!target_allowed(
            &scope,
            perm::POLICIES_MANAGE,
            "global",
            None,
            None,
            false
        ));
    }
}
