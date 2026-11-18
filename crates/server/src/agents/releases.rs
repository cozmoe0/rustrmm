//! Agent releases: import + signing, versioned artifact hosting, and staged rollouts.
//!
//! A release is the build's `manifest.json` plus its artifacts. On import the server verifies
//! every file hash, copies the files to `<data>/agents/releases/<version>/`, and signs the exact
//! manifest bytes with its *release* key; agents refuse any update whose manifest signature does
//! not verify against the key they pinned at enrollment.

use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use axum::body::Body;
use axum::extract::{Path as UrlPath, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use rustrmm_proto::commands::{
    Command, CommandResult, ReleaseManifest, UpdateAgent, manifest_signing_bytes, version_cmp,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio_util::io::ReaderStream;

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

const MAX_ATTEMPTS: i64 = 3;

pub fn releases_root(state: &AppState) -> PathBuf {
    state.args.data_dir.join("agents").join("releases")
}

fn safe(s: &str) -> bool {
    !s.is_empty()
        && s.len() < 80
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RolloutScope {
    All,
    Client { id: String },
    Site { id: String },
    Devices { ids: Vec<String> },
}

/// Creates a rollout and targets every eligible device; online ones are updated immediately.
pub async fn create_rollout(
    state: &AppState,
    release_id: &str,
    scope: &RolloutScope,
    percent: i64,
    created_by: &str,
) -> Result<String> {
    let (version, manifest_bytes): (String, Vec<u8>) =
        sqlx::query_as("SELECT version, manifest FROM agent_releases WHERE id = ?")
            .bind(release_id)
            .fetch_one(&state.db)
            .await?;
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
    sqlx::query("INSERT INTO rollouts (id, release_id, scope, percent, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)")
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
    Ok(id)
}

/// Sends the pending update (if any) to a connected device.
pub async fn dispatch_for_device(state: &AppState, device_id: &str) -> Result<()> {
    let target: Option<(String, String, String, Vec<u8>, Vec<u8>, i64)> = sqlx::query_as(
        "SELECT t.rollout_id, r.release_id, a.version, a.manifest, a.signature, t.attempts
         FROM rollout_targets t JOIN rollouts r ON r.id = t.rollout_id JOIN agent_releases a ON a.id = r.release_id
         WHERE t.device_id = ? AND r.status = 'active' AND t.status IN ('pending', 'sent') AND t.attempts < ?
         ORDER BY r.created_at DESC LIMIT 1",
    )
    .bind(device_id)
    .bind(MAX_ATTEMPTS)
    .fetch_optional(&state.db)
    .await?;
    let Some((rollout_id, _release_id, version, manifest, signature, _attempts)) = target else {
        return Ok(());
    };
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
    Ok(())
}

/// Called when a device connects: completes targets it already satisfies, then dispatches.
pub async fn on_connect(state: &AppState, device_id: &str, agent_version: &str) -> Result<()> {
    let sent: Vec<(String, String)> = sqlx::query_as(
        "SELECT t.rollout_id, a.version FROM rollout_targets t JOIN rollouts r ON r.id = t.rollout_id JOIN agent_releases a ON a.id = r.release_id
         WHERE t.device_id = ? AND t.status IN ('pending', 'sent')",
    )
    .bind(device_id)
    .fetch_all(&state.db)
    .await?;
    for (rollout_id, version) in sent {
        if version_cmp(agent_version, &version) != std::cmp::Ordering::Less {
            sqlx::query("UPDATE rollout_targets SET status = 'succeeded', last_error = NULL, updated_at = ? WHERE rollout_id = ? AND device_id = ?")
                .bind(rustrmm_common::now())
                .bind(&rollout_id)
                .bind(device_id)
                .execute(&state.db)
                .await?;
            super::timeline(
                &state.db,
                device_id,
                "agent.updated",
                "notice",
                &format!("Agent updated to {agent_version}"),
                json!({}),
            )
            .await?;
            complete_if_done(state, &rollout_id).await?;
        }
    }
    dispatch_for_device(state, device_id).await
}

/// Handles a failed/rejected update result and auto-pauses unhealthy rollouts.
pub async fn on_update_result(
    state: &AppState,
    device_id: &str,
    result: &CommandResult,
) -> Result<()> {
    if !matches!(result.status.as_str(), "failed" | "rejected") {
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
    sqlx::query("UPDATE rollout_targets SET status = 'failed', last_error = ?, updated_at = ? WHERE rollout_id = ? AND device_id = ?")
        .bind(result.message.chars().take(500).collect::<String>())
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
}
