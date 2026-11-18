//! Operating-system patching: scans (`patch_scan` → `patch_report`), installs of exactly the
//! keys the server approved (`patch_install`) and the reboot negotiation afterwards.
//!
//! * Windows: the Windows Update Agent COM API on a dedicated MTA thread, plus optional winget
//!   upgrades.
//! * Linux: apt, dnf, zypper, pacman and apk by absolute path, non-interactive.
//! * macOS: `softwareupdate` (installs only when the policy allows them).
//!
//! Results travel through the [`crate::outbox`] so they survive reconnects during long installs.

pub mod parsers;
pub mod reboot;

#[cfg(target_os = "linux")]
pub mod linux;
#[cfg(windows)]
mod wua;

use std::ffi::OsString;
use std::path::Path;
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use anyhow::Result;
use rustrmm_proto::commands::CommandResult;
use rustrmm_proto::patching::{
    PatchInstall, PatchInstallOutcome, PatchKeyResult, PatchReport, PatchScan,
};
use serde_json::json;

/// Package operations (patch scans and installs, software actions) run one at a time: package
/// managers and Windows Update hold exclusive locks.
pub static PACKAGE_LOCK: LazyLock<tokio::sync::Mutex<()>> =
    LazyLock::new(|| tokio::sync::Mutex::new(()));

/// Output of [`exec`].
#[derive(Debug, Clone)]
pub struct Exec {
    pub code: Option<i32>,
    pub stdout: String,
    #[cfg_attr(windows, allow(dead_code))]
    pub stderr: String,
}

/// The clean, non-interactive environment package tools run with.
pub fn tool_environment(dir: &Path, program: &Path) -> Vec<(OsString, OsString)> {
    #[cfg_attr(not(unix), allow(unused_mut))]
    let mut env = crate::scripts::base_environment(dir, program);
    #[cfg(unix)]
    {
        env.retain(|(k, _)| k != "LANG");
        for (k, v) in [
            ("LANG", "C.UTF-8"),
            ("LC_ALL", "C"),
            ("DEBIAN_FRONTEND", "noninteractive"),
            ("APT_LISTCHANGES_FRONTEND", "none"),
            ("NEEDRESTART_MODE", "a"),
        ] {
            env.push((k.into(), v.into()));
        }
    }
    env
}

/// Runs a tool by absolute path, contained, with a clean environment and a timeout.
pub fn exec(program: &Path, args: &[&str], timeout: Duration) -> Result<Exec> {
    let dir = std::env::temp_dir();
    let args: Vec<OsString> = args.iter().map(OsString::from).collect();
    let run = crate::scripts::run_program(
        program,
        &args,
        None,
        &dir,
        tool_environment(&dir, program),
        timeout,
        8 * 1024 * 1024,
        crate::scripts::Wait::Program,
    )?;
    if run.timed_out {
        anyhow::bail!("{} timed out", program.display());
    }
    Ok(Exec {
        code: run.exit_code,
        stdout: run.stdout,
        stderr: run.stderr,
    })
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Scans in report-only mode when `refresh` is false (no package list download: the self-test
/// must not need root).
pub fn scan_blocking(options: &PatchScan, refresh: bool) -> PatchReport {
    let mut report = PatchReport {
        scanned_at: now_ms(),
        ..PatchReport::default()
    };
    if let Err(e) = platform_scan(options, refresh, &mut report) {
        report.available.clear();
        report.installed_recent.clear();
        report.error = Some(format!("{e:#}").chars().take(1000).collect());
    }
    report.scanned_at = now_ms();
    report
}

#[cfg(windows)]
fn platform_scan(options: &PatchScan, _refresh: bool, report: &mut PatchReport) -> Result<()> {
    report.source = wua::source().to_string();
    let scan = wua::scan(options.clone())?;
    report.available = scan.available;
    report.installed_recent = scan.history;
    report.last_install_at = scan.last_install;
    if options.third_party_winget {
        match winget_upgrades() {
            Ok(mut upgrades) => report.available.append(&mut upgrades),
            Err(e) => tracing::warn!(error = %format!("{e:#}"), "winget upgrade scan failed"),
        }
    }
    let reasons = crate::collectors::windows::pending_reboot_reasons();
    report.pending_reboot = !reasons.is_empty();
    report.reboot_reasons = reasons.iter().map(|r| r.to_string()).collect();
    Ok(())
}

#[cfg(windows)]
fn winget_upgrades() -> Result<Vec<rustrmm_proto::patching::AgentPatch>> {
    let winget = crate::software::winget_path()
        .ok_or_else(|| anyhow::anyhow!("winget (App Installer) is not installed"))?;
    let out = exec(
        &winget,
        &[
            "upgrade",
            "--accept-source-agreements",
            "--disable-interactivity",
        ],
        Duration::from_secs(300),
    )?;
    Ok(parsers::parse_winget_upgrade(&out.stdout))
}

#[cfg(target_os = "linux")]
fn platform_scan(_options: &PatchScan, refresh: bool, report: &mut PatchReport) -> Result<()> {
    let manager = linux::Manager::detect()
        .ok_or_else(|| anyhow::anyhow!("no supported package manager found"))?;
    report.source = manager.name().to_string();
    report.available = linux::scan(manager, refresh)?;
    report.reboot_reasons = linux::reboot_reasons();
    report.pending_reboot = !report.reboot_reasons.is_empty();
    Ok(())
}

#[cfg(target_os = "macos")]
fn platform_scan(_options: &PatchScan, refresh: bool, report: &mut PatchReport) -> Result<()> {
    let tool = std::path::PathBuf::from("/usr/sbin/softwareupdate");
    report.source = "softwareupdate".into();
    if refresh {
        // Starts a background catalogue refresh; the listing below reads the cached result.
        let _ = exec(&tool, &["--background"], Duration::from_secs(60));
    }
    let out = exec(&tool, &["--list", "--no-scan"], Duration::from_secs(300))?;
    report.available = parsers::parse_softwareupdate(&format!("{}\n{}", out.stdout, out.stderr));
    Ok(())
}

/// Installs the given keys; returns per-key results and whether a restart is needed.
pub fn install_blocking(keys: &[String]) -> (Vec<PatchKeyResult>, bool) {
    platform_install(keys)
}

#[cfg(windows)]
fn platform_install(keys: &[String]) -> (Vec<PatchKeyResult>, bool) {
    let (winget, wua_keys): (Vec<String>, Vec<String>) =
        keys.iter().cloned().partition(|k| k.starts_with("winget:"));
    let mut results = Vec::new();
    let mut reboot = false;
    if !wua_keys.is_empty() {
        match wua::install(wua_keys.clone()) {
            Ok(outcome) => {
                results.extend(outcome.results);
                reboot |= outcome.reboot_required;
            }
            Err(e) => results.extend(wua_keys.iter().map(|k| {
                PatchKeyResult {
                    key: k.clone(),
                    status: "failed".into(),
                    hresult: e
                        .downcast_ref::<windows::core::Error>()
                        .map(|w| i64::from(w.code().0)),
                    error: Some(format!("{e:#}").chars().take(500).collect()),
                }
            })),
        }
    }
    for key in winget {
        let result = match (
            rustrmm_proto::patching::split_package_key(&key),
            crate::software::winget_path(),
        ) {
            (Some((_, id, _)), Some(winget)) => {
                match exec(
                    &winget,
                    &[
                        "upgrade",
                        "--id",
                        id,
                        "--exact",
                        "--silent",
                        "--accept-package-agreements",
                        "--accept-source-agreements",
                        "--disable-interactivity",
                    ],
                    Duration::from_secs(3600),
                ) {
                    Ok(out) => {
                        let code = i64::from(out.code.unwrap_or(-1));
                        let (ok, needs_reboot) = rustrmm_proto::patching::exit_code_outcome(code);
                        reboot |= needs_reboot;
                        PatchKeyResult {
                            key: key.clone(),
                            status: if ok { "installed" } else { "failed" }.into(),
                            hresult: (!ok).then_some(code),
                            error: (!ok).then(|| format!("winget exited with {code}")),
                        }
                    }
                    Err(e) => failed(&key, format!("{e:#}")),
                }
            }
            (_, None) => failed(&key, "winget is not installed".into()),
            (None, _) => failed(&key, "invalid winget key".into()),
        };
        results.push(result);
    }
    (results, reboot)
}

#[cfg(target_os = "linux")]
fn platform_install(keys: &[String]) -> (Vec<PatchKeyResult>, bool) {
    linux::install(keys)
}

#[cfg(target_os = "macos")]
fn platform_install(keys: &[String]) -> (Vec<PatchKeyResult>, bool) {
    let tool = std::path::PathBuf::from("/usr/sbin/softwareupdate");
    let mut reboot = false;
    let results = keys
        .iter()
        .map(|label| {
            if label.starts_with('-') {
                return failed(label, "invalid label".into());
            }
            match exec(&tool, &["-i", label], Duration::from_secs(4 * 3600)) {
                Ok(out) if out.code == Some(0) => {
                    let restart = out.stdout.to_lowercase().contains("restart");
                    reboot |= restart;
                    PatchKeyResult {
                        key: label.clone(),
                        status: if restart {
                            "pending_reboot"
                        } else {
                            "installed"
                        }
                        .into(),
                        hresult: None,
                        error: None,
                    }
                }
                Ok(out) => failed(label, out.stderr.trim().chars().take(500).collect()),
                Err(e) => failed(label, format!("{e:#}")),
            }
        })
        .collect();
    (results, reboot)
}

#[allow(dead_code)] // unused on Linux, where the package installer builds its own failures
fn failed(key: &str, error: String) -> PatchKeyResult {
    PatchKeyResult {
        key: key.to_string(),
        status: "failed".into(),
        hresult: None,
        error: Some(error),
    }
}

fn reply(cmd_id: &str, status: &str, message: String, data: serde_json::Value) -> CommandResult {
    CommandResult {
        cmd_id: cmd_id.to_string(),
        status: status.into(),
        message,
        data,
    }
}

/// Handles a verified `patch_scan`: the report and the command result go through the outbox.
pub fn spawn_scan(cmd_id: String, options: PatchScan) {
    tokio::spawn(async move {
        crate::outbox::result(reply(&cmd_id, "running", String::new(), json!(null)));
        let _lock = PACKAGE_LOCK.lock().await;
        let started = Instant::now();
        let mut report = tokio::task::spawn_blocking(move || scan_blocking(&options, true))
            .await
            .unwrap_or_else(|e| PatchReport {
                scanned_at: now_ms(),
                error: Some(format!("scan task failed: {e}")),
                ..PatchReport::default()
            });
        report.cmd_id = Some(cmd_id.clone());
        let summary = json!({ "available": report.available.len(), "source": report.source,
                              "duration_ms": started.elapsed().as_millis() as u64 });
        let result = match &report.error {
            None => reply(&cmd_id, "succeeded", String::new(), summary),
            Some(e) => reply(&cmd_id, "failed", e.clone(), summary),
        };
        tracing::info!(available = report.available.len(), source = %report.source, error = ?report.error, "patch scan finished");
        crate::outbox::push(&report);
        crate::outbox::result(result);
    });
}

/// Handles a verified `patch_install`: installs, reports the per-key outcome, negotiates the
/// restart, then reports the final result.
pub fn spawn_install(cmd_id: String, install: PatchInstall) {
    tokio::spawn(async move {
        crate::outbox::result(reply(&cmd_id, "running", String::new(), json!(null)));
        let lock = PACKAGE_LOCK.lock().await;
        let keys = install.keys.clone();
        tracing::info!(count = keys.len(), run = ?install.run_id, "installing patches");
        let (results, reboot_required) =
            tokio::task::spawn_blocking(move || install_blocking(&keys))
                .await
                .unwrap_or_else(|e| {
                    (
                        install
                            .keys
                            .iter()
                            .map(|k| PatchKeyResult {
                                key: k.clone(),
                                status: "failed".into(),
                                hresult: None,
                                error: Some(format!("install task failed: {e}")),
                            })
                            .collect(),
                        false,
                    )
                });
        drop(lock);
        let mut outcome = PatchInstallOutcome {
            results,
            reboot_required,
            rebooting: false,
            deferrals_used: 0,
            phase: None,
        };
        let negotiate = reboot_required && install.reboot.mode != "never";
        if negotiate {
            let mut interim = outcome.clone();
            interim.phase = Some("awaiting_reboot".into());
            crate::outbox::result(reply(
                &cmd_id,
                "running",
                String::new(),
                serde_json::to_value(&interim).unwrap_or_default(),
            ));
            let spec = install.reboot.clone();
            let negotiated = tokio::task::spawn_blocking(move || reboot::negotiate(&spec, true))
                .await
                .unwrap_or_default();
            outcome.rebooting = negotiated.rebooting;
            outcome.deferrals_used = negotiated.deferrals_used;
        }
        let failed = outcome
            .results
            .iter()
            .filter(|r| r.status == "failed")
            .count();
        tracing::info!(
            failed,
            reboot_required,
            rebooting = outcome.rebooting,
            "patch install finished"
        );
        crate::outbox::result(reply(
            &cmd_id,
            "succeeded",
            String::new(),
            serde_json::to_value(&outcome).unwrap_or_default(),
        ));
    });
}

/// `rustrmm-agent selftest` check: a report-only scan (Windows: a real WUA search, which can
/// take minutes; Linux: no package list refresh, so no root is needed).
pub async fn selftest() -> Result<String> {
    let started = Instant::now();
    let options = PatchScan::default();
    let report = tokio::time::timeout(
        Duration::from_secs(300),
        tokio::task::spawn_blocking(move || scan_blocking(&options, false)),
    )
    .await
    .map_err(|_| anyhow::anyhow!("the scan did not finish within 5 minutes"))??;
    let elapsed = started.elapsed();
    if let Some(e) = report.error {
        anyhow::bail!("scan failed after {:.1} s: {e}", elapsed.as_secs_f64());
    }
    let security = report
        .available
        .iter()
        .filter(|p| matches!(p.classification.as_str(), "security" | "SecurityUpdates"))
        .count();
    Ok(format!(
        "{} available ({security} security) from {}, {} history entries, pending reboot: {} ({:.1} s)",
        report.available.len(),
        report.source,
        report.installed_recent.len(),
        report.pending_reboot,
        elapsed.as_secs_f64()
    ))
}
