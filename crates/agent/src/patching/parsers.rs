//! Pure parsers for package-manager, `softwareupdate` and winget output, and the Windows
//! Update classification and severity mapping. Compiled on every platform so the fixtures in
//! the tests run everywhere.

// Each platform uses its own subset of these parsers; all of them are tested everywhere.
#![allow(dead_code)]

use std::collections::HashMap;

use rustrmm_proto::patching::{AgentPatch, package_key};

fn package_patch(manager: &str, name: &str, version: &str, classification: &str) -> AgentPatch {
    AgentPatch {
        key: package_key(manager, name, version),
        title: format!("{name} {version}"),
        classification: classification.into(),
        package: Some(name.to_string()),
        version: Some(version.to_string()),
        ..AgentPatch::default()
    }
}

// ------------------------------------------------------------------ apt

/// `apt list --upgradable`:
/// `openssl/jammy-updates,jammy-security 3.0.2-0ubuntu1.15 amd64 [upgradable from: 3.0.2-0ubuntu1.14]`
pub fn parse_apt_upgradable(output: &str) -> Vec<AgentPatch> {
    let mut out = Vec::new();
    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("Listing") || line.starts_with("WARNING") {
            continue;
        }
        let Some((name, rest)) = line.split_once('/') else {
            continue;
        };
        let fields: Vec<&str> = rest.split_whitespace().collect();
        if fields.len() < 2 || !line.contains("upgradable") {
            continue;
        }
        let suites = fields[0];
        let version = fields[1];
        let classification = if suites
            .split(',')
            .any(|s| s.contains("-security") || s == "security")
        {
            "security"
        } else if suites
            .split(',')
            .any(|s| s.ends_with("-updates") || s.ends_with("-proposed"))
        {
            "bugfix"
        } else {
            "other"
        };
        let mut patch = package_patch("apt", name, version, classification);
        if let Some(from) = line
            .split("upgradable from: ")
            .nth(1)
            .map(|s| s.trim_end_matches(']'))
        {
            patch.description = format!("Upgrade {name} from {from} to {version} ({suites})");
        }
        out.push(patch);
    }
    out
}

// ------------------------------------------------------------------ dnf

/// Splits `name-[epoch:]version-release.arch` into `(name, arch)`.
fn nevra_name_arch(nevra: &str) -> Option<(String, String)> {
    let (rest, arch) = nevra.rsplit_once('.')?;
    let (rest, _release) = rest.rsplit_once('-')?;
    let (name, _version) = rest.rsplit_once('-')?;
    Some((name.to_string(), arch.to_string()))
}

/// Architectures that end a `name.arch` or NEVRA.
const RPM_ARCHES: &[&str] = &[
    "x86_64", "noarch", "aarch64", "i686", "i386", "ppc64le", "s390x", "armv7hl", "riscv64",
];

fn has_rpm_arch(name_arch: &str) -> bool {
    name_arch
        .rsplit_once('.')
        .is_some_and(|(name, arch)| !name.is_empty() && RPM_ARCHES.contains(&arch))
}

/// `dnf -q check-update` (dnf 4) and `dnf5 -q check-upgrade`: `name.arch  version  repo` (long
/// names may wrap onto two lines). dnf5's repository-loading lines and section headers are
/// skipped.
pub fn parse_dnf_check_update(output: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut carry: Option<String> = None;
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("Obsoleting") {
            break;
        }
        if trimmed.is_empty()
            || trimmed.starts_with("Last metadata")
            || trimmed.starts_with("Security:")
            || trimmed.starts_with("Updating and loading repositories")
            || trimmed.starts_with("Repositories loaded")
            || trimmed.ends_with(':')
        {
            carry = None;
            continue;
        }
        let mut fields: Vec<String> = trimmed.split_whitespace().map(str::to_string).collect();
        if let Some(name) = carry.take() {
            fields.insert(0, name);
        }
        match fields.len() {
            // A wrapped long name continues on the next line; other single words are headers.
            1 if has_rpm_arch(&fields[0]) => carry = fields.pop(),
            n if n >= 3 && has_rpm_arch(&fields[0]) => {
                out.push((fields[0].clone(), fields[1].clone()));
            }
            _ => {}
        }
    }
    out
}

/// `dnf -q updateinfo list` (dnf 4): `FEDORA-2024-0a1b2c Important/Sec. openssl-1:3.1.4-3.fc39.x86_64`,
/// or dnf5's `advisory list` table (`Name Type Severity Package Issued`).
/// Returns `name.arch` → (classification, severity).
pub fn parse_dnf_updateinfo(output: &str) -> HashMap<String, (&'static str, Option<String>)> {
    let mut out: HashMap<String, (&'static str, Option<String>)> = HashMap::new();
    let rank = |c: &str| match c {
        "security" => 3,
        "bugfix" => 2,
        "enhancement" => 1,
        _ => 0,
    };
    let known_severity = |s: &str| matches!(s, "Critical" | "Important" | "Moderate" | "Low");
    for line in output.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        // dnf5 `advisory list` prints a header row: Name Type Severity Package Issued.
        if fields.len() < 3 || (fields[0] == "Name" && fields.contains(&"Type")) {
            continue;
        }
        let kind = fields[1];
        let (classification, mut severity): (&'static str, Option<String>) =
            if let Some(sev) = kind.strip_suffix("/Sec.") {
                ("security", known_severity(sev).then(|| sev.to_string()))
            } else {
                match kind {
                    "bugfix" => ("bugfix", None),
                    "enhancement" => ("enhancement", None),
                    "security" => ("security", None),
                    _ => ("other", None),
                }
            };
        // dnf5: `FEDORA-… security Important openssl-1:3.1.4-3.fc41.x86_64 2026-11-01 10:00:00`
        // (the severity is its own column and the issue date follows the package).
        if classification == "security" && severity.is_none() && known_severity(fields[2]) {
            severity = Some(fields[2].to_string());
        }
        let Some((name, arch)) = fields[2..]
            .iter()
            .filter_map(|f| nevra_name_arch(f))
            .find(|(_, arch)| RPM_ARCHES.contains(&arch.as_str()))
        else {
            continue;
        };
        let key = format!("{name}.{arch}");
        let replace = out
            .get(&key)
            .is_none_or(|(c, _)| rank(classification) > rank(c));
        if replace {
            out.insert(key, (classification, severity));
        }
    }
    out
}

/// Combines `check-update` with `updateinfo` classifications.
pub fn dnf_patches(check_update: &str, updateinfo: &str) -> Vec<AgentPatch> {
    let info = parse_dnf_updateinfo(updateinfo);
    parse_dnf_check_update(check_update)
        .into_iter()
        .map(|(name_arch, version)| {
            let (classification, severity) =
                info.get(&name_arch).cloned().unwrap_or(("other", None));
            let mut patch = package_patch("dnf", &name_arch, &version, classification);
            patch.severity = severity;
            patch
        })
        .collect()
}

// ------------------------------------------------------------------ zypper

/// Rows of a `zypper` table as maps from header to cell.
fn zypper_table(output: &str) -> Vec<HashMap<String, String>> {
    let mut header: Option<Vec<String>> = None;
    let mut rows = Vec::new();
    for line in output.lines() {
        if !line.contains('|') {
            continue;
        }
        let cells: Vec<String> = line.split('|').map(|c| c.trim().to_string()).collect();
        if cells
            .iter()
            .all(|c| c.chars().all(|ch| ch == '-' || ch == '+'))
        {
            continue;
        }
        match &header {
            None => header = Some(cells),
            Some(h) => {
                rows.push(h.iter().cloned().zip(cells).collect::<HashMap<_, _>>());
            }
        }
    }
    rows
}

fn zypper_severity(raw: &str) -> Option<String> {
    match raw.to_ascii_lowercase().as_str() {
        "critical" => Some("Critical".into()),
        "important" => Some("Important".into()),
        "moderate" => Some("Moderate".into()),
        "low" => Some("Low".into()),
        _ => None,
    }
}

/// `zypper -n lu` packages, classified with the needed patches from `zypper -n lp`
/// (a patch "Security update for openssl-3" marks package `openssl-3` as a security update).
pub fn zypper_patches(lu: &str, lp: &str) -> Vec<AgentPatch> {
    let mut mentions: Vec<(String, &'static str, Option<String>)> = Vec::new();
    for row in zypper_table(lp) {
        let status = row.get("Status").map(String::as_str).unwrap_or("needed");
        if status != "needed" {
            continue;
        }
        let category = match row
            .get("Category")
            .map(|c| c.to_ascii_lowercase())
            .as_deref()
        {
            Some("security") => "security",
            Some("recommended") => "bugfix",
            Some("optional") | Some("feature") => "enhancement",
            _ => "other",
        };
        let severity = row.get("Severity").and_then(|s| zypper_severity(s));
        if let Some(summary) = row.get("Summary")
            && let Some((_, names)) = summary.split_once(" for ")
        {
            for name in names
                .split([',', ' '])
                .filter(|n| !n.is_empty() && *n != "and")
            {
                mentions.push((name.to_string(), category, severity.clone()));
            }
        }
    }
    let rank = |c: &str| match c {
        "security" => 3,
        "bugfix" => 2,
        "enhancement" => 1,
        _ => 0,
    };
    zypper_table(lu)
        .into_iter()
        .filter_map(|row| {
            let name = row.get("Name")?.clone();
            let version = row.get("Available Version")?.clone();
            if name.is_empty() || version.is_empty() {
                return None;
            }
            let best = mentions
                .iter()
                .filter(|(m, ..)| *m == name)
                .max_by_key(|(_, c, _)| rank(c));
            let (classification, severity) = best
                .map(|(_, c, s)| (*c, s.clone()))
                .unwrap_or(("other", None));
            let mut patch = package_patch("zypper", &name, &version, classification);
            patch.severity = severity;
            Some(patch)
        })
        .collect()
}

// ------------------------------------------------------------------ pacman and apk

/// `checkupdates`: `linux 6.6.1.arch1-1 -> 6.6.2.arch1-1`.
pub fn parse_checkupdates(output: &str) -> Vec<AgentPatch> {
    output
        .lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            (fields.len() >= 4 && fields[2] == "->")
                .then(|| package_patch("pacman", fields[0], fields[3], "other"))
        })
        .collect()
}

/// `apk version -l '<'`: `busybox-1.36.1-r2   < 1.36.1-r5`.
pub fn parse_apk_version(output: &str) -> Vec<AgentPatch> {
    output
        .lines()
        .filter_map(|line| {
            let (installed, available) = line.split_once('<')?;
            let installed = installed.trim();
            let available = available.split_whitespace().next()?;
            let idx = installed.rmatch_indices('-').nth(1).map(|(i, _)| i)?;
            Some(package_patch("apk", &installed[..idx], available, "other"))
        })
        .collect()
}

// ------------------------------------------------------------------ macOS

fn parse_size(raw: &str) -> Option<u64> {
    let raw = raw.trim();
    let digits: String = raw.chars().take_while(|c| c.is_ascii_digit()).collect();
    let n: u64 = digits.parse().ok()?;
    let unit = raw[digits.len()..].trim().to_ascii_uppercase();
    Some(match unit.as_str() {
        "" | "B" => n,
        "K" | "KB" | "KIB" => n * 1024,
        "M" | "MB" | "MIB" => n * 1024 * 1024,
        _ => n,
    })
}

/// `softwareupdate --list --no-scan`:
/// ```text
/// * Label: macOS Sonoma 14.4.1-23E224
///     Title: macOS Sonoma 14.4.1, Version: 14.4.1, Size: 1234567KiB, Recommended: YES, Action: restart,
/// ```
pub fn parse_softwareupdate(output: &str) -> Vec<AgentPatch> {
    let mut out: Vec<AgentPatch> = Vec::new();
    for line in output.lines() {
        let trimmed = line.trim();
        if let Some(label) = trimmed.strip_prefix("* Label:") {
            let label = label.trim().to_string();
            out.push(AgentPatch {
                key: label.clone(),
                title: label,
                classification: "app".into(),
                ..AgentPatch::default()
            });
            continue;
        }
        let Some(current) = out.last_mut() else {
            continue;
        };
        if !trimmed.starts_with("Title:") {
            continue;
        }
        for part in trimmed.split(',') {
            let Some((k, v)) = part.split_once(':') else {
                continue;
            };
            let v = v.trim();
            match k.trim() {
                "Title" => current.title = v.to_string(),
                "Version" => current.version = Some(v.to_string()),
                "Size" => current.size_bytes = parse_size(v),
                "Action" => current.reboot_required = v.eq_ignore_ascii_case("restart"),
                _ => {}
            }
        }
    }
    for patch in &mut out {
        let text = format!("{} {}", patch.key, patch.title).to_lowercase();
        patch.classification = if text.contains("security")
            || text.contains("xprotect")
            || text.contains("rapid security response")
        {
            "security"
        } else if patch.title.starts_with("macOS") || patch.key.starts_with("macOS") {
            "os"
        } else {
            "app"
        }
        .into();
    }
    out
}

// ------------------------------------------------------------------ winget

/// `winget upgrade` table: columns are located from the header (by character position), rows
/// end at the first blank or summary line.
pub fn parse_winget_upgrade(output: &str) -> Vec<AgentPatch> {
    // Progress spinners are separated by carriage returns; keep what follows the last one.
    let lines: Vec<String> = output
        .lines()
        .map(|l| l.rsplit('\r').next().unwrap_or(l).to_string())
        .collect();
    let Some(header_idx) = lines.iter().position(|l| {
        let t = l.trim_start();
        t.starts_with("Name") && l.contains(" Id ") && l.contains("Version")
    }) else {
        return Vec::new();
    };
    let header: Vec<char> = lines[header_idx].chars().collect();
    let find = |word: &str| -> Option<usize> {
        let w: Vec<char> = word.chars().collect();
        (0..header.len().saturating_sub(w.len() - 1)).find(|&i| {
            header[i..i + w.len()] == w[..]
                && (i == 0 || header[i - 1] == ' ')
                && header.get(i + w.len()).is_none_or(|c| *c == ' ')
        })
    };
    let (Some(id_col), Some(ver_col), Some(avail_col)) =
        (find("Id"), find("Version"), find("Available"))
    else {
        return Vec::new();
    };
    let source_col = find("Source");
    let cell = |chars: &[char], from: usize, to: Option<usize>| -> String {
        let end = to.unwrap_or(chars.len()).min(chars.len());
        if from >= end {
            return String::new();
        }
        chars[from..end]
            .iter()
            .collect::<String>()
            .trim()
            .to_string()
    };
    let mut out = Vec::new();
    for line in lines.iter().skip(header_idx + 1) {
        if line.trim().is_empty() {
            break;
        }
        if line.trim().chars().all(|c| c == '-') {
            continue;
        }
        let chars: Vec<char> = line.chars().collect();
        if chars.len() <= avail_col {
            break;
        }
        let name = cell(&chars, 0, Some(id_col));
        let id = cell(&chars, id_col, Some(ver_col));
        let installed = cell(&chars, ver_col, Some(avail_col));
        let available = cell(&chars, avail_col, source_col);
        if id.is_empty() || available.is_empty() || id.contains(' ') {
            break;
        }
        out.push(AgentPatch {
            key: format!("winget:{id}:{available}"),
            platform: Some("winget".into()),
            title: format!("{name} {available}"),
            classification: "app".into(),
            description: format!("Upgrade {name} from {installed} to {available}"),
            package: Some(id),
            version: Some(available),
            ..AgentPatch::default()
        });
    }
    out
}

// ------------------------------------------------------------------ Windows Update

/// WUA `UpdateClassification` category ids (locale-independent) and their names.
const WUA_CLASSIFICATIONS: &[(&str, &str, &str)] = &[
    (
        "0fa1201d-4330-4fa8-8ae9-b877473b6441",
        "Security Updates",
        "SecurityUpdates",
    ),
    (
        "e6cf1350-c01b-414d-a61f-263d14d133b4",
        "Critical Updates",
        "CriticalUpdates",
    ),
    (
        "28bc880e-0592-4cbf-8f95-c79b17911d5f",
        "Update Rollups",
        "UpdateRollups",
    ),
    ("cd5ffd1e-e932-4e3a-bf74-18bf0b1bbd83", "Updates", "Updates"),
    (
        "e0789628-ce08-4437-be74-2495b842f43b",
        "Definition Updates",
        "Definitions",
    ),
    ("ebfc1fc5-71a4-4f7b-9aca-3b9a503104a0", "Drivers", "Drivers"),
    (
        "b54e7d24-7add-428f-8b75-90a396fa584f",
        "Feature Packs",
        "FeaturePacks",
    ),
    (
        "3689bdc8-b205-4af4-8d4a-a63924c5e9d5",
        "Upgrades",
        "Upgrades",
    ),
    (
        "68c5b0a3-d1a6-4553-ae49-01d3a7827828",
        "Service Packs",
        "ServicePacks",
    ),
    ("b4832bd8-e735-4761-8daf-37f882276dab", "Tools", "Tools"),
];

/// Maps a WUA classification category (by id, falling back to the English name).
pub fn wua_classification(category_id: &str, name: &str) -> Option<&'static str> {
    let id = category_id
        .trim()
        .trim_matches(['{', '}'])
        .to_ascii_lowercase();
    WUA_CLASSIFICATIONS
        .iter()
        .find(|(cid, cname, _)| *cid == id || cname.eq_ignore_ascii_case(name.trim()))
        .map(|(_, _, c)| *c)
}

/// Picks the classification of an update from its categories (`(type, id, name)`); drivers
/// are recognised by update type when they carry no classification category.
pub fn wua_pick_classification(categories: &[(String, String, String)], is_driver: bool) -> String {
    categories
        .iter()
        .filter(|(kind, ..)| kind == "UpdateClassification")
        .find_map(|(_, id, name)| wua_classification(id, name))
        .or(is_driver.then_some("Drivers"))
        .unwrap_or("Updates")
        .to_string()
}

/// `MsrcSeverity` → severity (empty or unknown → none).
pub fn wua_severity(msrc: &str) -> Option<String> {
    match msrc.trim() {
        s @ ("Critical" | "Important" | "Moderate" | "Low") => Some(s.to_string()),
        _ => None,
    }
}

/// OLE automation date (days since 1899-12-30) → RFC 3339.
pub fn ole_date(days: f64) -> Option<String> {
    if !days.is_finite() || days <= 0.0 {
        return None;
    }
    let epoch = chrono::NaiveDate::from_ymd_opt(1899, 12, 30)?.and_hms_opt(0, 0, 0)?;
    let secs = (days * 86_400.0).round() as i64;
    let t = epoch.checked_add_signed(chrono::Duration::seconds(secs))?;
    Some(
        t.and_utc()
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
    )
}

/// First `KBnnnnnnn` in a title.
pub fn kb_from_title(title: &str) -> Option<String> {
    let upper = title.to_ascii_uppercase();
    let idx = upper.find("KB")?;
    let digits: String = upper[idx + 2..]
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    (digits.len() >= 6).then(|| format!("KB{digits}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const APT: &str = "Listing... Done
openssl/jammy-updates,jammy-security 3.0.2-0ubuntu1.15 amd64 [upgradable from: 3.0.2-0ubuntu1.14]
libssl3/jammy-updates,jammy-security 3.0.2-0ubuntu1.15 amd64 [upgradable from: 3.0.2-0ubuntu1.14]
tzdata/jammy-updates 2024a-0ubuntu0.22.04 all [upgradable from: 2023c-0ubuntu0.22.04.2]
curl/kali-rolling 8.11.0-1 amd64 [upgradable from: 8.10.1-2]
";

    #[test]
    fn apt_upgradable() {
        let patches = parse_apt_upgradable(APT);
        assert_eq!(patches.len(), 4);
        assert_eq!(patches[0].key, "apt:openssl:3.0.2-0ubuntu1.15");
        assert_eq!(patches[0].classification, "security");
        assert_eq!(patches[0].package.as_deref(), Some("openssl"));
        assert_eq!(patches[2].classification, "bugfix");
        assert_eq!(patches[3].classification, "other");
        assert!(patches[3].description.contains("8.10.1-2"));
        assert!(parse_apt_upgradable("Listing... Done\n").is_empty());
    }

    const DNF_CHECK: &str = "
Last metadata expiration check: 0:12:01 ago on Tue 14 Nov 2026 10:00:00 AM UTC.

openssl.x86_64                        1:3.1.4-3.fc39                 updates
curl.x86_64                           8.2.1-4.fc39                   updates
a-very-long-package-name-that-wraps.noarch
                                      2.0-1.fc39                     updates
Obsoleting Packages
grub2-tools.x86_64                    1:2.06-100.fc39                updates
";
    const DNF_INFO: &str = "FEDORA-2026-0a1b2c3d4e Important/Sec. openssl-1:3.1.4-3.fc39.x86_64
FEDORA-2026-1111111111 bugfix        curl-8.2.1-4.fc39.x86_64
FEDORA-2026-2222222222 Moderate/Sec. curl-8.2.1-4.fc39.x86_64
FEDORA-2026-3333333333 enhancement   a-very-long-package-name-that-wraps-2.0-1.fc39.noarch
";

    const DNF5_CHECK: &str = "Updating and loading repositories:
Repositories loaded.
Upgrades
openssl.x86_64                        1:3.2.2-9.fc41                 updates
kernel-core.x86_64                    6.11.8-300.fc41                updates
an-extremely-long-package-name-from-dnf5.noarch
                                      3.0-1.fc41                     updates
Obsoleting packages
grub2-tools.x86_64                    1:2.12-10.fc41                 updates
";
    const DNF5_INFO: &str = "Name                     Type        Severity  Package                                   Issued
FEDORA-2026-aaaaaaaaaa   security    Important openssl-1:3.2.2-9.fc41.x86_64             2026-11-01 10:00:00
FEDORA-2026-bbbbbbbbbb   bugfix      None      kernel-core-6.11.8-300.fc41.x86_64        2026-11-02 11:00:00
FEDORA-2026-cccccccccc   security    Critical  kernel-core-6.11.8-300.fc41.x86_64        2026-11-02 11:00:00
FEDORA-2026-dddddddddd   enhancement None      an-extremely-long-package-name-from-dnf5-3.0-1.fc41.noarch 2026-11-03 12:00:00
";

    #[test]
    fn dnf5_check_upgrade_and_advisories() {
        let patches = dnf_patches(DNF5_CHECK, DNF5_INFO);
        assert_eq!(patches.len(), 3, "headers and obsoletes are skipped");
        assert_eq!(patches[0].key, "dnf:openssl.x86_64:1:3.2.2-9.fc41");
        assert_eq!(patches[0].classification, "security");
        assert_eq!(patches[0].severity.as_deref(), Some("Important"));
        assert_eq!(patches[1].package.as_deref(), Some("kernel-core.x86_64"));
        assert_eq!(
            patches[1].classification, "security",
            "security beats bugfix"
        );
        assert_eq!(patches[1].severity.as_deref(), Some("Critical"));
        assert_eq!(
            patches[2].package.as_deref(),
            Some("an-extremely-long-package-name-from-dnf5.noarch")
        );
        assert_eq!(patches[2].classification, "enhancement");
    }

    #[test]
    fn dnf_check_update_with_updateinfo() {
        let patches = dnf_patches(DNF_CHECK, DNF_INFO);
        assert_eq!(patches.len(), 3, "obsoletes are not upgrades");
        assert_eq!(patches[0].key, "dnf:openssl.x86_64:1:3.1.4-3.fc39");
        assert_eq!(patches[0].classification, "security");
        assert_eq!(patches[0].severity.as_deref(), Some("Important"));
        assert_eq!(
            patches[1].classification, "security",
            "security beats bugfix"
        );
        assert_eq!(patches[1].severity.as_deref(), Some("Moderate"));
        assert_eq!(
            patches[2].package.as_deref(),
            Some("a-very-long-package-name-that-wraps.noarch")
        );
        assert_eq!(patches[2].classification, "enhancement");
        assert_eq!(
            nevra_name_arch("openssl-libs-1:3.1.4-3.fc39.x86_64"),
            Some(("openssl-libs".into(), "x86_64".into()))
        );
    }

    const ZYPPER_LU: &str = "Loading repository data...
Reading installed packages...
S | Repository             | Name        | Current Version     | Available Version   | Arch
--+------------------------+-------------+---------------------+---------------------+-------
v | Main Update Repository | openssl-3   | 3.0.8-150500.5.8.1  | 3.0.8-150500.5.11.1 | x86_64
v | Main Update Repository | vim         | 9.0.2103-150500.20  | 9.1.0111-150500.20  | x86_64
";
    const ZYPPER_LP: &str = "Loading repository data...
Repository             | Name                        | Category    | Severity  | Interactive | Status | Summary
-----------------------+-----------------------------+-------------+-----------+-------------+--------+------------------------------
Main Update Repository | openSUSE-SLE-15.5-2026-1234 | security    | important | ---         | needed | Security update for openssl-3
Main Update Repository | openSUSE-SLE-15.5-2026-1300 | recommended | moderate  | ---         | needed | Recommended update for vim
";

    #[test]
    fn zypper_updates_and_patches() {
        let patches = zypper_patches(ZYPPER_LU, ZYPPER_LP);
        assert_eq!(patches.len(), 2);
        assert_eq!(patches[0].key, "zypper:openssl-3:3.0.8-150500.5.11.1");
        assert_eq!(patches[0].classification, "security");
        assert_eq!(patches[0].severity.as_deref(), Some("Important"));
        assert_eq!(patches[1].classification, "bugfix");
    }

    #[test]
    fn pacman_and_apk() {
        let pacman = parse_checkupdates(
            "linux 6.6.1.arch1-1 -> 6.6.2.arch1-1\nopenssl 3.2.0-1 -> 3.2.1-1\n",
        );
        assert_eq!(pacman.len(), 2);
        assert_eq!(pacman[0].key, "pacman:linux:6.6.2.arch1-1");
        let apk = parse_apk_version(
            "Installed:                                Available:\nbusybox-1.36.1-r2                       < 1.36.1-r5\nlibcrypto3-3.1.4-r1                     < 3.1.4-r5\n",
        );
        assert_eq!(apk.len(), 2);
        assert_eq!(apk[0].key, "apk:busybox:1.36.1-r5");
        assert_eq!(apk[1].package.as_deref(), Some("libcrypto3"));
    }

    const SOFTWAREUPDATE: &str = "Software Update Tool

Finding available software
Software Update found the following new or updated software:
* Label: macOS Sonoma 14.4.1-23E224
\tTitle: macOS Sonoma 14.4.1, Version: 14.4.1, Size: 1234567KiB, Recommended: YES, Action: restart,
* Label: Safari17.4.1MontereyAuto-17.4.1
\tTitle: Safari, Version: 17.4.1, Size: 158192K, Recommended: YES,
* Label: XProtectPlistConfigData-5272
\tTitle: XProtectPlistConfigData, Version: 5272, Size: 4096K, Recommended: YES,
";

    #[test]
    fn softwareupdate_list() {
        let patches = parse_softwareupdate(SOFTWAREUPDATE);
        assert_eq!(patches.len(), 3);
        assert_eq!(patches[0].key, "macOS Sonoma 14.4.1-23E224");
        assert_eq!(patches[0].classification, "os");
        assert!(patches[0].reboot_required);
        assert_eq!(patches[0].size_bytes, Some(1_234_567 * 1024));
        assert_eq!(patches[1].classification, "app");
        assert!(!patches[1].reboot_required);
        assert_eq!(patches[2].classification, "security");
    }

    const WINGET: &str = "   - \r   \\ \r\
Name                                   Id                           Version        Available      Source
-----------------------------------------------------------------------------------------------------------
Microsoft Edge                         Microsoft.Edge               130.0.2849.80  131.0.2903.51  winget
7-Zip 23.01 (x64)                      7zip.7zip                    23.01          24.08          winget
2 upgrades available.
";

    #[test]
    fn winget_upgrade_table() {
        let patches = parse_winget_upgrade(WINGET);
        assert_eq!(patches.len(), 2);
        assert_eq!(patches[0].key, "winget:Microsoft.Edge:131.0.2903.51");
        assert_eq!(patches[0].platform.as_deref(), Some("winget"));
        assert_eq!(patches[1].package.as_deref(), Some("7zip.7zip"));
        assert!(patches[1].description.contains("23.01"));
        assert!(
            parse_winget_upgrade("No installed package found matching input criteria.").is_empty()
        );
    }

    #[test]
    fn wua_classification_and_severity() {
        assert_eq!(
            wua_classification(
                "{0FA1201D-4330-4FA8-8AE9-B877473B6441}",
                "Sicherheitsupdates"
            ),
            Some("SecurityUpdates"),
            "matched by id whatever the language"
        );
        assert_eq!(
            wua_classification("", "Critical Updates"),
            Some("CriticalUpdates")
        );
        assert_eq!(wua_classification("x", "Unknown"), None);
        let categories = vec![
            (
                "Product".to_string(),
                "6407468e".to_string(),
                "Windows 11".to_string(),
            ),
            (
                "UpdateClassification".to_string(),
                "e0789628-ce08-4437-be74-2495b842f43b".to_string(),
                "Definition Updates".to_string(),
            ),
        ];
        assert_eq!(wua_pick_classification(&categories, false), "Definitions");
        assert_eq!(wua_pick_classification(&[], true), "Drivers");
        assert_eq!(wua_pick_classification(&[], false), "Updates");
        assert_eq!(wua_severity("Critical"), Some("Critical".into()));
        assert_eq!(wua_severity(""), None);
        assert_eq!(wua_severity("Unspecified"), None);
        assert_eq!(ole_date(45_658.0).as_deref(), Some("2025-01-01T00:00:00Z"));
        assert_eq!(ole_date(0.0), None);
        assert_eq!(
            kb_from_title("2026-11 Cumulative Update for Windows 11 (KB5039212)").as_deref(),
            Some("KB5039212")
        );
        assert_eq!(
            kb_from_title("Windows Malicious Software Removal Tool"),
            None
        );
    }
}
