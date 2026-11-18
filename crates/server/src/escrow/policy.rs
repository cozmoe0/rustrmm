//! The `escrow` policy section: LAPS-style rotation and FileVault escrow.
//!
//! ```jsonc
//! { "escrow": {
//!     "laps": { "enabled": true, "account": "rmm-admin", "create_if_missing": true, "length": 20,
//!               "complexity": "full", "rotate_days": 30, "rotate_after_reveal_hours": 24 },
//!     "filevault": { "escrow": false } } }
//! ```
//!
//! Objects deep-merge like every other section (a later layer overrides only the keys it sets).

use rustrmm_proto::escrow::{
    COMPLEXITIES, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, RotateLocalAdmin, valid_account_name,
};
use serde_json::Value;

use crate::automation::policies::DocError;

const LAPS_KEYS: &[&str] = &[
    "enabled",
    "account",
    "create_if_missing",
    "length",
    "complexity",
    "rotate_days",
    "rotate_after_reveal_hours",
];
pub const ROTATE_DAYS: (i64, i64) = (1, 365);
pub const AFTER_REVEAL_HOURS: (i64, i64) = (0, 720);

fn err(path: impl Into<String>, message: impl Into<String>) -> DocError {
    DocError {
        path: path.into(),
        message: message.into(),
    }
}

/// Effective LAPS settings of a device (defaults for anything unset).
#[derive(Debug, Clone, PartialEq)]
pub struct LapsPolicy {
    pub enabled: bool,
    pub account: String,
    pub create_if_missing: bool,
    pub length: u32,
    pub complexity: String,
    pub rotate_days: i64,
    /// 0 = no rotation after a reveal.
    pub rotate_after_reveal_hours: i64,
}

impl Default for LapsPolicy {
    fn default() -> Self {
        Self {
            enabled: false,
            account: "rmm-admin".into(),
            create_if_missing: true,
            length: 20,
            complexity: "full".into(),
            rotate_days: 30,
            rotate_after_reveal_hours: 24,
        }
    }
}

impl LapsPolicy {
    /// The signed command that applies these settings.
    pub fn command(&self) -> RotateLocalAdmin {
        RotateLocalAdmin {
            account: self.account.clone(),
            create_if_missing: self.create_if_missing,
            length: self.length,
            complexity: self.complexity.clone(),
            disable_other_admins: false,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct EscrowPolicy {
    pub laps: LapsPolicy,
    pub filevault_escrow: bool,
}

/// Reads the `escrow` section of a merged document.
pub fn from_effective(doc: &Value) -> EscrowPolicy {
    let mut policy = EscrowPolicy::default();
    let laps = doc.pointer("/escrow/laps");
    let get = |key: &str| laps.and_then(|l| l.get(key));
    let l = &mut policy.laps;
    if let Some(v) = get("enabled").and_then(Value::as_bool) {
        l.enabled = v;
    }
    if let Some(v) = get("account")
        .and_then(Value::as_str)
        .filter(|a| valid_account_name(a))
    {
        l.account = v.to_string();
    }
    if let Some(v) = get("create_if_missing").and_then(Value::as_bool) {
        l.create_if_missing = v;
    }
    if let Some(v) = get("length").and_then(Value::as_u64) {
        l.length = (v as u32).clamp(MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH);
    }
    if let Some(v) = get("complexity")
        .and_then(Value::as_str)
        .filter(|c| COMPLEXITIES.contains(c))
    {
        l.complexity = v.to_string();
    }
    if let Some(v) = get("rotate_days").and_then(Value::as_i64) {
        l.rotate_days = v.clamp(ROTATE_DAYS.0, ROTATE_DAYS.1);
    }
    if let Some(v) = get("rotate_after_reveal_hours").and_then(Value::as_i64) {
        l.rotate_after_reveal_hours = v.clamp(AFTER_REVEAL_HOURS.0, AFTER_REVEAL_HOURS.1);
    }
    if let Some(v) = doc
        .pointer("/escrow/filevault/escrow")
        .and_then(Value::as_bool)
    {
        policy.filevault_escrow = v;
    }
    policy
}

fn whole(path: &str, v: &Value, (min, max): (i64, i64)) -> Result<(), DocError> {
    match v.as_i64() {
        Some(n) if (min..=max).contains(&n) => Ok(()),
        _ => Err(err(
            path,
            format!("must be a whole number from {min} to {max}"),
        )),
    }
}

/// Structural validation of the `escrow` section.
pub fn validate_section(value: &Value) -> Result<(), DocError> {
    let obj = value
        .as_object()
        .ok_or_else(|| err("escrow", "must be an object"))?;
    for (key, v) in obj {
        match key.as_str() {
            "laps" => {
                let laps = v
                    .as_object()
                    .ok_or_else(|| err("escrow.laps", "must be an object"))?;
                for (k, v) in laps {
                    let path = format!("escrow.laps.{k}");
                    match k.as_str() {
                        "enabled" | "create_if_missing" => {
                            if !v.is_boolean() {
                                return Err(err(path, "must be true or false"));
                            }
                        }
                        "account" => {
                            if !v.as_str().is_some_and(valid_account_name) {
                                return Err(err(
                                    path,
                                    "must be 1–20 letters, digits, -, _ or . (not starting with - or .)",
                                ));
                            }
                        }
                        "length" => whole(
                            &path,
                            v,
                            (
                                i64::from(MIN_PASSWORD_LENGTH),
                                i64::from(MAX_PASSWORD_LENGTH),
                            ),
                        )?,
                        "complexity" => {
                            if !v.as_str().is_some_and(|c| COMPLEXITIES.contains(&c)) {
                                return Err(err(path, "must be full or alphanumeric"));
                            }
                        }
                        "rotate_days" => whole(&path, v, ROTATE_DAYS)?,
                        "rotate_after_reveal_hours" => whole(&path, v, AFTER_REVEAL_HOURS)?,
                        _ => {
                            return Err(err(
                                path,
                                format!("unknown setting (allowed: {})", LAPS_KEYS.join(", ")),
                            ));
                        }
                    }
                }
            }
            "filevault" => {
                let fv = v
                    .as_object()
                    .ok_or_else(|| err("escrow.filevault", "must be an object"))?;
                for (k, v) in fv {
                    let path = format!("escrow.filevault.{k}");
                    match k.as_str() {
                        "escrow" if v.is_boolean() => {}
                        "escrow" => return Err(err(path, "must be true or false")),
                        _ => return Err(err(path, "unknown setting")),
                    }
                }
            }
            other => {
                return Err(err(
                    format!("escrow.{other}"),
                    "unknown setting (allowed: laps, filevault)",
                ));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::automation::policies::{Layer, merge, validate_structure};
    use serde_json::json;

    #[test]
    fn escrow_policy_validation() {
        let good = json!({ "escrow": {
            "laps": { "enabled": true, "account": "rmm-admin", "create_if_missing": true, "length": 20,
                      "rotate_days": 30, "rotate_after_reveal_hours": 24, "complexity": "full" },
            "filevault": { "escrow": false } } });
        assert!(validate_structure(&good).is_ok());
        for (doc, path) in [
            (json!({ "escrow": [] }), "escrow"),
            (
                json!({ "escrow": { "laps": { "length": 8 } } }),
                "escrow.laps.length",
            ),
            (
                json!({ "escrow": { "laps": { "length": 65 } } }),
                "escrow.laps.length",
            ),
            (
                json!({ "escrow": { "laps": { "account": "bad name" } } }),
                "escrow.laps.account",
            ),
            (
                json!({ "escrow": { "laps": { "rotate_days": 0 } } }),
                "escrow.laps.rotate_days",
            ),
            (
                json!({ "escrow": { "laps": { "rotate_after_reveal_hours": 721 } } }),
                "escrow.laps.rotate_after_reveal_hours",
            ),
            (
                json!({ "escrow": { "laps": { "enabled": "yes" } } }),
                "escrow.laps.enabled",
            ),
            (
                json!({ "escrow": { "laps": { "complexity": "weak" } } }),
                "escrow.laps.complexity",
            ),
            (
                json!({ "escrow": { "laps": { "password": "x" } } }),
                "escrow.laps.password",
            ),
            (
                json!({ "escrow": { "filevault": { "escrow": 1 } } }),
                "escrow.filevault.escrow",
            ),
            (json!({ "escrow": { "bitlocker": {} } }), "escrow.bitlocker"),
        ] {
            let e = validate_structure(&doc).expect_err("invalid");
            assert_eq!(e.path, path, "{doc}");
        }
    }

    #[test]
    fn escrow_sections_merge_key_by_key() {
        let global = json!({ "escrow": { "laps": { "enabled": true, "rotate_days": 30 } } });
        let device =
            json!({ "escrow": { "laps": { "rotate_days": 7 }, "filevault": { "escrow": true } } });
        let (doc, origins) = merge(&[
            Layer {
                policy_id: "g",
                document: &global,
            },
            Layer {
                policy_id: "d",
                document: &device,
            },
        ]);
        let policy = from_effective(&doc);
        assert!(policy.laps.enabled);
        assert_eq!(policy.laps.rotate_days, 7);
        assert!(policy.filevault_escrow);
        assert_eq!(policy.laps.account, "rmm-admin");
        assert_eq!(
            origins.get("escrow.laps.enabled").map(String::as_str),
            Some("g")
        );
        assert_eq!(
            origins.get("escrow.laps.rotate_days").map(String::as_str),
            Some("d")
        );
        let cmd = policy.laps.command();
        assert_eq!(cmd.length, 20);
        assert!(!cmd.disable_other_admins);
        assert_eq!(from_effective(&json!({})), EscrowPolicy::default());
    }
}
