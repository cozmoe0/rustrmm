//! Agent releases: import + signing, versioned artifact hosting, staged rollouts and automatic
//! updates.
//!
//! A release is the build's `manifest.json` plus its artifacts. On import the server verifies
//! every file hash, copies the files to `<data>/agents/releases/<version>/`, and signs the exact
//! manifest bytes with its *release* key; agents refuse any update whose manifest signature does
//! not verify against the key they pinned at enrollment.
//!
//! Every image build stamps its version (`0.1.0+20261118220341`, see `crates/common/build.rs`), so
//! redeploying a rebuilt server imports a new, newer release at start-up. Devices whose effective
//! policy allows it (`agent_updates.auto_update`, on by default) are then added to the release's
//! *automatic* rollout — when they connect and by a sweeper every two minutes — and updated a few
//! at a time. People can still update any device at once ("Update now", manual rollouts).

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use axum::body::Body;
use axum::extract::{Path as UrlPath, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use chrono::{DateTime, Utc};
use rustrmm_proto::commands::{
    Command, CommandResult, ReleaseManifest, UpdateAgent, manifest_signing_bytes, version_cmp,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio_util::io::ReaderStream;

use crate::automation::policies::{self, PolicyContext};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

const MAX_ATTEMPTS: i64 = 3;
/// Releases whose artifacts are kept; older ones are pruned (their rows and history stay).
const KEEP_RELEASES: usize = 3;
/// Automatic updates allowed in flight at once; the rest wait for the sweeper.
const MAX_AUTO_IN_FLIGHT: i64 = 25;
/// An update sent this long ago without an answer no longer counts as in flight.
const IN_FLIGHT_WINDOW: chrono::Duration = chrono::Duration::minutes(15);
const SWEEP_EVERY: Duration = Duration::from_secs(120);

pub fn releases_root(state: &AppState) -> PathBuf {
    state.args.data_dir.join("agents").join("releases")
}

fn safe(s: &str) -> bool {
    !s.is_empty()
        && s.len() < 80
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_.+".contains(c))
        && !s.contains("..")
}

/// Imports the release found in the distribution directory if it is new. Returns its version.
pub async fn import_dist(state: &AppState) -> Result<Option<String>> {
    let dist = super::installers::dist_dir(state);
    let manifest_path = dist.join("manifest.json");
    let Ok(text) = tokio::fs::read_to_string(&manifest_path).await else {
        return Ok(None);
    };
    let manifest: ReleaseManifest =
        serde_json::from_str(&text).context("invalid agent manifest.json")?;
    if !safe(&manifest.version) {
        bail!("invalid release version");
    }
    let exists: Option<String> =
        sqlx::query_scalar("SELECT id FROM agent_releases WHERE version = ?")
            .bind(&manifest.version)
            .fetch_optional(&state.db)
            .await?;
    if exists.is_some() {
        return Ok(None);
    }
    let target = releases_root(state).join(&manifest.version);
    for file in &manifest.files {
        if !safe(&file.platform) || !safe(&file.file) {
            bail!("unsafe artifact path in manifest");
        }
        let source = dist.join(&file.platform).join(&file.file);
        let bytes = tokio::fs::read(&source)
            .await
            .with_context(|| format!("reading {}", source.display()))?;
        if bytes.len() as u64 != file.size_bytes
            || hex::encode(Sha256::digest(&bytes)) != file.sha256
        {
            bail!("{} does not match its manifest entry", source.display());
        }
        let dest = target.join(&file.platform).join(&file.file);
        tokio::fs::create_dir_all(dest.parent().context("artifact path")?).await?;
        tokio::fs::write(&dest, &bytes).await?;
    }
    let canonical = serde_json::to_vec(&ReleaseManifest {
        created_at: Some(rustrmm_common::now().to_rfc3339()),
        ..manifest.clone()
    })?;
    let signature = state.keys.release.sign(&manifest_signing_bytes(&canonical));
    sqlx::query("INSERT INTO agent_releases (id, version, manifest, signature, imported_at) VALUES (?, ?, ?, ?, ?)")
        .bind(rustrmm_common::new_id())
        .bind(&manifest.version)
        .bind(&canonical)
        .bind(&signature)
        .bind(rustrmm_common::now())
        .execute(&state.db)
        .await?;
    tracing::info!(version = %manifest.version, files = manifest.files.len(), "imported agent release");
    if let Err(e) = after_import(state).await {
        tracing::warn!(error = %format!("{e:#}"), "agent release housekeeping failed");
    }
    Ok(Some(manifest.version))
}

/// `GET /agent/v1/releases/{version}/{platform}/{file}` — versioned artifacts for updates.
pub async fn download(
    State(state): State<AppState>,
    UrlPath((version, platform, file)): UrlPath<(String, String, String)>,
) -> ApiResult<Response> {
    if !safe(&version) || !safe(&platform) || !safe(&file) {
        return Err(ApiError::not_found("Release artifact"));
    }
    let path = releases_root(&state)
        .join(&version)
        .join(&platform)
        .join(&file);
    let handle = tokio::fs::File::open(&path)
        .await
        .map_err(|_| ApiError::not_found("Release artifact"))?;
    let size = handle.metadata().await.map(|m| m.len()).unwrap_or(0);
    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_string()),
            (header::CONTENT_LENGTH, size.to_string()),
        ],
        Body::from_stream(ReaderStream::new(handle)),
    )
        .into_response())
}

/// Artifact platform for a device (`windows-x86_64`, `linux-aarch64`, `macos-universal`).
pub fn device_platform(os_family: &str, arch: &str) -> String {
    match os_family {
        "macos" => "macos-universal".into(),
        family => format!("{family}-{}", if arch.is_empty() { "x86_64" } else { arch }),
    }
}

/// An imported release whose artifacts are still on disk.
#[derive(Debug, Clone)]
pub struct Release {
    pub id: String,
    pub version: String,
    pub manifest: ReleaseManifest,
    pub imported_at: DateTime<Utc>,
}

impl Release {
    /// Whether the release has an agent build for this device's platform.
    pub fn supports(&self, os_family: &str, arch: &str) -> bool {
        self.manifest
            .agent_file(&device_platform(os_family, arch))
            .is_some()
    }
}

/// The newest release (by version) that can still be rolled out.
pub async fn latest_release(state: &AppState) -> Result<Option<Release>> {
    let rows: Vec<(String, String, Vec<u8>, DateTime<Utc>)> = sqlx::query_as(
        "SELECT id, version, manifest, imported_at FROM agent_releases WHERE pruned_at IS NULL",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|(id, version, manifest, imported_at)| {
            let manifest = serde_json::from_slice(&manifest).ok()?;
            Some(Release {
                id,
                version,
                manifest,
                imported_at,
            })
        })
        .max_by(|a, b| version_cmp(&a.version, &b.version)))
}

/// After a new release: retire older automatic rollouts (the new one replaces them) and prune old
/// artifacts.
pub async fn after_import(state: &AppState) -> Result<()> {
    if let Some(latest) = latest_release(state).await? {
        let now = rustrmm_common::now();
        sqlx::query(
            "UPDATE rollout_targets SET status = 'skipped', last_error = 'superseded by a newer release', updated_at = ?
             WHERE status IN ('pending', 'sent')
               AND rollout_id IN (SELECT id FROM rollouts WHERE kind = 'auto' AND release_id <> ?)",
        )
        .bind(now)
        .bind(&latest.id)
        .execute(&state.db)
        .await?;
        sqlx::query(
            "UPDATE rollouts SET status = 'completed', updated_at = ?
             WHERE kind = 'auto' AND release_id <> ? AND status IN ('active', 'paused')",
        )
        .bind(now)
        .bind(&latest.id)
        .execute(&state.db)
        .await?;
    }
    let pruned = prune(state).await?;
    if pruned > 0 {
        tracing::info!(pruned, "pruned old agent release artifacts");
    }
    Ok(())
}

/// Deletes the artifacts of all but the newest [`KEEP_RELEASES`] releases, except releases a
/// device is still waiting for. Returns how many were pruned.
pub async fn prune(state: &AppState) -> Result<usize> {
    let mut rows: Vec<(String, String)> =
        sqlx::query_as("SELECT id, version FROM agent_releases WHERE pruned_at IS NULL")
            .fetch_all(&state.db)
            .await?;
    rows.sort_by(|a, b| version_cmp(&b.1, &a.1));
    let mut pruned = 0;
    for (id, version) in rows.into_iter().skip(KEEP_RELEASES) {
        let open: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM rollout_targets t JOIN rollouts r ON r.id = t.rollout_id
             WHERE r.release_id = ? AND r.status IN ('active', 'paused') AND t.status IN ('pending', 'sent')",
        )
        .bind(&id)
        .fetch_one(&state.db)
        .await?;
        if open > 0 || !safe(&version) {
            continue;
        }
        let dir = releases_root(state).join(&version);
        if let Err(e) = tokio::fs::remove_dir_all(&dir).await
            && e.kind() != std::io::ErrorKind::NotFound
        {
            tracing::warn!(%version, error = %e, "could not delete old release artifacts");
            continue;
        }
        sqlx::query("UPDATE agent_releases SET pruned_at = ? WHERE id = ?")
            .bind(rustrmm_common::now())
            .bind(&id)
            .execute(&state.db)
            .await?;
        pruned += 1;
    }
    Ok(pruned)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RolloutScope {
    All,
    Client { id: String },
    Site { id: String },
    Devices { ids: Vec<String> },
}

/// A rollout that was just created.
#[derive(Debug, Clone)]
pub struct CreatedRollout {
    pub id: String,
    pub version: String,
    /// Devices in scope that were outdated and have a build for their platform.
    pub targeted: usize,
}

/// Creates a rollout and targets every eligible device; online ones are updated immediately.
pub async fn create_rollout(
    state: &AppState,
    release_id: &str,
    scope: &RolloutScope,
    percent: i64,
    created_by: &str,
) -> Result<CreatedRollout> {
    let (version, manifest_bytes, pruned_at): (String, Vec<u8>, Option<String>) =
        sqlx::query_as("SELECT version, manifest, pruned_at FROM agent_releases WHERE id = ?")
            .bind(release_id)
            .fetch_one(&state.db)
            .await?;
    if pruned_at.is_some() {
        bail!(
            "the files of release {version} were removed to save space; roll out a newer release"
        );
    }
    let manifest: ReleaseManifest = serde_json::from_slice(&manifest_bytes)?;
    let rows: Vec<(String, String, String, String, String, String)> = sqlx::query_as(
        "SELECT d.id, d.os_family, d.arch, d.agent_version, d.site_id, s.client_id FROM devices d JOIN sites s ON s.id = d.site_id
         WHERE d.status = 'active'",
    )
    .fetch_all(&state.db)
    .await?;
    let percent = percent.clamp(1, 100);
    let id = rustrmm_common::new_id();
    let now = rustrmm_common::now();
    let mut tx = state.db.begin().await?;
    sqlx::query("INSERT INTO rollouts (id, release_id, scope, percent, status, created_by, created_at, updated_at, kind) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, 'manual')")
        .bind(&id)
        .bind(release_id)
        .bind(serde_json::to_string(scope)?)
        .bind(percent)
        .bind(created_by)
        .bind(now)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    let mut targeted = 0;
    for (device_id, os, arch, current, site_id, client_id) in rows {
        let in_scope = match scope {
            RolloutScope::All => true,
            RolloutScope::Client { id } => &client_id == id,
            RolloutScope::Site { id } => &site_id == id,
            RolloutScope::Devices { ids } => ids.contains(&device_id),
        };
        // Deterministic ring membership: the same devices land in the first N %.
        let bucket = u64::from_str_radix(
            &rustrmm_crypto::random::sha256_hex(device_id.as_bytes())[..8],
            16,
        )
        .unwrap_or(0)
            % 100;
        let has_artifact = manifest.agent_file(&device_platform(&os, &arch)).is_some();
        let outdated = version_cmp(&current, &version) == std::cmp::Ordering::Less;
        if in_scope && (bucket as i64) < percent && has_artifact && outdated {
            sqlx::query("INSERT OR IGNORE INTO rollout_targets (rollout_id, device_id, status, updated_at) VALUES (?, ?, 'pending', ?)")
                .bind(&id)
                .bind(&device_id)
                .bind(now)
                .execute(&mut *tx)
                .await?;
            targeted += 1;
        }
    }
    if targeted == 0 {
        sqlx::query("UPDATE rollouts SET status = 'completed' WHERE id = ?")
            .bind(&id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    tracing::info!(rollout = %id, version = %version, targeted, "rollout created");
    let online: Vec<String> =
        sqlx::query_scalar("SELECT device_id FROM rollout_targets WHERE rollout_id = ?")
            .bind(&id)
            .fetch_all(&state.db)
            .await?;
    for device_id in online.into_iter().filter(|d| state.agents.is_online(d)) {
        if let Err(e) = dispatch_for_device(state, &device_id).await {
            tracing::warn!(device = %device_id, error = %format!("{e:#}"), "could not dispatch update");
        }
    }
    state
        .events
        .publish("agent_updates.changed", None, json!({}));
    Ok(CreatedRollout {
        id,
        version,
        targeted,
    })
}

/// Automatic updates sent recently and not yet finished.
async fn auto_in_flight(state: &AppState) -> Result<i64> {
    Ok(sqlx::query_scalar(
        "SELECT COUNT(*) FROM rollout_targets t JOIN rollouts r ON r.id = t.rollout_id
         WHERE r.kind = 'auto' AND t.status = 'sent' AND t.updated_at > ?",
    )
    .bind(rustrmm_common::now() - IN_FLIGHT_WINDOW)
    .fetch_one(&state.db)
    .await?)
}

/// Sends the pending update (if any) to a connected device. Updates for the newest release go
/// first, and a person's rollout before the automatic one. Automatic updates wait while
/// [`MAX_AUTO_IN_FLIGHT`] others are installing.
pub async fn dispatch_for_device(state: &AppState, device_id: &str) -> Result<()> {
    let target: Option<(String, String, Vec<u8>, Vec<u8>, String)> = sqlx::query_as(
        "SELECT t.rollout_id, a.version, a.manifest, a.signature, r.kind
         FROM rollout_targets t JOIN rollouts r ON r.id = t.rollout_id JOIN agent_releases a ON a.id = r.release_id
         WHERE t.device_id = ? AND r.status = 'active' AND t.status IN ('pending', 'sent') AND t.attempts < ?
           AND a.pruned_at IS NULL
         ORDER BY a.imported_at DESC, (r.kind = 'manual') DESC, r.created_at DESC LIMIT 1",
    )
    .bind(device_id)
    .bind(MAX_ATTEMPTS)
    .fetch_optional(&state.db)
    .await?;
    let Some((rollout_id, version, manifest, signature, kind)) = target else {
        return Ok(());
    };
    if kind == "auto" && auto_in_flight(state).await? >= MAX_AUTO_IN_FLIGHT {
        return Ok(());
    }
    let mut base = state
        .args
        .effective_agent_url()
        .as_str()
        .trim_end_matches('/')
        .to_string();
    base.push_str(&format!("/agent/v1/releases/{version}"));
    let command = Command::UpdateAgent(UpdateAgent {
        version: version.clone(),
        manifest,
        manifest_signature: signature,
        download_base: base,
        allow_downgrade: false,
    });
    let cmd_id = super::commands::send(
        state,
        device_id,
        command,
        None,
        600,
        &format!("Update agent to {version}"),
    )
    .await?;
    sqlx::query("UPDATE rollout_targets SET status = 'sent', attempts = attempts + 1, command_id = ?, updated_at = ? WHERE rollout_id = ? AND device_id = ?")
        .bind(&cmd_id)
        .bind(rustrmm_common::now())
        .bind(&rollout_id)
        .bind(device_id)
        .execute(&state.db)
        .await?;
    state.events.publish(
        "agent_updates.changed",
        None,
        json!({ "device_id": device_id }),
    );
    Ok(())
}

/// The release's automatic rollout, created on first use and reopened when it had completed.
/// `None` when someone cancelled it: automatic updates to that release stay off.
async fn auto_rollout(state: &AppState, release_id: &str) -> Result<Option<String>> {
    let existing: Option<(String, String)> = sqlx::query_as(
        "SELECT id, status FROM rollouts WHERE release_id = ? AND kind = 'auto' ORDER BY created_at DESC LIMIT 1",
    )
    .bind(release_id)
    .fetch_optional(&state.db)
    .await?;
    let now = rustrmm_common::now();
    match existing {
        Some((_, status)) if status == "cancelled" => Ok(None),
        Some((id, status)) => {
            if status == "completed" {
                sqlx::query("UPDATE rollouts SET status = 'active', updated_at = ? WHERE id = ?")
                    .bind(now)
                    .bind(&id)
                    .execute(&state.db)
                    .await?;
            }
            Ok(Some(id))
        }
        None => {
            let id = rustrmm_common::new_id();
            sqlx::query("INSERT INTO rollouts (id, release_id, scope, percent, status, created_by, created_at, updated_at, kind) VALUES (?, ?, ?, 100, 'active', NULL, ?, ?, 'auto')")
                .bind(&id)
                .bind(release_id)
                .bind(serde_json::to_string(&RolloutScope::All)?)
                .bind(now)
                .bind(now)
                .execute(&state.db)
                .await?;
            Ok(Some(id))
        }
    }
}

/// One active device, as automatic updates see it.
#[derive(Debug, Clone, sqlx::FromRow)]
struct DeviceVersion {
    id: String,
    os_family: String,
    arch: String,
    agent_version: String,
}

/// Queues the latest release for a device when its policy allows automatic updates, it runs an
/// older agent and it has not been offered that release before (a failed automatic update is not
/// retried by itself; "Update now" retries). Returns whether the device was queued.
async fn enroll_auto(
    state: &AppState,
    latest: &Release,
    device: &DeviceVersion,
    auto_update: bool,
) -> Result<bool> {
    if !auto_update
        || !latest.supports(&device.os_family, &device.arch)
        || version_cmp(&device.agent_version, &latest.version) != std::cmp::Ordering::Less
    {
        return Ok(false);
    }
    let offered: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM rollout_targets t JOIN rollouts r ON r.id = t.rollout_id
         WHERE t.device_id = ? AND r.release_id = ?",
    )
    .bind(&device.id)
    .bind(&latest.id)
    .fetch_one(&state.db)
    .await?;
    if offered > 0 {
        return Ok(false);
    }
    let Some(rollout_id) = auto_rollout(state, &latest.id).await? else {
        return Ok(false);
    };
    sqlx::query("INSERT OR IGNORE INTO rollout_targets (rollout_id, device_id, status, updated_at) VALUES (?, ?, 'pending', ?)")
        .bind(&rollout_id)
        .bind(&device.id)
        .bind(rustrmm_common::now())
        .execute(&state.db)
        .await?;
    tracing::info!(device = %device.id, from = %device.agent_version, to = %latest.version, "queued automatic agent update");
    Ok(true)
}

/// Effective `agent_updates.auto_update` of a device, with the name of the policy that set it.
pub fn auto_update_of(effective: &policies::Effective) -> (bool, Option<String>) {
    let (on, origin) = policies::auto_update(&effective.document, &effective.origins);
    let name = origin.map(|id| {
        effective
            .sources
            .iter()
            .find(|s| s.policy_id == id)
            .map(|s| s.policy_name.clone())
            .unwrap_or(id)
    });
    (on, name)
}

/// Effective `agent_updates.auto_update` of every active device.
pub fn auto_update_map(ctx: &PolicyContext) -> HashMap<String, (bool, Option<String>)> {
    ctx.index
        .facts
        .iter()
        .map(|facts| (facts.id.clone(), auto_update_of(&ctx.effective(facts))))
        .collect()
}

/// Called when a device connects: completes targets it already satisfies, queues an automatic
/// update when its policy allows one, then dispatches.
pub async fn on_connect(state: &AppState, device_id: &str, agent_version: &str) -> Result<()> {
    let sent: Vec<(String, String)> = sqlx::query_as(
        "SELECT t.rollout_id, a.version FROM rollout_targets t JOIN rollouts r ON r.id = t.rollout_id JOIN agent_releases a ON a.id = r.release_id
         WHERE t.device_id = ? AND t.status IN ('pending', 'sent')",
    )
    .bind(device_id)
    .fetch_all(&state.db)
    .await?;
    let mut updated = false;
    for (rollout_id, version) in sent {
        if version_cmp(agent_version, &version) != std::cmp::Ordering::Less {
            sqlx::query("UPDATE rollout_targets SET status = 'succeeded', last_error = NULL, updated_at = ? WHERE rollout_id = ? AND device_id = ?")
                .bind(rustrmm_common::now())
                .bind(&rollout_id)
                .bind(device_id)
                .execute(&state.db)
                .await?;
            if !updated {
                super::timeline(
                    &state.db,
                    device_id,
                    "agent.updated",
                    "notice",
                    &format!("Agent updated to {agent_version}"),
                    json!({}),
                )
                .await?;
                updated = true;
            }
            complete_if_done(state, &rollout_id).await?;
        }
    }
    if let Some(latest) = latest_release(state).await? {
        let device: Option<DeviceVersion> = sqlx::query_as(
            "SELECT id, os_family, arch, agent_version FROM devices WHERE id = ? AND status = 'active'",
        )
        .bind(device_id)
        .fetch_optional(&state.db)
        .await?;
        if let Some(mut device) = device {
            device.agent_version = agent_version.to_string();
            let (auto_update, _) =
                match policies::effective_for_device(&state.db, device_id).await? {
                    Some(effective) => auto_update_of(&effective),
                    None => (true, None),
                };
            enroll_auto(state, &latest, &device, auto_update).await?;
        }
    }
    if updated {
        state.events.publish(
            "agent_updates.changed",
            None,
            json!({ "device_id": device_id }),
        );
    }
    dispatch_for_device(state, device_id).await
}

/// Queues and dispatches automatic updates for connected devices. Returns how many were queued.
pub async fn sweep(state: &AppState) -> Result<usize> {
    let Some(latest) = latest_release(state).await? else {
        return Ok(0);
    };
    let devices: Vec<DeviceVersion> = sqlx::query_as(
        "SELECT id, os_family, arch, agent_version FROM devices WHERE status = 'active'",
    )
    .fetch_all(&state.db)
    .await?;
    let online: Vec<DeviceVersion> = devices
        .into_iter()
        .filter(|d| state.agents.is_online(&d.id))
        .collect();
    if online.is_empty() {
        return Ok(0);
    }
    let ctx = PolicyContext::load(&state.db, None).await?;
    let auto = auto_update_map(&ctx);
    let mut queued = 0;
    for device in &online {
        let on = auto.get(&device.id).is_none_or(|(on, _)| *on);
        if enroll_auto(state, &latest, device, on).await? {
            queued += 1;
        }
        if let Err(e) = dispatch_for_device(state, &device.id).await {
            tracing::debug!(device = %device.id, error = %format!("{e:#}"), "update dispatch failed");
        }
    }
    if queued > 0 {
        state
            .events
            .publish("agent_updates.changed", None, json!({}));
    }
    Ok(queued)
}

/// Runs [`sweep`] every two minutes: picks up policy changes and the devices that waited for an
/// automatic-update slot.
pub fn spawn_auto_updates(state: AppState) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(SWEEP_EVERY);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        tick.tick().await;
        loop {
            tick.tick().await;
            if let Err(e) = sweep(&state).await {
                tracing::warn!(error = %format!("{e:#}"), "automatic agent update sweep failed");
            }
        }
    });
}

/// Handles an update result: failures (and auto-pausing unhealthy rollouts), and development
/// agents that verify an update without installing it.
pub async fn on_update_result(
    state: &AppState,
    device_id: &str,
    result: &CommandResult,
) -> Result<()> {
    let not_installed = result.status == "succeeded" && result.message.contains("development mode");
    if !not_installed && !matches!(result.status.as_str(), "failed" | "rejected") {
        return Ok(());
    }
    let rollout_id: Option<String> = sqlx::query_scalar(
        "SELECT rollout_id FROM rollout_targets WHERE device_id = ? AND command_id = ?",
    )
    .bind(device_id)
    .bind(&result.cmd_id)
    .fetch_optional(&state.db)
    .await?;
    let Some(rollout_id) = rollout_id else {
        return Ok(());
    };
    let message: String = result.message.chars().take(500).collect();
    if not_installed {
        sqlx::query("UPDATE rollout_targets SET status = 'skipped', last_error = ?, updated_at = ? WHERE rollout_id = ? AND device_id = ?")
            .bind(&message)
            .bind(rustrmm_common::now())
            .bind(&rollout_id)
            .bind(device_id)
            .execute(&state.db)
            .await?;
        complete_if_done(state, &rollout_id).await?;
        state.events.publish(
            "agent_updates.changed",
            None,
            json!({ "device_id": device_id }),
        );
        return Ok(());
    }
    sqlx::query("UPDATE rollout_targets SET status = 'failed', last_error = ?, updated_at = ? WHERE rollout_id = ? AND device_id = ?")
        .bind(&message)
        .bind(rustrmm_common::now())
        .bind(&rollout_id)
        .bind(device_id)
        .execute(&state.db)
        .await?;
    super::timeline(
        &state.db,
        device_id,
        "agent.update_failed",
        "warning",
        &format!("Agent update failed: {}", result.message),
        json!({}),
    )
    .await?;
    let (failed, attempted, threshold): (i64, i64, i64) = sqlx::query_as(
        "SELECT SUM(t.status = 'failed'), SUM(t.status IN ('failed', 'succeeded')), r.failure_threshold_pct
         FROM rollout_targets t JOIN rollouts r ON r.id = t.rollout_id WHERE t.rollout_id = ?",
    )
    .bind(&rollout_id)
    .fetch_one(&state.db)
    .await?;
    if attempted >= 3 && failed * 100 > threshold * attempted {
        sqlx::query("UPDATE rollouts SET status = 'paused', updated_at = ? WHERE id = ? AND status = 'active'")
            .bind(rustrmm_common::now())
            .bind(&rollout_id)
            .execute(&state.db)
            .await?;
        tracing::warn!(rollout = %rollout_id, failed, attempted, "rollout auto-paused: failure rate above threshold");
    }
    complete_if_done(state, &rollout_id).await?;
    state.events.publish(
        "agent_updates.changed",
        None,
        json!({ "device_id": device_id }),
    );
    Ok(())
}

async fn complete_if_done(state: &AppState, rollout_id: &str) -> Result<()> {
    let open: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM rollout_targets WHERE rollout_id = ? AND status IN ('pending', 'sent')")
        .bind(rollout_id)
        .fetch_one(&state.db)
        .await?;
    if open == 0 {
        sqlx::query("UPDATE rollouts SET status = 'completed', updated_at = ? WHERE id = ? AND status = 'active'")
            .bind(rustrmm_common::now())
            .bind(rollout_id)
            .execute(&state.db)
            .await?;
    }
    Ok(())
}

// ------------------------------------------------------------------ status for the console

/// Where a device stands against the latest release.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateState {
    /// Runs the latest release (or newer).
    Current,
    /// Runs an older agent and no update is waiting.
    Outdated,
    /// An update is waiting to be sent (device offline, rollout paused or no free slot).
    Queued,
    /// The update was sent and the device has not come back with the new version yet.
    Updating,
    /// The last update attempt for the latest release failed.
    Failed,
    /// The latest release has no agent build for the device's platform.
    Unsupported,
    /// No release has been imported.
    Unknown,
}

/// A device's update status (`GET /agent-updates`, `GET /devices/{id}/agent-update`).
#[derive(Debug, Clone, Serialize)]
pub struct DeviceUpdateStatus {
    pub state: UpdateState,
    pub latest_version: Option<String>,
    /// Version of the open or last update attempt for the latest release.
    pub target_version: Option<String>,
    pub last_error: Option<String>,
    /// When the last update attempt changed.
    pub attempt_at: Option<DateTime<Utc>>,
    /// `manual` or `auto`, for the last attempt.
    pub attempt_kind: Option<String>,
    pub auto_update: bool,
    /// Name of the policy that set `agent_updates.auto_update`; `None` when the default applies.
    pub auto_update_policy: Option<String>,
}

/// The latest attempt per device for a release: `(status, last_error, updated_at, kind, rollout status)`.
type Attempt = (String, Option<String>, DateTime<Utc>, String, String);

pub async fn attempts_for(state: &AppState, release_id: &str) -> Result<HashMap<String, Attempt>> {
    let rows: Vec<(
        String,
        String,
        Option<String>,
        DateTime<Utc>,
        String,
        String,
    )> = sqlx::query_as(
        "SELECT t.device_id, t.status, t.last_error, t.updated_at, r.kind, r.status
         FROM rollout_targets t JOIN rollouts r ON r.id = t.rollout_id
         WHERE r.release_id = ? ORDER BY t.updated_at",
    )
    .bind(release_id)
    .fetch_all(&state.db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(device, status, error, at, kind, rollout)| {
            (device, (status, error, at, kind, rollout))
        })
        .collect())
}

/// Combines a device's version, the latest release and its last attempt into a status.
pub fn status_for(
    latest: Option<&Release>,
    os_family: &str,
    arch: &str,
    agent_version: &str,
    attempt: Option<&Attempt>,
    auto_update: (bool, Option<String>),
) -> DeviceUpdateStatus {
    let mut status = DeviceUpdateStatus {
        state: UpdateState::Unknown,
        latest_version: latest.map(|r| r.version.clone()),
        target_version: None,
        last_error: None,
        attempt_at: None,
        attempt_kind: None,
        auto_update: auto_update.0,
        auto_update_policy: auto_update.1,
    };
    let Some(latest) = latest else {
        return status;
    };
    if version_cmp(agent_version, &latest.version) != std::cmp::Ordering::Less {
        status.state = UpdateState::Current;
        return status;
    }
    if !latest.supports(os_family, arch) {
        status.state = UpdateState::Unsupported;
        return status;
    }
    status.state = UpdateState::Outdated;
    if let Some((target, error, at, kind, rollout)) = attempt {
        status.target_version = Some(latest.version.clone());
        status.attempt_at = Some(*at);
        status.attempt_kind = Some(kind.clone());
        status.last_error = error.clone();
        let open = rollout == "active" || rollout == "paused";
        status.state = match target.as_str() {
            "pending" if open => UpdateState::Queued,
            "sent" if open => UpdateState::Updating,
            "failed" => UpdateState::Failed,
            _ => UpdateState::Outdated,
        };
    }
    status
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platforms() {
        assert_eq!(device_platform("windows", "x86_64"), "windows-x86_64");
        assert_eq!(device_platform("linux", "aarch64"), "linux-aarch64");
        assert_eq!(device_platform("macos", "aarch64"), "macos-universal");
        assert_eq!(device_platform("linux", ""), "linux-x86_64");
    }

    #[test]
    fn stamped_versions_are_safe_paths() {
        assert!(safe("0.1.0+20261118220341"));
        assert!(!safe("../0.1.0"));
        assert!(!safe("0.1.0/x"));
    }

    fn release() -> Release {
        Release {
            id: "r1".into(),
            version: "0.1.0+20261118220341".into(),
            manifest: serde_json::from_value(json!({
                "version": "0.1.0+20261118220341",
                "files": [
                    { "platform": "windows-x86_64", "file": "rustrmm-agent.exe", "size_bytes": 1, "sha256": "00" },
                    { "platform": "linux-x86_64", "file": "rustrmm-agent", "size_bytes": 1, "sha256": "00" }
                ]
            }))
            .expect("manifest"),
            imported_at: rustrmm_common::now(),
        }
    }

    #[test]
    fn statuses() {
        let latest = release();
        let on = || (true, None);
        let state = |version: &str, os: &str, attempt: Option<&Attempt>| {
            status_for(Some(&latest), os, "x86_64", version, attempt, on()).state
        };
        assert_eq!(
            status_for(None, "windows", "x86_64", "0.1.0", None, on()).state,
            UpdateState::Unknown
        );
        assert_eq!(
            state("0.1.0+20261118220341", "windows", None),
            UpdateState::Current
        );
        assert_eq!(state("0.1.1", "windows", None), UpdateState::Current);
        assert_eq!(state("0.1.0", "macos", None), UpdateState::Unsupported);
        assert_eq!(state("0.1.0", "windows", None), UpdateState::Outdated);
        let at = rustrmm_common::now();
        let attempt = |target: &str, rollout: &str| -> Attempt {
            (target.into(), None, at, "auto".into(), rollout.into())
        };
        assert_eq!(
            state("0.1.0", "linux", Some(&attempt("pending", "active"))),
            UpdateState::Queued
        );
        assert_eq!(
            state("0.1.0", "linux", Some(&attempt("sent", "active"))),
            UpdateState::Updating
        );
        assert_eq!(
            state("0.1.0", "linux", Some(&attempt("failed", "completed"))),
            UpdateState::Failed
        );
        assert_eq!(
            state("0.1.0", "linux", Some(&attempt("pending", "cancelled"))),
            UpdateState::Outdated
        );
    }
}
