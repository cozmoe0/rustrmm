//! `rustrmm-server restore` — offline restore of a backup archive into a data directory.

use std::path::Path;

use anyhow::{Context, Result, bail};

use super::archive;
use crate::config::RestoreArgs;

pub async fn run(args: RestoreArgs) -> Result<()> {
    let data = args.data_dir.clone();
    std::fs::create_dir_all(&data)?;
    let _lock = crate::lockfile::acquire(&data).context(
        "another RustRMM server is using this data directory — stop it before restoring",
    )?;

    let identity = std::fs::read_to_string(&args.identity_file)
        .with_context(|| format!("reading identity file {}", args.identity_file.display()))?;
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S").to_string();
    let staging = data.join(format!("restore-staging-{stamp}"));
    let archive_path = args.file.clone();
    let staging_clone = staging.clone();
    let manifest = tokio::task::spawn_blocking(move || {
        archive::extract(&archive_path, &identity, &staging_clone)
    })
    .await?
    .context("extracting backup")?;
    super::integrity_check(&staging.join(archive::DB_ENTRY))
        .await
        .context("restored database is damaged")?;

    let previous = data.join(format!("pre-restore-{stamp}"));
    std::fs::create_dir_all(&previous)?;
    for name in ["rustrmm.db", "rustrmm.db-wal", "rustrmm.db-shm"] {
        move_if_exists(&data.join(name), &previous.join(name))?;
    }
    // The master key may live in keys/ (default when not supplied as a secret) — keep it.
    let master_key = std::fs::read(data.join("keys").join("master.key")).ok();
    for dir in ["keys", "pki", "files"] {
        let has_restored = staging.join(dir).exists();
        if dir == "files" && !has_restored {
            continue;
        }
        move_if_exists(&data.join(dir), &previous.join(dir))?;
        if has_restored {
            std::fs::rename(staging.join(dir), data.join(dir))?;
        } else {
            std::fs::create_dir_all(data.join(dir))?;
        }
    }
    if let Some(key) = master_key {
        let path = data.join("keys").join("master.key");
        if !path.exists() {
            rustrmm_crypto::keyfile::write_private(&path, &key)?;
        }
    }
    std::fs::rename(staging.join(archive::DB_ENTRY), data.join("rustrmm.db"))?;
    std::fs::remove_dir_all(&staging).ok();

    println!("Restore complete.");
    println!(
        "  backup created: {} (RustRMM {}, schema {})",
        manifest.created_at, manifest.version, manifest.schema_version
    );
    println!("  previous data moved to: {}", previous.display());
    println!();
    println!(
        "The restored keys are wrapped by the master key that was in use when the backup was taken."
    );
    println!(
        "If this is a new machine, install that master key (from your recovery kit) before starting the server."
    );
    Ok(())
}

fn move_if_exists(from: &Path, to: &Path) -> Result<()> {
    if !from.exists() {
        return Ok(());
    }
    if to.exists() {
        bail!("{} already exists", to.display());
    }
    std::fs::rename(from, to).with_context(|| format!("moving {} aside", from.display()))
}
