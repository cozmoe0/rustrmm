//! SQLite pool, migrations and small shared query helpers.

use std::path::Path;
use std::str::FromStr;
use std::time::Duration;

use anyhow::{Context, Result};
use serde::Serialize;
use serde::de::DeserializeOwned;
use sqlx::SqlitePool;
use sqlx::migrate::Migrator;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};

pub static MIGRATOR: Migrator = sqlx::migrate!("./migrations");

pub type Db = SqlitePool;

fn options(path: &Path) -> SqliteConnectOptions {
    SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(10))
        .pragma("temp_store", "memory")
        .pragma("cache_size", "-16000")
}

/// Opens (creating if needed) the database file with production pragmas.
pub async fn connect(path: &Path) -> Result<Db> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }
    SqlitePoolOptions::new()
        .max_connections(8)
        .min_connections(1)
        .connect_with(options(path))
        .await
        .with_context(|| format!("opening database {}", path.display()))
}

/// In-memory database for tests (single shared connection).
pub async fn connect_memory() -> Result<Db> {
    let opts = SqliteConnectOptions::from_str("sqlite::memory:")?.foreign_keys(true);
    Ok(SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(opts)
        .await?)
}

/// Number of migrations embedded in the binary that the database has not applied yet.
/// Returns `None` for a brand-new database (no migrations table).
pub async fn pending_migrations(db: &Db) -> Result<Option<usize>> {
    let has_table: Option<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_sqlx_migrations'",
    )
    .fetch_optional(db)
    .await?;
    if has_table.is_none() {
        return Ok(None);
    }
    let applied: Vec<i64> =
        sqlx::query_scalar("SELECT version FROM _sqlx_migrations WHERE success = 1")
            .fetch_all(db)
            .await?;
    Ok(Some(
        MIGRATOR
            .iter()
            .filter(|m| !applied.contains(&m.version))
            .count(),
    ))
}

pub async fn migrate(db: &Db) -> Result<()> {
    MIGRATOR
        .run(db)
        .await
        .context("running database migrations")
}

/// Reads a JSON setting.
pub async fn get_setting<T: DeserializeOwned>(db: &Db, key: &str) -> Result<Option<T>> {
    let raw: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = ?")
        .bind(key)
        .fetch_optional(db)
        .await?;
    raw.map(|v| serde_json::from_str(&v).with_context(|| format!("decoding setting {key}")))
        .transpose()
}

/// Writes a JSON setting (upsert).
pub async fn set_setting<T: Serialize>(db: &Db, key: &str, value: &T) -> Result<()> {
    let json = serde_json::to_string(value)?;
    sqlx::query(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .bind(key)
    .bind(json)
    .bind(rustrmm_common::now())
    .execute(db)
    .await?;
    Ok(())
}

/// Size in bytes of the database file and its WAL.
pub fn file_sizes(path: &Path) -> (u64, u64) {
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let mut wal = path.as_os_str().to_owned();
    wal.push("-wal");
    let wal_size = std::fs::metadata(Path::new(&wal))
        .map(|m| m.len())
        .unwrap_or(0);
    (size, wal_size)
}
