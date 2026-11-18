//! The check-type catalog: labels, supported platforms and a config schema per type. The same
//! catalog validates policy documents and is served by `GET /monitoring/check-types` so the
//! console can build forms.

use serde::Serialize;
use serde_json::{Map, Value, json};

/// One config field of a check type.
#[derive(Debug, Clone, Serialize)]
pub struct Field {
    pub key: &'static str,
    pub label: &'static str,
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub required: bool,
    pub default: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<&'static str>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unit: Option<&'static str>,
}

/// One check type.
#[derive(Debug, Clone, Serialize)]
pub struct CheckType {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub platforms: Vec<&'static str>,
    /// The agent grades results as warning or critical and the state sets the alert severity.
    /// For other types a failing check reports `critical` and the alert takes the check's
    /// `severity`.
    pub graded: bool,
    pub config_schema: Vec<Field>,
}

const ALL: &[&str] = &["windows", "linux", "macos"];

fn num(key: &'static str, label: &'static str, default: Option<f64>, min: f64, max: f64) -> Field {
    Field {
        key,
        label,
        kind: "number",
        required: default.is_some(),
        default: default.map(|d| json!(d)).unwrap_or(Value::Null),
        min: Some(min),
        max: Some(max),
        options: None,
        unit: None,
    }
}

fn opt_num(key: &'static str, label: &'static str, min: f64, max: f64) -> Field {
    let mut f = num(key, label, None, min, max);
    f.required = false;
    f
}

fn text(key: &'static str, label: &'static str, required: bool, default: Option<&str>) -> Field {
    Field {
        key,
        label,
        kind: "text",
        required,
        default: default.map(|d| json!(d)).unwrap_or(Value::Null),
        min: None,
        max: None,
        options: None,
        unit: None,
    }
}

fn boolean(key: &'static str, label: &'static str, default: bool) -> Field {
    Field {
        key,
        label,
        kind: "boolean",
        required: false,
        default: json!(default),
        min: None,
        max: None,
        options: None,
        unit: None,
    }
}

fn select(
    key: &'static str,
    label: &'static str,
    options: &[&'static str],
    default: &str,
) -> Field {
    Field {
        key,
        label,
        kind: "select",
        required: true,
        default: json!(default),
        min: None,
        max: None,
        options: Some(options.to_vec()),
        unit: None,
    }
}

fn unit(mut f: Field, unit: &'static str) -> Field {
    f.unit = Some(unit);
    f
}

fn kind(
    kind: &'static str,
    label: &'static str,
    description: &'static str,
    platforms: &[&'static str],
    graded: bool,
    config_schema: Vec<Field>,
) -> CheckType {
    CheckType {
        kind,
        label,
        description,
        platforms: platforms.to_vec(),
        graded,
        config_schema,
    }
}

/// The complete catalog.
pub fn catalog() -> Vec<CheckType> {
    vec![
        kind(
            "cpu",
            "CPU usage",
            "Average processor usage over a window",
            ALL,
            true,
            vec![
                unit(num("warn_pct", "Warning at", Some(85.0), 1.0, 100.0), "%"),
                unit(num("crit_pct", "Critical at", Some(95.0), 1.0, 100.0), "%"),
                unit(num("window_minutes", "Window", Some(5.0), 1.0, 60.0), "min"),
            ],
        ),
        kind(
            "memory",
            "Memory usage",
            "Average memory usage over a window",
            ALL,
            true,
            vec![
                unit(num("warn_pct", "Warning at", Some(85.0), 1.0, 100.0), "%"),
                unit(num("crit_pct", "Critical at", Some(95.0), 1.0, 100.0), "%"),
                unit(num("window_minutes", "Window", Some(5.0), 1.0, 60.0), "min"),
            ],
        ),
        kind(
            "disk",
            "Disk space",
            "Free space on one volume, or every fixed volume with *",
            ALL,
            true,
            vec![
                text("volume", "Volume", true, Some("*")),
                unit(opt_num("warn_free_pct", "Warning below", 0.0, 100.0), "%"),
                unit(opt_num("crit_free_pct", "Critical below", 0.0, 100.0), "%"),
                unit(
                    opt_num("warn_free_gb", "Warning below", 0.0, 1_000_000.0),
                    "GB",
                ),
                unit(
                    opt_num("crit_free_gb", "Critical below", 0.0, 1_000_000.0),
                    "GB",
                ),
            ],
        ),
        kind(
            "service",
            "Service",
            "A Windows service, systemd unit or launchd job is in the expected state",
            ALL,
            false,
            vec![
                text("name", "Service name", true, None),
                select(
                    "expected",
                    "Expected state",
                    &["running", "stopped"],
                    "running",
                ),
                boolean("auto_restart", "Restart automatically", false),
                num("restart_attempts", "Restart attempts", Some(2.0), 0.0, 5.0),
            ],
        ),
        kind(
            "process",
            "Process",
            "A process is running (or not), optionally within CPU and memory limits",
            ALL,
            false,
            vec![
                text("name", "Process name", true, None),
                select(
                    "expected",
                    "Expected",
                    &["running", "not_running"],
                    "running",
                ),
                unit(opt_num("max_cpu_pct", "Maximum CPU", 1.0, 100.0), "%"),
                unit(
                    opt_num("max_memory_mb", "Maximum memory", 1.0, 1_048_576.0),
                    "MB",
                ),
            ],
        ),
        kind(
            "event_log",
            "Event log",
            "Matching events in a Windows event log or the journal of a systemd unit",
            &["windows", "linux"],
            false,
            vec![
                text("log", "Log or unit", true, Some("System")),
                text("source", "Source", false, None),
                Field {
                    kind: "number_list",
                    ..text("event_ids", "Event IDs", false, None)
                },
                num(
                    "min_level",
                    "Minimum level (1 critical … 4 information)",
                    Some(2.0),
                    1.0,
                    4.0,
                ),
                unit(
                    num("window_minutes", "Window", Some(15.0), 1.0, 1440.0),
                    "min",
                ),
                num("threshold", "Events needed", Some(1.0), 1.0, 10_000.0),
            ],
        ),
        kind(
            "script",
            "Script",
            "Runs a library script: exit code 0 is ok, 1 warning, 2 or anything else critical",
            ALL,
            true,
            vec![
                Field {
                    kind: "script",
                    ..text("script_id", "Script", true, None)
                },
                unit(num("timeout_secs", "Timeout", Some(60.0), 5.0, 3600.0), "s"),
            ],
        ),
        kind(
            "ping",
            "Ping",
            "ICMP reachability measured from the device",
            ALL,
            false,
            vec![
                text("target", "Host", true, None),
                num("count", "Pings", Some(3.0), 1.0, 20.0),
                unit(
                    num("max_loss_pct", "Maximum loss", Some(50.0), 0.0, 100.0),
                    "%",
                ),
                unit(
                    opt_num("max_rtt_ms", "Maximum round trip", 1.0, 60_000.0),
                    "ms",
                ),
            ],
        ),
        kind(
            "tcp_port",
            "TCP port",
            "A TCP connection from the device succeeds",
            ALL,
            false,
            vec![
                text("host", "Host", true, None),
                Field {
                    required: true,
                    ..num("port", "Port", None, 1.0, 65_535.0)
                },
                unit(
                    num("timeout_ms", "Timeout", Some(3000.0), 100.0, 60_000.0),
                    "ms",
                ),
            ],
        ),
        kind(
            "http",
            "HTTP(S)",
            "An http(s) URL answers with the expected status, keyword, latency and certificate",
            ALL,
            true,
            vec![
                text("url", "URL", true, None),
                select("method", "Method", &["GET", "HEAD", "POST"], "GET"),
                num(
                    "expect_status",
                    "Expected status",
                    Some(200.0),
                    100.0,
                    599.0,
                ),
                text("keyword", "Keyword", false, None),
                unit(
                    opt_num("max_latency_ms", "Maximum latency", 1.0, 120_000.0),
                    "ms",
                ),
                unit(
                    num(
                        "cert_warn_days",
                        "Certificate warning",
                        Some(14.0),
                        0.0,
                        365.0,
                    ),
                    "days",
                ),
                boolean("verify_tls", "Verify TLS", true),
            ],
        ),
        kind(
            "certificate",
            "Certificate expiry",
            "Local certificates in a store (Windows) or a PEM/DER file",
            ALL,
            true,
            vec![
                select("source", "Source", &["store", "file"], "store"),
                text("store", "Store", false, Some("LocalMachine\\My")),
                text("path", "File", false, None),
                unit(
                    num("warn_days", "Warning within", Some(30.0), 0.0, 3650.0),
                    "days",
                ),
                unit(
                    num("crit_days", "Critical within", Some(7.0), 0.0, 3650.0),
                    "days",
                ),
            ],
        ),
        kind(
            "pending_reboot",
            "Pending restart",
            "A restart has been pending for longer than allowed",
            ALL,
            false,
            vec![unit(
                num("warn_after_hours", "Alert after", Some(72.0), 0.0, 8760.0),
                "h",
            )],
        ),
        kind(
            "antivirus",
            "Antivirus",
            "Real-time protection is on (critical when off) and signatures are recent",
            &["windows"],
            true,
            vec![unit(
                num(
                    "max_signature_age_hours",
                    "Maximum signature age",
                    Some(72.0),
                    1.0,
                    8760.0,
                ),
                "h",
            )],
        ),
        kind(
            "firewall",
            "Firewall",
            "Every firewall profile is enabled",
            ALL,
            true,
            vec![],
        ),
        kind(
            "uptime",
            "Uptime",
            "Time since the last restart",
            ALL,
            true,
            vec![
                unit(
                    num("warn_days", "Warning after", Some(30.0), 1.0, 3650.0),
                    "days",
                ),
                unit(
                    num("crit_days", "Critical after", Some(60.0), 1.0, 3650.0),
                    "days",
                ),
            ],
        ),
        kind(
            "file",
            "File",
            "A file exists, is missing, is older than or larger than a limit",
            ALL,
            false,
            vec![
                text("path", "Path", true, None),
                select(
                    "condition",
                    "Condition",
                    &["exists", "missing", "older_than", "larger_than"],
                    "exists",
                ),
                unit(opt_num("minutes", "Age", 1.0, 5_256_000.0), "min"),
                unit(opt_num("size_mb", "Size", 0.001, 10_485_760.0), "MB"),
            ],
        ),
        kind(
            "windows_update",
            "Windows Update",
            "Days since updates were last installed, and recent installation failures",
            &["windows"],
            false,
            vec![
                unit(
                    num(
                        "warn_days_since_install",
                        "Alert after",
                        Some(35.0),
                        1.0,
                        365.0,
                    ),
                    "days",
                ),
                boolean("alert_on_failures", "Alert on failures", true),
            ],
        ),
        kind(
            "battery",
            "Battery health",
            "Full-charge capacity as a share of the design capacity (devices with a battery)",
            ALL,
            false,
            vec![unit(
                num("min_health_pct", "Minimum health", Some(60.0), 1.0, 100.0),
                "%",
            )],
        ),
    ]
}

pub fn find(kind: &str) -> Option<CheckType> {
    catalog().into_iter().find(|t| t.kind == kind)
}

/// Whether a check type runs on an operating system.
pub fn supports(kind: &str, os_family: &str) -> bool {
    find(kind).is_some_and(|t| t.platforms.contains(&os_family))
}

/// Alert severity for a failing state: graded types follow the state, others use the check's
/// configured severity. `unknown` always maps to `info`.
pub fn alert_severity(kind: &str, state: &str, configured: &str) -> &'static str {
    match state {
        "unknown" => "info",
        _ if find(kind).is_some_and(|t| t.graded) => {
            if state == "critical" {
                "critical"
            } else {
                "warning"
            }
        }
        _ => match configured {
            "info" => "info",
            "critical" => "critical",
            _ => "warning",
        },
    }
}

fn valid_text(s: &str) -> bool {
    !s.is_empty() && s.chars().count() <= 2048 && !s.contains('\0')
}

/// Validates a check `config` for a type. With `complete`, required fields must be present
/// (after defaults) and cross-field rules apply; otherwise (a partial override in a policy
/// layer) only the given keys are checked. Returns the config with defaults filled in.
pub fn validate_config(
    kind: &str,
    config: &Map<String, Value>,
    complete: bool,
) -> Result<Map<String, Value>, (String, String)> {
    let check_type =
        find(kind).ok_or_else(|| ("type".to_string(), format!("unknown check type '{kind}'")))?;
    let mut out = Map::new();
    for (key, value) in config {
        let field = if kind == "script" && key == "parameters" {
            if !value.is_object() && !value.is_null() {
                return Err((format!("config.{key}"), "must be an object".into()));
            }
            out.insert(key.clone(), value.clone());
            continue;
        } else {
            check_type
                .config_schema
                .iter()
                .find(|f| f.key == key)
                .ok_or_else(|| (format!("config.{key}"), "unknown setting".to_string()))?
        };
        let path = format!("config.{key}");
        if value.is_null() {
            continue;
        }
        match field.kind {
            "number" => {
                let n = value
                    .as_f64()
                    .filter(|n| n.is_finite())
                    .ok_or_else(|| (path.clone(), "must be a number".to_string()))?;
                if let (Some(min), Some(max)) = (field.min, field.max)
                    && !(min..=max).contains(&n)
                {
                    return Err((path, format!("must be between {min} and {max}")));
                }
            }
            "boolean" => {
                if !value.is_boolean() {
                    return Err((path, "must be true or false".into()));
                }
            }
            "select" => {
                let s = value.as_str().unwrap_or_default();
                if !field.options.as_ref().is_some_and(|o| o.contains(&s)) {
                    return Err((
                        path,
                        format!(
                            "must be one of {}",
                            field.options.clone().unwrap_or_default().join(", ")
                        ),
                    ));
                }
            }
            "number_list" => {
                let list = value
                    .as_array()
                    .ok_or_else(|| (path.clone(), "must be a list of numbers".to_string()))?;
                if list.len() > 100 || !list.iter().all(|v| v.as_u64().is_some_and(|n| n <= 65_535))
                {
                    return Err((path, "must be a list of up to 100 whole numbers".into()));
                }
            }
            _ => {
                let s = value
                    .as_str()
                    .ok_or_else(|| (path.clone(), "must be text".to_string()))?;
                if !valid_text(s.trim()) {
                    return Err((path, "must be 1–2048 characters".into()));
                }
            }
        }
        out.insert(key.clone(), value.clone());
    }
    if !complete {
        return Ok(out);
    }
    for field in &check_type.config_schema {
        if out.get(field.key).is_none_or(Value::is_null) {
            if !field.default.is_null() {
                out.insert(field.key.to_string(), field.default.clone());
            } else if field.required {
                return Err((format!("config.{}", field.key), "is required".into()));
            }
        }
    }
    cross_checks(kind, &out)?;
    Ok(out)
}

fn n(config: &Map<String, Value>, key: &str) -> Option<f64> {
    config.get(key).and_then(Value::as_f64)
}

fn cross_checks(kind: &str, c: &Map<String, Value>) -> Result<(), (String, String)> {
    let ordered = |warn: &str, crit: &str, higher_is_worse: bool| -> Result<(), (String, String)> {
        if let (Some(w), Some(k)) = (n(c, warn), n(c, crit)) {
            let bad = if higher_is_worse { k < w } else { k > w };
            if bad {
                return Err((
                    format!("config.{crit}"),
                    format!(
                        "must be {} than {warn}",
                        if higher_is_worse {
                            "at least"
                        } else {
                            "at most"
                        }
                    ),
                ));
            }
        }
        Ok(())
    };
    match kind {
        "cpu" | "memory" => ordered("warn_pct", "crit_pct", true),
        "uptime" => ordered("warn_days", "crit_days", true),
        "certificate" => {
            ordered("warn_days", "crit_days", false)?;
            match c.get("source").and_then(Value::as_str) {
                Some("file") if c.get("path").and_then(Value::as_str).is_none() => Err((
                    "config.path".into(),
                    "is required for file certificates".into(),
                )),
                _ => Ok(()),
            }
        }
        "disk" => {
            ordered("warn_free_pct", "crit_free_pct", false)?;
            ordered("warn_free_gb", "crit_free_gb", false)?;
            if [
                "warn_free_pct",
                "crit_free_pct",
                "warn_free_gb",
                "crit_free_gb",
            ]
            .iter()
            .all(|k| n(c, k).is_none())
            {
                return Err((
                    "config".into(),
                    "set at least one of warn_free_pct, crit_free_pct, warn_free_gb, crit_free_gb"
                        .into(),
                ));
            }
            Ok(())
        }
        "http" => {
            let url = c.get("url").and_then(Value::as_str).unwrap_or_default();
            match url::Url::parse(url.trim()) {
                Ok(u) if matches!(u.scheme(), "http" | "https") && u.host_str().is_some() => Ok(()),
                _ => Err(("config.url".into(), "must be an http(s) URL".into())),
            }
        }
        "ping" => target(c, "target"),
        "tcp_port" => target(c, "host"),
        "file" => match c.get("condition").and_then(Value::as_str) {
            Some("older_than") if n(c, "minutes").is_none() => {
                Err(("config.minutes".into(), "is required for older_than".into()))
            }
            Some("larger_than") if n(c, "size_mb").is_none() => Err((
                "config.size_mb".into(),
                "is required for larger_than".into(),
            )),
            _ => Ok(()),
        },
        "service" => {
            let name = c.get("name").and_then(Value::as_str).unwrap_or_default();
            if rustrmm_proto::remote::valid_service_name(name.trim()) {
                Ok(())
            } else {
                Err(("config.name".into(), "is not a valid service name".into()))
            }
        }
        _ => Ok(()),
    }
}

fn target(c: &Map<String, Value>, key: &str) -> Result<(), (String, String)> {
    let host = c.get(key).and_then(Value::as_str).unwrap_or_default();
    if rustrmm_proto::remote::valid_target(host.trim()) {
        Ok(())
    } else {
        Err((
            format!("config.{key}"),
            "is not a valid host name or address".into(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(v: Value) -> Map<String, Value> {
        v.as_object().cloned().expect("object")
    }

    #[test]
    fn catalog_is_consistent() {
        let all = catalog();
        let mut kinds: Vec<&str> = all.iter().map(|t| t.kind).collect();
        kinds.sort();
        kinds.dedup();
        assert_eq!(kinds.len(), all.len(), "unique types");
        assert_eq!(all.len(), 18);
        assert!(supports("windows_update", "windows"));
        assert!(!supports("windows_update", "linux"));
        assert!(!supports("antivirus", "macos"));
        assert!(supports("disk", "macos"));
    }

    #[test]
    fn configs_validate_with_defaults_and_cross_checks() {
        let cpu = validate_config("cpu", &map(json!({ "warn_pct": 80 })), true).expect("valid");
        assert_eq!(cpu["crit_pct"], json!(95.0));
        assert_eq!(cpu["window_minutes"], json!(5.0));
        let err = validate_config("cpu", &map(json!({ "warn_pct": 90, "crit_pct": 80 })), true)
            .expect_err("crit below warn");
        assert_eq!(err.0, "config.crit_pct");
        assert_eq!(
            validate_config("cpu", &map(json!({ "warn_pct": 150 })), false)
                .expect_err("range")
                .0,
            "config.warn_pct"
        );
        assert_eq!(
            validate_config("disk", &map(json!({ "volume": "C:" })), true)
                .expect_err("needs a threshold")
                .0,
            "config"
        );
        assert!(
            validate_config(
                "disk",
                &map(json!({ "warn_free_pct": 15, "crit_free_pct": 5 })),
                true
            )
            .is_ok()
        );
        assert_eq!(
            validate_config("tcp_port", &map(json!({ "host": "db1" })), true)
                .expect_err("port required")
                .0,
            "config.port"
        );
        assert_eq!(
            validate_config("http", &map(json!({ "url": "ftp://x" })), true)
                .expect_err("http only")
                .0,
            "config.url"
        );
        assert_eq!(
            validate_config("service", &map(json!({ "name": "--now" })), true)
                .expect_err("option injection")
                .0,
            "config.name"
        );
        assert_eq!(
            validate_config("ping", &map(json!({ "colour": 1 })), false)
                .expect_err("unknown key")
                .0,
            "config.colour"
        );
        assert_eq!(
            validate_config(
                "file",
                &map(json!({ "path": "/x", "condition": "older_than" })),
                true
            )
            .expect_err("minutes")
            .0,
            "config.minutes"
        );
        assert!(validate_config("firewall", &Map::new(), true).is_ok());
        assert!(validate_config("teleport", &Map::new(), true).is_err());
    }

    #[test]
    fn severity_mapping() {
        assert_eq!(alert_severity("disk", "critical", "info"), "critical");
        assert_eq!(alert_severity("disk", "warning", "critical"), "warning");
        assert_eq!(alert_severity("service", "critical", "warning"), "warning");
        assert_eq!(
            alert_severity("service", "critical", "critical"),
            "critical"
        );
        assert_eq!(alert_severity("ping", "critical", "info"), "info");
        assert_eq!(alert_severity("cpu", "unknown", "critical"), "info");
    }
}
