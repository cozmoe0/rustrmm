//! The `monitoring` policy section: validation, merging checks by `id`, the effective checks of
//! a device and the [`MonitoringConfig`] pushed to agents.

use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;

use rustrmm_proto::commands::Command;
use rustrmm_proto::monitoring::{CheckDefinition, EmbeddedScript, MonitoringConfig};
use rustrmm_proto::scripts as rules;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use super::catalog;
use crate::automation::params::{self, SecretRule};
use crate::automation::policies::{DocError, PolicyContext};
use crate::automation::rules::DeviceFacts;
use crate::state::AppState;

pub const MAX_CHECKS: usize = 100;
const CHECK_KEYS: &[&str] = &[
    "id",
    "type",
    "name",
    "enabled",
    "interval_secs",
    "severity",
    "config",
    "remediation",
    "platforms",
];
const SEVERITIES: &[&str] = &["info", "warning", "critical"];
const PLATFORMS: &[&str] = &["windows", "linux", "macos"];

fn err(path: impl Into<String>, message: impl Into<String>) -> DocError {
    DocError {
        path: path.into(),
        message: message.into(),
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Remediation attached to a check.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Remediation {
    pub script_id: String,
    #[serde(default)]
    pub parameters: Map<String, Value>,
    #[serde(default = "one")]
    pub max_attempts: i64,
}

fn one() -> i64 {
    1
}

/// A complete, validated check after merging.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CheckSpec {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub interval_secs: u32,
    pub severity: String,
    pub config: Map<String, Value>,
    pub remediation: Option<Remediation>,
    pub platforms: Vec<String>,
    /// The policy that last set this check (merge origin).
    pub policy_id: Option<String>,
}

/// Validates generic check fields. `complete`: the layer defines the whole check (it sets
/// `type`), so required config fields must be present.
fn check_fields(
    check: &Map<String, Value>,
    base: &str,
    complete: bool,
) -> Result<Option<CheckSpec>, DocError> {
    for key in check.keys() {
        if !CHECK_KEYS.contains(&key.as_str()) {
            return Err(err(format!("{base}.{key}"), "unknown setting"));
        }
    }
    let id = check
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string();
    if !valid_id(&id) {
        return Err(err(
            format!("{base}.id"),
            "must be 1–64 letters, digits, - or _",
        ));
    }
    let kind = match check.get("type") {
        None | Some(Value::Null) if !complete => String::new(),
        Some(Value::String(t)) if catalog::find(t).is_some() => t.clone(),
        Some(Value::String(t)) => {
            return Err(err(
                format!("{base}.type"),
                format!("unknown check type '{t}'"),
            ));
        }
        _ => return Err(err(format!("{base}.type"), "is required")),
    };
    let name = match check.get("name") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if !s.trim().is_empty() && s.trim().chars().count() <= 120 => {
            Some(s.trim().to_string())
        }
        _ => return Err(err(format!("{base}.name"), "must be 1–120 characters")),
    };
    if let Some(v) = check.get("enabled")
        && !v.is_boolean()
    {
        return Err(err(format!("{base}.enabled"), "must be true or false"));
    }
    let interval = match check.get("interval_secs") {
        None | Some(Value::Null) => None,
        Some(v) => match v.as_i64() {
            Some(n) if (30..=86_400).contains(&n) => Some(n as u32),
            _ => {
                return Err(err(
                    format!("{base}.interval_secs"),
                    "must be a whole number from 30 to 86400",
                ));
            }
        },
    };
    let severity = match check.get("severity") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if SEVERITIES.contains(&s.as_str()) => Some(s.clone()),
        _ => {
            return Err(err(
                format!("{base}.severity"),
                "must be info, warning or critical",
            ));
        }
    };
    let platforms = match check.get("platforms") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(list))
            if list
                .iter()
                .all(|p| p.as_str().is_some_and(|p| PLATFORMS.contains(&p))) =>
        {
            list.iter()
                .filter_map(|p| p.as_str().map(str::to_string))
                .collect()
        }
        _ => {
            return Err(err(
                format!("{base}.platforms"),
                "must be a list of windows, linux, macos",
            ));
        }
    };
    let remediation = match check.get("remediation") {
        None | Some(Value::Null) => None,
        Some(Value::Object(r)) => {
            for key in r.keys() {
                if !["script_id", "parameters", "max_attempts"].contains(&key.as_str()) {
                    return Err(err(format!("{base}.remediation.{key}"), "unknown setting"));
                }
            }
            let script_id = r
                .get("script_id")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or_default();
            if script_id.is_empty() && complete {
                return Err(err(format!("{base}.remediation.script_id"), "is required"));
            }
            let parameters = match r.get("parameters") {
                None | Some(Value::Null) => Map::new(),
                Some(Value::Object(m)) => m.clone(),
                Some(_) => {
                    return Err(err(
                        format!("{base}.remediation.parameters"),
                        "must be an object",
                    ));
                }
            };
            let max_attempts = match r.get("max_attempts") {
                None | Some(Value::Null) => 1,
                Some(v) => match v.as_i64() {
                    Some(n) if (1..=10).contains(&n) => n,
                    _ => {
                        return Err(err(
                            format!("{base}.remediation.max_attempts"),
                            "must be a whole number from 1 to 10",
                        ));
                    }
                },
            };
            Some(Remediation {
                script_id: script_id.to_string(),
                parameters,
                max_attempts,
            })
        }
        Some(_) => {
            return Err(err(format!("{base}.remediation"), "must be an object"));
        }
    };
    let config = match check.get("config") {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(m)) => m.clone(),
        Some(_) => return Err(err(format!("{base}.config"), "must be an object")),
    };
    if kind.is_empty() {
        // A partial override: the merged check is validated when it is used.
        return Ok(None);
    }
    let config = catalog::validate_config(&kind, &config, complete)
        .map_err(|(path, message)| err(format!("{base}.{path}"), message))?;
    let label = catalog::find(&kind).map(|t| t.label).unwrap_or_default();
    Ok(Some(CheckSpec {
        name: name.unwrap_or_else(|| label.to_string()),
        interval_secs: interval.unwrap_or(300),
        severity: severity.unwrap_or_else(|| "warning".into()),
        config,
        remediation,
        platforms,
        policy_id: None,
        id,
        kind,
    }))
}

/// Structural validation of the `monitoring` section of one policy document.
pub fn validate_section(value: &Value) -> Result<(), DocError> {
    let section = value
        .as_object()
        .ok_or_else(|| err("monitoring", "must be an object"))?;
    for (key, value) in section {
        match key.as_str() {
            "checks" => {
                let list = value
                    .as_array()
                    .ok_or_else(|| err("monitoring.checks", "must be a list"))?;
                if list.len() > MAX_CHECKS {
                    return Err(err(
                        "monitoring.checks",
                        format!("at most {MAX_CHECKS} checks"),
                    ));
                }
                let mut ids = HashSet::new();
                for (i, item) in list.iter().enumerate() {
                    let base = format!("monitoring.checks[{i}]");
                    let check = item
                        .as_object()
                        .ok_or_else(|| err(&base, "must be an object"))?;
                    let complete = check.get("type").is_some_and(|t| !t.is_null());
                    check_fields(check, &base, complete)?;
                    let id = check.get("id").and_then(Value::as_str).unwrap_or_default();
                    if !ids.insert(id.trim().to_string()) {
                        return Err(err(format!("{base}.id"), "is used by another check"));
                    }
                }
            }
            "server" => {
                let server = value
                    .as_object()
                    .ok_or_else(|| err("monitoring.server", "must be an object"))?;
                for (key, v) in server {
                    let path = format!("monitoring.server.{key}");
                    let ok = match key.as_str() {
                        "offline_minutes" => v.as_i64().is_some_and(|n| (0..=10_080).contains(&n)),
                        "disk_forecast_days" => v.as_i64().is_some_and(|n| (0..=365).contains(&n)),
                        "offline_severity" => v.as_str().is_some_and(|s| SEVERITIES.contains(&s)),
                        "agent_outdated" | "security_changes" => v.is_boolean(),
                        _ => return Err(err(path, "unknown setting")),
                    };
                    if !ok {
                        let message = match key.as_str() {
                            "offline_minutes" => "must be a whole number from 0 to 10080",
                            "disk_forecast_days" => "must be a whole number from 0 to 365",
                            "offline_severity" => "must be info, warning or critical",
                            _ => "must be true or false",
                        };
                        return Err(err(path, message));
                    }
                }
            }
            other => {
                return Err(err(
                    format!("monitoring.{other}"),
                    "unknown setting (allowed: checks, server)",
                ));
            }
        }
    }
    Ok(())
}

/// Database checks for one document: scripts of `script` checks and remediations must be
/// runnable, and their parameters valid (secret values come from variables).
pub async fn validate_scripts(state: &AppState, doc: &Value) -> Result<(), DocError> {
    let Some(list) = doc.pointer("/monitoring/checks").and_then(Value::as_array) else {
        return Ok(());
    };
    let settings = crate::automation::settings::load(state)
        .await
        .map_err(|_| err("", "could not load settings"))?;
    for (i, check) in list.iter().enumerate() {
        let base = format!("monitoring.checks[{i}]");
        let mut wanted = Vec::new();
        if check.get("type").and_then(Value::as_str) == Some("script")
            && let Some(id) = check.pointer("/config/script_id").and_then(Value::as_str)
        {
            let params = check
                .pointer("/config/parameters")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            wanted.push((format!("{base}.config"), id.to_string(), params));
        }
        if let Some(r) = check.get("remediation").and_then(Value::as_object)
            && let Some(id) = r.get("script_id").and_then(Value::as_str)
            && !id.trim().is_empty()
        {
            let params = r
                .get("parameters")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            wanted.push((format!("{base}.remediation"), id.trim().to_string(), params));
        }
        for (path, script_id, parameters) in wanted {
            let script = crate::automation::scripts::runnable_version(state, &script_id, &settings)
                .await
                .map_err(|e| err(format!("{path}.script_id"), e.message))?;
            params::validate_values(&script.parameters, &parameters, SecretRule::FromVariables)
                .map_err(|e| err(format!("{path}.parameters"), e))?;
        }
    }
    Ok(())
}

// ------------------------------------------------------------------ merging

/// Deep-merges JSON objects (`source` keys win; `null` leaves the target alone).
fn deep_merge(target: &mut Value, source: &Value) {
    match (target.as_object_mut(), source) {
        (Some(t), Value::Object(s)) => {
            for (key, value) in s {
                match t.get_mut(key) {
                    Some(slot) if slot.is_object() && value.is_object() => deep_merge(slot, value),
                    _ if value.is_null() => {}
                    _ => {
                        t.insert(key.clone(), value.clone());
                    }
                }
            }
        }
        (_, Value::Null) => {}
        _ => *target = source.clone(),
    }
}

/// Merges one layer's `monitoring.checks` into the merged list: a check whose `id` already
/// exists has its fields overridden (objects such as `config` deep-merge), new ids append.
pub fn merge_checks(
    list: &mut Vec<Value>,
    source: &Value,
    policy_id: &str,
    origins: &mut BTreeMap<String, String>,
) {
    let Some(src) = source.as_array() else {
        return;
    };
    for check in src {
        let Some(id) = check.get("id").and_then(Value::as_str) else {
            continue;
        };
        match list
            .iter()
            .position(|c| c.get("id").and_then(Value::as_str) == Some(id))
        {
            Some(i) => {
                // A layer that sets a different type redefines the check from scratch.
                let retyped = check
                    .get("type")
                    .and_then(Value::as_str)
                    .is_some_and(|t| list[i].get("type").and_then(Value::as_str) != Some(t));
                if retyped {
                    list[i] = check.clone();
                } else {
                    deep_merge(&mut list[i], check);
                }
            }
            None => list.push(check.clone()),
        }
        origins.insert(format!("monitoring.checks.{id}"), policy_id.to_string());
    }
}

// ------------------------------------------------------------------ effective configuration

/// Server-side check settings for one device.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ServerConfig {
    /// `None` when no policy sets it (the monitoring setting `default_offline_minutes` applies).
    pub offline_minutes: Option<i64>,
    pub offline_severity: String,
    pub agent_outdated: bool,
    pub disk_forecast_days: i64,
    pub security_changes: bool,
}

pub fn server_config(doc: &Value) -> ServerConfig {
    let get = |key: &str| doc.pointer(&format!("/monitoring/server/{key}"));
    ServerConfig {
        offline_minutes: get("offline_minutes").and_then(Value::as_i64),
        offline_severity: get("offline_severity")
            .and_then(Value::as_str)
            .filter(|s| SEVERITIES.contains(s))
            .unwrap_or("critical")
            .to_string(),
        agent_outdated: get("agent_outdated")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        disk_forecast_days: get("disk_forecast_days")
            .and_then(Value::as_i64)
            .unwrap_or(14),
        security_changes: get("security_changes")
            .and_then(Value::as_bool)
            .unwrap_or(true),
    }
}

/// The enabled, valid checks of a merged document that apply to an operating system.
pub fn effective_checks(
    doc: &Value,
    origins: &BTreeMap<String, String>,
    os_family: &str,
) -> Vec<CheckSpec> {
    let Some(list) = doc.pointer("/monitoring/checks").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for item in list {
        let Some(check) = item.as_object() else {
            continue;
        };
        if check.get("enabled").and_then(Value::as_bool) == Some(false) {
            continue;
        }
        let id = check.get("id").and_then(Value::as_str).unwrap_or_default();
        match check_fields(check, &format!("monitoring.checks.{id}"), true) {
            Ok(Some(mut spec)) => {
                if !catalog::supports(&spec.kind, os_family)
                    || (!spec.platforms.is_empty()
                        && !spec.platforms.iter().any(|p| p == os_family))
                {
                    continue;
                }
                if spec
                    .remediation
                    .as_ref()
                    .is_some_and(|r| r.script_id.is_empty())
                {
                    spec.remediation = None;
                }
                spec.policy_id = origins.get(&format!("monitoring.checks.{id}")).cloned();
                out.push(spec);
            }
            Ok(None) => {}
            Err(e) => {
                tracing::debug!(check = id, path = %e.path, error = %e.message, "skipping an invalid merged check");
            }
        }
    }
    out
}

/// Effective monitoring of one device (checks plus server settings).
#[derive(Debug, Clone)]
pub struct DeviceMonitoring {
    pub device_id: String,
    pub checks: Vec<CheckSpec>,
    pub server: ServerConfig,
}

impl DeviceMonitoring {
    pub fn check(&self, id: &str) -> Option<&CheckSpec> {
        self.checks.iter().find(|c| c.id == id)
    }
}

pub fn device_monitoring(ctx: &PolicyContext, facts: &DeviceFacts) -> DeviceMonitoring {
    let effective = ctx.effective(facts);
    DeviceMonitoring {
        device_id: facts.id.clone(),
        checks: effective_checks(&effective.document, &effective.origins, &facts.os_family),
        server: server_config(&effective.document),
    }
}

/// Effective monitoring of one device, loaded from the database (`None` when inactive).
pub async fn load_device(
    state: &AppState,
    device_id: &str,
) -> anyhow::Result<Option<DeviceMonitoring>> {
    let ids = [device_id.to_string()];
    let ctx = PolicyContext::load(&state.db, Some(&ids)).await?;
    let found = ctx.facts(device_id).map(|f| device_monitoring(&ctx, f));
    if let Some(m) = &found {
        state
            .monitoring
            .devices
            .insert(device_id.to_string(), Arc::new(m.clone()));
    }
    Ok(found)
}

/// Cached effective monitoring (refreshed whenever configuration is pushed).
pub async fn cached_device(
    state: &AppState,
    device_id: &str,
) -> anyhow::Result<Option<Arc<DeviceMonitoring>>> {
    if let Some(m) = state.monitoring.devices.get(device_id) {
        return Ok(Some(m.clone()));
    }
    Ok(load_device(state, device_id).await?.map(Arc::new))
}

// ------------------------------------------------------------------ agent configuration

/// Builds the configuration sent to one device: catalog defaults are filled in and `script`
/// checks embed the resolved script, variables and parameters.
pub async fn build_config(
    state: &AppState,
    facts: &DeviceFacts,
    checks: &[CheckSpec],
) -> anyhow::Result<MonitoringConfig> {
    let settings = super::settings::load(state).await?;
    let automation = crate::automation::settings::load(state).await?;
    let mut definitions = Vec::with_capacity(checks.len());
    for spec in checks {
        let mut config = spec.config.clone();
        let mut script = None;
        if spec.kind == "script" {
            match embed_script(state, facts, &config, &automation).await {
                Ok(s) => script = Some(s),
                Err(reason) => {
                    config.insert("unavailable".into(), json!(reason));
                }
            }
            // Parameters travel as environment, never in the plain config.
            config.remove("parameters");
        }
        definitions.push(CheckDefinition {
            id: spec.id.clone(),
            kind: spec.kind.clone(),
            name: spec.name.clone(),
            interval_secs: spec.interval_secs,
            config: Value::Object(config),
            script,
        });
    }
    Ok(MonitoringConfig::new(
        definitions,
        settings.unknown_threshold.clamp(1, 100) as u32,
    ))
}

async fn embed_script(
    state: &AppState,
    facts: &DeviceFacts,
    config: &Map<String, Value>,
    automation: &crate::automation::settings::AutomationSettings,
) -> Result<EmbeddedScript, String> {
    let script_id = config
        .get("script_id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let runnable = crate::automation::scripts::runnable_version(state, script_id, automation)
        .await
        .map_err(|e| format!("script unavailable: {}", e.message))?;
    if !rules::language_platforms(&runnable.script.language).contains(&facts.os_family.as_str()) {
        return Err(format!(
            "{} scripts cannot run on {}",
            runnable.script.language, facts.os_family
        ));
    }
    let parameters = config
        .get("parameters")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let values =
        params::validate_values(&runnable.parameters, &parameters, SecretRule::FromVariables)?;
    let mut env = Vec::new();
    let mut mask = Vec::new();
    let variables =
        crate::automation::variables::for_device(state, &facts.client_id, &facts.site_id)
            .await
            .map_err(|e| format!("variables unavailable: {e:#}"))?;
    for var in variables {
        if var.secret {
            mask.push(var.value.clone());
        }
        env.push((var.name, var.value));
    }
    for (key, value) in values {
        if value.secret {
            mask.push(value.value.clone());
        }
        env.push((key, value.value));
    }
    mask.retain(|m| m.chars().count() >= rules::MIN_MASK_LEN);
    Ok(EmbeddedScript {
        language: runnable.script.language.clone(),
        content_sha256: runnable.content_sha256.clone(),
        content: runnable.content,
        env,
        mask,
    })
}

/// Sends the configuration to one connected device (always, used on connect).
pub async fn push_device(state: &AppState, device_id: &str) -> anyhow::Result<()> {
    let ids = [device_id.to_string()];
    let ctx = PolicyContext::load(&state.db, Some(&ids)).await?;
    let Some(facts) = ctx.facts(device_id) else {
        return Ok(());
    };
    let monitoring = device_monitoring(&ctx, facts);
    let config = build_config(state, facts, &monitoring.checks).await?;
    send(state, device_id, config, true).await?;
    state
        .monitoring
        .devices
        .insert(device_id.to_string(), Arc::new(monitoring));
    Ok(())
}

async fn send(
    state: &AppState,
    device_id: &str,
    config: MonitoringConfig,
    force: bool,
) -> anyhow::Result<bool> {
    let version = config.version.clone();
    if !force
        && state
            .monitoring
            .pushed
            .get(device_id)
            .is_some_and(|v| *v == version)
    {
        return Ok(false);
    }
    crate::agents::commands::send_quiet(state, device_id, Command::MonitoringConfig(config), 120)
        .await?;
    state
        .monitoring
        .pushed
        .insert(device_id.to_string(), version);
    Ok(true)
}

/// Re-sends changed configurations to every connected device (after policy changes).
pub async fn push_all(state: &AppState) -> anyhow::Result<usize> {
    state.monitoring.devices.clear();
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
    for facts in &ctx.index.facts {
        let monitoring = device_monitoring(&ctx, facts);
        match build_config(state, facts, &monitoring.checks).await {
            Ok(config) => match send(state, &facts.id, config, false).await {
                Ok(true) => sent += 1,
                Ok(false) => {}
                Err(e) => {
                    tracing::debug!(device = %facts.id, error = %format!("{e:#}"), "monitoring config not sent")
                }
            },
            Err(e) => {
                tracing::warn!(device = %facts.id, error = %format!("{e:#}"), "building monitoring config failed")
            }
        }
        state
            .monitoring
            .devices
            .insert(facts.id.clone(), Arc::new(monitoring));
    }
    Ok(sent)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn section_validation_points_at_paths() {
        assert!(validate_section(&json!({})).is_ok());
        let ok = json!({
            "checks": [
                { "id": "disk-c", "type": "disk", "name": "Low disk space", "interval_secs": 300, "severity": "warning",
                  "config": { "volume": "*", "warn_free_pct": 15, "crit_free_pct": 5 },
                  "remediation": { "script_id": "s1", "parameters": {}, "max_attempts": 1 } },
                { "id": "cpu", "enabled": false }
            ],
            "server": { "offline_minutes": 15, "offline_severity": "critical", "agent_outdated": true,
                        "disk_forecast_days": 14, "security_changes": true }
        });
        validate_section(&ok).expect("valid");
        let cases = [
            (json!({ "colour": 1 }), "monitoring.colour"),
            (json!({ "checks": {} }), "monitoring.checks"),
            (
                json!({ "checks": [{ "id": "a b", "type": "cpu" }] }),
                "monitoring.checks[0].id",
            ),
            (
                json!({ "checks": [{ "id": "a", "type": "nope" }] }),
                "monitoring.checks[0].type",
            ),
            (
                json!({ "checks": [{ "id": "a", "type": "cpu", "interval_secs": 5 }] }),
                "monitoring.checks[0].interval_secs",
            ),
            (
                json!({ "checks": [{ "id": "a", "type": "cpu", "config": { "warn_pct": 101 } }] }),
                "monitoring.checks[0].config.warn_pct",
            ),
            (
                json!({ "checks": [{ "id": "a", "type": "tcp_port", "config": { "host": "x" } }] }),
                "monitoring.checks[0].config.port",
            ),
            (
                json!({ "checks": [{ "id": "a", "type": "cpu" }, { "id": "a", "type": "memory" }] }),
                "monitoring.checks[1].id",
            ),
            (
                json!({ "checks": [{ "id": "a", "type": "cpu", "severity": "huge" }] }),
                "monitoring.checks[0].severity",
            ),
            (
                json!({ "checks": [{ "id": "a", "type": "cpu", "remediation": { "max_attempts": 0, "script_id": "s" } }] }),
                "monitoring.checks[0].remediation.max_attempts",
            ),
            (
                json!({ "checks": [{ "id": "a", "type": "cpu", "platforms": ["bsd"] }] }),
                "monitoring.checks[0].platforms",
            ),
            (
                json!({ "server": { "offline_minutes": -1 } }),
                "monitoring.server.offline_minutes",
            ),
            (
                json!({ "server": { "pager": true } }),
                "monitoring.server.pager",
            ),
        ];
        for (doc, path) in cases {
            assert_eq!(
                validate_section(&doc).expect_err("invalid").path,
                path,
                "{doc}"
            );
        }
    }

    #[test]
    fn checks_merge_by_id_with_field_overrides() {
        let global = json!([
            { "id": "disk-c", "type": "disk", "name": "Disk", "config": { "volume": "*", "warn_free_pct": 15, "crit_free_pct": 5 } },
            { "id": "cpu", "type": "cpu", "config": { "warn_pct": 85 } },
            { "id": "svc", "type": "service", "config": { "name": "Spooler" } }
        ]);
        let client = json!([
            { "id": "disk-c", "config": { "warn_free_pct": 25 }, "severity": "critical" },
            { "id": "cpu", "enabled": false },
            { "id": "svc", "type": "process", "config": { "name": "spoolsv.exe" } },
            { "id": "uptime", "type": "uptime", "platforms": ["windows"] }
        ]);
        let mut list = Vec::new();
        let mut origins = BTreeMap::new();
        merge_checks(&mut list, &global, "pg", &mut origins);
        merge_checks(&mut list, &client, "pc", &mut origins);
        assert_eq!(list.len(), 4);
        assert_eq!(list[0]["config"]["warn_free_pct"], 25, "override");
        assert_eq!(
            list[0]["config"]["crit_free_pct"], 5,
            "kept from the earlier layer"
        );
        assert_eq!(list[0]["severity"], "critical");
        assert_eq!(list[0]["name"], "Disk");
        assert_eq!(list[2]["type"], "process", "a new type redefines the check");
        assert!(list[2]["config"].get("volume").is_none());
        assert_eq!(origins["monitoring.checks.disk-c"], "pc");

        let doc = json!({ "monitoring": { "checks": list } });
        let windows = effective_checks(&doc, &origins, "windows");
        let ids: Vec<&str> = windows.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, vec!["disk-c", "svc", "uptime"], "cpu is disabled");
        assert_eq!(windows[0].policy_id.as_deref(), Some("pc"));
        assert_eq!(windows[0].config["warn_free_pct"], 25);
        assert_eq!(
            windows[2].config["crit_days"],
            json!(60.0),
            "defaults filled in"
        );
        let linux = effective_checks(&doc, &origins, "linux");
        assert!(linux.iter().all(|c| c.id != "uptime"), "platform filter");

        let server =
            server_config(&json!({ "monitoring": { "server": { "offline_minutes": 5 } } }));
        assert_eq!(server.offline_minutes, Some(5));
        assert_eq!(server.offline_severity, "critical");
        assert!(server_config(&json!({})).offline_minutes.is_none());
    }

    #[test]
    fn windows_only_types_are_filtered() {
        let doc = json!({ "monitoring": { "checks": [
            { "id": "wu", "type": "windows_update" },
            { "id": "av", "type": "antivirus" }
        ] } });
        assert_eq!(effective_checks(&doc, &BTreeMap::new(), "windows").len(), 2);
        assert!(effective_checks(&doc, &BTreeMap::new(), "macos").is_empty());
    }
}
