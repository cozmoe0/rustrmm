//! `PatchReport` ingestion: catalog upserts, per-device states, reconciliation of patches that
//! disappeared, and auto-approval of patches seen for the first time in a client.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Utc};
use rustrmm_proto::patching::{AgentPatch, PatchReport, split_package_key};
use serde_json::json;

use super::approvals;
use crate::agents::DeviceRecord;
use crate::state::AppState;

const MAX_PATCHES: usize = 5000;

fn clip(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

fn ms_to_time(ms: i64) -> Option<DateTime<Utc>> {
    let now = rustrmm_common::now();
    DateTime::<Utc>::from_timestamp_millis(ms).map(|t| t.min(now))
}

/// Catalog platform of a patch reported by a device.
pub fn patch_platform(patch: &AgentPatch, os_family: &str) -> String {
    match patch.platform.as_deref() {
        Some("winget") => "winget".into(),
        _ => os_family.to_string(),
    }
}

/// Inserts or refreshes a catalog entry; returns `(id, newly created)`.
async fn upsert_catalog(
    tx: &mut sqlx::SqliteConnection,
    platform: &str,
    patch: &AgentPatch,
    now: DateTime<Utc>,
) -> anyhow::Result<(String, bool)> {
    let existing: Option<String> =
        sqlx::query_scalar("SELECT id FROM patch_catalog WHERE platform = ? AND key = ?")
            .bind(platform)
            .bind(&patch.key)
            .fetch_optional(&mut *tx)
            .await?;
    let cves = serde_json::to_string(
        &patch
            .cves
            .iter()
            .take(200)
            .map(|c| clip(c, 40))
            .collect::<Vec<_>>(),
    )?;
    let severity = patch
        .severity
        .as_deref()
        .filter(|s| super::policy::SEVERITIES.contains(s));
    match existing {
        Some(id) => {
            sqlx::query(
                "UPDATE patch_catalog SET kb = COALESCE(?, kb), title = ?, classification = ?, severity = COALESCE(?, severity),
                        size_bytes = COALESCE(?, size_bytes), reboot_required = ?, release_date = COALESCE(?, release_date),
                        description = CASE WHEN ? = '' THEN description ELSE ? END, support_url = COALESCE(?, support_url),
                        cves = CASE WHEN ? = '[]' THEN cves ELSE ? END, package = COALESCE(?, package), version = COALESCE(?, version),
                        updated_at = ? WHERE id = ?",
            )
            .bind(patch.kb.as_deref().map(|k| clip(k, 40)))
            .bind(clip(&patch.title, 500))
            .bind(clip(&patch.classification, 40))
            .bind(severity)
            .bind(patch.size_bytes.map(|s| s.min(i64::MAX as u64) as i64))
            .bind(patch.reboot_required)
            .bind(patch.release_date.as_deref().map(|d| clip(d, 40)))
            .bind(clip(&patch.description, 4000))
            .bind(clip(&patch.description, 4000))
            .bind(patch.support_url.as_deref().map(|u| clip(u, 500)))
            .bind(&cves)
            .bind(&cves)
            .bind(patch.package.as_deref().map(|p| clip(p, 200)))
            .bind(patch.version.as_deref().map(|v| clip(v, 100)))
            .bind(now)
            .bind(&id)
            .execute(&mut *tx)
            .await?;
            Ok((id, false))
        }
        None => {
            let id = rustrmm_common::new_id();
            sqlx::query(
                "INSERT INTO patch_catalog (id, platform, key, kb, title, classification, severity, size_bytes, reboot_required,
                        release_date, description, support_url, cves, package, version, first_seen_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&id)
            .bind(platform)
            .bind(clip(&patch.key, 300))
            .bind(patch.kb.as_deref().map(|k| clip(k, 40)))
            .bind(clip(&patch.title, 500))
            .bind(clip(&patch.classification, 40))
            .bind(severity)
            .bind(patch.size_bytes.map(|s| s.min(i64::MAX as u64) as i64))
            .bind(patch.reboot_required)
            .bind(patch.release_date.as_deref().map(|d| clip(d, 40)))
            .bind(clip(&patch.description, 4000))
            .bind(patch.support_url.as_deref().map(|u| clip(u, 500)))
            .bind(&cves)
            .bind(patch.package.as_deref().map(|p| clip(p, 200)))
            .bind(patch.version.as_deref().map(|v| clip(v, 100)))
            .bind(now)
            .bind(now)
            .execute(&mut *tx)
            .await?;
            Ok((id, true))
        }
    }
}

/// What happens to a previously missing patch that is no longer reported.
pub fn disappeared_state(
    platform: &str,
    key: &str,
    state: &str,
    installed_keys: &HashSet<&str>,
    available_keys: &HashSet<&str>,
) -> &'static str {
    if installed_keys.contains(key) || matches!(state, "installing" | "downloaded") {
        return "installed";
    }
    if platform == "windows" {
        // WUA collapses revisions and drops superseded updates from searches.
        return "superseded";
    }
    if let Some((manager, package, _)) = split_package_key(key) {
        let prefix = format!("{manager}:{package}:");
        if available_keys.iter().any(|k| k.starts_with(&prefix)) {
            return "superseded";
        }
    }
    "installed"
}

/// Handles a `patch_report` message.
pub async fn on_report(
    state: &AppState,
    device: &DeviceRecord,
    report: PatchReport,
) -> anyhow::Result<()> {
    let now = rustrmm_common::now();
    let scanned_at = ms_to_time(report.scanned_at).unwrap_or(now);
    let os_family: String = sqlx::query_scalar("SELECT os_family FROM devices WHERE id = ?")
        .bind(&device.id)
        .fetch_one(&state.db)
        .await?;
    let reasons = serde_json::to_string(
        &report
            .reboot_reasons
            .iter()
            .take(20)
            .map(|r| clip(r, 60))
            .collect::<Vec<_>>(),
    )?;
    sqlx::query(
        "INSERT INTO device_patch_status (device_id, scanned_at, source, pending_reboot, reboot_reasons, last_install_at, error, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (device_id) DO UPDATE SET scanned_at = excluded.scanned_at, source = excluded.source,
            pending_reboot = excluded.pending_reboot, reboot_reasons = excluded.reboot_reasons,
            last_install_at = COALESCE(excluded.last_install_at, device_patch_status.last_install_at),
            error = excluded.error, updated_at = excluded.updated_at",
    )
    .bind(&device.id)
    .bind(scanned_at)
    .bind(clip(&report.source, 40))
    .bind(report.pending_reboot)
    .bind(&reasons)
    .bind(report.last_install_at.and_then(ms_to_time))
    .bind(report.error.as_deref().map(|e| clip(e, 1000)))
    .bind(now)
    .execute(&state.db)
    .await?;
    if report.error.is_some() {
        // A failed scan says nothing about what is installed.
        state.events.publish(
            "patches.changed",
            Some(device.client_id.clone()),
            json!({ "device_id": device.id }),
        );
        return Ok(());
    }

    let config = super::device_config(&state.db, &device.id).await?;
    // The transaction reads before it writes: take the write lock up front so concurrent
    // reports from several devices queue instead of failing with a stale snapshot.
    let mut tx = state.db.begin_with("BEGIN IMMEDIATE").await?;
    let mut new_for_client: Vec<(String, AgentPatch, String)> = Vec::new();
    let mut seen_ids: HashSet<String> = HashSet::new();
    let available: Vec<&AgentPatch> = report
        .available
        .iter()
        .filter(|p| !p.key.trim().is_empty())
        .take(MAX_PATCHES)
        .collect();
    for patch in &available {
        let platform = patch_platform(patch, &os_family);
        let (patch_id, _) = upsert_catalog(&mut tx, &platform, patch, now).await?;
        seen_ids.insert(patch_id.clone());
        let current: Option<String> = sqlx::query_scalar(
            "SELECT state FROM device_patches WHERE device_id = ? AND patch_id = ?",
        )
        .bind(&device.id)
        .bind(&patch_id)
        .fetch_optional(&mut *tx)
        .await?;
        match current.as_deref() {
            None => {
                let in_client: Option<i64> = sqlx::query_scalar(
                    "SELECT 1 FROM device_patches dp JOIN devices d ON d.id = dp.device_id JOIN sites s ON s.id = d.site_id
                     WHERE dp.patch_id = ? AND s.client_id = ? LIMIT 1",
                )
                .bind(&patch_id)
                .bind(&device.client_id)
                .fetch_optional(&mut *tx)
                .await?;
                sqlx::query(
                    "INSERT INTO device_patches (device_id, patch_id, state, detected_at, updated_at) VALUES (?, ?, 'missing', ?, ?)",
                )
                .bind(&device.id)
                .bind(&patch_id)
                .bind(now)
                .bind(now)
                .execute(&mut *tx)
                .await?;
                if in_client.is_none() {
                    new_for_client.push((patch_id, (*patch).clone(), platform));
                }
            }
            // Still missing, or failed and still missing: unchanged.
            Some("missing" | "failed" | "downloaded" | "installing") => {}
            Some("pending_reboot") if report.pending_reboot => {}
            Some(_) => {
                sqlx::query(
                    "UPDATE device_patches SET state = 'missing', detected_at = ?, installed_at = NULL, updated_at = ?
                     WHERE device_id = ? AND patch_id = ?",
                )
                .bind(now)
                .bind(now)
                .bind(&device.id)
                .bind(&patch_id)
                .execute(&mut *tx)
                .await?;
            }
        }
    }

    // Recently installed updates (Windows history, our own installs).
    let mut installed_keys: HashSet<&str> = HashSet::new();
    let mut history: HashMap<&str, &AgentPatch> = HashMap::new();
    for patch in report.installed_recent.iter().take(MAX_PATCHES) {
        if patch.result.as_deref() != Some("failed") {
            installed_keys.insert(patch.key.as_str());
        }
        history.insert(patch.key.as_str(), patch);
    }
    let available_keys: HashSet<&str> = available.iter().map(|p| p.key.as_str()).collect();
    let rows: Vec<(String, String, String, String)> = sqlx::query_as(
        "SELECT dp.patch_id, c.platform, c.key, dp.state FROM device_patches dp JOIN patch_catalog c ON c.id = dp.patch_id
         WHERE dp.device_id = ?",
    )
    .bind(&device.id)
    .fetch_all(&mut *tx)
    .await?;
    for (patch_id, platform, key, current) in rows {
        if seen_ids.contains(&patch_id) {
            continue;
        }
        let installed_at = history
            .get(key.as_str())
            .and_then(|p| p.installed_at.as_deref())
            .and_then(approvals::parse_date)
            .unwrap_or(now);
        let new_state = match current.as_str() {
            "missing" | "downloaded" | "installing" | "failed" => {
                disappeared_state(&platform, &key, &current, &installed_keys, &available_keys)
            }
            "pending_reboot" if !report.pending_reboot => "installed",
            _ => continue,
        };
        sqlx::query(
            "UPDATE device_patches SET state = ?, installed_at = CASE WHEN ? = 'installed' THEN COALESCE(installed_at, ?) ELSE installed_at END,
                    last_error = CASE WHEN ? = 'installed' THEN NULL ELSE last_error END, updated_at = ?
             WHERE device_id = ? AND patch_id = ?",
        )
        .bind(new_state)
        .bind(new_state)
        .bind(installed_at)
        .bind(new_state)
        .bind(now)
        .bind(&device.id)
        .bind(&patch_id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    // Auto-approval: rules of this device's effective policy, for patches new to its client.
    let mut approved = 0;
    for (patch_id, patch, platform) in &new_for_client {
        if let Some(rule) =
            config.matching_rule(platform, &patch.classification, patch.severity.as_deref())
            && approvals::insert_rule_approval(
                &state.db,
                patch_id,
                &device.client_id,
                config.rules_policy.as_deref(),
                rule.delay_days,
            )
            .await?
        {
            approved += 1;
        }
    }
    if approved > 0 {
        tracing::info!(device = %device.id, approved, "patches approved by auto-approval rules");
    }
    state.events.publish(
        "patches.changed",
        Some(device.client_id.clone()),
        json!({ "device_id": device.id }),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disappeared_patches_become_installed_or_superseded() {
        let installed: HashSet<&str> = ["KB-A"].into_iter().collect();
        let available: HashSet<&str> = ["apt:openssl:3.0.2-2"].into_iter().collect();
        assert_eq!(
            disappeared_state("windows", "KB-A", "missing", &installed, &available),
            "installed"
        );
        assert_eq!(
            disappeared_state("windows", "KB-B", "missing", &installed, &available),
            "superseded"
        );
        assert_eq!(
            disappeared_state("windows", "KB-C", "installing", &installed, &available),
            "installed"
        );
        assert_eq!(
            disappeared_state(
                "linux",
                "apt:openssl:3.0.2-1",
                "missing",
                &installed,
                &available
            ),
            "superseded",
            "a newer version of the same package is offered"
        );
        assert_eq!(
            disappeared_state("linux", "apt:curl:8.5-1", "failed", &installed, &available),
            "installed"
        );
        let winget = AgentPatch {
            platform: Some("winget".into()),
            ..AgentPatch::default()
        };
        assert_eq!(patch_platform(&winget, "windows"), "winget");
        assert_eq!(patch_platform(&AgentPatch::default(), "linux"), "linux");
    }
}
