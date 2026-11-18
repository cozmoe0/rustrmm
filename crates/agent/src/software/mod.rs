//! Executor for signed `software_action` commands: detection before, the install or uninstall
//! through winget, Chocolatey, Homebrew, the distribution package manager or an uploaded file,
//! then detection again.
//!
//! Uploaded files are fetched over the agent's pinned TLS client from the server it is
//! connected to (`/agent/v1/files/{sha256}?token=…`, a single-use token from the signed
//! command), verified against the SHA-256 before anything runs, and executed from the
//! protected per-command directory `<data dir>/software/<cmd_id>/`, which is deleted afterwards.

pub mod detect;

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use rustrmm_proto::commands::CommandResult;
use rustrmm_proto::software::{FileDownload, PackageSource, SoftwareAction, SoftwareActionOutcome};
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use crate::paths::Paths;

const OUTPUT_CAP: usize = 64 * 1024;
const MAX_TIMEOUT_SECS: u32 = 4 * 3600;
/// Header naming this device on file downloads (the server checks it against the token).
pub const DEVICE_HEADER: &str = "x-rustrmm-device-id";

/// Picks the newest `Microsoft.DesktopAppInstaller_<version>_<arch>__<publisher>` folder name.
pub fn newest_app_installer(names: &[String]) -> Option<String> {
    names
        .iter()
        .filter(|n| n.starts_with("Microsoft.DesktopAppInstaller_"))
        .filter(|n| !n.contains("_neutral_") || n.contains("__"))
        .max_by(|a, b| {
            let version = |n: &str| n.split('_').nth(1).unwrap_or("0").to_string();
            rustrmm_proto::commands::version_cmp(&version(a), &version(b))
        })
        .cloned()
}

/// `winget.exe` from the newest App Installer package under `C:\Program Files\WindowsApps`
/// (the only way to run winget as SYSTEM; never resolved through `PATH`).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn winget_path() -> Option<PathBuf> {
    let root = std::env::var_os("ProgramFiles")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Program Files"))
        .join("WindowsApps");
    let names: Vec<String> = std::fs::read_dir(&root)
        .ok()?
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| root.join(n).join("winget.exe").is_file())
        .collect();
    newest_app_installer(&names).map(|n| root.join(n).join("winget.exe"))
}

fn reply(cmd_id: &str, status: &str, message: String, data: serde_json::Value) -> CommandResult {
    CommandResult {
        cmd_id: cmd_id.to_string(),
        status: status.into(),
        message,
        data,
    }
}

/// Handles a verified `software_action` in the background; results go through the outbox.
pub fn spawn_action(
    paths: Paths,
    base_url: String,
    tls: Arc<rustls::ClientConfig>,
    device_id: String,
    cmd_id: String,
    action: SoftwareAction,
) {
    tokio::spawn(async move {
        crate::outbox::result(reply(&cmd_id, "running", String::new(), json!(null)));
        let _lock = crate::patching::PACKAGE_LOCK.lock().await;
        let outcome = run(&paths, &base_url, tls, &device_id, &cmd_id, action).await;
        let result = match outcome {
            Ok(outcome) => reply(
                &cmd_id,
                "succeeded",
                String::new(),
                serde_json::to_value(&outcome).unwrap_or_default(),
            ),
            Err(e) => {
                tracing::warn!(cmd = %cmd_id, error = %format!("{e:#}"), "software action failed");
                reply(&cmd_id, "failed", format!("{e:#}"), json!(null))
            }
        };
        crate::outbox::result(result);
    });
}

fn check_platform(source: &PackageSource) -> Result<()> {
    let os = crate::collectors::os_family();
    if !source.platforms().contains(&os) {
        bail!("{} packages cannot be installed on {os}", source.kind());
    }
    Ok(())
}

/// Runs one action; `Ok` whenever it got as far as running (or skipping) something.
pub async fn run(
    paths: &Paths,
    base_url: &str,
    tls: Arc<rustls::ClientConfig>,
    device_id: &str,
    cmd_id: &str,
    action: SoftwareAction,
) -> Result<SoftwareActionOutcome> {
    if !matches!(action.action.as_str(), "install" | "uninstall") {
        bail!("unknown action {}", action.action);
    }
    check_platform(&action.source)?;
    let install = action.action == "install";
    let rule = action.detection.clone();
    let before = tokio::task::spawn_blocking(move || detect::detect(&rule)).await?;
    if before == Some(install) {
        tracing::info!(cmd = %cmd_id, "detection shows the desired state already; skipping");
        return Ok(SoftwareActionOutcome {
            detected_before: before,
            detected_after: before,
            skipped: true,
            ..SoftwareActionOutcome::default()
        });
    }
    let dir = crate::scripts::work_dir_in(paths, "software", cmd_id);
    let prepare = dir.clone();
    tokio::task::spawn_blocking(move || crate::scripts::prepare_dir(&prepare)).await??;
    let result = execute(&dir, base_url, tls, device_id, &action).await;
    let cleanup = dir.clone();
    let _ = tokio::task::spawn_blocking(move || crate::scripts::remove_dir(&cleanup)).await;
    let (exit_code, output, duration_ms) = result?;
    let rule = action.detection.clone();
    let after = tokio::task::spawn_blocking(move || detect::detect(&rule)).await?;
    let (_, reboot_required) = rustrmm_proto::patching::exit_code_outcome(exit_code);
    Ok(SoftwareActionOutcome {
        exit_code: Some(exit_code),
        detected_before: before,
        detected_after: after,
        skipped: false,
        reboot_required,
        output: output.chars().take(4096).collect(),
        duration_ms,
    })
}

async fn execute(
    dir: &Path,
    base_url: &str,
    tls: Arc<rustls::ClientConfig>,
    device_id: &str,
    action: &SoftwareAction,
) -> Result<(i64, String, u64)> {
    let file = match (&action.source, &action.download) {
        (
            PackageSource::File {
                file_name, sha256, ..
            },
            Some(download),
        ) => {
            if !download.sha256.eq_ignore_ascii_case(sha256) {
                bail!("the download does not match the package's SHA-256");
            }
            Some(download_file(dir, base_url, tls, device_id, file_name, download).await?)
        }
        (PackageSource::File { .. }, None) => bail!("the command carries no download"),
        _ => None,
    };
    let (program, args, raw) = command_for(&action.action, &action.source, file.as_deref())?;
    if !program.is_file() {
        bail!("{} is not available on this device", program.display());
    }
    let timeout = Duration::from_secs(u64::from(action.timeout_secs.clamp(60, MAX_TIMEOUT_SECS)));
    let dir = dir.to_path_buf();
    tracing::info!(program = %program.display(), action = %action.action, source = action.source.kind(), "running software action");
    let run = tokio::task::spawn_blocking(move || {
        let env = crate::patching::tool_environment(&dir, &program);
        crate::scripts::run_program(
            &program,
            &args,
            raw.as_deref(),
            &dir,
            env,
            timeout,
            OUTPUT_CAP,
            crate::scripts::Wait::Tree,
        )
    })
    .await??;
    if run.timed_out {
        bail!("the action timed out after {} s", timeout.as_secs());
    }
    let code = i64::from(run.exit_code.unwrap_or(-1));
    let output = format!("{}{}", run.stdout, run.stderr);
    Ok((code, output, run.duration_ms))
}

/// Resolves the download path against the connected server; other origins are refused.
pub fn download_url(base_url: &str, path: &str) -> Result<url::Url> {
    let base = url::Url::parse(base_url).context("invalid server URL")?;
    let url = base.join(path).context("invalid download path")?;
    if url.origin() != base.origin() || !url.path().starts_with("/agent/v1/files/") {
        bail!("refusing to download from {url}");
    }
    Ok(url)
}

async fn download_file(
    dir: &Path,
    base_url: &str,
    tls: Arc<rustls::ClientConfig>,
    device_id: &str,
    file_name: &str,
    download: &FileDownload,
) -> Result<PathBuf> {
    let url = download_url(base_url, &download.url)?;
    let safe: String = file_name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ' | '(' | ')'))
        .take(120)
        .collect();
    let safe = if safe.trim().is_empty() || safe.starts_with('.') {
        format!(
            "installer-{}",
            &download.sha256[..download.sha256.len().min(12)]
        )
    } else {
        safe
    };
    let target = dir.join(safe.trim());
    let client = crate::tls::http_client(tls)?;
    let mut response = client
        .get(url)
        .header(DEVICE_HEADER, device_id)
        .timeout(Duration::from_secs(3600))
        .send()
        .await?
        .error_for_status()
        .context("the server refused the download")?;
    let mut out = tokio::fs::File::create(&target).await?;
    let mut hasher = Sha256::new();
    let mut size = 0u64;
    while let Some(chunk) = response.chunk().await? {
        size += chunk.len() as u64;
        if size > download.size {
            bail!("the download is larger than announced");
        }
        hasher.update(&chunk);
        out.write_all(&chunk).await?;
    }
    out.flush().await?;
    drop(out);
    let actual = hex::encode(hasher.finalize());
    if size != download.size || !actual.eq_ignore_ascii_case(&download.sha256) {
        let _ = tokio::fs::remove_file(&target).await;
        bail!("the downloaded file failed its SHA-256 check");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(target)
}

/// Program, arguments and (Windows) a raw argument string for an action.
fn command_for(
    action: &str,
    source: &PackageSource,
    file: Option<&Path>,
) -> Result<(PathBuf, Vec<OsString>, Option<String>)> {
    let install = action == "install";
    let os = |v: &[&str]| v.iter().map(OsString::from).collect::<Vec<_>>();
    match source {
        PackageSource::Winget { id } => {
            let winget = winget_path().context("winget (App Installer) is not installed")?;
            let verb = if install { "install" } else { "uninstall" };
            let mut args = os(&[verb, "--id", id, "--exact", "--silent"]);
            if install {
                args.extend(os(&["--accept-package-agreements"]));
            }
            args.extend(os(&[
                "--accept-source-agreements",
                "--scope",
                "machine",
                "--disable-interactivity",
            ]));
            Ok((winget, args, None))
        }
        PackageSource::Choco { id } => {
            let choco = PathBuf::from(r"C:\ProgramData\chocolatey\bin\choco.exe");
            if !choco.is_file() {
                bail!("Chocolatey is not installed");
            }
            let verb = if install { "install" } else { "uninstall" };
            Ok((choco, os(&[verb, id, "-y", "--no-progress"]), None))
        }
        PackageSource::Brew { id, cask } => {
            let brew = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]
                .iter()
                .map(PathBuf::from)
                .find(|p| p.is_file())
                .context("Homebrew is not installed")?;
            let user = crate::collectors::console_user()
                .filter(|u| u != "root" && !u.is_empty())
                .context("Homebrew runs as the signed-in user, and nobody is signed in")?;
            let mut args = os(&["-u", &user, "-H"]);
            args.push(brew.into_os_string());
            args.push(if install { "install" } else { "uninstall" }.into());
            if *cask {
                args.push("--cask".into());
            }
            args.push(id.into());
            Ok((crate::util::system_tool("sudo"), args, None))
        }
        PackageSource::Apt { id }
        | PackageSource::Dnf { id }
        | PackageSource::Zypper { id }
        | PackageSource::Pacman { id }
        | PackageSource::Apk { id } => linux_command(source.kind(), action, id),
        PackageSource::File {
            installer,
            install_args,
            uninstall_args,
            ..
        } => {
            let file = file.context("the installer was not downloaded")?;
            let args = if install {
                install_args
            } else {
                uninstall_args
            };
            file_command(installer, install, file, args)
        }
    }
}

#[cfg(target_os = "linux")]
fn linux_command(
    manager: &str,
    action: &str,
    id: &str,
) -> Result<(PathBuf, Vec<OsString>, Option<String>)> {
    use crate::patching::linux::Manager;
    let manager = Manager::from_name(manager).context("unknown package manager")?;
    if Manager::detect() != Some(manager) {
        bail!("{} is not this device's package manager", manager.name());
    }
    // Absolute paths and non-interactive flags, as for patching.
    crate::patching::linux::package_action_args(manager, action, id)
}

#[cfg(not(target_os = "linux"))]
fn linux_command(
    manager: &str,
    _action: &str,
    _id: &str,
) -> Result<(PathBuf, Vec<OsString>, Option<String>)> {
    bail!("{manager} packages need Linux")
}

fn file_command(
    installer: &str,
    install: bool,
    file: &Path,
    args: &str,
) -> Result<(PathBuf, Vec<OsString>, Option<String>)> {
    let args = args.trim();
    let file_os = file.as_os_str().to_owned();
    match installer {
        "msi" => {
            let raw = if args.is_empty() {
                "/qn /norestart"
            } else {
                args
            };
            let flag = if install { "/i" } else { "/x" };
            Ok((
                crate::util::system_tool("msiexec.exe"),
                vec![flag.into(), file_os],
                Some(raw.to_string()),
            ))
        }
        "exe" => Ok((file.to_path_buf(), Vec::new(), Some(args.to_string()))),
        "pkg" if install => Ok((
            PathBuf::from("/usr/sbin/installer"),
            vec!["-pkg".into(), file_os, "-target".into(), "/".into()],
            None,
        )),
        "deb" if install => Ok((
            PathBuf::from("/usr/bin/dpkg"),
            vec!["-i".into(), file_os],
            None,
        )),
        "rpm" if install => Ok((
            PathBuf::from("/usr/bin/rpm"),
            vec!["-U".into(), file_os],
            None,
        )),
        "sh" => {
            let shell = ["/bin/sh", "/usr/bin/sh"]
                .iter()
                .map(PathBuf::from)
                .find(|p| p.is_file())
                .unwrap_or_else(|| PathBuf::from("/bin/sh"));
            Ok((shell, vec![file_os], Some(args.to_string())))
        }
        other => bail!(
            "{other} files cannot be {}",
            if install { "installed" } else { "uninstalled" }
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newest_winget_package_wins() {
        let names = vec![
            "Microsoft.DesktopAppInstaller_1.22.10582.0_x64__8wekyb3d8bbwe".to_string(),
            "Microsoft.DesktopAppInstaller_1.24.25200.0_x64__8wekyb3d8bbwe".to_string(),
            "Microsoft.DesktopAppInstaller_1.9.1792.0_x64__8wekyb3d8bbwe".to_string(),
            "Microsoft.WindowsTerminal_1.21.0_x64__8wekyb3d8bbwe".to_string(),
        ];
        assert_eq!(
            newest_app_installer(&names).as_deref(),
            Some("Microsoft.DesktopAppInstaller_1.24.25200.0_x64__8wekyb3d8bbwe")
        );
        assert_eq!(newest_app_installer(&[]), None);
    }

    #[test]
    fn downloads_stay_on_the_connected_server() {
        let ok =
            download_url("https://rmm.example:8444", "/agent/v1/files/abc?token=t").expect("url");
        assert_eq!(
            ok.as_str(),
            "https://rmm.example:8444/agent/v1/files/abc?token=t"
        );
        assert!(
            download_url(
                "https://rmm.example:8444",
                "https://evil.example/agent/v1/files/abc"
            )
            .is_err()
        );
        assert!(
            download_url(
                "https://rmm.example:8444",
                "//evil.example/agent/v1/files/x"
            )
            .is_err()
        );
        assert!(download_url("https://rmm.example:8444", "/agent/v1/connect").is_err());
    }

    #[test]
    fn installer_command_lines() {
        let file = Path::new("C:/work/7z.msi");
        let (program, args, raw) = file_command("msi", true, file, "").expect("msi");
        assert!(
            program
                .to_string_lossy()
                .to_lowercase()
                .ends_with("msiexec.exe")
        );
        assert_eq!(args[0], "/i");
        assert_eq!(raw.as_deref(), Some("/qn /norestart"));
        let (_, args, raw) = file_command("msi", false, file, "/qn").expect("msi uninstall");
        assert_eq!(args[0], "/x");
        assert_eq!(raw.as_deref(), Some("/qn"));
        let (program, args, raw) =
            file_command("exe", true, Path::new("C:/w/setup.exe"), "/S").expect("exe");
        assert_eq!(program, PathBuf::from("C:/w/setup.exe"));
        assert!(args.is_empty());
        assert_eq!(raw.as_deref(), Some("/S"));
        let (program, args, _) = file_command("deb", true, Path::new("/w/x.deb"), "").expect("deb");
        assert_eq!(program, PathBuf::from("/usr/bin/dpkg"));
        assert_eq!(args[0], "-i");
        assert!(file_command("deb", false, Path::new("/w/x.deb"), "").is_err());
        assert!(file_command("pkg", false, Path::new("/w/x.pkg"), "").is_err());
    }
}
