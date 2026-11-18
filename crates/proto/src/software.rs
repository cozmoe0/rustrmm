//! Software library packages and the `software_action` command (see `docs/api-patching.md`,
//! "Software library and deployments").
//!
//! The same [`PackageSource`] and [`Detection`] shapes are stored in the server's library and
//! sent to agents, so the matching helpers here are shared by both sides.

use serde::{Deserialize, Serialize};

use crate::commands::version_cmp;

/// Installer kinds for uploaded files and the platforms that can run them.
pub const INSTALLERS: &[(&str, &[&str])] = &[
    ("msi", &["windows"]),
    ("exe", &["windows"]),
    ("pkg", &["macos"]),
    ("deb", &["linux"]),
    ("rpm", &["linux"]),
    ("sh", &["linux", "macos"]),
];

/// Where a package comes from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PackageSource {
    Winget {
        id: String,
    },
    Choco {
        id: String,
    },
    Brew {
        id: String,
        #[serde(default)]
        cask: bool,
    },
    Apt {
        id: String,
    },
    Dnf {
        id: String,
    },
    Zypper {
        id: String,
    },
    Pacman {
        id: String,
    },
    Apk {
        id: String,
    },
    File {
        #[serde(default)]
        file_id: String,
        #[serde(default)]
        file_name: String,
        #[serde(default)]
        sha256: String,
        #[serde(default)]
        size_bytes: u64,
        /// `msi` | `exe` | `pkg` | `deb` | `rpm` | `sh`
        installer: String,
        #[serde(default)]
        install_args: String,
        #[serde(default)]
        uninstall_args: String,
    },
}

impl PackageSource {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Winget { .. } => "winget",
            Self::Choco { .. } => "choco",
            Self::Brew { .. } => "brew",
            Self::Apt { .. } => "apt",
            Self::Dnf { .. } => "dnf",
            Self::Zypper { .. } => "zypper",
            Self::Pacman { .. } => "pacman",
            Self::Apk { .. } => "apk",
            Self::File { .. } => "file",
        }
    }

    /// Package-manager id (empty for files).
    pub fn id(&self) -> &str {
        match self {
            Self::Winget { id }
            | Self::Choco { id }
            | Self::Brew { id, .. }
            | Self::Apt { id }
            | Self::Dnf { id }
            | Self::Zypper { id }
            | Self::Pacman { id }
            | Self::Apk { id } => id,
            Self::File { .. } => "",
        }
    }

    /// Operating systems this source can install on.
    pub fn platforms(&self) -> &'static [&'static str] {
        match self {
            Self::Winget { .. } | Self::Choco { .. } => &["windows"],
            Self::Brew { .. } => &["macos"],
            Self::Apt { .. }
            | Self::Dnf { .. }
            | Self::Zypper { .. }
            | Self::Pacman { .. }
            | Self::Apk { .. } => &["linux"],
            Self::File { installer, .. } => INSTALLERS
                .iter()
                .find(|(i, _)| i == installer)
                .map(|(_, p)| *p)
                .unwrap_or(&[]),
        }
    }
}

/// How the agent decides whether a package is installed.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Detection {
    /// Installed software whose name matches `pattern` (`*` and `?` wildcards, case-insensitive).
    SoftwareName {
        pattern: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        min_version: Option<String>,
    },
    /// A file exists (Windows: with at least `min_version` as its file version).
    File {
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        min_version: Option<String>,
    },
    /// A registry key exists (Windows), optionally with `value` (equal to `equals`).
    Registry {
        key: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        equals: Option<String>,
    },
    #[default]
    None,
}

/// Where the agent fetches an uploaded installer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileDownload {
    /// Path on the agent gateway (`/agent/v1/files/{sha256}?token=…`); the agent resolves it
    /// against the server it is connected to and never follows another origin.
    pub url: String,
    pub sha256: String,
    pub size: u64,
}

/// Server → agent: install or uninstall one package.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SoftwareAction {
    /// `install` | `uninstall`
    pub action: String,
    pub source: PackageSource,
    #[serde(default)]
    pub detection: Detection,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub download: Option<FileDownload>,
    pub timeout_secs: u32,
    /// The deployment this action belongs to (for logging).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deployment_id: Option<String>,
}

/// `CommandResult.data` of a `software_action` command.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SoftwareActionOutcome {
    /// `None` when the action was skipped or could not start.
    #[serde(default)]
    pub exit_code: Option<i64>,
    /// Detection before the action (`None` for `detection: none`).
    #[serde(default)]
    pub detected_before: Option<bool>,
    #[serde(default)]
    pub detected_after: Option<bool>,
    /// Detection already showed the desired state; nothing ran.
    #[serde(default)]
    pub skipped: bool,
    #[serde(default)]
    pub reboot_required: bool,
    /// First 4 KiB of combined output.
    #[serde(default)]
    pub output: String,
    #[serde(default)]
    pub duration_ms: u64,
}

impl SoftwareActionOutcome {
    /// Whether the action reached its goal: a success exit code and, when detection is
    /// configured, the expected state afterwards.
    pub fn succeeded(&self, action: &str) -> bool {
        if self.skipped {
            return true;
        }
        let exit_ok = self
            .exit_code
            .is_some_and(|c| crate::patching::exit_code_outcome(c).0);
        let detected_ok = match self.detected_after {
            None => true,
            Some(found) => found == (action == "install"),
        };
        exit_ok && detected_ok
    }
}

/// Case-insensitive glob match with `*` (any run) and `?` (one character).
pub fn glob_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.to_lowercase().chars().collect();
    let t: Vec<char> = text.to_lowercase().chars().collect();
    let (mut pi, mut ti) = (0usize, 0usize);
    let mut star: Option<(usize, usize)> = None;
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some((pi, ti));
            pi += 1;
        } else if let Some((sp, st)) = star {
            pi = sp + 1;
            ti = st + 1;
            star = Some((sp, st + 1));
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

/// `version >= min` with numeric dotted comparison (no minimum always satisfies).
pub fn version_satisfies(version: &str, min: Option<&str>) -> bool {
    match min.map(str::trim).filter(|m| !m.is_empty()) {
        None => true,
        Some(min) => version_cmp(version.trim(), min) != std::cmp::Ordering::Less,
    }
}

/// Evaluates a `software_name` rule against an inventory of `(name, version)` pairs.
pub fn software_detected(
    installed: &[(String, String)],
    pattern: &str,
    min_version: Option<&str>,
) -> bool {
    installed
        .iter()
        .any(|(name, version)| glob_match(pattern, name) && version_satisfies(version, min_version))
}

/// Splits a registry path into its hive and subkey (`HKLM\SOFTWARE\x` → `("HKLM", "SOFTWARE\x")`).
pub fn split_registry_key(path: &str) -> Option<(&'static str, &str)> {
    let trimmed = path.trim().trim_start_matches('\\');
    let (hive, rest) = trimmed.split_once('\\').unwrap_or((trimmed, ""));
    let hive = match hive.to_ascii_uppercase().as_str() {
        "HKLM" | "HKEY_LOCAL_MACHINE" => "HKLM",
        "HKCU" | "HKEY_CURRENT_USER" => "HKCU",
        "HKU" | "HKEY_USERS" => "HKU",
        "HKCR" | "HKEY_CLASSES_ROOT" => "HKCR",
        _ => return None,
    };
    Some((hive, rest.trim_matches('\\')))
}

/// Splits installer arguments like a shell would (double and single quotes group words).
pub fn split_args(args: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut has_token = false;
    for c in args.chars() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), c) => current.push(c),
            (None, '"' | '\'') => {
                quote = Some(c);
                has_token = true;
            }
            (None, c) if c.is_whitespace() => {
                if has_token || !current.is_empty() {
                    out.push(std::mem::take(&mut current));
                    has_token = false;
                }
            }
            (None, c) => current.push(c),
        }
    }
    if has_token || !current.is_empty() {
        out.push(current);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn globs_match_case_insensitively() {
        assert!(glob_match("7-Zip*", "7-Zip 24.08 (x64)"));
        assert!(glob_match("*chrome*", "Google Chrome"));
        assert!(glob_match("Fire?ox", "firefox"));
        assert!(glob_match("*", ""));
        assert!(!glob_match("7-Zip", "7-Zip 24.08"));
        assert!(!glob_match("Fire?ox", "Firefoox"));
        assert!(glob_match("a*b*c", "axxbyyc"));
        assert!(!glob_match("a*b*c", "axxbyy"));
    }

    #[test]
    fn detection_rules_with_versions() {
        let installed = vec![
            ("7-Zip 24.08 (x64)".to_string(), "24.08".to_string()),
            ("Google Chrome".to_string(), "131.0.6778.86".to_string()),
        ];
        assert!(software_detected(&installed, "7-Zip*", Some("24.0")));
        assert!(!software_detected(&installed, "7-Zip*", Some("24.9")));
        assert!(software_detected(&installed, "google chrome", None));
        assert!(software_detected(
            &installed,
            "Google Chrome",
            Some("131.0.6778")
        ));
        assert!(!software_detected(&installed, "Firefox*", None));
        assert!(version_satisfies("1.2.3", Some("")));
        assert!(version_satisfies("10.0", Some("9.9.9")));
        assert!(!version_satisfies("0.9", Some("1.0")));
    }

    #[test]
    fn outcome_success_rules() {
        let mut outcome = SoftwareActionOutcome {
            exit_code: Some(3010),
            detected_after: Some(true),
            ..Default::default()
        };
        assert!(outcome.succeeded("install"));
        assert!(
            !outcome.succeeded("uninstall"),
            "still detected after uninstall"
        );
        outcome.detected_after = None;
        outcome.exit_code = Some(1603);
        assert!(!outcome.succeeded("install"));
        outcome.skipped = true;
        assert!(outcome.succeeded("install"));
    }

    #[test]
    fn registry_paths_and_args() {
        assert_eq!(
            split_registry_key(r"HKEY_LOCAL_MACHINE\SOFTWARE\7-Zip"),
            Some(("HKLM", r"SOFTWARE\7-Zip"))
        );
        assert_eq!(split_registry_key(r"HKLM"), Some(("HKLM", "")));
        assert_eq!(split_registry_key(r"BOGUS\x"), None);
        assert_eq!(
            split_args(r#"/qn INSTALLDIR="C:\Program Files\App" ''"#),
            vec!["/qn", r"INSTALLDIR=C:\Program Files\App", ""]
        );
        assert!(split_args("   ").is_empty());
    }

    #[test]
    fn sources_round_trip_and_know_platforms() {
        let source = PackageSource::File {
            file_id: "f1".into(),
            file_name: "7z.msi".into(),
            sha256: "ab".into(),
            size_bytes: 10,
            installer: "msi".into(),
            install_args: "/qn".into(),
            uninstall_args: String::new(),
        };
        let json = serde_json::to_value(&source).expect("json");
        assert_eq!(json["type"], "file");
        assert_eq!(source.platforms(), &["windows"]);
        let brew: PackageSource =
            serde_json::from_value(serde_json::json!({ "type": "brew", "id": "p7zip" }))
                .expect("brew");
        assert_eq!(brew.platforms(), &["macos"]);
        let detection: Detection =
            serde_json::from_value(serde_json::json!({ "type": "none" })).expect("none");
        assert_eq!(detection, Detection::None);
    }
}
