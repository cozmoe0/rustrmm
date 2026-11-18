//! Scans, maintenance-window patch runs, `PatchInstall` dispatch and results.
//!
//! When a device's window opens the server creates one patch run per policy window and sends
//! every effective-approved missing patch to each online device of that window. Offline devices
//! wait as `pending` and are served at their next connect while the window is still open.
//! Immediate installs from the console create a run with `trigger_kind = manual`.

use std::collections::{BTreeMap, HashMap, HashSet};

use chrono::{DateTime, Utc};
use rustrmm_proto::commands::{Command, CommandResult};
use rustrmm_proto::patching::{PatchInstall, PatchInstallOutcome, PatchScan, RebootSpec};
use serde::Serialize;
use serde_json::{Value, json};

use super::approvals::{self, PatchApprovals};
use super::{DeviceCtx, policy::PatchingConfig};
use crate::audit::{Actor, AuditEntry};
use crate::db::Db;
use crate::monitoring::alerts::{self, Raise};
use crate::state::AppState;

/// Failed installs are retried in later windows this many times.
pub const MAX_ATTEMPTS: i64 = 3;
/// A running install with no answer this long after its window ended fails.
const RESULT_GRACE_HOURS: i64 = 6;
pub const ALERT_CHECK_ID: &str = "patching.install_failed";

/// A patch a device still needs.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct MissingPatch {
    pub patch_id: String,
    pub key: String,
    pub platform: String,
    pub classification: String,
    pub severity: Option<String>,
    pub release_date: Option<String>,
    pub first_seen_at: DateTime<Utc>,
    pub state: String,
    pub attempts: i64,
}

pub async fn missing_patches(db: &Db, device_id: &str) -> anyhow::Result<Vec<MissingPatch>> {
    Ok(sqlx::query_as(
        "SELECT dp.patch_id, c.key, c.platform, c.classification, c.severity, c.release_date, c.first_seen_at, dp.state, dp.attempts
         FROM device_patches dp JOIN patch_catalog c ON c.id = dp.patch_id
         WHERE dp.device_id = ? AND dp.state IN ('missing', 'downloaded', 'failed') ORDER BY c.key",
    )
    .bind(device_id)
    .fetch_all(db)
    .await?)
}

/// The patches a window install sends to a device: effective-approved, allowed by the
/// device's configuration, and not failed too often.
pub fn installable(
    client_id: &str,
    config: &PatchingConfig,
    missing: &[MissingPatch],
    approvals: &HashMap<String, PatchApprovals>,
    now: DateTime<Utc>,
) -> Vec<MissingPatch> {
    let empty = PatchApprovals::default();
    missing
        .iter()
        .filter(|p| p.state != "failed" || p.attempts < MAX_ATTEMPTS)
        .filter(|p| match p.platform.as_str() {
            "macos" => config.macos_install,
            "winget" => config.third_party_winget,
            _ => true,
        })
        .filter(|p| {
            let decisions = approvals.get(&p.patch_id).unwrap_or(&empty);
            let base = approvals::base_date(p.release_date.as_deref(), p.first_seen_at);
            if !decisions.effective_approved(client_id, &config.ring, base, now) {
                return false;
            }
            // Linux `security` mode: rule approvals only cover security updates.
            if p.platform == "linux" && config.linux_mode == "security" {
                let manual = decisions
                    .effective_for(Some(client_id), now)
                    .is_some_and(|a| a.source == "manual");
                return manual || p.classification == "security";
            }
            true
        })
        .cloned()
        .collect()
}

fn reboot_spec(config: &PatchingConfig, window_end: Option<DateTime<Utc>>) -> RebootSpec {
    RebootSpec {
        mode: config.reboot.mode.clone(),
        deferrals: config.reboot.prompt_deferrals,
        message: config.reboot.message.clone(),
        deadline_unix: if config.reboot.force_at_window_end {
            window_end.map(|t| t.timestamp())
        } else {
            None
        },
    }
}

// ------------------------------------------------------------------ scans

/// Sends `PatchScan` with the device's scan options. `record` keeps it in command history.
pub async fn send_scan(
    state: &AppState,
    device_id: &str,
    config: &PatchingConfig,
    created_by: Option<&str>,
    record: bool,
) -> anyhow::Result<String> {
    let command = Command::PatchScan(PatchScan {
        include_drivers: config.include_drivers,
        include_feature_updates: config.include_feature_updates,
        include_preview: config.include_preview,
        third_party_winget: config.third_party_winget,
    });
    let cmd_id = if record {
        crate::agents::commands::send(
            state,
            device_id,
            command,
            created_by,
            600,
            "Scan for patches",
        )
        .await?
    } else {
        crate::agents::commands::send_quiet(state, device_id, command, 600).await?
    };
    let now = rustrmm_common::now();
    sqlx::query(
        "INSERT INTO device_patch_status (device_id, last_scan_requested_at, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (device_id) DO UPDATE SET last_scan_requested_at = excluded.last_scan_requested_at, updated_at = excluded.updated_at",
    )
    .bind(device_id)
    .bind(now)
    .bind(now)
    .execute(&state.db)
    .await?;
    Ok(cmd_id)
}

/// Whether a scheduled scan is due for a device.
pub fn scan_due(
    last_requested: Option<DateTime<Utc>>,
    interval_hours: i64,
    now: DateTime<Utc>,
) -> bool {
    last_requested.is_none_or(|t| now - t >= chrono::Duration::hours(interval_hours.max(1)))
}

async fn last_requested(db: &Db) -> anyhow::Result<HashMap<String, Option<DateTime<Utc>>>> {
    let rows: Vec<(String, Option<DateTime<Utc>>)> =
        sqlx::query_as("SELECT device_id, last_scan_requested_at FROM device_patch_status")
            .fetch_all(db)
            .await?;
    Ok(rows.into_iter().collect())
}

// ------------------------------------------------------------------ dispatch

pub enum Dispatch {
    /// Nothing effective-approved is missing.
    Nothing,
    Sent {
        cmd_id: String,
        count: usize,
    },
}

/// Sends the given patches to an online device as part of `run_id`.
pub async fn send_install(
    state: &AppState,
    run_id: &str,
    device: &DeviceCtx,
    patches: &[MissingPatch],
    reboot: RebootSpec,
    window_end: Option<DateTime<Utc>>,
    created_by: Option<&str>,
) -> anyhow::Result<Dispatch> {
    if patches.is_empty() {
        return Ok(Dispatch::Nothing);
    }
    let keys: Vec<String> = patches.iter().map(|p| p.key.clone()).collect();
    let cmd_id = rustrmm_common::new_id();
    let now = rustrmm_common::now();
    sqlx::query(
        "INSERT INTO patch_run_results (run_id, device_id, status, keys, command_id, window_end, started_at, updated_at)
         VALUES (?, ?, 'running', ?, ?, ?, ?, ?)
         ON CONFLICT (run_id, device_id) DO UPDATE SET status = 'running', keys = excluded.keys, command_id = excluded.command_id,
            window_end = excluded.window_end, started_at = excluded.started_at, error = NULL, updated_at = excluded.updated_at",
    )
    .bind(run_id)
    .bind(&device.id)
    .bind(serde_json::to_string(&keys)?)
    .bind(&cmd_id)
    .bind(window_end)
    .bind(now)
    .bind(now)
    .execute(&state.db)
    .await?;
    for patch in patches {
        sqlx::query("UPDATE device_patches SET state = 'installing', attempts = attempts + 1, updated_at = ? WHERE device_id = ? AND patch_id = ?")
            .bind(now)
            .bind(&device.id)
            .bind(&patch.patch_id)
            .execute(&state.db)
            .await?;
    }
    let command = Command::PatchInstall(PatchInstall {
        run_id: Some(run_id.to_string()),
        keys: keys.clone(),
        reboot,
        window_end_unix: window_end.map(|t| t.timestamp()),
    });
    let sent = crate::agents::commands::send_as(
        state,
        &cmd_id,
        &device.id,
        command,
        created_by,
        600,
        &format!("Install {} patch(es)", keys.len()),
    )
    .await;
    if let Err(e) = sent {
        // Undo: the device never got the command.
        for patch in patches {
            sqlx::query("UPDATE device_patches SET state = ?, attempts = MAX(attempts - 1, 0) WHERE device_id = ? AND patch_id = ? AND state = 'installing'")
                .bind(&patch.state)
                .bind(&device.id)
                .bind(&patch.patch_id)
                .execute(&state.db)
                .await?;
        }
        sqlx::query("UPDATE patch_run_results SET status = 'pending', command_id = NULL, started_at = NULL WHERE run_id = ? AND device_id = ? AND command_id = ?")
            .bind(run_id)
            .bind(&device.id)
            .bind(&cmd_id)
            .execute(&state.db)
            .await?;
        return Err(e);
    }
    Ok(Dispatch::Sent {
        cmd_id,
        count: keys.len(),
    })
}

/// Serves a device in a window run: sends its installable patches, or skips it.
async fn serve_device(
    state: &AppState,
    run_id: &str,
    device: &DeviceCtx,
    window_end: DateTime<Utc>,
    approvals: &HashMap<String, PatchApprovals>,
    keep_empty: bool,
) -> anyhow::Result<()> {
    let now = rustrmm_common::now();
    let missing = missing_patches(&state.db, &device.id).await?;
    let patches = installable(&device.client_id, &device.config, &missing, approvals, now);
    let reboot = reboot_spec(&device.config, Some(window_end));
    match send_install(
        state,
        run_id,
        device,
        &patches,
        reboot,
        Some(window_end),
        None,
    )
    .await
    {
        Ok(Dispatch::Sent { .. }) => {}
        Ok(Dispatch::Nothing) => {
            if keep_empty {
                sqlx::query("UPDATE patch_run_results SET status = 'skipped', error = 'Nothing to install', finished_at = ?, updated_at = ?
                             WHERE run_id = ? AND device_id = ? AND status = 'pending'")
                    .bind(now)
                    .bind(now)
                    .bind(run_id)
                    .bind(&device.id)
                    .execute(&state.db)
                    .await?;
            }
        }
        Err(e) => {
            tracing::debug!(device = %device.id, error = %format!("{e:#}"), "patch install not sent; waiting");
            sqlx::query(
                "INSERT OR IGNORE INTO patch_run_results (run_id, device_id, status, window_end, updated_at) VALUES (?, ?, 'pending', ?, ?)",
            )
            .bind(run_id)
            .bind(&device.id)
            .bind(window_end)
            .bind(now)
            .execute(&state.db)
            .await?;
        }
    }
    Ok(())
}

/// Opens runs for windows that are open at `now` and serves their devices.
async fn open_windows(
    state: &AppState,
    devices: &[DeviceCtx],
    now: DateTime<Utc>,
) -> anyhow::Result<()> {
    let mut groups: BTreeMap<(String, DateTime<Utc>), Vec<(&DeviceCtx, DateTime<Utc>)>> =
        BTreeMap::new();
    for device in devices.iter().filter(|d| d.config.enabled) {
        let Some(window) = &device.config.window else {
            continue;
        };
        if let Some((start, end)) = window.open_at(now) {
            let policy = device.config.window_policy.clone().unwrap_or_default();
            groups
                .entry((policy, start))
                .or_default()
                .push((device, end));
        }
    }
    if groups.is_empty() {
        return Ok(());
    }
    // Loaded only when a run actually opens (ticks inside an open window skip it).
    let mut decisions: Option<HashMap<String, PatchApprovals>> = None;
    for ((policy_id, start), members) in groups {
        let existing: Option<String> = sqlx::query_scalar(
            "SELECT id FROM patch_runs WHERE trigger_kind = 'window' AND COALESCE(policy_id, '') = ? AND window_start = ?",
        )
        .bind(&policy_id)
        .bind(start)
        .fetch_optional(&state.db)
        .await?;
        if existing.is_some() {
            continue;
        }
        let end = members.iter().map(|(_, e)| *e).max().unwrap_or(start);
        let policy_name: String = sqlx::query_scalar("SELECT name FROM policies WHERE id = ?")
            .bind(&policy_id)
            .fetch_optional(&state.db)
            .await?
            .unwrap_or_default();
        let run_id = rustrmm_common::new_id();
        let inserted = sqlx::query(
            "INSERT OR IGNORE INTO patch_runs (id, policy_id, policy_name, window_start, window_end, status, trigger_kind, created_at)
             VALUES (?, ?, ?, ?, ?, 'running', 'window', ?)",
        )
        .bind(&run_id)
        .bind((!policy_id.is_empty()).then_some(policy_id.as_str()))
        .bind(&policy_name)
        .bind(start)
        .bind(end)
        .bind(rustrmm_common::now())
        .execute(&state.db)
        .await?
        .rows_affected();
        if inserted == 0 {
            continue;
        }
        state
            .audit
            .record_or_log(
                &state.db,
                AuditEntry::new(Actor::System, "patch_run.started")
                    .target("patch_run", &run_id, &policy_name)
                    .details(
                        json!({ "policy_id": policy_id, "window_start": start, "window_end": end,
                                     "devices": members.len() }),
                    ),
            )
            .await;
        if decisions.is_none() {
            decisions = Some(approvals::load(&state.db, None).await?);
        }
        let Some(approvals) = decisions.as_ref() else {
            continue;
        };
        for (device, device_end) in members {
            if device.online {
                serve_device(state, &run_id, device, device_end, approvals, false).await?;
            } else {
                sqlx::query(
                    "INSERT OR IGNORE INTO patch_run_results (run_id, device_id, status, window_end, updated_at) VALUES (?, ?, 'pending', ?, ?)",
                )
                .bind(&run_id)
                .bind(&device.id)
                .bind(device_end)
                .bind(rustrmm_common::now())
                .execute(&state.db)
                .await?;
            }
        }
        publish_run(state, &run_id).await;
        complete_if_done(state, &run_id, now).await?;
    }
    Ok(())
}

/// Opens a manual run of a policy window now: online devices are served at once, offline ones
/// wait as `pending` until the run's window (`minutes` from now) ends. Returns the run id.
pub async fn run_window_now(
    state: &AppState,
    policy_id: &str,
    policy_name: &str,
    devices: &[DeviceCtx],
    minutes: i64,
) -> anyhow::Result<String> {
    let now = rustrmm_common::now();
    let end = now + chrono::Duration::minutes(minutes);
    let run_id = rustrmm_common::new_id();
    sqlx::query(
        "INSERT INTO patch_runs (id, policy_id, policy_name, window_start, window_end, status, trigger_kind, created_at)
         VALUES (?, ?, ?, ?, ?, 'running', 'manual', ?)",
    )
    .bind(&run_id)
    .bind(policy_id)
    .bind(policy_name)
    .bind(now)
    .bind(end)
    .bind(now)
    .execute(&state.db)
    .await?;
    let approvals = approvals::load(&state.db, None).await?;
    for device in devices {
        if device.online {
            serve_device(state, &run_id, device, end, &approvals, true).await?;
        } else {
            sqlx::query(
                "INSERT OR IGNORE INTO patch_run_results (run_id, device_id, status, window_end, updated_at) VALUES (?, ?, 'pending', ?, ?)",
            )
            .bind(&run_id)
            .bind(&device.id)
            .bind(end)
            .bind(now)
            .execute(&state.db)
            .await?;
        }
    }
    // Online devices with nothing to install are recorded as skipped.
    for device in devices.iter().filter(|d| d.online) {
        sqlx::query(
            "INSERT OR IGNORE INTO patch_run_results (run_id, device_id, status, error, window_end, finished_at, updated_at)
             VALUES (?, ?, 'skipped', 'Nothing to install', ?, ?, ?)",
        )
        .bind(&run_id)
        .bind(&device.id)
        .bind(end)
        .bind(now)
        .bind(now)
        .execute(&state.db)
        .await?;
    }
    publish_run(state, &run_id).await;
    complete_if_done(state, &run_id, now).await?;
    Ok(run_id)
}

/// One scheduler pass at `now` (the test hook): scheduled scans, window openings, offline
/// devices that came back, expired waits and run completion.
pub async fn tick_at(state: &AppState, now: DateTime<Utc>) -> anyhow::Result<()> {
    let devices = super::load_devices(state, None).await?;
    let requested = last_requested(&state.db).await?;
    for device in devices.iter().filter(|d| d.config.enabled && d.online) {
        let last = requested.get(&device.id).copied().flatten();
        if scan_due(last, device.config.scan_interval_hours, now)
            && let Err(e) = send_scan(state, &device.id, &device.config, None, false).await
        {
            tracing::debug!(device = %device.id, error = %format!("{e:#}"), "patch scan not sent");
        }
    }
    open_windows(state, &devices, now).await?;
    // Pending results of devices that are online now.
    let pending: Vec<(String, String, Option<DateTime<Utc>>)> = sqlx::query_as(
        "SELECT r.run_id, r.device_id, r.window_end FROM patch_run_results r JOIN patch_runs p ON p.id = r.run_id
         WHERE r.status = 'pending' AND p.status = 'running'",
    )
    .fetch_all(&state.db)
    .await?;
    if !pending.is_empty() {
        let approvals = approvals::load(&state.db, None).await?;
        let by_id: HashMap<&str, &DeviceCtx> = devices.iter().map(|d| (d.id.as_str(), d)).collect();
        for (run_id, device_id, end) in &pending {
            let (Some(device), Some(end)) = (by_id.get(device_id.as_str()), end) else {
                continue;
            };
            if device.online && now < *end {
                serve_device(state, run_id, device, *end, &approvals, true).await?;
            }
        }
    }
    sweep(state, now).await
}

/// Expires offline waits and silent installs, and completes runs.
pub async fn sweep(state: &AppState, now: DateTime<Utc>) -> anyhow::Result<()> {
    sqlx::query(
        "UPDATE patch_run_results SET status = 'skipped', error = 'The device was offline during the window', finished_at = ?, updated_at = ?
         WHERE status = 'pending' AND window_end IS NOT NULL AND window_end <= ?",
    )
    .bind(now)
    .bind(now)
    .bind(now)
    .execute(&state.db)
    .await?;
    let silent: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT run_id, device_id, keys FROM patch_run_results WHERE status = 'running'
           AND MAX(COALESCE(window_end, started_at), started_at) <= ?",
    )
    .bind(now - chrono::Duration::hours(RESULT_GRACE_HOURS))
    .fetch_all(&state.db)
    .await?;
    for (run_id, device_id, keys) in silent {
        let keys: Vec<String> = serde_json::from_str(&keys).unwrap_or_default();
        fail_keys(
            state,
            &device_id,
            &keys,
            "The device did not report a result",
        )
        .await?;
        sqlx::query("UPDATE patch_run_results SET status = 'failed', error = 'The device did not report a result', finished_at = ?, updated_at = ?
                     WHERE run_id = ? AND device_id = ? AND status = 'running'")
            .bind(now)
            .bind(now)
            .bind(&run_id)
            .bind(&device_id)
            .execute(&state.db)
            .await?;
    }
    let runs: Vec<String> =
        sqlx::query_scalar("SELECT id FROM patch_runs WHERE status = 'running'")
            .fetch_all(&state.db)
            .await?;
    for run_id in runs {
        complete_if_done(state, &run_id, now).await?;
    }
    Ok(())
}

/// Marks a run completed once nothing is pending or running.
pub async fn complete_if_done(
    state: &AppState,
    run_id: &str,
    now: DateTime<Utc>,
) -> anyhow::Result<()> {
    let open: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM patch_run_results WHERE run_id = ? AND status IN ('pending', 'running')",
    )
    .bind(run_id)
    .fetch_one(&state.db)
    .await?;
    if open > 0 {
        return Ok(());
    }
    let changed = sqlx::query(
        "UPDATE patch_runs SET status = 'completed', finished_at = ? WHERE id = ? AND status = 'running'",
    )
    .bind(now)
    .bind(run_id)
    .execute(&state.db)
    .await?
    .rows_affected();
    if changed > 0 {
        publish_run(state, run_id).await;
        if let Ok(by_client) = counts_by_client(&state.db, run_id).await {
            for (client, counts) in by_client {
                state.events.publish(
                    "patch_run.completed",
                    Some(client),
                    json!({ "run_id": run_id, "status": "completed", "finished_at": now, "counts": counts }),
                );
            }
        }
    }
    Ok(())
}

/// A device connected: scan when due (or after a reboot), serve its pending window installs.
pub async fn on_connect(state: &AppState, device_id: &str) -> anyhow::Result<()> {
    let ids = [device_id.to_string()];
    let Some(device) = super::load_devices(state, Some(&ids))
        .await?
        .into_iter()
        .next()
    else {
        return Ok(());
    };
    let now = rustrmm_common::now();
    if device.config.enabled {
        let status: Option<(Option<DateTime<Utc>>, bool)> = sqlx::query_as(
            "SELECT last_scan_requested_at, pending_reboot FROM device_patch_status WHERE device_id = ?",
        )
        .bind(device_id)
        .fetch_optional(&state.db)
        .await?;
        let pending_states: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM device_patches WHERE device_id = ? AND state IN ('pending_reboot', 'installing')",
        )
        .bind(device_id)
        .fetch_one(&state.db)
        .await?;
        let (last, reboot) = status.unwrap_or((None, false));
        if reboot || pending_states > 0 || scan_due(last, device.config.scan_interval_hours, now) {
            send_scan(state, device_id, &device.config, None, false).await?;
        }
    }
    let pending: Vec<(String, Option<DateTime<Utc>>)> = sqlx::query_as(
        "SELECT r.run_id, r.window_end FROM patch_run_results r JOIN patch_runs p ON p.id = r.run_id
         WHERE r.device_id = ? AND r.status = 'pending' AND p.status = 'running'",
    )
    .bind(device_id)
    .fetch_all(&state.db)
    .await?;
    if !pending.is_empty() {
        let approvals = approvals::load(&state.db, None).await?;
        for (run_id, end) in pending {
            match end {
                Some(end) if now < end => {
                    serve_device(state, &run_id, &device, end, &approvals, true).await?;
                    publish_run(state, &run_id).await;
                    complete_if_done(state, &run_id, now).await?;
                }
                _ => {}
            }
        }
    }
    Ok(())
}

// ------------------------------------------------------------------ results

async fn patch_ids_for_keys(
    db: &Db,
    device_id: &str,
    keys: &[String],
) -> anyhow::Result<Vec<(String, String)>> {
    let mut out = Vec::new();
    for key in keys {
        let id: Option<String> = sqlx::query_scalar(
            "SELECT c.id FROM device_patches dp JOIN patch_catalog c ON c.id = dp.patch_id WHERE dp.device_id = ? AND c.key = ?",
        )
        .bind(device_id)
        .bind(key)
        .fetch_optional(db)
        .await?;
        if let Some(id) = id {
            out.push((key.clone(), id));
        }
    }
    Ok(out)
}

/// Keys whose install never happened go back to `failed` with a reason.
async fn fail_keys(
    state: &AppState,
    device_id: &str,
    keys: &[String],
    reason: &str,
) -> anyhow::Result<()> {
    let now = rustrmm_common::now();
    for (_, patch_id) in patch_ids_for_keys(&state.db, device_id, keys).await? {
        sqlx::query("UPDATE device_patches SET state = 'failed', last_error = ?, updated_at = ? WHERE device_id = ? AND patch_id = ? AND state = 'installing'")
            .bind(reason.chars().take(500).collect::<String>())
            .bind(now)
            .bind(device_id)
            .bind(&patch_id)
            .execute(&state.db)
            .await?;
    }
    Ok(())
}

/// Applies per-key outcomes to device states; returns (installed, failed).
async fn apply_outcome(
    state: &AppState,
    device_id: &str,
    outcome: &PatchInstallOutcome,
) -> anyhow::Result<(i64, i64)> {
    let now = rustrmm_common::now();
    let keys: Vec<String> = outcome.results.iter().map(|r| r.key.clone()).collect();
    let ids: HashMap<String, String> = patch_ids_for_keys(&state.db, device_id, &keys)
        .await?
        .into_iter()
        .collect();
    let (mut installed, mut failed) = (0, 0);
    for r in &outcome.results {
        let Some(patch_id) = ids.get(&r.key) else {
            continue;
        };
        let (new_state, error) = match r.status.as_str() {
            "installed" => ("installed", None),
            "pending_reboot" => ("pending_reboot", None),
            _ => (
                "failed",
                Some(match (&r.error, r.hresult) {
                    (Some(e), Some(h)) => format!("{e} (0x{:08X})", h as u32),
                    (Some(e), None) => e.clone(),
                    (None, Some(h)) => format!("HRESULT 0x{:08X}", h as u32),
                    (None, None) => "installation failed".into(),
                }),
            ),
        };
        if new_state == "failed" {
            failed += 1;
        } else {
            installed += 1;
        }
        sqlx::query(
            "UPDATE device_patches SET state = ?, last_error = ?, installed_at = CASE WHEN ? = 'failed' THEN installed_at ELSE ? END,
                    updated_at = ? WHERE device_id = ? AND patch_id = ?",
        )
        .bind(new_state)
        .bind(error.map(|e| e.chars().take(500).collect::<String>()))
        .bind(new_state)
        .bind(now)
        .bind(now)
        .bind(device_id)
        .bind(patch_id)
        .execute(&state.db)
        .await?;
    }
    Ok((installed, failed))
}

/// Handles a `patch_install` command result (called from `record_result`).
pub async fn on_install_result(
    state: &AppState,
    device_id: &str,
    result: &CommandResult,
) -> anyhow::Result<()> {
    if result.status == "accepted" {
        return Ok(());
    }
    let row: Option<(String, String, String)> = sqlx::query_as(
        "SELECT run_id, status, keys FROM patch_run_results WHERE command_id = ? AND device_id = ?",
    )
    .bind(&result.cmd_id)
    .bind(device_id)
    .fetch_optional(&state.db)
    .await?;
    let Some((run_id, current, keys)) = row else {
        return Ok(());
    };
    if current != "running" {
        return Ok(());
    }
    let keys: Vec<String> = serde_json::from_str(&keys).unwrap_or_default();
    let outcome: Option<PatchInstallOutcome> = result
        .data
        .get("results")
        .is_some()
        .then(|| serde_json::from_value(result.data.clone()).ok())
        .flatten();
    let now = rustrmm_common::now();
    let (installed, failed) = match &outcome {
        Some(o) => apply_outcome(state, device_id, o).await?,
        None => (0, 0),
    };
    let is_final = matches!(result.status.as_str(), "succeeded" | "failed" | "rejected");
    if !is_final {
        sqlx::query("UPDATE patch_run_results SET installed = ?, failed = ?, updated_at = ? WHERE run_id = ? AND device_id = ?")
            .bind(installed)
            .bind(failed)
            .bind(now)
            .bind(&run_id)
            .bind(device_id)
            .execute(&state.db)
            .await?;
        publish_device(state, device_id).await;
        publish_run(state, &run_id).await;
        return Ok(());
    }
    // Keys the agent did not report on (refused or failed command) did not install.
    let reported: HashSet<&str> = outcome
        .as_ref()
        .map(|o| o.results.iter().map(|r| r.key.as_str()).collect())
        .unwrap_or_default();
    let unreported: Vec<String> = keys
        .iter()
        .filter(|k| !reported.contains(k.as_str()))
        .cloned()
        .collect();
    let message = if result.message.is_empty() {
        format!("The device reported {}", result.status)
    } else {
        result.message.chars().take(500).collect()
    };
    let unreported_failed = if result.status == "succeeded" {
        fail_keys(
            state,
            device_id,
            &unreported,
            "The device did not report this patch",
        )
        .await?;
        unreported.len() as i64
    } else {
        fail_keys(state, device_id, &unreported, &message).await?;
        unreported.len() as i64
    };
    let failed = failed + unreported_failed;
    let rebooting = outcome.as_ref().is_some_and(|o| o.rebooting);
    let reboot_pending = outcome
        .as_ref()
        .is_some_and(|o| o.reboot_required && !o.rebooting);
    let status = if result.status != "succeeded" || failed > 0 {
        "failed"
    } else if reboot_pending {
        "pending_reboot"
    } else {
        "succeeded"
    };
    let error = if result.status != "succeeded" {
        Some(message.clone())
    } else if failed > 0 {
        Some(format!("{failed} patch(es) failed to install"))
    } else {
        None
    };
    sqlx::query(
        "UPDATE patch_run_results SET status = ?, installed = ?, failed = ?, rebooted = ?, error = ?, finished_at = ?, updated_at = ?
         WHERE run_id = ? AND device_id = ?",
    )
    .bind(status)
    .bind(installed)
    .bind(failed)
    .bind(rebooting)
    .bind(&error)
    .bind(now)
    .bind(now)
    .bind(&run_id)
    .bind(device_id)
    .execute(&state.db)
    .await?;
    if reboot_pending || rebooting {
        sqlx::query(
            "UPDATE device_patch_status SET pending_reboot = 1, updated_at = ? WHERE device_id = ?",
        )
        .bind(now)
        .bind(device_id)
        .execute(&state.db)
        .await?;
    }
    let hostname: String = sqlx::query_scalar("SELECT hostname FROM devices WHERE id = ?")
        .bind(device_id)
        .fetch_optional(&state.db)
        .await?
        .unwrap_or_default();
    let (kind, severity, summary) = if status == "failed" {
        (
            "patch.install_failed",
            "warning",
            format!(
                "Patch installation failed: {}",
                error.clone().unwrap_or_default()
            ),
        )
    } else {
        (
            "patch.installed",
            "info",
            format!("{installed} patch(es) installed"),
        )
    };
    let _ = crate::agents::timeline(
        &state.db,
        device_id,
        kind,
        severity,
        &summary,
        json!({ "run_id": run_id, "installed": installed, "failed": failed, "rebooting": rebooting }),
    )
    .await;
    // Failures raise a server-side alert; a clean run clears it.
    if status == "failed" {
        let raised = alerts::raise(
            state,
            Raise {
                device_id: device_id.to_string(),
                source: "server",
                check_id: ALERT_CHECK_ID.into(),
                check_type: "patching".into(),
                severity: "warning".into(),
                title: format!("Patch installation failed on {hostname}"),
                message: error.clone().unwrap_or_default(),
                policy_id: None,
                remediation: None,
                repeat: true,
            },
        )
        .await;
        if let Err(e) = raised {
            tracing::warn!(device = device_id, error = %format!("{e:#}"), "raising the patch failure alert failed");
        }
    } else if let Err(e) = alerts::clear(
        state,
        device_id,
        ALERT_CHECK_ID,
        "Patches installed successfully",
    )
    .await
    {
        tracing::warn!(device = device_id, error = %format!("{e:#}"), "clearing the patch failure alert failed");
    }
    // Refresh the device's state after a successful install.
    if installed > 0 && !rebooting {
        let ids = [device_id.to_string()];
        if let Some(device) = super::load_devices(state, Some(&ids))
            .await?
            .into_iter()
            .next()
            && let Err(e) = send_scan(state, device_id, &device.config, None, false).await
        {
            tracing::debug!(device = device_id, error = %format!("{e:#}"), "post-install scan not sent");
        }
    }
    publish_device(state, device_id).await;
    publish_run(state, &run_id).await;
    complete_if_done(state, &run_id, now).await
}

/// Creates a manual run for an immediate install and sends it.
pub async fn install_now(
    state: &AppState,
    device: &DeviceCtx,
    patches: &[MissingPatch],
    reboot: RebootSpec,
    actor_id: &str,
) -> anyhow::Result<(String, Dispatch)> {
    let run_id = rustrmm_common::new_id();
    let now = rustrmm_common::now();
    sqlx::query(
        "INSERT INTO patch_runs (id, policy_id, policy_name, window_start, window_end, status, trigger_kind, created_at)
         VALUES (?, NULL, 'Immediate install', ?, ?, 'running', 'manual', ?)",
    )
    .bind(&run_id)
    .bind(now)
    .bind(now)
    .bind(now)
    .execute(&state.db)
    .await?;
    let dispatch = send_install(
        state,
        &run_id,
        device,
        patches,
        reboot,
        None,
        Some(actor_id),
    )
    .await;
    if dispatch.is_err() {
        sqlx::query("UPDATE patch_runs SET status = 'cancelled', finished_at = ? WHERE id = ?")
            .bind(now)
            .bind(&run_id)
            .execute(&state.db)
            .await?;
    }
    let dispatch = dispatch?;
    publish_run(state, &run_id).await;
    Ok((run_id, dispatch))
}

// ------------------------------------------------------------------ counts and events

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct RunCounts {
    pub total: i64,
    pub succeeded: i64,
    pub failed: i64,
    pub pending_reboot: i64,
    /// Pending and running.
    pub pending: i64,
    pub skipped: i64,
}

impl RunCounts {
    pub fn add(&mut self, status: &str) {
        self.total += 1;
        match status {
            "succeeded" => self.succeeded += 1,
            "failed" => self.failed += 1,
            "pending_reboot" => self.pending_reboot += 1,
            "pending" | "running" => self.pending += 1,
            _ => self.skipped += 1,
        }
    }
}

/// Run counts per client (events never carry other tenants' numbers).
pub async fn counts_by_client(
    db: &Db,
    run_id: &str,
) -> anyhow::Result<BTreeMap<String, RunCounts>> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT s.client_id, r.status FROM patch_run_results r JOIN devices d ON d.id = r.device_id JOIN sites s ON s.id = d.site_id
         WHERE r.run_id = ?",
    )
    .bind(run_id)
    .fetch_all(db)
    .await?;
    let mut out: BTreeMap<String, RunCounts> = BTreeMap::new();
    for (client, status) in rows {
        out.entry(client).or_default().add(&status);
    }
    Ok(out)
}

/// `patch_run.updated` per client with that client's counts.
pub async fn publish_run(state: &AppState, run_id: &str) {
    let Ok(by_client) = counts_by_client(&state.db, run_id).await else {
        return;
    };
    for (client, counts) in by_client {
        state.events.publish(
            "patch_run.updated",
            Some(client),
            json!({ "run_id": run_id, "counts": counts }),
        );
    }
}

pub async fn publish_device(state: &AppState, device_id: &str) {
    let client: Option<String> = sqlx::query_scalar(
        "SELECT s.client_id FROM devices d JOIN sites s ON s.id = d.site_id WHERE d.id = ?",
    )
    .bind(device_id)
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten();
    if let Some(client) = client {
        state.events.publish(
            "patches.changed",
            Some(client),
            json!({ "device_id": device_id }),
        );
    }
}

/// Result data of a run for the API.
pub fn result_json(row: &(String, String, String, i64, i64, bool, Option<String>)) -> Value {
    let (device_id, hostname, status, installed, failed, rebooted, error) = row;
    json!({ "device_id": device_id, "hostname": hostname, "status": status, "installed": installed,
            "failed": failed, "rebooted": rebooted, "error": error })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::patching::approvals::Approval;
    use crate::patching::policy::DelayDays;

    fn patch(
        id: &str,
        platform: &str,
        classification: &str,
        state: &str,
        attempts: i64,
    ) -> MissingPatch {
        MissingPatch {
            patch_id: id.into(),
            key: format!("key-{id}"),
            platform: platform.into(),
            classification: classification.into(),
            severity: None,
            release_date: Some(
                (rustrmm_common::now() - chrono::Duration::days(10))
                    .format("%Y-%m-%d")
                    .to_string(),
            ),
            first_seen_at: rustrmm_common::now(),
            state: state.into(),
            attempts,
        }
    }

    fn approved(source: &str, client: Option<&str>) -> Approval {
        Approval {
            decision: "approved".into(),
            until: None,
            source: source.into(),
            at: rustrmm_common::now() - chrono::Duration::days(20),
            by_name: String::new(),
            client_id: client.map(str::to_string),
            delay_days: DelayDays::default(),
        }
    }

    #[test]
    fn installable_patches_follow_approvals_and_config() {
        let now = rustrmm_common::now();
        let mut config = PatchingConfig::default();
        let missing = vec![
            patch("a", "windows", "SecurityUpdates", "missing", 0),
            patch("b", "windows", "Updates", "missing", 0),
            patch("c", "windows", "SecurityUpdates", "failed", 3),
            patch("d", "linux", "bugfix", "missing", 0),
            patch("e", "linux", "bugfix", "missing", 0),
            patch("f", "macos", "os", "missing", 0),
        ];
        let mut map = HashMap::new();
        for id in ["a", "c", "f"] {
            map.insert(
                id.to_string(),
                PatchApprovals {
                    global: Some(approved("manual", None)),
                    clients: HashMap::new(),
                },
            );
        }
        let mut rule_only = PatchApprovals::default();
        rule_only
            .clients
            .insert("c1".into(), approved("rule", Some("c1")));
        map.insert("d".into(), rule_only);
        map.insert(
            "e".into(),
            PatchApprovals {
                global: Some(approved("manual", None)),
                clients: HashMap::new(),
            },
        );
        let keys =
            |list: Vec<MissingPatch>| list.into_iter().map(|p| p.patch_id).collect::<Vec<_>>();
        // b is not approved, c failed too often, d is a rule-approved bugfix in security mode,
        // f is macOS without installs.
        assert_eq!(
            keys(installable("c1", &config, &missing, &map, now)),
            vec!["a", "e"]
        );
        config.linux_mode = "all".into();
        config.macos_install = true;
        assert_eq!(
            keys(installable("c1", &config, &missing, &map, now)),
            vec!["a", "d", "e", "f"]
        );
        assert!(scan_due(None, 12, now));
        assert!(!scan_due(Some(now - chrono::Duration::hours(2)), 12, now));
        assert!(scan_due(Some(now - chrono::Duration::hours(13)), 12, now));
        let mut counts = RunCounts::default();
        for s in [
            "succeeded",
            "failed",
            "running",
            "pending",
            "skipped",
            "pending_reboot",
        ] {
            counts.add(s);
        }
        assert_eq!(
            counts,
            RunCounts {
                total: 6,
                succeeded: 1,
                failed: 1,
                pending_reboot: 1,
                pending: 2,
                skipped: 1
            }
        );
    }
}
