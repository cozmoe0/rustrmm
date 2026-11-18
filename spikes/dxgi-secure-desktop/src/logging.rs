//! Minimal append-only file logger. The service and the helper have no
//! console, so everything they observe goes to C:\ProgramData\RustRMMSpike\logs.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

static SINK: Mutex<Option<File>> = Mutex::new(None);
static ECHO: AtomicBool = AtomicBool::new(false);

pub fn init(path: &Path, echo_to_stderr: bool) -> anyhow::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let file = OpenOptions::new().create(true).append(true).open(path)?;
    *SINK.lock().unwrap_or_else(|p| p.into_inner()) = Some(file);
    ECHO.store(echo_to_stderr, Ordering::Relaxed);
    Ok(())
}

pub fn echoing() -> bool {
    ECHO.load(Ordering::Relaxed)
}

pub fn write(args: std::fmt::Arguments<'_>) {
    let line = format!(
        "{} [{:>5}] {}\n",
        crate::util::timestamp(),
        crate::util::thread_id(),
        args
    );
    if ECHO.load(Ordering::Relaxed) {
        eprint!("{line}");
    }
    let mut sink = SINK.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(file) = sink.as_mut() {
        let _ = file.write_all(line.as_bytes());
    }
}
