//! Exclusive lock on the data directory so two servers (or a server and a restore) never share it.

use std::fs::{File, OpenOptions};
use std::path::Path;

use anyhow::{Context, Result};

/// Held for the lifetime of the process; the OS releases it on exit.
pub struct DataLock {
    _file: File,
}

pub fn acquire(data_dir: &Path) -> Result<DataLock> {
    let path = data_dir.join(".lock");
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&path)
        .with_context(|| format!("opening {}", path.display()))?;
    file.try_lock()
        .map_err(|e| anyhow::anyhow!("data directory {} is locked: {e}", data_dir.display()))?;
    Ok(DataLock { _file: file })
}
