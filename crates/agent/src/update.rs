//! Agent self-update: verify → download → stage → hand over to a detached helper that swaps the
//! binary, restarts the service and rolls back automatically if the new version does not come
//! back healthy. One code path for Windows, Linux and macOS.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use rustrmm_crypto::sign::PublicKey;
use rustrmm_proto::commands::{
    CommandResult, ReleaseManifest, UpdateAgent, current_platform, manifest_signing_bytes,
    version_cmp,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use crate::config::AgentConfig;
use crate::paths::Paths;

const HEALTH_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateState {
    pub cmd_id: String,
    pub version: String,
    /// staged | waiting | healthy | rolled_back | reported
    pub status: String,
    #[serde(default)]
    pub message: String,
}

fn state_file(paths: &Paths) -> PathBuf {
    paths.data_dir.join("update-state.json")
}

fn read_state(paths: &Paths) -> Option<UpdateState> {
    serde_json::from_slice(&std::fs::read(state_file(paths)).ok()?).ok()
}

fn write_state(paths: &Paths, state: &UpdateState) -> Result<()> {
    crate::config::write_private(&state_file(paths), &serde_json::to_vec_pretty(state)?)
}

fn result(cmd_id: &str, status: &str, message: impl Into<String>) -> CommandResult {
    CommandResult {
        cmd_id: cmd_id.to_string(),
        status: status.to_string(),
        message: message.into(),
        data: serde_json::Value::Null,
    }
}

/// Verifies and stages an update, then launches the helper. Returns the result to report now.
pub async fn apply(
    paths: &Paths,
    config: &AgentConfig,
    tls: std::sync::Arc<rustls::ClientConfig>,
    cmd_id: &str,
    update: UpdateAgent,
) -> CommandResult {
    match stage(paths, config, tls, cmd_id, &update).await {
        Ok(Staged::AlreadyCurrent) => result(
            cmd_id,
            "succeeded",
            format!("already running {}", crate::AGENT_VERSION),
        ),
        Ok(Staged::Ready(staged)) => {
            if paths.custom {
                return result(
                    cmd_id,
                    "succeeded",
                    format!(
                        "verified and staged at {} (development mode: not installed)",
                        staged.display()
                    ),
                );
            }
            match launch_helper(paths, &staged, &update.version, cmd_id) {
                Ok(()) => result(cmd_id, "running", format!("installing {}", update.version)),
                Err(e) => result(
                    cmd_id,
                    "failed",
                    format!("could not start the update helper: {e:#}"),
                ),
            }
        }
        Err(e) => result(cmd_id, "failed", format!("{e:#}")),
    }
}

enum Staged {
    AlreadyCurrent,
    Ready(PathBuf),
}

async fn stage(
    paths: &Paths,
    config: &AgentConfig,
    tls: std::sync::Arc<rustls::ClientConfig>,
    cmd_id: &str,
    update: &UpdateAgent,
) -> Result<Staged> {
    let release_key = PublicKey::parse(&config.release_key)?;
    release_key
        .verify(
            &manifest_signing_bytes(&update.manifest),
            &update.manifest_signature,
        )
        .context("release manifest signature is invalid — refusing update")?;
    let manifest: ReleaseManifest =
        serde_json::from_slice(&update.manifest).context("invalid release manifest")?;
    if manifest.version != update.version {
        bail!(
            "manifest version {} does not match command version {}",
            manifest.version,
            update.version
        );
    }
    match version_cmp(&manifest.version, crate::AGENT_VERSION) {
        std::cmp::Ordering::Equal => return Ok(Staged::AlreadyCurrent),
        std::cmp::Ordering::Less if !update.allow_downgrade => bail!(
            "refusing to downgrade from {} to {}",
            crate::AGENT_VERSION,
            manifest.version
        ),
        _ => {}
    }
    let platform = current_platform();
    let file = manifest
        .agent_file(&platform)
        .with_context(|| format!("release has no artifact for {platform}"))?;
    if file.file.contains(['/', '\\']) || file.file.contains("..") {
        bail!("unsafe artifact name");
    }
    let dir = paths.data_dir.join("updates").join(&manifest.version);
    tokio::fs::create_dir_all(&dir).await?;
    let staged = dir.join(&file.file);
    let partial = dir.join(format!("{}.partial", file.file));
    let url = format!(
        "{}/{}/{}",
        update.download_base.trim_end_matches('/'),
        platform,
        file.file
    );
    let client = crate::tls::http_client(tls)?;
    let mut response = client
        .get(&url)
        .send()
        .await?
        .error_for_status()
        .context("download failed")?;
    let mut out = tokio::fs::File::create(&partial).await?;
    let mut hasher = Sha256::new();
    let mut size = 0u64;
    while let Some(chunk) = response.chunk().await? {
        size += chunk.len() as u64;
        if size > file.size_bytes {
            bail!("download is larger than the manifest says");
        }
        hasher.update(&chunk);
        out.write_all(&chunk).await?;
    }
    out.flush().await?;
    drop(out);
    if size != file.size_bytes || hex::encode(hasher.finalize()) != file.sha256 {
        let _ = tokio::fs::remove_file(&partial).await;
        bail!("downloaded file failed its integrity check");
    }
    tokio::fs::rename(&partial, &staged).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755))?;
    }
    write_state(
        paths,
        &UpdateState {
            cmd_id: cmd_id.to_string(),
            version: manifest.version.clone(),
            status: "staged".into(),
            message: String::new(),
        },
    )?;
    tracing::info!(version = %manifest.version, "update verified and staged");
    Ok(Staged::Ready(staged))
}

fn launch_helper(paths: &Paths, staged: &Path, version: &str, cmd_id: &str) -> Result<()> {
    let target = paths.installed_binary();
    let args: Vec<String> = vec![
        "update-helper".into(),
        "--staged".into(),
        staged.display().to_string(),
        "--target".into(),
        target.display().to_string(),
        "--version".into(),
        version.to_string(),
        "--cmd-id".into(),
        cmd_id.to_string(),
    ];
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        let spawn = |flags: u32| {
            std::process::Command::new(staged)
                .args(&args)
                .creation_flags(flags)
                .spawn()
        };
        spawn(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB)
            .or_else(|_| spawn(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP))
            .context("spawning update helper")?;
    }
    #[cfg(target_os = "linux")]
    {
        // systemd stops every process in the unit's cgroup; run the helper in its own transient unit.
        if std::path::Path::new("/run/systemd/system").exists() {
            let unit = format!("rustrmm-agent-update-{}", chrono::Utc::now().timestamp());
            std::process::Command::new("systemd-run")
                .args(["--unit", &unit, "--collect", "--quiet"])
                .arg(staged)
                .args(&args)
                .spawn()
                .context("spawning update helper via systemd-run")?;
        } else {
            spawn_setsid(staged, &args)?;
        }
    }
    #[cfg(target_os = "macos")]
    spawn_setsid(staged, &args)?;
    Ok(())
}

#[cfg(unix)]
#[allow(dead_code)]
fn spawn_setsid(program: &Path, args: &[String]) -> Result<()> {
    use std::os::unix::process::CommandExt;
    let mut cmd = std::process::Command::new(program);
    cmd.args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    // SAFETY: setsid is async-signal-safe and only detaches the child from our session.
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    cmd.spawn().context("spawning update helper")?;
    Ok(())
}

/// Called after every successful handshake: confirms a pending update or reports a rollback.
pub fn after_connect(paths: &Paths) -> Option<CommandResult> {
    let mut state = read_state(paths)?;
    match state.status.as_str() {
        "staged" | "waiting" if state.version == crate::AGENT_VERSION => {
            state.status = "healthy".into();
            let _ = write_state(paths, &state);
            Some(result(
                &state.cmd_id,
                "succeeded",
                format!("updated to {}", state.version),
            ))
        }
        "rolled_back" => {
            let message = format!("update to {} rolled back: {}", state.version, state.message);
            state.status = "reported".into();
            let _ = write_state(paths, &state);
            Some(result(&state.cmd_id, "failed", message))
        }
        _ => None,
    }
}

// ------------------------------------------------------------------ helper process

/// `rustrmm-agent update-helper` — runs detached from the service.
pub fn run_helper(
    paths: &Paths,
    staged: &Path,
    target: &Path,
    version: &str,
    cmd_id: &str,
) -> Result<()> {
    std::thread::sleep(Duration::from_secs(2));
    let backup = target.with_extension(if cfg!(windows) { "exe.old" } else { "old" });
    let _ = std::fs::remove_file(&backup);
    write_state(
        paths,
        &UpdateState {
            cmd_id: cmd_id.into(),
            version: version.into(),
            status: "waiting".into(),
            message: String::new(),
        },
    )?;

    stop_service();
    std::fs::rename(target, &backup)
        .with_context(|| format!("moving {} aside", target.display()))?;
    if let Err(e) = std::fs::copy(staged, target) {
        let _ = std::fs::rename(&backup, target);
        start_service();
        bail!("installing new binary failed: {e}");
    }
    start_service();

    let deadline = std::time::Instant::now() + HEALTH_TIMEOUT;
    while std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_secs(3));
        if read_state(paths).is_some_and(|s| s.status == "healthy" && s.version == version) {
            let _ = std::fs::remove_file(&backup);
            let _ = std::fs::remove_dir_all(staged.parent().unwrap_or(staged));
            tracing::info!(%version, "update confirmed healthy");
            return Ok(());
        }
    }

    tracing::error!(%version, "new version did not report healthy; rolling back");
    stop_service();
    let failed = target.with_extension("failed");
    let _ = std::fs::remove_file(&failed);
    let _ = std::fs::rename(target, &failed);
    std::fs::rename(&backup, target).context("restoring previous binary")?;
    start_service();
    write_state(
        paths,
        &UpdateState {
            cmd_id: cmd_id.into(),
            version: version.into(),
            status: "rolled_back".into(),
            message: "new version did not reconnect within 3 minutes".into(),
        },
    )?;
    Ok(())
}

#[cfg(windows)]
fn stop_service() {
    let _ = crate::util::run(
        "sc.exe",
        &["stop", crate::paths::SERVICE_NAME],
        Duration::from_secs(30),
    );
    for _ in 0..30 {
        let stopped = crate::util::run_any(
            "sc.exe",
            &["query", crate::paths::SERVICE_NAME],
            Duration::from_secs(10),
        )
        .is_some_and(|o| o.contains("STOPPED"));
        if stopped {
            break;
        }
        std::thread::sleep(Duration::from_secs(1));
    }
}

#[cfg(windows)]
fn start_service() {
    let _ = crate::util::run(
        "sc.exe",
        &["start", crate::paths::SERVICE_NAME],
        Duration::from_secs(30),
    );
}

#[cfg(target_os = "linux")]
fn stop_service() {}

#[cfg(target_os = "linux")]
fn start_service() {
    // Replacing a running binary is safe on Unix; a restart picks up the new file.
    if crate::util::run(
        "systemctl",
        &["restart", crate::paths::SYSTEMD_UNIT],
        Duration::from_secs(60),
    )
    .is_none()
    {
        let _ = crate::util::run(
            "rc-service",
            &["rustrmm-agent", "restart"],
            Duration::from_secs(60),
        );
    }
}

#[cfg(target_os = "macos")]
fn stop_service() {}

#[cfg(target_os = "macos")]
fn start_service() {
    let _ = crate::util::run(
        "launchctl",
        &[
            "kickstart",
            "-k",
            &format!("system/{}", crate::paths::LAUNCHD_LABEL),
        ],
        Duration::from_secs(60),
    );
}
