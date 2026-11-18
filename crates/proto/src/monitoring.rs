//! Monitoring: the check configuration the server sends to agents and the check results agents
//! report back (see `docs/api-monitoring.md`, "Agent protocol additions").
//!
//! The configuration travels inside a signed command ([`crate::commands::Command::MonitoringConfig`])
//! because `script` checks embed code: an unsigned frame could otherwise run code on a device. The
//! agent persists the verified configuration so checks keep running while it is offline.

use serde::{Deserialize, Serialize};

use crate::Message;

/// Default number of consecutive `unknown` evaluations before the server raises an `info` alert.
pub const DEFAULT_UNKNOWN_THRESHOLD: u32 = 3;
/// Bounds the agent enforces on check intervals, whatever the server sends.
pub const MIN_INTERVAL_SECS: u32 = 30;
pub const MAX_INTERVAL_SECS: u32 = 86_400;

/// Outcome of one check evaluation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckState {
    Ok,
    Warning,
    Critical,
    /// The check could not run (or a newer peer sent a state this build does not know).
    #[serde(other)]
    Unknown,
}

impl CheckState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Warning => "warning",
            Self::Critical => "critical",
            Self::Unknown => "unknown",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "ok" => Some(Self::Ok),
            "warning" => Some(Self::Warning),
            "critical" => Some(Self::Critical),
            "unknown" => Some(Self::Unknown),
            _ => None,
        }
    }

    /// Warning or critical.
    pub fn is_failing(self) -> bool {
        matches!(self, Self::Warning | Self::Critical)
    }
}

impl std::fmt::Display for CheckState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Script embedded in a `script` check. The server resolves the script version and variables;
/// the agent verifies `content_sha256` before running it with the Phase 5 executor.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EmbeddedScript {
    pub language: String,
    pub content: String,
    pub content_sha256: String,
    #[serde(default)]
    pub env: Vec<(String, String)>,
    #[serde(default)]
    pub mask: Vec<String>,
}

impl std::fmt::Debug for EmbeddedScript {
    // Environment values and mask entries carry secrets; content is never logged either.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EmbeddedScript")
            .field("language", &self.language)
            .field("content_sha256", &self.content_sha256)
            .field(
                "env",
                &self.env.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(),
            )
            .field("mask", &self.mask.len())
            .finish()
    }
}

/// One check as the agent runs it. Thresholds live in `config` and are evaluated on the agent;
/// the alert severity is applied by the server.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CheckDefinition {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub name: String,
    pub interval_secs: u32,
    #[serde(default)]
    pub config: serde_json::Value,
    /// `script` checks only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub script: Option<EmbeddedScript>,
}

/// Server → agent: the device's complete check configuration.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MonitoringConfig {
    /// Hash of the configuration; the agent replaces its stored copy when it changes.
    pub version: String,
    #[serde(default)]
    pub checks: Vec<CheckDefinition>,
    /// `unknown` results are re-sent when they reach this many consecutive evaluations.
    #[serde(default = "default_unknown_threshold")]
    pub unknown_threshold: u32,
}

fn default_unknown_threshold() -> u32 {
    DEFAULT_UNKNOWN_THRESHOLD
}

impl Message for MonitoringConfig {
    const TYPE: &'static str = "monitoring_config";
}

impl MonitoringConfig {
    /// Builds a configuration whose `version` is the SHA-256 of its content.
    pub fn new(checks: Vec<CheckDefinition>, unknown_threshold: u32) -> Self {
        let mut config = Self {
            version: String::new(),
            checks,
            unknown_threshold,
        };
        config.version = config.content_hash();
        config
    }

    /// Lowercase hex SHA-256 over the checks and threshold (not the version itself).
    pub fn content_hash(&self) -> String {
        let body =
            rmp_serde::to_vec_named(&(&self.checks, self.unknown_threshold)).unwrap_or_default();
        rustrmm_crypto::random::sha256_hex(&body)
    }
}

/// One check result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CheckResult {
    pub check_id: String,
    pub state: CheckState,
    #[serde(default)]
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<f64>,
    /// Agent clock, unix milliseconds.
    pub at: i64,
    /// Consecutive evaluations that produced this state (1 for a fresh critical transition).
    #[serde(default)]
    pub streak: u32,
}

/// Agent → server: state transitions (debounced) or, with `full`, every check's current state.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CheckResults {
    pub results: Vec<CheckResult>,
    #[serde(default)]
    pub full: bool,
}

impl Message for CheckResults {
    const TYPE: &'static str = "check_results";
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Frame;
    use serde_json::json;

    fn sample_config() -> MonitoringConfig {
        MonitoringConfig::new(
            vec![
                CheckDefinition {
                    id: "disk-c".into(),
                    kind: "disk".into(),
                    name: "Low disk space".into(),
                    interval_secs: 300,
                    config: json!({ "volume": "*", "warn_free_pct": 15, "crit_free_pct": 5 }),
                    script: None,
                },
                CheckDefinition {
                    id: "custom".into(),
                    kind: "script".into(),
                    name: "Custom".into(),
                    interval_secs: 600,
                    config: json!({ "timeout_secs": 60 }),
                    script: Some(EmbeddedScript {
                        language: "bash".into(),
                        content: "echo ok".into(),
                        content_sha256: crate::scripts::sha256_hex("echo ok"),
                        env: vec![("TOKEN".into(), "hunter22".into())],
                        mask: vec!["hunter22".into()],
                    }),
                },
            ],
            3,
        )
    }

    #[test]
    fn monitoring_config_round_trips() {
        let config = sample_config();
        assert_eq!(config.version, config.content_hash());
        let bytes = crate::encode(&config).expect("encode");
        let frame = Frame::decode(&bytes).expect("decode");
        assert_eq!(frame.t, "monitoring_config");
        let back: MonitoringConfig = frame.body().expect("body");
        assert_eq!(back, config);
        assert_eq!(back.checks[0].config["warn_free_pct"], 15);
        assert!(
            !format!("{back:?}").contains("hunter22"),
            "debug output hides secrets"
        );
        let mut changed = config.clone();
        changed.checks[0].interval_secs = 60;
        assert_ne!(changed.content_hash(), config.version);
    }

    #[test]
    fn check_results_round_trip_and_tolerate_unknown_states() {
        let results = CheckResults {
            results: vec![
                CheckResult {
                    check_id: "disk-c".into(),
                    state: CheckState::Critical,
                    message: "C: 4% free".into(),
                    value: Some(4.0),
                    at: 1_700_000_000_000,
                    streak: 1,
                },
                CheckResult {
                    check_id: "uptime".into(),
                    state: CheckState::Ok,
                    message: String::new(),
                    value: None,
                    at: 1_700_000_000_000,
                    streak: 7,
                },
            ],
            full: true,
        };
        let bytes = crate::encode(&results).expect("encode");
        let back: CheckResults = Frame::decode(&bytes).expect("decode").body().expect("body");
        assert_eq!(back, results);

        #[derive(Serialize)]
        struct Future<'a> {
            check_id: &'a str,
            state: &'a str,
            at: i64,
        }
        let raw = rmp_serde::to_vec_named(&Future {
            check_id: "x",
            state: "degraded",
            at: 1,
        })
        .expect("encode");
        let parsed: CheckResult = rmp_serde::from_slice(&raw).expect("decode");
        assert_eq!(parsed.state, CheckState::Unknown);
        assert_eq!(parsed.streak, 0);
        assert_eq!(CheckState::parse("warning"), Some(CheckState::Warning));
        assert!(CheckState::Critical.is_failing() && !CheckState::Unknown.is_failing());
    }
}
