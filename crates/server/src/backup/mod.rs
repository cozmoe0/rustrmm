//! Automatic database backups.
//!
//! Scheduled (cron), on demand, and automatically before every schema migration. Each run takes
//! a consistent `VACUUM INTO` snapshot, verifies it with `PRAGMA integrity_check`, packs it with
//! the wrapped key files into an age-encrypted archive, writes it to the local backup directory
//! and/or S3, then applies grandfather-father-son retention.

pub mod archive;
pub mod restore;
pub mod s3;

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use chrono::{DateTime, Datelike, Local, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{ConnectOptions, Connection, FromRow};
use tokio::sync::{Mutex, Notify};

use crate::audit::{Actor, AuditEntry, AuditLog};
use crate::config::ServeArgs;
use crate::db::{self, Db};
use crate::state::AppState;
use rustrmm_crypto::field::FieldCipher;

pub const SETTINGS_KEY: &str = "backups";
const S3_SECRET_AAD: &str = "settings/backups/s3_secret";
const PRE_MIGRATION_KEEP: usize = 5;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Retention {
    pub hourly: u32,
    pub daily: u32,
    pub weekly: u32,
    pub monthly: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct S3Settings {
    pub enabled: bool,
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub prefix: String,
    pub access_key_id: String,
    /// base64 of the field-encrypted secret access key.
    #[serde(default)]
    pub secret_enc: Option<String>,
    #[serde(default)]
    pub object_lock_days: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupSettings {
    pub enabled: bool,
    pub schedule_cron: String,
    pub retention: Retention,
    pub include_files: bool,
    /// age X25519 recipient (public key) — the matching identity lives only in the recovery kit.
    pub recipient: String,
    pub local_enabled: bool,
    pub s3: S3Settings,
}

impl BackupSettings {
    pub fn initial(recipient: String) -> Self {
        Self {
            enabled: true,
            schedule_cron: "0 2 * * *".into(),
            retention: Retention {
                hourly: 24,
                daily: 14,
                weekly: 8,
                monthly: 12,
            },
            include_files: false,
            recipient,
            local_enabled: true,
            s3: S3Settings {
                region: "us-east-1".into(),
                prefix: "rustrmm".into(),
                ..S3Settings::default()
            },
        }
    }

    pub fn s3_secret(&self, cipher: &FieldCipher) -> Result<Option<String>> {
        let Some(enc) = &self.s3.secret_enc else {
            return Ok(None);
        };
        let blob = STANDARD.decode(enc).context("corrupt S3 secret")?;
        Ok(Some(
            cipher.decrypt_string(&blob, S3_SECRET_AAD)?.to_string(),
        ))
    }

    pub fn set_s3_secret(&mut self, cipher: &FieldCipher, secret: &str) {
        self.s3.secret_enc = Some(STANDARD.encode(cipher.encrypt_str(secret, S3_SECRET_AAD)));
    }

    pub fn s3_target(&self, cipher: &FieldCipher) -> Result<Option<s3::S3Target>> {
        if !self.s3.enabled {
            return Ok(None);
        }
        let secret = self
            .s3_secret(cipher)?
            .context("S3 secret access key is not set")?;
        Ok(Some(s3::S3Target {
            endpoint: self.s3.endpoint.clone(),
            region: self.s3.region.clone(),
            bucket: self.s3.bucket.clone(),
            prefix: self.s3.prefix.clone(),
            access_key_id: self.s3.access_key_id.clone(),
            secret_access_key: secret,
        }))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    Schedule,
    Manual,
    PreMigration,
}

impl Trigger {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Schedule => "schedule",
            Self::Manual => "manual",
            Self::PreMigration => "pre_migration",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DestinationResult {
    pub kind: String,
    pub status: String,
    pub location: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, FromRow)]
pub struct BackupRow {
    pub id: String,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
    pub status: String,
    pub trigger_kind: String,
    pub file_name: Option<String>,
    pub size_bytes: Option<i64>,
    pub sha256: Option<String>,
    pub destinations: String,
    pub error: Option<String>,
}

pub const ROW_COLUMNS: &str = "id, started_at, finished_at, status, trigger_kind, file_name, size_bytes, sha256, destinations, error";

pub fn validate_cron(expr: &str) -> bool {
    croner::Cron::from_str(expr).is_ok()
}

pub fn next_run(expr: &str, from: DateTime<Local>) -> Option<DateTime<Local>> {
    croner::Cron::from_str(expr)
        .ok()?
        .find_next_occurrence(&from, false)
        .ok()
}

/// Maps a timestamp to its retention bucket (hour, day, ISO week or month).
type BucketKey = fn(&DateTime<Utc>) -> String;

/// Backups whose ids should be kept under grandfather-father-son retention.
pub fn select_keep(backups: &[(String, DateTime<Utc>)], retention: &Retention) -> HashSet<String> {
    let mut sorted: Vec<&(String, DateTime<Utc>)> = backups.iter().collect();
    sorted.sort_by_key(|b| std::cmp::Reverse(b.1));
    let mut keep = HashSet::new();
    if let Some(newest) = sorted.first() {
        keep.insert(newest.0.clone());
    }
    let buckets: [(u32, BucketKey); 4] = [
        (retention.hourly, |t| t.format("%Y%m%d%H").to_string()),
        (retention.daily, |t| t.format("%Y%m%d").to_string()),
        (retention.weekly, |t| {
            let w = t.iso_week();
            format!("{}-{}", w.year(), w.week())
        }),
        (retention.monthly, |t| t.format("%Y%m").to_string()),
    ];
    for (count, key_fn) in buckets {
        let mut seen = HashSet::new();
        for (id, at) in &sorted {
            if seen.len() >= count as usize {
                break;
            }
            if seen.insert(key_fn(at)) {
                keep.insert(id.clone());
            }
        }
    }
    keep
}

struct Outcome {
    file_name: String,
    size_bytes: u64,
    sha256: String,
    destinations: Vec<DestinationResult>,
}

/// Runs one backup without needing the full application state (used before migrations).
pub async fn perform(
    db: &Db,
    args: &ServeArgs,
    cipher: &FieldCipher,
    server_identity: &str,
    trigger: Trigger,
) -> Result<BackupRow> {
    let settings: BackupSettings = db::get_setting(db, SETTINGS_KEY)
        .await?
        .context("Backups are not configured yet — finish first-run setup")?;
    if !settings.local_enabled && !settings.s3.enabled {
        bail!("No backup destination is enabled");
    }
    let id = rustrmm_common::new_id();
    let started = rustrmm_common::now();
    sqlx::query(
        "INSERT INTO backups (id, started_at, status, trigger_kind) VALUES (?, ?, 'running', ?)",
    )
    .bind(&id)
    .bind(started)
    .bind(trigger.as_str())
    .execute(db)
    .await?;

    let result = build_and_ship(db, args, cipher, server_identity, &settings, &id).await;
    let finished = rustrmm_common::now();
    match &result {
        Ok(out) => {
            sqlx::query(
                "UPDATE backups SET status = 'ok', finished_at = ?, file_name = ?, size_bytes = ?, sha256 = ?, destinations = ?
                 WHERE id = ?",
            )
            .bind(finished)
            .bind(&out.file_name)
            .bind(out.size_bytes as i64)
            .bind(&out.sha256)
            .bind(serde_json::to_string(&out.destinations)?)
            .bind(&id)
            .execute(db)
            .await?;
        }
        Err(e) => {
            sqlx::query(
                "UPDATE backups SET status = 'failed', finished_at = ?, error = ? WHERE id = ?",
            )
            .bind(finished)
            .bind(format!("{e:#}").chars().take(2000).collect::<String>())
            .bind(&id)
            .execute(db)
            .await?;
        }
    }
    let row: BackupRow = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {ROW_COLUMNS} FROM backups WHERE id = ?"
    )))
    .bind(&id)
    .fetch_one(db)
    .await?;
    if result.is_ok()
        && let Err(e) = apply_retention(db, args, cipher, &settings).await
    {
        tracing::warn!(error = %format!("{e:#}"), "backup retention pruning failed");
    }
    result.map(|_| row)
}

async fn build_and_ship(
    db: &Db,
    args: &ServeArgs,
    cipher: &FieldCipher,
    server_identity: &str,
    settings: &BackupSettings,
    id: &str,
) -> Result<Outcome> {
    let tmp = args.tmp_dir();
    tokio::fs::create_dir_all(&tmp).await?;
    let snapshot = tmp.join(format!("snapshot-{id}.db"));
    let _ = tokio::fs::remove_file(&snapshot).await;
    let snapshot_str = snapshot
        .to_str()
        .context("temporary path is not UTF-8")?
        .to_string();
    sqlx::query("VACUUM INTO ?")
        .bind(&snapshot_str)
        .execute(db)
        .await
        .context("taking database snapshot")?;
    let guard = TempFile(snapshot.clone());

    integrity_check(&snapshot).await?;
    let schema_version: i64 =
        sqlx::query_scalar("SELECT COALESCE(MAX(version), 0) FROM _sqlx_migrations")
            .fetch_one(db)
            .await
            .unwrap_or(0);
    let now = rustrmm_common::now();
    let file_name = format!(
        "rustrmm-backup-{}-{}.tar.zst.age",
        now.format("%Y%m%d-%H%M%S"),
        &id[id.len().saturating_sub(8)..]
    );
    let backup_dir = args.backup_path();
    tokio::fs::create_dir_all(&backup_dir).await?;
    let staging = if settings.local_enabled {
        backup_dir.join(format!("{file_name}.partial"))
    } else {
        tmp.join(&file_name)
    };

    let manifest = archive::Manifest {
        product: rustrmm_common::PRODUCT_NAME.into(),
        version: rustrmm_common::VERSION.into(),
        created_at: now,
        schema_version,
        includes_files: settings.include_files,
        server_identity: server_identity.to_string(),
    };
    let (keys_dir, pki_dir, files_dir) = (args.keys_dir(), args.pki_dir(), args.files_dir());
    let include_files = settings.include_files;
    let recipient = settings.recipient.clone();
    let staging_clone = staging.clone();
    let snapshot_clone = snapshot.clone();
    let output = tokio::task::spawn_blocking(move || {
        archive::create(
            &archive::ArchiveInputs {
                snapshot: &snapshot_clone,
                keys_dir: &keys_dir,
                pki_dir: &pki_dir,
                files_dir: include_files.then_some(files_dir.as_path()),
                manifest: &manifest,
                recipient: &recipient,
            },
            &staging_clone,
        )
    })
    .await??;
    drop(guard);

    let mut destinations = Vec::new();
    let local_final = backup_dir.join(&file_name);
    if settings.local_enabled {
        tokio::fs::rename(&staging, &local_final)
            .await
            .context("finalising local backup")?;
        destinations.push(DestinationResult {
            kind: "local".into(),
            status: "ok".into(),
            location: Some(local_final.display().to_string()),
            error: None,
        });
    }
    let source = if settings.local_enabled {
        local_final.clone()
    } else {
        staging.clone()
    };
    match settings.s3_target(cipher) {
        Ok(Some(target)) => match target.upload(&source, &file_name).await {
            Ok(location) => destinations.push(DestinationResult {
                kind: "s3".into(),
                status: "ok".into(),
                location: Some(location),
                error: None,
            }),
            Err(e) => destinations.push(DestinationResult {
                kind: "s3".into(),
                status: "failed".into(),
                location: Some(target.location(&file_name)),
                error: Some(format!("{e:#}")),
            }),
        },
        Ok(None) => {}
        Err(e) => destinations.push(DestinationResult {
            kind: "s3".into(),
            status: "failed".into(),
            location: None,
            error: Some(format!("{e:#}")),
        }),
    }
    if !settings.local_enabled {
        let _ = tokio::fs::remove_file(&staging).await;
    }
    if destinations.iter().all(|d| d.status != "ok") {
        bail!(
            "backup could not be stored: {}",
            destinations
                .iter()
                .filter_map(|d| d.error.clone())
                .collect::<Vec<_>>()
                .join("; ")
        );
    }
    Ok(Outcome {
        file_name,
        size_bytes: output.size_bytes,
        sha256: output.sha256,
        destinations,
    })
}

/// Removes a temporary file on drop.
struct TempFile(PathBuf);

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Opens a database file read-only and runs `PRAGMA integrity_check`.
pub async fn integrity_check(path: &Path) -> Result<()> {
    let mut conn = SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .connect()
        .await
        .context("opening snapshot")?;
    let result: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(&mut conn)
        .await?;
    conn.close().await.ok();
    if result != "ok" {
        bail!("snapshot failed integrity check: {result}");
    }
    Ok(())
}

async fn apply_retention(
    db: &Db,
    args: &ServeArgs,
    cipher: &FieldCipher,
    settings: &BackupSettings,
) -> Result<()> {
    let rows: Vec<BackupRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {ROW_COLUMNS} FROM backups WHERE status = 'ok' ORDER BY started_at DESC"
    )))
    .fetch_all(db)
    .await?;
    let regular: Vec<(String, DateTime<Utc>)> = rows
        .iter()
        .filter(|r| r.trigger_kind != "pre_migration")
        .map(|r| (r.id.clone(), r.started_at))
        .collect();
    let mut keep = select_keep(&regular, &settings.retention);
    keep.extend(
        rows.iter()
            .filter(|r| r.trigger_kind == "pre_migration")
            .take(PRE_MIGRATION_KEEP)
            .map(|r| r.id.clone()),
    );
    let target = settings.s3_target(cipher).ok().flatten();
    for row in rows.iter().filter(|r| !keep.contains(&r.id)) {
        delete_artifacts(args, target.as_ref(), row).await;
        sqlx::query("DELETE FROM backups WHERE id = ?")
            .bind(&row.id)
            .execute(db)
            .await?;
        tracing::info!(backup = %row.id, "pruned backup by retention policy");
    }
    let cutoff = rustrmm_common::now() - chrono::Duration::days(30);
    sqlx::query("DELETE FROM backups WHERE status = 'failed' AND started_at < ?")
        .bind(cutoff)
        .execute(db)
        .await?;
    Ok(())
}

/// Deletes a backup's local file and S3 object (best effort).
pub async fn delete_artifacts(args: &ServeArgs, target: Option<&s3::S3Target>, row: &BackupRow) {
    let Some(file_name) = &row.file_name else {
        return;
    };
    let local = args.backup_path().join(file_name);
    if local.exists()
        && let Err(e) = tokio::fs::remove_file(&local).await
    {
        tracing::warn!(path = %local.display(), error = %e, "could not delete backup file");
    }
    let shipped_to_s3 = serde_json::from_str::<Vec<DestinationResult>>(&row.destinations)
        .unwrap_or_default()
        .iter()
        .any(|d| d.kind == "s3" && d.status == "ok");
    if shipped_to_s3
        && let Some(target) = target
        && let Err(e) = target.delete(file_name).await
    {
        tracing::warn!(file = %file_name, error = %format!("{e:#}"), "could not delete S3 backup object");
    }
}

/// Serialises backup runs and wakes the scheduler when settings change.
pub struct BackupService {
    running: Mutex<()>,
    notify: Notify,
}

impl Default for BackupService {
    fn default() -> Self {
        Self::new()
    }
}

impl BackupService {
    pub fn new() -> Self {
        Self {
            running: Mutex::new(()),
            notify: Notify::new(),
        }
    }

    pub fn notify_settings_changed(&self) {
        self.notify.notify_one();
    }

    pub fn is_running(&self) -> bool {
        self.running.try_lock().is_err()
    }

    /// Runs a backup with auditing and live events. Fails fast if one is already running.
    pub async fn run(&self, state: &AppState, trigger: Trigger, actor: Actor) -> Result<BackupRow> {
        let Ok(_guard) = self.running.try_lock() else {
            bail!("A backup is already running")
        };
        state
            .events
            .publish("backups.changed", None, json!({ "status": "running" }));
        let identity = state.keys.identity_public().to_string();
        let result = perform(&state.db, &state.args, &state.cipher, &identity, trigger).await;
        let entry = match &result {
            Ok(row) => AuditEntry::new(actor, "backup.completed")
                .target("backup", &row.id, row.file_name.clone().unwrap_or_default())
                .details(json!({
                    "trigger": trigger.as_str(),
                    "size_bytes": row.size_bytes,
                    "sha256": row.sha256,
                })),
            Err(e) => AuditEntry::new(actor, "backup.failed")
                .details(json!({ "trigger": trigger.as_str(), "error": format!("{e:#}") })),
        };
        state.audit.record_or_log(&state.db, entry).await;
        state.events.publish(
            "backups.changed",
            None,
            json!({ "status": if result.is_ok() { "ok" } else { "failed" } }),
        );
        result
    }

    pub fn spawn_scheduler(state: AppState) {
        tokio::spawn(async move {
            loop {
                let settings: Option<BackupSettings> = db::get_setting(&state.db, SETTINGS_KEY)
                    .await
                    .ok()
                    .flatten();
                let next = settings
                    .as_ref()
                    .filter(|s| s.enabled)
                    .and_then(|s| next_run(&s.schedule_cron, Local::now()));
                let Some(at) = next else {
                    state.backups.notify.notified().await;
                    continue;
                };
                let wait = (at - Local::now()).to_std().unwrap_or(Duration::ZERO);
                tracing::debug!(next = %at, "next scheduled backup");
                tokio::select! {
                    _ = tokio::time::sleep(wait) => {
                        if let Err(e) = state.backups.run(&state, Trigger::Schedule, Actor::System).await {
                            tracing::error!(error = %format!("{e:#}"), "scheduled backup failed");
                        }
                        // Avoid double-firing within the same minute.
                        tokio::time::sleep(Duration::from_secs(61)).await;
                    }
                    _ = state.backups.notify.notified() => {}
                }
            }
        });
    }
}

/// Startup hook: take a backup before applying pending migrations to an existing database.
pub async fn pre_migration(db: &Db, args: &ServeArgs, cipher: &FieldCipher, server_identity: &str) {
    match perform(db, args, cipher, server_identity, Trigger::PreMigration).await {
        Ok(row) => {
            tracing::info!(file = ?row.file_name, "pre-migration backup written");
            AuditLog::new()
                .record_or_log(
                    db,
                    AuditEntry::new(Actor::System, "backup.completed")
                        .details(json!({ "trigger": "pre_migration" })),
                )
                .await;
        }
        Err(e) => tracing::warn!(error = %format!("{e:#}"), "pre-migration backup skipped"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn cron_helpers() {
        assert!(validate_cron("0 2 * * *"));
        assert!(validate_cron("*/15 * * * *"));
        assert!(!validate_cron("not a cron"));
        let from = Local
            .with_ymd_and_hms(2026, 1, 1, 1, 0, 0)
            .single()
            .expect("valid time");
        let next = next_run("0 2 * * *", from).expect("next");
        assert_eq!(next.format("%H:%M").to_string(), "02:00");
    }

    #[test]
    fn gfs_retention_keeps_expected_points() {
        let base = Utc
            .with_ymd_and_hms(2026, 3, 31, 23, 0, 0)
            .single()
            .expect("time");
        // One backup per hour for 60 days.
        let backups: Vec<(String, DateTime<Utc>)> = (0..24 * 60)
            .map(|h| (format!("b{h}"), base - chrono::Duration::hours(h)))
            .collect();
        let keep = select_keep(
            &backups,
            &Retention {
                hourly: 24,
                daily: 7,
                weekly: 4,
                monthly: 3,
            },
        );
        assert!(keep.contains("b0"));
        // 24 hourly + up to 7 daily + up to 4 weekly + up to 3 monthly, with overlaps.
        assert!(
            keep.len() >= 24 && keep.len() <= 24 + 7 + 4 + 3,
            "kept {}",
            keep.len()
        );
        assert!(
            !keep.contains("b30"),
            "an arbitrary mid-day hourly backup from yesterday is pruned"
        );
    }
}
