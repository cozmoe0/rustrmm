//! Dynamic group rule engine.
//!
//! A rule document is `{ "match": "all" | "any", "conditions": [Condition | RuleDocument] }`,
//! nested at most [`MAX_DEPTH`] levels with at most [`MAX_CONDITIONS`] conditions in total. A
//! document is validated and compiled once (regular expressions included) and then evaluated
//! against [`DeviceFacts`] for every candidate device.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, NaiveDate, Utc};
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{QueryBuilder, Sqlite};

use crate::db::Db;

pub const MAX_DEPTH: usize = 3;
pub const MAX_CONDITIONS: usize = 50;
pub const MAX_REGEX_LEN: usize = 200;
const MAX_LIST: usize = 100;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RuleDocument {
    #[serde(rename = "match")]
    pub match_kind: String,
    #[serde(default)]
    pub conditions: Vec<RuleNode>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RuleNode {
    Group(RuleDocument),
    Condition(Condition),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Condition {
    pub field: String,
    pub op: String,
    #[serde(default)]
    pub value: Value,
}

/// Value kinds a field can have.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Text,
    Id,
    Tag,
    Bool,
    Number,
    Date,
}

/// Built-in fields and their kinds.
pub fn builtin_kind(field: &str) -> Option<Kind> {
    Some(match field {
        "hostname" | "os_name" | "os_version" | "agent_version" | "device_type" | "last_user"
        | "domain" | "manufacturer" | "model" | "serial" | "public_ip" | "os_family" => Kind::Text,
        "client_id" | "site_id" => Kind::Id,
        "tag" => Kind::Tag,
        "online" | "pending_reboot" => Kind::Bool,
        "health_score" | "ram_gb" | "disk_free_pct" | "uptime_days" | "last_seen_minutes" => {
            Kind::Number
        }
        _ => return None,
    })
}

/// Maps a custom field type to a rule kind.
pub fn custom_kind(field_type: &str) -> Kind {
    match field_type {
        "number" => Kind::Number,
        "boolean" => Kind::Bool,
        "date" => Kind::Date,
        _ => Kind::Text,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Op {
    Eq,
    Neq,
    In,
    NotIn,
    Exists,
    NotExists,
    Contains,
    NotContains,
    StartsWith,
    EndsWith,
    Matches,
    Gt,
    Gte,
    Lt,
    Lte,
}

fn parse_op(op: &str, kind: Kind) -> Result<Op, String> {
    let parsed = match op {
        "eq" => Op::Eq,
        "neq" => Op::Neq,
        "in" => Op::In,
        "not_in" => Op::NotIn,
        "exists" => Op::Exists,
        "not_exists" => Op::NotExists,
        "contains" => Op::Contains,
        "not_contains" => Op::NotContains,
        "starts_with" => Op::StartsWith,
        "ends_with" => Op::EndsWith,
        "matches" => Op::Matches,
        "gt" => Op::Gt,
        "gte" => Op::Gte,
        "lt" => Op::Lt,
        "lte" => Op::Lte,
        other => return Err(format!("unknown operator '{other}'")),
    };
    let allowed = match parsed {
        Op::Eq | Op::Neq | Op::In | Op::NotIn | Op::Exists | Op::NotExists => true,
        Op::Contains | Op::NotContains | Op::StartsWith | Op::EndsWith | Op::Matches => {
            matches!(kind, Kind::Text | Kind::Tag)
        }
        Op::Gt | Op::Gte | Op::Lt | Op::Lte => matches!(kind, Kind::Number | Kind::Date),
    };
    if allowed {
        Ok(parsed)
    } else {
        Err(format!("operator '{op}' does not apply to this field"))
    }
}

#[derive(Debug, Clone)]
enum Scalar {
    Text(String),
    Number(f64),
    Bool(bool),
    Date(NaiveDate),
}

#[derive(Debug, Clone)]
enum Operand {
    None,
    One(Scalar),
    Many(Vec<Scalar>),
    Regex(Box<Regex>),
}

/// Parses `YYYY-MM-DD` or an RFC 3339 timestamp to a calendar date.
pub fn parse_date(s: &str) -> Option<NaiveDate> {
    let s = s.trim();
    NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .ok()
        .or_else(|| DateTime::parse_from_rfc3339(s).ok().map(|d| d.date_naive()))
}

fn scalar(kind: Kind, value: &Value) -> Result<Scalar, String> {
    match kind {
        Kind::Text | Kind::Id | Kind::Tag => match value {
            Value::String(s) if s.chars().count() <= 500 => Ok(Scalar::Text(s.to_lowercase())),
            Value::Number(n) => Ok(Scalar::Text(n.to_string())),
            _ => Err("value must be text of at most 500 characters".into()),
        },
        Kind::Number => match value {
            Value::Number(n) => n
                .as_f64()
                .map(Scalar::Number)
                .ok_or_else(|| "invalid number".into()),
            Value::String(s) => s
                .trim()
                .parse::<f64>()
                .ok()
                .filter(|f| f.is_finite())
                .map(Scalar::Number)
                .ok_or_else(|| "value must be a number".into()),
            _ => Err("value must be a number".into()),
        },
        Kind::Bool => match value {
            Value::Bool(b) => Ok(Scalar::Bool(*b)),
            Value::String(s) if s.eq_ignore_ascii_case("true") => Ok(Scalar::Bool(true)),
            Value::String(s) if s.eq_ignore_ascii_case("false") => Ok(Scalar::Bool(false)),
            _ => Err("value must be true or false".into()),
        },
        Kind::Date => match value {
            Value::String(s) => parse_date(s)
                .map(Scalar::Date)
                .ok_or_else(|| "value must be a date (YYYY-MM-DD)".into()),
            _ => Err("value must be a date (YYYY-MM-DD)".into()),
        },
    }
}

#[derive(Debug, Clone)]
struct CompiledCondition {
    field: String,
    kind: Kind,
    op: Op,
    operand: Operand,
}

#[derive(Debug, Clone)]
enum CompiledNode {
    Group(CompiledRule),
    Condition(CompiledCondition),
}

/// A validated, ready-to-evaluate rule document.
#[derive(Debug, Clone)]
pub struct CompiledRule {
    all: bool,
    nodes: Vec<CompiledNode>,
}

/// Custom field definitions visible to rules: key → field type.
pub type CustomDefs = HashMap<String, String>;

/// Validates and compiles a rule document. Errors name the offending condition path.
pub fn compile(doc: &RuleDocument, custom: &CustomDefs) -> Result<CompiledRule, String> {
    let mut count = 0usize;
    compile_level(doc, custom, 1, "conditions", &mut count)
}

fn compile_level(
    doc: &RuleDocument,
    custom: &CustomDefs,
    depth: usize,
    path: &str,
    count: &mut usize,
) -> Result<CompiledRule, String> {
    if depth > MAX_DEPTH {
        return Err(format!("{path}: rules can nest at most {MAX_DEPTH} levels"));
    }
    let all = match doc.match_kind.as_str() {
        "all" => true,
        "any" => false,
        _ => return Err(format!("{path}: match must be \"all\" or \"any\"")),
    };
    let mut nodes = Vec::with_capacity(doc.conditions.len());
    for (i, node) in doc.conditions.iter().enumerate() {
        let here = format!("{path}[{i}]");
        match node {
            RuleNode::Group(group) => nodes.push(CompiledNode::Group(compile_level(
                group,
                custom,
                depth + 1,
                &format!("{here}.conditions"),
                count,
            )?)),
            RuleNode::Condition(cond) => {
                *count += 1;
                if *count > MAX_CONDITIONS {
                    return Err(format!(
                        "a rule can hold at most {MAX_CONDITIONS} conditions"
                    ));
                }
                nodes.push(CompiledNode::Condition(
                    compile_condition(cond, custom).map_err(|e| format!("{here}: {e}"))?,
                ));
            }
        }
    }
    Ok(CompiledRule { all, nodes })
}

fn compile_condition(cond: &Condition, custom: &CustomDefs) -> Result<CompiledCondition, String> {
    let kind = if let Some(key) = cond.field.strip_prefix("custom.") {
        custom_kind(
            custom
                .get(key)
                .ok_or_else(|| format!("unknown custom field '{key}'"))?,
        )
    } else {
        builtin_kind(&cond.field).ok_or_else(|| format!("unknown field '{}'", cond.field))?
    };
    let op = parse_op(&cond.op, kind)?;
    let operand = match op {
        Op::Exists | Op::NotExists => Operand::None,
        Op::In | Op::NotIn => {
            let items = cond.value.as_array().ok_or("value must be a list")?;
            if items.is_empty() || items.len() > MAX_LIST {
                return Err(format!("value must hold 1–{MAX_LIST} items"));
            }
            Operand::Many(
                items
                    .iter()
                    .map(|v| scalar(kind, v))
                    .collect::<Result<Vec<_>, _>>()?,
            )
        }
        Op::Contains | Op::NotContains | Op::StartsWith | Op::EndsWith => match &cond.value {
            Value::String(s) if !s.is_empty() && s.chars().count() <= 500 => {
                Operand::One(Scalar::Text(s.to_lowercase()))
            }
            _ => return Err("value must be non-empty text".into()),
        },
        Op::Matches => {
            let pattern = cond
                .value
                .as_str()
                .ok_or("value must be a regular expression")?;
            if pattern.is_empty() || pattern.chars().count() > MAX_REGEX_LEN {
                return Err(format!(
                    "regular expressions must be 1–{MAX_REGEX_LEN} characters"
                ));
            }
            let regex = RegexBuilder::new(pattern)
                .size_limit(1 << 20)
                .dfa_size_limit(1 << 20)
                .build()
                .map_err(|e| format!("invalid regular expression: {e}"))?;
            Operand::Regex(Box::new(regex))
        }
        Op::Eq | Op::Neq | Op::Gt | Op::Gte | Op::Lt | Op::Lte => {
            Operand::One(scalar(kind, &cond.value)?)
        }
    };
    Ok(CompiledCondition {
        field: cond.field.clone(),
        kind,
        op,
        operand,
    })
}

/// Everything rules can look at for one device.
#[derive(Debug, Clone, Default)]
pub struct DeviceFacts {
    pub id: String,
    pub client_id: String,
    pub site_id: String,
    pub hostname: String,
    pub os_family: String,
    pub os_name: String,
    pub os_version: String,
    pub agent_version: String,
    pub device_type: Option<String>,
    pub last_user: Option<String>,
    pub domain: Option<String>,
    pub manufacturer: Option<String>,
    pub model: Option<String>,
    pub serial: Option<String>,
    pub public_ip: Option<String>,
    pub tags: Vec<String>,
    pub online: bool,
    pub pending_reboot: Option<bool>,
    pub health_score: Option<f64>,
    pub ram_gb: Option<f64>,
    pub disk_free_pct: Option<f64>,
    pub uptime_days: Option<f64>,
    pub last_seen_minutes: Option<f64>,
    /// Device custom field values by key.
    pub custom: HashMap<String, Value>,
}

enum Fact<'a> {
    Missing,
    Text(&'a str),
    Tags(&'a [String]),
    Number(f64),
    Bool(bool),
    Date(NaiveDate),
}

fn opt_text(s: &Option<String>) -> Fact<'_> {
    s.as_deref().map(Fact::Text).unwrap_or(Fact::Missing)
}

fn num(n: Option<f64>) -> Fact<'static> {
    n.map(Fact::Number).unwrap_or(Fact::Missing)
}

impl DeviceFacts {
    fn fact(&self, field: &str, kind: Kind) -> Fact<'_> {
        match field {
            "hostname" => Fact::Text(&self.hostname),
            "os_family" => Fact::Text(&self.os_family),
            "os_name" => Fact::Text(&self.os_name),
            "os_version" => Fact::Text(&self.os_version),
            "agent_version" => Fact::Text(&self.agent_version),
            "device_type" => opt_text(&self.device_type),
            "last_user" => opt_text(&self.last_user),
            "domain" => opt_text(&self.domain),
            "manufacturer" => opt_text(&self.manufacturer),
            "model" => opt_text(&self.model),
            "serial" => opt_text(&self.serial),
            "public_ip" => opt_text(&self.public_ip),
            "client_id" => Fact::Text(&self.client_id),
            "site_id" => Fact::Text(&self.site_id),
            "tag" => Fact::Tags(&self.tags),
            "online" => Fact::Bool(self.online),
            "pending_reboot" => self.pending_reboot.map(Fact::Bool).unwrap_or(Fact::Missing),
            "health_score" => num(self.health_score),
            "ram_gb" => num(self.ram_gb),
            "disk_free_pct" => num(self.disk_free_pct),
            "uptime_days" => num(self.uptime_days),
            "last_seen_minutes" => num(self.last_seen_minutes),
            other => {
                let Some(key) = other.strip_prefix("custom.") else {
                    return Fact::Missing;
                };
                match (self.custom.get(key), kind) {
                    (None | Some(Value::Null), _) => Fact::Missing,
                    (Some(Value::Number(n)), Kind::Number) => num(n.as_f64()),
                    (Some(Value::String(s)), Kind::Number) => num(s.trim().parse().ok()),
                    (Some(Value::Bool(b)), Kind::Bool) => Fact::Bool(*b),
                    (Some(Value::String(s)), Kind::Date) => {
                        parse_date(s).map(Fact::Date).unwrap_or(Fact::Missing)
                    }
                    (Some(Value::String(s)), _) => Fact::Text(s),
                    _ => Fact::Missing,
                }
            }
        }
    }
}

impl CompiledRule {
    pub fn matches(&self, facts: &DeviceFacts) -> bool {
        let mut results = self.nodes.iter().map(|node| match node {
            CompiledNode::Group(group) => group.matches(facts),
            CompiledNode::Condition(cond) => cond.matches(facts),
        });
        if self.all {
            results.all(|r| r)
        } else {
            results.any(|r| r)
        }
    }

    /// Custom field keys the rule reads.
    pub fn custom_keys(&self, out: &mut HashSet<String>) {
        for node in &self.nodes {
            match node {
                CompiledNode::Group(g) => g.custom_keys(out),
                CompiledNode::Condition(c) => {
                    if let Some(key) = c.field.strip_prefix("custom.") {
                        out.insert(key.to_string());
                    }
                }
            }
        }
    }
}

fn scalar_eq(fact: &Fact<'_>, want: &Scalar) -> bool {
    match (fact, want) {
        (Fact::Text(t), Scalar::Text(w)) => t.to_lowercase() == *w,
        (Fact::Tags(tags), Scalar::Text(w)) => tags.iter().any(|t| t.to_lowercase() == *w),
        (Fact::Number(n), Scalar::Number(w)) => (n - w).abs() < 1e-9,
        (Fact::Bool(b), Scalar::Bool(w)) => b == w,
        (Fact::Date(d), Scalar::Date(w)) => d == w,
        _ => false,
    }
}

fn text_test(fact: &Fact<'_>, test: impl Fn(&str) -> bool) -> bool {
    match fact {
        Fact::Text(t) => test(&t.to_lowercase()),
        Fact::Tags(tags) => tags.iter().any(|t| test(&t.to_lowercase())),
        _ => false,
    }
}

impl CompiledCondition {
    fn matches(&self, facts: &DeviceFacts) -> bool {
        let fact = facts.fact(&self.field, self.kind);
        let present = match &fact {
            Fact::Missing => false,
            Fact::Text(t) => !t.is_empty(),
            Fact::Tags(tags) => !tags.is_empty(),
            _ => true,
        };
        let one = || match &self.operand {
            Operand::One(s) => Some(s),
            _ => None,
        };
        let text = || match one() {
            Some(Scalar::Text(t)) => t.as_str(),
            _ => "",
        };
        match self.op {
            Op::Exists => present,
            Op::NotExists => !present,
            Op::Eq => one().is_some_and(|w| scalar_eq(&fact, w)),
            Op::Neq => !one().is_some_and(|w| scalar_eq(&fact, w)),
            Op::In => {
                matches!(&self.operand, Operand::Many(list) if list.iter().any(|w| scalar_eq(&fact, w)))
            }
            Op::NotIn => {
                !matches!(&self.operand, Operand::Many(list) if list.iter().any(|w| scalar_eq(&fact, w)))
            }
            Op::Contains => text_test(&fact, |t| t.contains(text())),
            Op::NotContains => !text_test(&fact, |t| t.contains(text())),
            Op::StartsWith => text_test(&fact, |t| t.starts_with(text())),
            Op::EndsWith => text_test(&fact, |t| t.ends_with(text())),
            Op::Matches => match (&self.operand, &fact) {
                (Operand::Regex(re), Fact::Text(t)) => re.is_match(t),
                (Operand::Regex(re), Fact::Tags(tags)) => tags.iter().any(|t| re.is_match(t)),
                _ => false,
            },
            Op::Gt | Op::Gte | Op::Lt | Op::Lte => {
                let ordering = match (&fact, one()) {
                    (Fact::Number(n), Some(Scalar::Number(w))) => n.partial_cmp(w),
                    (Fact::Date(d), Some(Scalar::Date(w))) => Some(d.cmp(w)),
                    _ => None,
                };
                match ordering {
                    Some(o) => match self.op {
                        Op::Gt => o.is_gt(),
                        Op::Gte => o.is_ge(),
                        Op::Lt => o.is_lt(),
                        _ => o.is_le(),
                    },
                    None => false,
                }
            }
        }
    }
}

/// Device-scope custom field definitions (key → type) for rule validation.
pub async fn custom_defs(db: &Db) -> anyhow::Result<CustomDefs> {
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT key, type FROM custom_fields WHERE scope = 'device'")
            .fetch_all(db)
            .await?;
    Ok(rows.into_iter().collect())
}

/// Which devices to load facts for.
#[derive(Debug, Default, Clone)]
pub struct FactsFilter<'a> {
    pub client_id: Option<&'a str>,
    pub device_ids: Option<&'a [String]>,
}

#[derive(sqlx::FromRow)]
struct FactsRow {
    id: String,
    client_id: String,
    site_id: String,
    hostname: String,
    os_family: String,
    os_name: String,
    os_version: String,
    agent_version: String,
    device_type: Option<String>,
    last_user: Option<String>,
    domain: Option<String>,
    manufacturer: Option<String>,
    model: Option<String>,
    serial: Option<String>,
    last_ip: Option<String>,
    tags: String,
    online: bool,
    health_score: Option<i64>,
    disk_pct: Option<f64>,
    uptime_s: Option<i64>,
    last_seen_at: Option<DateTime<Utc>>,
    ram_bytes: Option<i64>,
    pending_reboot: Option<i64>,
}

/// Loads facts for active devices.
pub async fn load_facts(db: &Db, filter: FactsFilter<'_>) -> anyhow::Result<Vec<DeviceFacts>> {
    if filter.device_ids.is_some_and(|ids| ids.is_empty()) {
        return Ok(Vec::new());
    }
    let mut qb = QueryBuilder::<Sqlite>::new(
        "SELECT d.id, s.client_id, d.site_id, d.hostname, d.os_family, d.os_name, d.os_version, d.agent_version,
                d.device_type, d.last_user, d.domain, d.manufacturer, d.model, d.serial, d.last_ip, d.tags, d.online,
                d.health_score, d.disk_pct, d.uptime_s, d.last_seen_at,
                (SELECT CAST(json_extract(i.data, '$.memory.total_bytes') AS INTEGER) FROM device_inventory i
                  WHERE i.device_id = d.id AND i.section = 'hardware') AS ram_bytes,
                COALESCE(
                  (SELECT CAST(json_extract(i.data, '$.pending_reboot') AS INTEGER) FROM device_inventory i
                    WHERE i.device_id = d.id AND i.section = 'system'),
                  (SELECT CAST(json_extract(i.data, '$.pending_reboot') AS INTEGER) FROM device_inventory i
                    WHERE i.device_id = d.id AND i.section = 'updates')) AS pending_reboot
         FROM devices d JOIN sites s ON s.id = d.site_id WHERE d.status = 'active'",
    );
    if let Some(client) = filter.client_id {
        qb.push(" AND s.client_id = ").push_bind(client.to_string());
    }
    if let Some(ids) = filter.device_ids {
        qb.push(" AND d.id IN (");
        let mut sep = qb.separated(", ");
        for id in ids {
            sep.push_bind(id.clone());
        }
        qb.push(")");
    }
    let rows: Vec<FactsRow> = qb.build_query_as().fetch_all(db).await?;

    let mut custom_q = QueryBuilder::<Sqlite>::new(
        "SELECT v.entity_id, f.key, v.value FROM custom_field_values v JOIN custom_fields f ON f.id = v.field_id
         WHERE f.scope = 'device'",
    );
    if let Some(ids) = filter.device_ids {
        custom_q.push(" AND v.entity_id IN (");
        let mut sep = custom_q.separated(", ");
        for id in ids {
            sep.push_bind(id.clone());
        }
        custom_q.push(")");
    }
    let custom_rows: Vec<(String, String, String)> =
        custom_q.build_query_as().fetch_all(db).await?;
    let mut custom: HashMap<String, HashMap<String, Value>> = HashMap::new();
    for (device, key, value) in custom_rows {
        if let Ok(v) = serde_json::from_str(&value) {
            custom.entry(device).or_default().insert(key, v);
        }
    }

    let now = rustrmm_common::now();
    Ok(rows
        .into_iter()
        .map(|r| DeviceFacts {
            custom: custom.remove(&r.id).unwrap_or_default(),
            tags: serde_json::from_str(&r.tags).unwrap_or_default(),
            pending_reboot: r.pending_reboot.map(|v| v != 0),
            health_score: r.health_score.map(|h| h as f64),
            ram_gb: r
                .ram_bytes
                .map(|b| (b as f64 / 1_073_741_824.0 * 10.0).round() / 10.0),
            // disk_pct is the highest usage among fixed volumes, so this is the lowest free share.
            disk_free_pct: r.disk_pct.map(|p| (100.0 - p).max(0.0)),
            uptime_days: r.uptime_s.map(|s| s as f64 / 86_400.0),
            last_seen_minutes: if r.online {
                Some(0.0)
            } else {
                r.last_seen_at
                    .map(|t| (now - t).num_seconds().max(0) as f64 / 60.0)
            },
            id: r.id,
            client_id: r.client_id,
            site_id: r.site_id,
            hostname: r.hostname,
            os_family: r.os_family,
            os_name: r.os_name,
            os_version: r.os_version,
            agent_version: r.agent_version,
            device_type: r.device_type,
            last_user: r.last_user,
            domain: r.domain,
            manufacturer: r.manufacturer,
            model: r.model,
            serial: r.serial,
            public_ip: r.last_ip,
            online: r.online,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn device() -> DeviceFacts {
        DeviceFacts {
            id: "d1".into(),
            client_id: "c1".into(),
            site_id: "s1".into(),
            hostname: "WS-ACCT-01".into(),
            os_family: "windows".into(),
            os_name: "Windows 11 Pro".into(),
            os_version: "10.0.26100".into(),
            agent_version: "0.1.0".into(),
            device_type: Some("laptop".into()),
            domain: Some("corp.example".into()),
            tags: vec!["finance".into(), "VIP".into()],
            online: true,
            pending_reboot: Some(false),
            health_score: Some(82.0),
            ram_gb: Some(16.0),
            disk_free_pct: Some(12.5),
            uptime_days: Some(3.2),
            last_seen_minutes: Some(0.0),
            custom: HashMap::from([
                ("asset_tag".to_string(), json!("A-123")),
                ("warranty_end".to_string(), json!("2027-03-01")),
                ("rack_units".to_string(), json!(2)),
                ("managed".to_string(), json!(true)),
            ]),
            ..DeviceFacts::default()
        }
    }

    fn defs() -> CustomDefs {
        HashMap::from([
            ("asset_tag".to_string(), "text".to_string()),
            ("warranty_end".to_string(), "date".to_string()),
            ("rack_units".to_string(), "number".to_string()),
            ("managed".to_string(), "boolean".to_string()),
            ("owner".to_string(), "select".to_string()),
        ])
    }

    fn eval(rule: Value) -> bool {
        let doc: RuleDocument = serde_json::from_value(rule).expect("rule document");
        compile(&doc, &defs()).expect("compiles").matches(&device())
    }

    fn cond(field: &str, op: &str, value: Value) -> bool {
        eval(
            json!({ "match": "all", "conditions": [{ "field": field, "op": op, "value": value }] }),
        )
    }

    fn invalid(rule: Value) -> String {
        let doc: RuleDocument = serde_json::from_value(rule).expect("rule document");
        compile(&doc, &defs()).expect_err("should be refused")
    }

    #[test]
    fn equality_operators() {
        assert!(cond("os_family", "eq", json!("windows")));
        assert!(
            cond("hostname", "eq", json!("ws-acct-01")),
            "case-insensitive"
        );
        assert!(!cond("os_family", "eq", json!("linux")));
        assert!(cond("os_family", "neq", json!("linux")));
        assert!(cond("os_family", "in", json!(["linux", "windows"])));
        assert!(!cond("os_family", "not_in", json!(["linux", "windows"])));
        assert!(cond("os_family", "not_in", json!(["linux", "macos"])));
        assert!(cond("client_id", "eq", json!("c1")));
        assert!(cond("online", "eq", json!(true)));
        assert!(cond("pending_reboot", "eq", json!("false")));
        assert!(cond("ram_gb", "eq", json!(16)));
        assert!(
            cond("tag", "eq", json!("vip")),
            "tags match case-insensitively"
        );
        assert!(!cond("tag", "eq", json!("hr")));
        assert!(cond("tag", "in", json!(["hr", "finance"])));
        // A missing value never equals anything and is never in a list.
        assert!(!cond("serial", "eq", json!("x")));
        assert!(cond("serial", "neq", json!("x")));
        assert!(!cond("serial", "in", json!(["x"])));
        assert!(cond("serial", "not_in", json!(["x"])));
    }

    #[test]
    fn existence_operators() {
        assert!(cond("domain", "exists", Value::Null));
        assert!(!cond("domain", "not_exists", Value::Null));
        assert!(cond("serial", "not_exists", Value::Null));
        assert!(cond("tag", "exists", Value::Null));
        assert!(cond("custom.asset_tag", "exists", Value::Null));
        assert!(cond("custom.owner", "not_exists", Value::Null));
    }

    #[test]
    fn text_operators() {
        assert!(cond("os_name", "contains", json!("11 pro")));
        assert!(cond("os_name", "not_contains", json!("server")));
        assert!(!cond("os_name", "not_contains", json!("windows")));
        assert!(cond("hostname", "starts_with", json!("ws-")));
        assert!(cond("hostname", "ends_with", json!("-01")));
        assert!(!cond("hostname", "ends_with", json!("-02")));
        assert!(cond("hostname", "matches", json!("^WS-[A-Z]+-\\d{2}$")));
        assert!(
            !cond("hostname", "matches", json!("^ws-")),
            "regexes are case-sensitive unless (?i)"
        );
        assert!(cond("hostname", "matches", json!("(?i)^ws-")));
        assert!(cond("tag", "contains", json!("fin")));
        assert!(cond("tag", "matches", json!("^V")));
        assert!(
            !cond("serial", "contains", json!("x")),
            "missing never contains"
        );
        assert!(cond("serial", "not_contains", json!("x")));
    }

    #[test]
    fn number_and_date_operators() {
        assert!(cond("disk_free_pct", "lt", json!(15)));
        assert!(!cond("disk_free_pct", "gt", json!(15)));
        assert!(cond("health_score", "gte", json!(82)));
        assert!(cond("health_score", "lte", json!("82")));
        assert!(!cond("health_score", "lt", json!(82)));
        assert!(cond("uptime_days", "gt", json!(3)));
        assert!(cond("custom.rack_units", "gte", json!(2)));
        assert!(cond("custom.warranty_end", "gt", json!("2027-01-01")));
        assert!(cond("custom.warranty_end", "lt", json!("2027-03-02")));
        assert!(cond("custom.warranty_end", "eq", json!("2027-03-01")));
        assert!(cond("custom.managed", "eq", json!(true)));
        assert!(cond("custom.asset_tag", "starts_with", json!("a-")));
    }

    #[test]
    fn nesting_all_and_any() {
        let rule = json!({
            "match": "all",
            "conditions": [
                { "field": "os_family", "op": "eq", "value": "windows" },
                { "match": "any", "conditions": [
                    { "field": "disk_free_pct", "op": "lt", "value": 10 },
                    { "match": "all", "conditions": [
                        { "field": "tag", "op": "eq", "value": "finance" },
                        { "field": "custom.asset_tag", "op": "eq", "value": "a-123" }
                    ]}
                ]}
            ]
        });
        assert!(eval(rule));
        let rule = json!({
            "match": "any",
            "conditions": [
                { "field": "os_family", "op": "eq", "value": "linux" },
                { "field": "custom.rack_units", "op": "gt", "value": 5 }
            ]
        });
        assert!(!eval(rule));
        assert!(
            eval(json!({ "match": "all", "conditions": [] })),
            "an empty all-rule matches"
        );
        assert!(!eval(json!({ "match": "any", "conditions": [] })));
    }

    #[test]
    fn validation_limits() {
        let level4 = json!({ "match": "all", "conditions": [
            { "match": "all", "conditions": [
                { "match": "all", "conditions": [
                    { "match": "all", "conditions": [ { "field": "online", "op": "eq", "value": true } ] }
                ]}
            ]}
        ]});
        assert!(invalid(level4).contains("nest"));
        let many: Vec<Value> = (0..51)
            .map(|_| json!({ "field": "online", "op": "eq", "value": true }))
            .collect();
        assert!(invalid(json!({ "match": "all", "conditions": many })).contains("50"));
        assert!(invalid(json!({ "match": "some", "conditions": [] })).contains("match"));
        assert!(invalid(json!({ "match": "all", "conditions": [{ "field": "nope", "op": "eq", "value": 1 }] })).contains("unknown field"));
        assert!(invalid(json!({ "match": "all", "conditions": [{ "field": "custom.missing", "op": "eq", "value": 1 }] })).contains("custom field"));
        assert!(invalid(json!({ "match": "all", "conditions": [{ "field": "ram_gb", "op": "contains", "value": "1" }] })).contains("does not apply"));
        assert!(invalid(json!({ "match": "all", "conditions": [{ "field": "hostname", "op": "gt", "value": "a" }] })).contains("does not apply"));
        assert!(invalid(json!({ "match": "all", "conditions": [{ "field": "online", "op": "eq", "value": "maybe" }] })).contains("true or false"));
        assert!(invalid(json!({ "match": "all", "conditions": [{ "field": "hostname", "op": "matches", "value": "(" }] })).contains("regular expression"));
        let long = "a".repeat(201);
        assert!(invalid(json!({ "match": "all", "conditions": [{ "field": "hostname", "op": "matches", "value": long }] })).contains("200"));
        assert!(invalid(json!({ "match": "all", "conditions": [{ "field": "os_family", "op": "in", "value": [] }] })).contains("items"));
        assert!(invalid(json!({ "match": "all", "conditions": [{ "field": "custom.warranty_end", "op": "gt", "value": "soon" }] })).contains("date"));
        let err = invalid(json!({ "match": "all", "conditions": [
            { "field": "online", "op": "eq", "value": true },
            { "match": "any", "conditions": [{ "field": "x", "op": "eq", "value": 1 }] }
        ]}));
        assert!(err.starts_with("conditions[1].conditions[0]"), "{err}");
    }
}
