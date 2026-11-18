//! The `patching` policy section: validation and the effective configuration of a device.
//!
//! The section merges like any other policy object (objects deep-merge key by key, other values
//! and lists replace), so `auto_approve` comes whole from the last layer that sets it.

use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::automation::policies::DocError;

pub const RINGS: &[&str] = &["pilot", "broad", "late"];
pub const RULE_PLATFORMS: &[&str] = &["windows", "linux", "macos", "winget"];
pub const SEVERITIES: &[&str] = &["Critical", "Important", "Moderate", "Low"];
pub const WINDOWS_CLASSIFICATIONS: &[&str] = &[
    "SecurityUpdates",
    "CriticalUpdates",
    "UpdateRollups",
    "Updates",
    "Definitions",
    "Drivers",
    "FeaturePacks",
    "Upgrades",
    "ServicePacks",
    "Tools",
];
pub const LINUX_CLASSIFICATIONS: &[&str] = &["security", "bugfix", "enhancement", "other"];
pub const MAC_CLASSIFICATIONS: &[&str] = &["os", "security", "app"];
pub const MAX_RULES: usize = 50;
const DEFAULT_MESSAGE: &str = "Your IT team installed updates. Please restart to finish.";

const SECTION_KEYS: &[&str] = &[
    "enabled",
    "scan_interval_hours",
    "window",
    "ring",
    "auto_approve",
    "windows",
    "linux",
    "macos",
    "reboot",
    "third_party",
];

fn err(path: impl Into<String>, message: impl Into<String>) -> DocError {
    DocError {
        path: path.into(),
        message: message.into(),
    }
}

/// Ring delays of an approval, in days from the release date.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DelayDays {
    #[serde(default)]
    pub pilot: i64,
    #[serde(default)]
    pub broad: i64,
    #[serde(default)]
    pub late: i64,
}

impl DelayDays {
    pub fn for_ring(&self, ring: &str) -> i64 {
        match ring {
            "pilot" => self.pilot,
            "late" => self.late,
            _ => self.broad,
        }
        .max(0)
    }
}

/// One auto-approval rule.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Rule {
    pub platform: String,
    #[serde(default)]
    pub classifications: Vec<String>,
    #[serde(default)]
    pub severities: Vec<String>,
    #[serde(default)]
    pub delay_days: DelayDays,
}

impl Rule {
    /// Empty lists match anything; a patch without a severity matches only when `severities`
    /// is empty.
    pub fn matches(&self, platform: &str, classification: &str, severity: Option<&str>) -> bool {
        self.platform == platform
            && (self.classifications.is_empty()
                || self
                    .classifications
                    .iter()
                    .any(|c| c.eq_ignore_ascii_case(classification)))
            && (self.severities.is_empty()
                || severity
                    .is_some_and(|s| self.severities.iter().any(|x| x.eq_ignore_ascii_case(s))))
    }
}

/// A maintenance window for installs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstallWindow {
    pub cron: String,
    pub duration_minutes: i64,
    pub timezone: String,
}

impl InstallWindow {
    /// The occurrence that opened the window currently in progress at `now`, if any.
    pub fn open_at(&self, now: DateTime<Utc>) -> Option<(DateTime<Utc>, DateTime<Utc>)> {
        let from = now - chrono::Duration::minutes(self.duration_minutes);
        let start = crate::automation::cron::next_after(&self.cron, &self.timezone, from)?;
        (start <= now).then(|| {
            (
                start,
                start + chrono::Duration::minutes(self.duration_minutes),
            )
        })
    }

    pub fn next_start(&self, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
        crate::automation::cron::next_after(&self.cron, &self.timezone, now)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RebootConfig {
    pub mode: String,
    pub prompt_deferrals: u32,
    pub force_at_window_end: bool,
    pub message: String,
}

/// The effective `patching` configuration of a device (defaults filled in).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PatchingConfig {
    pub enabled: bool,
    pub scan_interval_hours: i64,
    pub window: Option<InstallWindow>,
    /// The policy that set `window.cron` (identifies the policy window of patch runs).
    pub window_policy: Option<String>,
    pub ring: String,
    pub auto_approve: Vec<Rule>,
    /// The policy whose `auto_approve` list applies.
    pub rules_policy: Option<String>,
    pub include_drivers: bool,
    pub include_feature_updates: bool,
    pub include_preview: bool,
    pub linux_mode: String,
    pub macos_install: bool,
    pub reboot: RebootConfig,
    pub third_party_winget: bool,
}

impl Default for PatchingConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            scan_interval_hours: 12,
            window: None,
            window_policy: None,
            ring: "broad".into(),
            auto_approve: Vec::new(),
            rules_policy: None,
            include_drivers: false,
            include_feature_updates: false,
            include_preview: false,
            linux_mode: "security".into(),
            macos_install: false,
            reboot: RebootConfig {
                mode: "prompt".into(),
                prompt_deferrals: 3,
                force_at_window_end: true,
                message: DEFAULT_MESSAGE.into(),
            },
            third_party_winget: false,
        }
    }
}

impl PatchingConfig {
    /// Reads the merged document (unset keys keep their defaults; invalid values are ignored).
    pub fn from_effective(doc: &Value, origins: &BTreeMap<String, String>) -> Self {
        let mut cfg = Self::default();
        let Some(p) = doc.get("patching").and_then(Value::as_object) else {
            return cfg;
        };
        let get = |ptr: &str| doc.pointer(&format!("/patching{ptr}"));
        if let Some(b) = get("/enabled").and_then(Value::as_bool) {
            cfg.enabled = b;
        }
        if let Some(n) = get("/scan_interval_hours").and_then(Value::as_i64) {
            cfg.scan_interval_hours = n.clamp(1, 168);
        }
        if let Some(cron) = get("/window/cron").and_then(Value::as_str) {
            let duration = get("/window/duration_minutes")
                .and_then(Value::as_i64)
                .unwrap_or(180)
                .clamp(15, 1440);
            let timezone = get("/window/timezone")
                .and_then(Value::as_str)
                .unwrap_or("UTC")
                .to_string();
            if crate::automation::cron::validate(cron, &timezone).is_ok() {
                cfg.window = Some(InstallWindow {
                    cron: cron.to_string(),
                    duration_minutes: duration,
                    timezone,
                });
                cfg.window_policy = origins.get("patching.window.cron").cloned();
            }
        }
        if let Some(ring) = get("/ring").and_then(Value::as_str)
            && RINGS.contains(&ring)
        {
            cfg.ring = ring.to_string();
        }
        if let Some(list) = p.get("auto_approve") {
            cfg.auto_approve = serde_json::from_value(list.clone()).unwrap_or_default();
            cfg.rules_policy = origins.get("patching.auto_approve").cloned();
        }
        let flag = |ptr: &str, default: bool| get(ptr).and_then(Value::as_bool).unwrap_or(default);
        cfg.include_drivers = flag("/windows/include_drivers", false);
        cfg.include_feature_updates = flag("/windows/include_feature_updates", false);
        cfg.include_preview = flag("/windows/include_preview", false);
        if let Some(mode) = get("/linux/mode").and_then(Value::as_str)
            && matches!(mode, "security" | "all")
        {
            cfg.linux_mode = mode.to_string();
        }
        cfg.macos_install = flag("/macos/install", false);
        if let Some(mode) = get("/reboot/mode").and_then(Value::as_str)
            && rustrmm_proto::patching::REBOOT_MODES.contains(&mode)
        {
            cfg.reboot.mode = mode.to_string();
        }
        if let Some(n) = get("/reboot/prompt_deferrals").and_then(Value::as_u64) {
            cfg.reboot.prompt_deferrals = n.min(10) as u32;
        }
        cfg.reboot.force_at_window_end = flag("/reboot/force_at_window_end", true);
        if let Some(m) = get("/reboot/message").and_then(Value::as_str)
            && !m.trim().is_empty()
        {
            cfg.reboot.message = m.trim().chars().take(500).collect();
        }
        cfg.third_party_winget = flag("/third_party/winget", false);
        cfg
    }

    /// The first rule matching a patch.
    pub fn matching_rule(
        &self,
        platform: &str,
        classification: &str,
        severity: Option<&str>,
    ) -> Option<&Rule> {
        self.auto_approve
            .iter()
            .find(|r| r.matches(platform, classification, severity))
    }
}

// ------------------------------------------------------------------ validation

fn bool_at(obj: &Map<String, Value>, key: &str, base: &str) -> Result<(), DocError> {
    match obj.get(key) {
        None | Some(Value::Bool(_)) => Ok(()),
        Some(_) => Err(err(format!("{base}.{key}"), "must be true or false")),
    }
}

fn known_keys(obj: &Map<String, Value>, allowed: &[&str], base: &str) -> Result<(), DocError> {
    for key in obj.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(err(format!("{base}.{key}"), "unknown setting"));
        }
    }
    Ok(())
}

fn object<'a>(value: &'a Value, path: &str) -> Result<&'a Map<String, Value>, DocError> {
    value
        .as_object()
        .ok_or_else(|| err(path, "must be an object"))
}

fn int_in(value: &Value, path: &str, min: i64, max: i64) -> Result<i64, DocError> {
    match value.as_i64() {
        Some(n) if (min..=max).contains(&n) => Ok(n),
        _ => Err(err(
            path,
            format!("must be a whole number from {min} to {max}"),
        )),
    }
}

/// Structural validation of the `patching` section.
pub fn validate_section(value: &Value) -> Result<(), DocError> {
    let section = object(value, "patching")?;
    known_keys(section, SECTION_KEYS, "patching")?;
    bool_at(section, "enabled", "patching")?;
    if let Some(v) = section.get("scan_interval_hours") {
        int_in(v, "patching.scan_interval_hours", 1, 168)?;
    }
    if let Some(v) = section.get("window") {
        let window = object(v, "patching.window")?;
        known_keys(
            window,
            &["cron", "duration_minutes", "timezone"],
            "patching.window",
        )?;
        let cron = window
            .get("cron")
            .and_then(Value::as_str)
            .ok_or_else(|| err("patching.window.cron", "is required"))?;
        crate::automation::cron::parse(cron).map_err(|e| err("patching.window.cron", e))?;
        if let Some(tz) = window.get("timezone") {
            let tz = tz
                .as_str()
                .ok_or_else(|| err("patching.window.timezone", "must be a time zone name"))?;
            crate::automation::cron::timezone(tz)
                .map_err(|e| err("patching.window.timezone", e))?;
        }
        if let Some(d) = window.get("duration_minutes") {
            int_in(d, "patching.window.duration_minutes", 15, 1440)?;
        }
    }
    if let Some(v) = section.get("ring")
        && !v.as_str().is_some_and(|r| RINGS.contains(&r))
    {
        return Err(err("patching.ring", "must be pilot, broad or late"));
    }
    if let Some(v) = section.get("auto_approve") {
        let list = v
            .as_array()
            .ok_or_else(|| err("patching.auto_approve", "must be a list"))?;
        if list.len() > MAX_RULES {
            return Err(err(
                "patching.auto_approve",
                format!("at most {MAX_RULES} rules"),
            ));
        }
        for (i, item) in list.iter().enumerate() {
            let base = format!("patching.auto_approve[{i}]");
            let rule = object(item, &base)?;
            known_keys(
                rule,
                &["platform", "classifications", "severities", "delay_days"],
                &base,
            )?;
            let platform = rule
                .get("platform")
                .and_then(Value::as_str)
                .filter(|p| RULE_PLATFORMS.contains(p))
                .ok_or_else(|| {
                    err(
                        format!("{base}.platform"),
                        "must be windows, linux, macos or winget",
                    )
                })?;
            let allowed: &[&str] = match platform {
                "windows" => WINDOWS_CLASSIFICATIONS,
                "linux" => LINUX_CLASSIFICATIONS,
                _ => MAC_CLASSIFICATIONS,
            };
            if let Some(c) = rule.get("classifications") {
                let list = c
                    .as_array()
                    .ok_or_else(|| err(format!("{base}.classifications"), "must be a list"))?;
                for (j, item) in list.iter().enumerate() {
                    if !item.as_str().is_some_and(|s| allowed.contains(&s)) {
                        return Err(err(
                            format!("{base}.classifications[{j}]"),
                            format!("must be one of {}", allowed.join(", ")),
                        ));
                    }
                }
            }
            if let Some(s) = rule.get("severities") {
                let list = s
                    .as_array()
                    .ok_or_else(|| err(format!("{base}.severities"), "must be a list"))?;
                for (j, item) in list.iter().enumerate() {
                    if !item.as_str().is_some_and(|s| SEVERITIES.contains(&s)) {
                        return Err(err(
                            format!("{base}.severities[{j}]"),
                            "must be Critical, Important, Moderate or Low",
                        ));
                    }
                }
            }
            if let Some(d) = rule.get("delay_days") {
                let delays = object(d, &format!("{base}.delay_days"))?;
                known_keys(delays, RINGS, &format!("{base}.delay_days"))?;
                for (ring, value) in delays {
                    int_in(value, &format!("{base}.delay_days.{ring}"), 0, 365)?;
                }
            }
        }
    }
    if let Some(v) = section.get("windows") {
        let windows = object(v, "patching.windows")?;
        let keys = [
            "include_drivers",
            "include_feature_updates",
            "include_preview",
        ];
        known_keys(windows, &keys, "patching.windows")?;
        for key in keys {
            bool_at(windows, key, "patching.windows")?;
        }
    }
    if let Some(v) = section.get("linux") {
        let linux = object(v, "patching.linux")?;
        known_keys(linux, &["mode"], "patching.linux")?;
        if let Some(mode) = linux.get("mode")
            && !matches!(mode.as_str(), Some("security" | "all"))
        {
            return Err(err("patching.linux.mode", "must be security or all"));
        }
    }
    if let Some(v) = section.get("macos") {
        let macos = object(v, "patching.macos")?;
        known_keys(macos, &["install"], "patching.macos")?;
        bool_at(macos, "install", "patching.macos")?;
    }
    if let Some(v) = section.get("reboot") {
        let reboot = object(v, "patching.reboot")?;
        known_keys(
            reboot,
            &["mode", "prompt_deferrals", "force_at_window_end", "message"],
            "patching.reboot",
        )?;
        if let Some(mode) = reboot.get("mode")
            && !mode
                .as_str()
                .is_some_and(|m| rustrmm_proto::patching::REBOOT_MODES.contains(&m))
        {
            return Err(err(
                "patching.reboot.mode",
                "must be never, prompt or force",
            ));
        }
        if let Some(n) = reboot.get("prompt_deferrals") {
            int_in(n, "patching.reboot.prompt_deferrals", 0, 10)?;
        }
        bool_at(reboot, "force_at_window_end", "patching.reboot")?;
        if let Some(m) = reboot.get("message") {
            let m = m
                .as_str()
                .ok_or_else(|| err("patching.reboot.message", "must be text"))?;
            if m.chars().count() > 500 {
                return Err(err("patching.reboot.message", "at most 500 characters"));
            }
        }
    }
    if let Some(v) = section.get("third_party") {
        let third = object(v, "patching.third_party")?;
        known_keys(third, &["winget"], "patching.third_party")?;
        bool_at(third, "winget", "patching.third_party")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn section_validation_points_at_paths() {
        let ok = json!({
            "enabled": true, "scan_interval_hours": 12,
            "window": { "cron": "0 2 * * 3", "duration_minutes": 180, "timezone": "UTC" },
            "ring": "broad",
            "auto_approve": [
                { "platform": "windows", "classifications": ["SecurityUpdates", "CriticalUpdates"], "severities": [],
                  "delay_days": { "pilot": 0, "broad": 7, "late": 21 } },
                { "platform": "linux", "classifications": ["security"], "delay_days": { "pilot": 0, "broad": 3, "late": 10 } }
            ],
            "windows": { "include_drivers": false, "include_feature_updates": false, "include_preview": false },
            "linux": { "mode": "security" }, "macos": { "install": false },
            "reboot": { "mode": "prompt", "prompt_deferrals": 3, "force_at_window_end": true, "message": "Restart please" },
            "third_party": { "winget": false }
        });
        assert!(validate_section(&ok).is_ok());
        let cases = [
            (json!([]), "patching"),
            (json!({ "colour": 1 }), "patching.colour"),
            (json!({ "enabled": "yes" }), "patching.enabled"),
            (
                json!({ "scan_interval_hours": 0 }),
                "patching.scan_interval_hours",
            ),
            (
                json!({ "window": { "duration_minutes": 60 } }),
                "patching.window.cron",
            ),
            (
                json!({ "window": { "cron": "bad" } }),
                "patching.window.cron",
            ),
            (
                json!({ "window": { "cron": "0 2 * * 3", "timezone": "Mars/Base" } }),
                "patching.window.timezone",
            ),
            (
                json!({ "window": { "cron": "0 2 * * 3", "duration_minutes": 5 } }),
                "patching.window.duration_minutes",
            ),
            (json!({ "ring": "early" }), "patching.ring"),
            (
                json!({ "auto_approve": [{ "platform": "bsd" }] }),
                "patching.auto_approve[0].platform",
            ),
            (
                json!({ "auto_approve": [{ "platform": "windows", "classifications": ["security"] }] }),
                "patching.auto_approve[0].classifications[0]",
            ),
            (
                json!({ "auto_approve": [{ "platform": "linux", "severities": ["High"] }] }),
                "patching.auto_approve[0].severities[0]",
            ),
            (
                json!({ "auto_approve": [{ "platform": "linux", "delay_days": { "broad": -1 } }] }),
                "patching.auto_approve[0].delay_days.broad",
            ),
            (
                json!({ "auto_approve": [{ "platform": "linux", "delay_days": { "early": 1 } }] }),
                "patching.auto_approve[0].delay_days.early",
            ),
            (
                json!({ "linux": { "mode": "some" } }),
                "patching.linux.mode",
            ),
            (
                json!({ "reboot": { "mode": "maybe" } }),
                "patching.reboot.mode",
            ),
            (
                json!({ "reboot": { "prompt_deferrals": 11 } }),
                "patching.reboot.prompt_deferrals",
            ),
            (
                json!({ "third_party": { "choco": true } }),
                "patching.third_party.choco",
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
    fn effective_config_reads_defaults_and_origins() {
        let doc = json!({ "patching": {
            "enabled": true, "window": { "cron": "0 2 * * 3" }, "ring": "pilot",
            "auto_approve": [{ "platform": "windows", "classifications": ["SecurityUpdates"],
                               "delay_days": { "pilot": 0, "broad": 7 } }],
            "reboot": { "mode": "force" }
        }});
        let mut origins = BTreeMap::new();
        origins.insert("patching.window.cron".to_string(), "p1".to_string());
        origins.insert("patching.auto_approve".to_string(), "p2".to_string());
        let cfg = PatchingConfig::from_effective(&doc, &origins);
        assert!(cfg.enabled);
        assert_eq!(cfg.ring, "pilot");
        assert_eq!(cfg.window_policy.as_deref(), Some("p1"));
        assert_eq!(cfg.rules_policy.as_deref(), Some("p2"));
        let window = cfg.window.clone().expect("window");
        assert_eq!(window.duration_minutes, 180);
        assert_eq!(window.timezone, "UTC");
        assert_eq!(cfg.reboot.mode, "force");
        assert_eq!(cfg.reboot.prompt_deferrals, 3);
        assert!(cfg.reboot.force_at_window_end);
        let rule = cfg
            .matching_rule("windows", "SecurityUpdates", Some("Critical"))
            .expect("rule");
        assert_eq!(rule.delay_days.for_ring("pilot"), 0);
        assert_eq!(rule.delay_days.for_ring("broad"), 7);
        assert_eq!(rule.delay_days.for_ring("late"), 0);
        assert!(cfg.matching_rule("windows", "Updates", None).is_none());
        assert!(
            cfg.matching_rule("linux", "SecurityUpdates", None)
                .is_none()
        );
        assert_eq!(
            PatchingConfig::from_effective(&json!({}), &BTreeMap::new()),
            PatchingConfig::default()
        );
    }

    #[test]
    fn rules_match_severities_and_windows_open() {
        let rule = Rule {
            platform: "windows".into(),
            classifications: vec![],
            severities: vec!["Critical".into()],
            delay_days: DelayDays::default(),
        };
        assert!(rule.matches("windows", "Updates", Some("critical")));
        assert!(!rule.matches("windows", "Updates", None));
        assert!(!rule.matches("windows", "Updates", Some("Low")));
        let window = InstallWindow {
            cron: "0 2 * * 3".into(),
            duration_minutes: 180,
            timezone: "UTC".into(),
        };
        let wed = |h: u32, m: u32| {
            chrono::TimeZone::with_ymd_and_hms(&Utc, 2026, 11, 18, h, m, 0)
                .single()
                .expect("time")
        };
        let (start, end) = window.open_at(wed(3, 30)).expect("open");
        assert_eq!(start, wed(2, 0));
        assert_eq!(end, wed(5, 0));
        assert!(window.open_at(wed(5, 0)).is_none(), "the end is exclusive");
        assert!(window.open_at(wed(1, 59)).is_none());
    }
}
