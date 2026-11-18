//! Linux package managers: apt, dnf, zypper, pacman and apk. Every command runs by absolute
//! path with a clean, non-interactive environment (`DEBIAN_FRONTEND=noninteractive`, `LC_ALL=C`).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Result, bail};
use rustrmm_proto::patching::{AgentPatch, PatchKeyResult, split_package_key, valid_package_name};

use super::parsers;
use super::{Exec, exec};

const SCAN_TIMEOUT: Duration = Duration::from_secs(600);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(4 * 3600);

/// A detected package manager.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Manager {
    Apt,
    Dnf,
    Zypper,
    Pacman,
    Apk,
}

fn first(candidates: &[&str]) -> Option<PathBuf> {
    candidates.iter().map(PathBuf::from).find(|p| p.is_file())
}

impl Manager {
    pub fn detect() -> Option<Self> {
        if first(&["/usr/bin/apt-get"]).is_some() {
            Some(Self::Apt)
        } else if first(&["/usr/bin/dnf", "/usr/bin/dnf5"]).is_some() {
            Some(Self::Dnf)
        } else if first(&["/usr/bin/zypper"]).is_some() {
            Some(Self::Zypper)
        } else if first(&["/usr/bin/pacman"]).is_some() {
            Some(Self::Pacman)
        } else if first(&["/sbin/apk", "/usr/bin/apk", "/usr/sbin/apk"]).is_some() {
            Some(Self::Apk)
        } else {
            None
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Apt => "apt",
            Self::Dnf => "dnf",
            Self::Zypper => "zypper",
            Self::Pacman => "pacman",
            Self::Apk => "apk",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "apt" => Some(Self::Apt),
            "dnf" => Some(Self::Dnf),
            "zypper" => Some(Self::Zypper),
            "pacman" => Some(Self::Pacman),
            "apk" => Some(Self::Apk),
            _ => None,
        }
    }

    fn binary(self) -> Result<PathBuf> {
        let found = match self {
            Self::Apt => first(&["/usr/bin/apt-get"]),
            Self::Dnf => first(&["/usr/bin/dnf", "/usr/bin/dnf5"]),
            Self::Zypper => first(&["/usr/bin/zypper"]),
            Self::Pacman => first(&["/usr/bin/pacman"]),
            Self::Apk => first(&["/sbin/apk", "/usr/bin/apk", "/usr/sbin/apk"]),
        };
        found.ok_or_else(|| anyhow::anyhow!("{} is not installed", self.name()))
    }
}

fn out(e: &Exec) -> String {
    let text = if e.stderr.trim().is_empty() {
        &e.stdout
    } else {
        &e.stderr
    };
    text.trim().chars().take(500).collect()
}

/// Scans for upgradable packages. `refresh` downloads fresh package lists first (needs root);
/// the self-test skips it.
pub fn scan(manager: Manager, refresh: bool) -> Result<Vec<AgentPatch>> {
    match manager {
        Manager::Apt => {
            if refresh {
                let update = exec(&manager.binary()?, &["update", "-q"], SCAN_TIMEOUT)?;
                if update.code != Some(0) {
                    tracing::warn!(output = %out(&update), "apt-get update failed; using cached package lists");
                }
            }
            let apt =
                first(&["/usr/bin/apt"]).ok_or_else(|| anyhow::anyhow!("apt is not installed"))?;
            let list = exec(&apt, &["list", "--upgradable"], SCAN_TIMEOUT)?;
            if list.code != Some(0) {
                bail!("apt list failed: {}", out(&list));
            }
            Ok(parsers::parse_apt_upgradable(&list.stdout))
        }
        Manager::Dnf => {
            let dnf = manager.binary()?;
            let mut args = vec!["-q", "check-update"];
            if !refresh {
                args.insert(0, "-C");
            }
            let check = exec(&dnf, &args, SCAN_TIMEOUT)?;
            // 100 = updates available, 0 = none.
            if !matches!(check.code, Some(0 | 100)) {
                bail!("dnf check-update failed: {}", out(&check));
            }
            let mut info_args = vec!["-q", "updateinfo", "list"];
            if !refresh {
                info_args.insert(0, "-C");
            }
            let info = exec(&dnf, &info_args, SCAN_TIMEOUT)?;
            Ok(parsers::dnf_patches(&check.stdout, &info.stdout))
        }
        Manager::Zypper => {
            let zypper = manager.binary()?;
            let refresh_flag = if refresh { "-n" } else { "--no-refresh" };
            let lu = exec(&zypper, &["-n", refresh_flag, "lu"], SCAN_TIMEOUT)?;
            if lu.code != Some(0) {
                bail!("zypper lu failed: {}", out(&lu));
            }
            let lp = exec(&zypper, &["-n", "--no-refresh", "lp"], SCAN_TIMEOUT)?;
            Ok(parsers::zypper_patches(&lu.stdout, &lp.stdout))
        }
        Manager::Pacman => {
            let Some(checkupdates) = first(&["/usr/bin/checkupdates"]) else {
                bail!("checkupdates is not installed (package pacman-contrib)");
            };
            let check = exec(&checkupdates, &[], SCAN_TIMEOUT)?;
            // 2 = no updates.
            if !matches!(check.code, Some(0 | 2)) {
                bail!("checkupdates failed: {}", out(&check));
            }
            Ok(parsers::parse_checkupdates(&check.stdout))
        }
        Manager::Apk => {
            let apk = manager.binary()?;
            if refresh {
                let update = exec(&apk, &["update"], SCAN_TIMEOUT)?;
                if update.code != Some(0) {
                    tracing::warn!(output = %out(&update), "apk update failed; using the cached index");
                }
            }
            let version = exec(&apk, &["version", "-l", "<"], SCAN_TIMEOUT)?;
            if version.code != Some(0) {
                bail!("apk version failed: {}", out(&version));
            }
            Ok(parsers::parse_apk_version(&version.stdout))
        }
    }
}

/// Why a restart is pending.
pub fn reboot_reasons() -> Vec<String> {
    let mut reasons = Vec::new();
    if Path::new("/var/run/reboot-required").exists() || Path::new("/run/reboot-required").exists()
    {
        reasons.push("packages".to_string());
    }
    if let Some(tool) = first(&["/usr/bin/needs-restarting"])
        && exec(&tool, &["-r"], Duration::from_secs(60)).is_ok_and(|e| e.code == Some(1))
    {
        reasons.push("needs_restarting".to_string());
    }
    reasons
}

/// Installed version of a package (dpkg or rpm), for verifying an upgrade.
fn installed_version(manager: Manager, package: &str) -> Option<String> {
    let (tool, args): (&str, Vec<String>) = match manager {
        Manager::Apt => (
            "/usr/bin/dpkg-query",
            vec![
                "-W".into(),
                "-f".into(),
                "${Version}".into(),
                package.into(),
            ],
        ),
        Manager::Dnf | Manager::Zypper => {
            let name = package.rsplit_once('.').map_or(package, |(n, _)| n);
            (
                "/usr/bin/rpm",
                vec![
                    "-q".into(),
                    "--qf".into(),
                    "%|EPOCH?{%{EPOCH}:}:{}|%{VERSION}-%{RELEASE}\n".into(),
                    name.into(),
                ],
            )
        }
        _ => return None,
    };
    let path = Path::new(tool);
    if !path.is_file() {
        return None;
    }
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    exec(path, &refs, Duration::from_secs(60))
        .ok()
        .filter(|e| e.code == Some(0))
        .and_then(|e| e.stdout.lines().next().map(|l| l.trim().to_string()))
}

/// Installs the packages behind `keys` (`<manager>:<package>:<version>`).
pub fn install(keys: &[String]) -> (Vec<PatchKeyResult>, bool) {
    let mut results = Vec::new();
    // (manager, [(key, package, version)])
    type Batch = (Manager, Vec<(String, String, String)>);
    let mut by_manager: Vec<Batch> = Vec::new();
    for key in keys {
        let parsed = split_package_key(key).and_then(|(m, p, v)| {
            Manager::from_name(m)
                .filter(|_| valid_package_name(p))
                .map(|m| (m, p.to_string(), v.to_string()))
        });
        match parsed {
            Some((manager, package, version)) => {
                match by_manager.iter_mut().find(|(m, _)| *m == manager) {
                    Some((_, list)) => list.push((key.clone(), package, version)),
                    None => by_manager.push((manager, vec![(key.clone(), package, version)])),
                }
            }
            None => results.push(PatchKeyResult {
                key: key.clone(),
                status: "failed".into(),
                hresult: None,
                error: Some("not a package-manager patch key".into()),
            }),
        }
    }
    let mut reboot = false;
    for (manager, items) in by_manager {
        let packages: Vec<&str> = items.iter().map(|(_, p, _)| p.as_str()).collect();
        let outcome = run_install(manager, &packages);
        let (code, message) = match &outcome {
            Ok(e) => (e.code, out(e)),
            Err(e) => (None, format!("{e:#}")),
        };
        // zypper: 102 = installed, reboot needed; 103 = zypper itself was updated.
        let ok = match manager {
            Manager::Zypper => matches!(code, Some(0 | 102 | 103)),
            _ => code == Some(0),
        };
        if manager == Manager::Zypper && code == Some(102) {
            reboot = true;
        }
        let distinct: HashSet<&str> = packages.iter().copied().collect();
        for (key, package, version) in &items {
            // When the batch failed, packages that did reach the target version still count.
            let verified = installed_version(manager, package).map(|v| {
                rustrmm_proto::commands::version_cmp(&v, version) != std::cmp::Ordering::Less
                    && !v.is_empty()
            });
            let installed = match verified {
                Some(v) => v || ok,
                None => ok,
            };
            results.push(PatchKeyResult {
                key: key.clone(),
                status: if installed { "installed" } else { "failed" }.into(),
                hresult: None,
                error: (!installed).then(|| {
                    if distinct.len() > 1 {
                        format!("{} failed: {message}", manager.name())
                    } else {
                        message.clone()
                    }
                }),
            });
        }
    }
    if !reboot_reasons().is_empty() {
        reboot = true;
    }
    (results, reboot)
}

fn run_install(manager: Manager, packages: &[&str]) -> Result<Exec> {
    let binary = manager.binary()?;
    let mut args: Vec<&str> = match manager {
        Manager::Apt => vec![
            "install",
            "--only-upgrade",
            "-y",
            "-o",
            "Dpkg::Options::=--force-confdef",
            "-o",
            "Dpkg::Options::=--force-confold",
        ],
        Manager::Dnf => vec!["-y", "upgrade"],
        Manager::Zypper => vec!["-n", "up"],
        Manager::Pacman => vec!["-S", "--noconfirm"],
        Manager::Apk => vec!["upgrade"],
    };
    // Package names are validated (no leading `-`), so no `--` separator is needed.
    args.extend_from_slice(packages);
    tracing::info!(
        manager = manager.name(),
        count = packages.len(),
        "installing package updates"
    );
    exec(&binary, &args, INSTALL_TIMEOUT)
}

/// Program and arguments to install or remove one package for a software deployment.
pub fn package_action_args(
    manager: Manager,
    action: &str,
    package: &str,
) -> Result<(PathBuf, Vec<std::ffi::OsString>, Option<String>)> {
    if !valid_package_name(package) {
        bail!("invalid package name");
    }
    let binary = manager.binary()?;
    let install = action == "install";
    let mut args: Vec<&str> = match (manager, install) {
        (Manager::Apt, true) => vec![
            "install",
            "-y",
            "-o",
            "Dpkg::Options::=--force-confdef",
            "-o",
            "Dpkg::Options::=--force-confold",
        ],
        (Manager::Apt, false) => vec!["remove", "-y"],
        (Manager::Dnf, true) => vec!["-y", "install"],
        (Manager::Dnf, false) => vec!["-y", "remove"],
        (Manager::Zypper, true) => vec!["-n", "install"],
        (Manager::Zypper, false) => vec!["-n", "remove"],
        (Manager::Pacman, true) => vec!["-S", "--noconfirm"],
        (Manager::Pacman, false) => vec!["-R", "--noconfirm"],
        (Manager::Apk, true) => vec!["add"],
        (Manager::Apk, false) => vec!["del"],
    };
    args.push(package);
    Ok((
        binary,
        args.iter().map(std::ffi::OsString::from).collect(),
        None,
    ))
}
