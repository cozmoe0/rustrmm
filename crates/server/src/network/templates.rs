//! SNMP templates: which OIDs to poll and how to interpret them. Built-in templates are seeded
//! at start-up (refreshed on every start) and read-only.

use std::collections::HashSet;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use chrono::{DateTime, Utc};
use rustrmm_proto::network::SnmpOid;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::auth::AuthCtx;
use crate::db::Db;
use crate::error::{ApiError, ApiResult};
use crate::rbac::perm;
use crate::state::AppState;

pub const GENERIC: &str = "builtin-snmp-generic";
pub const INTERFACES: &str = "builtin-snmp-if-mib";
pub const HOST_RESOURCES: &str = "builtin-snmp-host-resources";
pub const PRINTER: &str = "builtin-snmp-printer";
pub const UPS: &str = "builtin-snmp-ups";

/// Hidden keys every poll includes (reset detection and device facts).
pub const UPTIME_KEY: &str = "_uptime";
pub const DESCR_KEY: &str = "_sysDescr";
pub const SYS_UPTIME_OID: &str = "1.3.6.1.2.1.1.3.0";
pub const SYS_DESCR_OID: &str = "1.3.6.1.2.1.1.1.0";
/// Prefixes of helper keys sent to the probe for table row labels and percentage bases.
pub const LABEL_PREFIX: &str = "label:";
pub const MAX_PREFIX: &str = "max:";
const MAX_METRICS: usize = 100;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Thresholds {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warn: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crit: Option<f64>,
    /// `above` | `below` (inclusive: `above` breaches at value ≥ threshold).
    pub direction: String,
}

impl Thresholds {
    /// `ok` | `warning` | `critical` for a value.
    pub fn evaluate(&self, value: f64) -> &'static str {
        let breach = |t: Option<f64>| {
            t.is_some_and(|t| {
                if self.direction == "below" {
                    value <= t
                } else {
                    value >= t
                }
            })
        };
        if breach(self.crit) {
            "critical"
        } else if breach(self.warn) {
            "warning"
        } else {
            "ok"
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Metric {
    pub key: String,
    #[serde(default)]
    pub label: String,
    pub oid: String,
    #[serde(default)]
    pub table: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index_label_oid: Option<String>,
    /// The value is reported as a percentage of the value at this OID (same row index).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_oid: Option<String>,
    #[serde(default)]
    pub unit: String,
    /// `gauge` | `counter` | `text`
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thresholds: Option<Thresholds>,
}

#[allow(clippy::too_many_arguments)]
fn m(
    key: &str,
    label: &str,
    oid: &str,
    table: bool,
    index_label_oid: Option<&str>,
    max_oid: Option<&str>,
    unit: &str,
    kind: &str,
    thresholds: Option<(Option<f64>, Option<f64>, &str)>,
) -> Metric {
    Metric {
        key: key.into(),
        label: label.into(),
        oid: oid.into(),
        table,
        index_label_oid: index_label_oid.map(Into::into),
        max_oid: max_oid.map(Into::into),
        unit: unit.into(),
        kind: kind.into(),
        thresholds: thresholds.map(|(warn, crit, direction)| Thresholds {
            warn,
            crit,
            direction: direction.into(),
        }),
    }
}

const IF_DESCR: &str = "1.3.6.1.2.1.2.2.1.2";

/// The built-in templates: (id, name, metrics).
pub fn builtins() -> Vec<(&'static str, &'static str, Vec<Metric>)> {
    vec![
        (
            GENERIC,
            "Generic",
            vec![
                m(
                    "sysUpTime",
                    "Uptime",
                    SYS_UPTIME_OID,
                    false,
                    None,
                    None,
                    "s",
                    "gauge",
                    None,
                ),
                m(
                    "sysDescr",
                    "Description",
                    SYS_DESCR_OID,
                    false,
                    None,
                    None,
                    "",
                    "text",
                    None,
                ),
            ],
        ),
        (
            INTERFACES,
            "Interfaces (IF-MIB)",
            vec![
                m(
                    "ifHCInOctets",
                    "Inbound traffic",
                    "1.3.6.1.2.1.31.1.1.1.6",
                    true,
                    Some(IF_DESCR),
                    None,
                    "B/s",
                    "counter",
                    None,
                ),
                m(
                    "ifHCOutOctets",
                    "Outbound traffic",
                    "1.3.6.1.2.1.31.1.1.1.10",
                    true,
                    Some(IF_DESCR),
                    None,
                    "B/s",
                    "counter",
                    None,
                ),
                m(
                    "ifOperStatus",
                    "Operational status (1 up, 2 down)",
                    "1.3.6.1.2.1.2.2.1.8",
                    true,
                    Some(IF_DESCR),
                    None,
                    "",
                    "gauge",
                    None,
                ),
                m(
                    "ifInErrors",
                    "Inbound errors",
                    "1.3.6.1.2.1.2.2.1.14",
                    true,
                    Some(IF_DESCR),
                    None,
                    "errors/s",
                    "counter",
                    None,
                ),
                m(
                    "ifOutErrors",
                    "Outbound errors",
                    "1.3.6.1.2.1.2.2.1.20",
                    true,
                    Some(IF_DESCR),
                    None,
                    "errors/s",
                    "counter",
                    None,
                ),
                m(
                    "lldpRemSysName",
                    "LLDP neighbour",
                    "1.0.8802.1.1.2.1.4.1.1.9",
                    true,
                    None,
                    None,
                    "",
                    "text",
                    None,
                ),
            ],
        ),
        (
            HOST_RESOURCES,
            "Host resources",
            vec![
                m(
                    "hrProcessorLoad",
                    "CPU load",
                    "1.3.6.1.2.1.25.3.3.1.2",
                    true,
                    None,
                    None,
                    "%",
                    "gauge",
                    Some((Some(85.0), Some(95.0), "above")),
                ),
                m(
                    "hrStorageUsed",
                    "Storage used",
                    "1.3.6.1.2.1.25.2.3.1.6",
                    true,
                    Some("1.3.6.1.2.1.25.2.3.1.3"),
                    Some("1.3.6.1.2.1.25.2.3.1.5"),
                    "%",
                    "gauge",
                    Some((Some(85.0), Some(95.0), "above")),
                ),
            ],
        ),
        (
            PRINTER,
            "Printer-MIB",
            vec![
                m(
                    "prtMarkerSuppliesLevel",
                    "Supply level",
                    "1.3.6.1.2.1.43.11.1.1.9",
                    true,
                    Some("1.3.6.1.2.1.43.11.1.1.6"),
                    Some("1.3.6.1.2.1.43.11.1.1.8"),
                    "%",
                    "gauge",
                    Some((Some(20.0), Some(10.0), "below")),
                ),
                m(
                    "hrPrinterStatus",
                    "Printer status (3 idle, 4 printing, 5 warming up)",
                    "1.3.6.1.2.1.25.3.5.1.1",
                    true,
                    None,
                    None,
                    "",
                    "gauge",
                    None,
                ),
            ],
        ),
        (
            UPS,
            "UPS-MIB",
            vec![
                m(
                    "upsBatteryStatus",
                    "Battery status (2 normal, 3 low, 4 depleted)",
                    "1.3.6.1.2.1.33.1.2.1.0",
                    false,
                    None,
                    None,
                    "",
                    "gauge",
                    Some((Some(3.0), Some(4.0), "above")),
                ),
                m(
                    "upsEstimatedChargeRemaining",
                    "Battery charge",
                    "1.3.6.1.2.1.33.1.2.4.0",
                    false,
                    None,
                    None,
                    "%",
                    "gauge",
                    Some((Some(50.0), Some(20.0), "below")),
                ),
                m(
                    "upsEstimatedMinutesRemaining",
                    "Runtime remaining",
                    "1.3.6.1.2.1.33.1.2.3.0",
                    false,
                    None,
                    None,
                    "min",
                    "gauge",
                    Some((Some(15.0), Some(5.0), "below")),
                ),
                m(
                    "upsInputVoltage",
                    "Input voltage",
                    "1.3.6.1.2.1.33.1.3.3.1.3",
                    true,
                    None,
                    None,
                    "V",
                    "gauge",
                    None,
                ),
                m(
                    "upsOutputPercentLoad",
                    "Load",
                    "1.3.6.1.2.1.33.1.4.4.1.5",
                    true,
                    None,
                    None,
                    "%",
                    "gauge",
                    Some((Some(80.0), Some(95.0), "above")),
                ),
            ],
        ),
    ]
}

/// Creates or refreshes the built-in templates.
pub async fn seed(db: &Db) -> anyhow::Result<()> {
    let now = rustrmm_common::now();
    for (id, name, metrics) in builtins() {
        sqlx::query(
            "INSERT INTO snmp_templates (id, name, builtin, metrics, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET name = excluded.name, builtin = 1, metrics = excluded.metrics",
        )
        .bind(id)
        .bind(name)
        .bind(serde_json::to_string(&metrics)?)
        .bind(now)
        .bind(now)
        .execute(db)
        .await?;
    }
    Ok(())
}

/// Default templates for a discovered asset type.
pub fn defaults_for(type_guess: &str) -> Vec<String> {
    let ids: &[&str] = match type_guess {
        "printer" => &[GENERIC, PRINTER],
        "ups" => &[GENERIC, UPS],
        "switch" | "router" | "ap" => &[GENERIC, INTERFACES],
        "nas" | "linux" | "windows" | "mac" => &[GENERIC, HOST_RESOURCES, INTERFACES],
        _ => &[GENERIC],
    };
    ids.iter().map(|s| (*s).to_string()).collect()
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct TemplateRow {
    pub id: String,
    pub name: String,
    pub builtin: bool,
    pub metrics: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl TemplateRow {
    pub fn metrics(&self) -> Vec<Metric> {
        serde_json::from_str(&self.metrics).unwrap_or_default()
    }

    fn to_json(&self) -> Value {
        json!({ "id": self.id, "name": self.name, "builtin": self.builtin, "metrics": self.metrics(),
                "created_at": self.created_at, "updated_at": self.updated_at })
    }
}

const SELECT: &str =
    "SELECT id, name, builtin, metrics, created_at, updated_at FROM snmp_templates";

pub async fn load_many(db: &Db, ids: &[String]) -> anyhow::Result<Vec<TemplateRow>> {
    let all: Vec<TemplateRow> = sqlx::query_as(SELECT).fetch_all(db).await?;
    // Keep the device's order.
    Ok(ids
        .iter()
        .filter_map(|id| all.iter().find(|t| &t.id == id).cloned())
        .collect())
}

/// Metrics of several templates; a later template's metric replaces an earlier one with the
/// same key.
pub fn merged_metrics(templates: &[TemplateRow]) -> Vec<Metric> {
    let mut out: Vec<Metric> = Vec::new();
    for t in templates {
        for metric in t.metrics() {
            match out.iter().position(|x| x.key == metric.key) {
                Some(i) => out[i] = metric,
                None => out.push(metric),
            }
        }
    }
    out
}

/// The OIDs the probe reads for these metrics (with row labels, percentage bases and the
/// hidden uptime and description keys).
pub fn oids_for(metrics: &[Metric]) -> Vec<SnmpOid> {
    let mut out = vec![
        SnmpOid {
            key: UPTIME_KEY.into(),
            oid: SYS_UPTIME_OID.into(),
            table: false,
        },
        SnmpOid {
            key: DESCR_KEY.into(),
            oid: SYS_DESCR_OID.into(),
            table: false,
        },
    ];
    for metric in metrics {
        out.push(SnmpOid {
            key: metric.key.clone(),
            oid: metric.oid.clone(),
            table: metric.table,
        });
        if let Some(oid) = &metric.index_label_oid
            && metric.table
        {
            out.push(SnmpOid {
                key: format!("{LABEL_PREFIX}{}", metric.key),
                oid: oid.clone(),
                table: true,
            });
        }
        if let Some(oid) = &metric.max_oid {
            out.push(SnmpOid {
                key: format!("{MAX_PREFIX}{}", metric.key),
                oid: oid.clone(),
                table: metric.table,
            });
        }
    }
    out
}

pub fn valid_oid(oid: &str) -> bool {
    let parts: Vec<&str> = oid.split('.').collect();
    parts.len() >= 2
        && parts.len() <= 128
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.len() <= 10 && p.bytes().all(|b| b.is_ascii_digit()))
        && matches!(parts[0], "0" | "1" | "2")
}

fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 64
        && key.starts_with(|c: char| c.is_ascii_alphabetic())
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
}

/// Validates a custom template's metrics.
pub fn validate_metrics(metrics: &[Metric]) -> Result<(), String> {
    if metrics.is_empty() || metrics.len() > MAX_METRICS {
        return Err(format!("metrics: 1–{MAX_METRICS} metrics"));
    }
    let mut keys = HashSet::new();
    for (i, metric) in metrics.iter().enumerate() {
        let path = format!("metrics[{i}]");
        if !valid_key(&metric.key) {
            return Err(format!(
                "{path}.key: 1–64 letters, digits, _, - or ., starting with a letter"
            ));
        }
        if !keys.insert(metric.key.clone()) {
            return Err(format!("{path}.key: used twice"));
        }
        if metric.label.chars().count() > 120 {
            return Err(format!("{path}.label: at most 120 characters"));
        }
        for (field, oid) in [
            ("oid", Some(&metric.oid)),
            ("index_label_oid", metric.index_label_oid.as_ref()),
            ("max_oid", metric.max_oid.as_ref()),
        ] {
            if let Some(oid) = oid
                && !valid_oid(oid)
            {
                return Err(format!(
                    "{path}.{field}: must be a numeric OID like 1.3.6.1.2.1.1.3.0"
                ));
            }
        }
        if metric.unit.chars().count() > 24 {
            return Err(format!("{path}.unit: at most 24 characters"));
        }
        if !matches!(metric.kind.as_str(), "gauge" | "counter" | "text") {
            return Err(format!("{path}.kind: must be gauge, counter or text"));
        }
        if let Some(t) = &metric.thresholds {
            if metric.kind == "text" {
                return Err(format!(
                    "{path}.thresholds: text metrics have no thresholds"
                ));
            }
            if !matches!(t.direction.as_str(), "above" | "below") {
                return Err(format!(
                    "{path}.thresholds.direction: must be above or below"
                ));
            }
            if t.warn.is_none() && t.crit.is_none() {
                return Err(format!("{path}.thresholds: set warn, crit or both"));
            }
            if let (Some(w), Some(c)) = (t.warn, t.crit) {
                let ordered = if t.direction == "above" {
                    c >= w
                } else {
                    c <= w
                };
                if !ordered {
                    return Err(format!(
                        "{path}.thresholds: crit must be {} warn",
                        if t.direction == "above" {
                            "at or above"
                        } else {
                            "at or below"
                        }
                    ));
                }
            }
        }
    }
    Ok(())
}

// ------------------------------------------------------------------ API

/// `GET /api/v1/network/snmp/templates`
#[utoipa::path(get, path = "/api/v1/network/snmp/templates", tag = "Network", summary = "List templates", responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn list(State(state): State<AppState>, ctx: AuthCtx) -> ApiResult<Json<Value>> {
    ctx.require(perm::NETWORK_VIEW)?;
    let rows: Vec<TemplateRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{SELECT} ORDER BY builtin DESC, name COLLATE NOCASE"
    )))
    .fetch_all(&state.db)
    .await?;
    Ok(Json(
        json!({ "items": rows.iter().map(TemplateRow::to_json).collect::<Vec<_>>() }),
    ))
}

#[derive(Deserialize)]
pub struct TemplateBody {
    name: String,
    metrics: Vec<Metric>,
}

fn check_body(body: &TemplateBody) -> ApiResult<String> {
    let name = body.name.trim().to_string();
    if name.is_empty() || name.chars().count() > 120 {
        return Err(ApiError::validation("Name must be 1–120 characters"));
    }
    validate_metrics(&body.metrics).map_err(ApiError::validation)?;
    Ok(name)
}

async fn load(db: &Db, id: &str) -> ApiResult<TemplateRow> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!("{SELECT} WHERE id = ?")))
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| ApiError::not_found("Template"))
}

/// `POST /api/v1/network/snmp/templates`
#[utoipa::path(post, path = "/api/v1/network/snmp/templates", tag = "Network", summary = "Create template", request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required")))]
pub async fn create(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Json(body): Json<TemplateBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    ctx.require_global(perm::NETWORK_MANAGE)?;
    let name = check_body(&body)?;
    let id = rustrmm_common::new_id();
    let now = rustrmm_common::now();
    sqlx::query("INSERT INTO snmp_templates (id, name, builtin, metrics, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?)")
        .bind(&id)
        .bind(&name)
        .bind(serde_json::to_string(&body.metrics)?)
        .bind(now)
        .bind(now)
        .execute(&state.db)
        .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("snmp.template_created")
                .target("snmp_template", &id, &name),
        )
        .await;
    Ok((
        StatusCode::CREATED,
        Json(load(&state.db, &id).await?.to_json()),
    ))
}

/// `PUT /api/v1/network/snmp/templates/{id}`
#[utoipa::path(put, path = "/api/v1/network/snmp/templates/{id}", tag = "Network", summary = "Update template", params(("id" = String, Path)), request_body(content = serde_json::Value, description = "JSON body (see the API documents in docs/)"), responses((status = 200, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn update(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
    Json(body): Json<TemplateBody>,
) -> ApiResult<Json<Value>> {
    ctx.require_global(perm::NETWORK_MANAGE)?;
    let current = load(&state.db, &id).await?;
    if current.builtin {
        return Err(ApiError::conflict(
            "builtin_template",
            "Built-in templates are read-only; duplicate it instead",
        ));
    }
    let name = check_body(&body)?;
    sqlx::query("UPDATE snmp_templates SET name = ?, metrics = ?, updated_at = ? WHERE id = ?")
        .bind(&name)
        .bind(serde_json::to_string(&body.metrics)?)
        .bind(rustrmm_common::now())
        .bind(&id)
        .execute(&state.db)
        .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("snmp.template_updated")
                .target("snmp_template", &id, &name),
        )
        .await;
    super::config::push_all_soon(&state);
    Ok(Json(load(&state.db, &id).await?.to_json()))
}

/// `DELETE /api/v1/network/snmp/templates/{id}`
#[utoipa::path(delete, path = "/api/v1/network/snmp/templates/{id}", tag = "Network", summary = "Delete template", params(("id" = String, Path)), responses((status = 204, description = "Success"), (status = 401, description = "Sign-in required"), (status = 403, description = "Missing permission or step-up required"), (status = 404, description = "Not found or outside your scope")))]
pub async fn delete(
    State(state): State<AppState>,
    ctx: AuthCtx,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    ctx.require_global(perm::NETWORK_MANAGE)?;
    let current = load(&state.db, &id).await?;
    if current.builtin {
        return Err(ApiError::conflict(
            "builtin_template",
            "Built-in templates cannot be deleted",
        ));
    }
    let in_use: Option<String> = sqlx::query_scalar(
        "SELECT d.name FROM snmp_devices d, json_each(d.template_ids) j WHERE j.value = ? LIMIT 1",
    )
    .bind(&id)
    .fetch_optional(&state.db)
    .await?;
    if let Some(device) = in_use {
        return Err(ApiError::conflict(
            "template_in_use",
            format!("The SNMP device {device} uses this template"),
        ));
    }
    sqlx::query("DELETE FROM snmp_templates WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await?;
    state
        .audit
        .record_or_log(
            &state.db,
            ctx.audit("snmp.template_deleted")
                .target("snmp_template", &id, &current.name),
        )
        .await;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn threshold_evaluation() {
        let below = Thresholds {
            warn: Some(20.0),
            crit: Some(10.0),
            direction: "below".into(),
        };
        assert_eq!(below.evaluate(55.0), "ok");
        assert_eq!(below.evaluate(20.0), "warning", "inclusive");
        assert_eq!(below.evaluate(12.5), "warning");
        assert_eq!(below.evaluate(10.0), "critical");
        assert_eq!(below.evaluate(0.0), "critical");
        let above = Thresholds {
            warn: Some(85.0),
            crit: None,
            direction: "above".into(),
        };
        assert_eq!(above.evaluate(84.9), "ok");
        assert_eq!(above.evaluate(85.0), "warning");
        assert_eq!(above.evaluate(100.0), "warning");
        let crit_only = Thresholds {
            warn: None,
            crit: Some(4.0),
            direction: "above".into(),
        };
        assert_eq!(crit_only.evaluate(3.0), "ok");
        assert_eq!(crit_only.evaluate(4.0), "critical");
    }

    #[test]
    fn builtins_are_valid_and_expand_to_oids() {
        for (id, _, metrics) in builtins() {
            validate_metrics(&metrics).unwrap_or_else(|e| panic!("{id}: {e}"));
        }
        let printer = builtins()
            .into_iter()
            .find(|(id, _, _)| *id == PRINTER)
            .expect("printer")
            .2;
        let oids = oids_for(&printer);
        let keys: Vec<&str> = oids.iter().map(|o| o.key.as_str()).collect();
        assert!(keys.contains(&"_uptime"));
        assert!(keys.contains(&"prtMarkerSuppliesLevel"));
        assert!(keys.contains(&"label:prtMarkerSuppliesLevel"));
        assert!(keys.contains(&"max:prtMarkerSuppliesLevel"));
        assert!(valid_oid("1.3.6.1.2.1.1.3.0"));
        assert!(!valid_oid("1.3.6.x"));
        assert!(!valid_oid("5.1"));
        let bad = vec![m(
            "x",
            "",
            "1.3.6.1",
            false,
            None,
            None,
            "",
            "text",
            Some((Some(1.0), None, "above")),
        )];
        assert!(validate_metrics(&bad).is_err());
        let bad = vec![m(
            "x",
            "",
            "1.3.6.1",
            false,
            None,
            None,
            "",
            "gauge",
            Some((Some(10.0), Some(20.0), "below")),
        )];
        assert!(validate_metrics(&bad).is_err());
        assert_eq!(
            defaults_for("printer"),
            vec![GENERIC.to_string(), PRINTER.to_string()]
        );
    }
}
