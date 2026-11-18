//! Operating-system patching (see `docs/api-patching.md`, "Agent protocol additions").
//!
//! * [`PatchScan`] (signed command) asks the agent to search for missing updates; the agent
//!   answers with an ordinary command result and a [`PatchReport`] message.
//! * [`PatchInstall`] (signed command) installs exactly the listed patch keys and negotiates the
//!   reboot with the signed-in user; its command result carries [`PatchInstallOutcome`].
//!
//! Patch keys: the WUA `UpdateID` on Windows, `<manager>:<package>:<version>` on Linux, the
//! `softwareupdate` label on macOS and `winget:<id>:<version>` for winget upgrades.

use serde::{Deserialize, Serialize};

use crate::Message;

/// Reboot modes a policy can choose.
pub const REBOOT_MODES: &[&str] = &["never", "prompt", "force"];
/// Minutes between reboot prompts after the user postponed.
pub const DEFERRAL_MINUTES: u32 = 60;
/// Exit codes that count as success for installers (3010 and 1641 also mean "reboot needed").
pub const SUCCESS_EXIT_CODES: &[i64] = &[0, 3010, 1641];

/// Whether an installer exit code means success, and whether it asks for a reboot.
pub fn exit_code_outcome(code: i64) -> (bool, bool) {
    (
        SUCCESS_EXIT_CODES.contains(&code),
        code == 3010 || code == 1641,
    )
}

/// Server → agent: search for missing patches now.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PatchScan {
    #[serde(default)]
    pub include_drivers: bool,
    #[serde(default)]
    pub include_feature_updates: bool,
    #[serde(default)]
    pub include_preview: bool,
    #[serde(default)]
    pub third_party_winget: bool,
}

/// One patch as the agent sees it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AgentPatch {
    pub key: String,
    /// Set when the patch belongs to another catalog platform than the device's operating
    /// system (`winget` upgrades on Windows).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kb: Option<String>,
    pub title: String,
    /// Windows: `SecurityUpdates` | `CriticalUpdates` | `UpdateRollups` | `Updates` |
    /// `Definitions` | `Drivers` | `FeaturePacks` | `Upgrades` | `ServicePacks` | `Tools`;
    /// Linux: `security` | `bugfix` | `enhancement` | `other`; macOS and winget: `os` |
    /// `security` | `app`.
    pub classification: String,
    /// `Critical` | `Important` | `Moderate` | `Low`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub severity: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    #[serde(default)]
    pub reboot_required: bool,
    /// RFC 3339 date-time (or `YYYY-MM-DD`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release_date: Option<String>,
    #[serde(default)]
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub support_url: Option<String>,
    #[serde(default)]
    pub cves: Vec<String>,
    /// Package name for package-manager patches (also part of the key).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub package: Option<String>,
    /// Available (or installed) version.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// `installed_recent` only: when the update was installed (RFC 3339).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installed_at: Option<String>,
    /// `installed_recent` only: `succeeded` | `failed`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    /// `installed_recent` only: the HRESULT of a failed install.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hresult: Option<i64>,
}

/// Agent → server: the outcome of a scan.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PatchReport {
    /// Agent clock, unix milliseconds.
    pub scanned_at: i64,
    /// `wsus` | `windows_update` | `apt` | `dnf` | `zypper` | `pacman` | `apk` | `softwareupdate`
    pub source: String,
    #[serde(default)]
    pub available: Vec<AgentPatch>,
    #[serde(default)]
    pub installed_recent: Vec<AgentPatch>,
    #[serde(default)]
    pub pending_reboot: bool,
    #[serde(default)]
    pub reboot_reasons: Vec<String>,
    /// Unix milliseconds of the newest successful install the agent knows about.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_install_at: Option<i64>,
    /// The scan failed (the lists are then empty and must not be reconciled).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// The `patch_scan` command this report answers (unsolicited reports leave it empty).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cmd_id: Option<String>,
}

impl Message for PatchReport {
    const TYPE: &'static str = "patch_report";
}

/// How the agent handles a reboot after installing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RebootSpec {
    /// `never` | `prompt` | `force`
    pub mode: String,
    /// How many times the user may postpone (60 minutes each).
    #[serde(default)]
    pub deferrals: u32,
    #[serde(default)]
    pub message: String,
    /// Unix seconds after which a pending reboot is forced (window end with
    /// `force_at_window_end`); `None` = no deadline.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline_unix: Option<i64>,
}

impl Default for RebootSpec {
    fn default() -> Self {
        Self {
            mode: "prompt".into(),
            deferrals: 3,
            message: String::new(),
            deadline_unix: None,
        }
    }
}

/// Server → agent: install exactly these patch keys.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PatchInstall {
    /// The patch run this install belongs to (`None` for an immediate install).
    #[serde(default)]
    pub run_id: Option<String>,
    pub keys: Vec<String>,
    #[serde(default)]
    pub reboot: RebootSpec,
    /// Unix seconds when the maintenance window closes (`None` outside a window).
    #[serde(default)]
    pub window_end_unix: Option<i64>,
}

/// Per-key outcome of an install.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PatchKeyResult {
    pub key: String,
    /// `installed` | `failed` | `pending_reboot`
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hresult: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `CommandResult.data` of a `patch_install` command. The agent first reports `running` with
/// `phase: "awaiting_reboot"` once the installs finished, then the final result after the
/// reboot negotiation.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PatchInstallOutcome {
    pub results: Vec<PatchKeyResult>,
    #[serde(default)]
    pub reboot_required: bool,
    #[serde(default)]
    pub rebooting: bool,
    #[serde(default)]
    pub deferrals_used: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
}

/// Linux package managers the agent knows.
pub const LINUX_MANAGERS: &[&str] = &["apt", "dnf", "zypper", "pacman", "apk"];

/// Builds a package-manager patch key `<manager>:<package>:<version>`.
pub fn package_key(manager: &str, package: &str, version: &str) -> String {
    format!("{manager}:{package}:{version}")
}

/// Splits a package-manager (or winget) key into `(manager, package, version)`. Versions may
/// contain `:` (Debian epochs), so only the first two separators count.
pub fn split_package_key(key: &str) -> Option<(&str, &str, &str)> {
    let (manager, rest) = key.split_once(':')?;
    let (package, version) = rest.split_once(':')?;
    if manager.is_empty() || package.is_empty() {
        return None;
    }
    Some((manager, package, version))
}

/// Package names passed to package managers: no option injection, no shell metacharacters.
pub fn valid_package_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 200
        && !name.starts_with('-')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '+' | '@' | '/'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Frame;

    #[test]
    fn report_round_trips() {
        let report = PatchReport {
            scanned_at: 1_700_000_000_000,
            source: "windows_update".into(),
            available: vec![AgentPatch {
                key: "8a5f2e4c-0000-4000-8000-000000000001".into(),
                kb: Some("KB5039212".into()),
                title: "2026-11 Cumulative Update".into(),
                classification: "SecurityUpdates".into(),
                severity: Some("Critical".into()),
                size_bytes: Some(812_000_000),
                reboot_required: true,
                release_date: Some("2026-11-10T00:00:00Z".into()),
                cves: vec!["CVE-2026-1234".into()],
                ..AgentPatch::default()
            }],
            installed_recent: vec![],
            pending_reboot: false,
            reboot_reasons: vec![],
            last_install_at: None,
            error: None,
            cmd_id: Some("cmd-1".into()),
        };
        let bytes = crate::encode(&report).expect("encode");
        let frame = Frame::decode(&bytes).expect("decode");
        assert_eq!(frame.t, "patch_report");
        let back: PatchReport = frame.body().expect("body");
        assert_eq!(back, report);
    }

    #[test]
    fn package_keys_split_with_epochs() {
        let key = package_key("apt", "openssl", "1:3.0.2-0ubuntu1.15");
        assert_eq!(
            split_package_key(&key),
            Some(("apt", "openssl", "1:3.0.2-0ubuntu1.15"))
        );
        assert_eq!(split_package_key("nope"), None);
        assert!(valid_package_name("libssl3"));
        assert!(valid_package_name("openssl.x86_64"));
        assert!(!valid_package_name("--force"));
        assert!(!valid_package_name("a;b"));
        assert_eq!(exit_code_outcome(0), (true, false));
        assert_eq!(exit_code_outcome(3010), (true, true));
        assert_eq!(exit_code_outcome(1641), (true, true));
        assert_eq!(exit_code_outcome(1603), (false, false));
    }
}
