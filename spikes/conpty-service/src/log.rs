//! Minimal line logger: stdout in console mode, an append-only file in service mode
//! (services have no console, so stdout goes nowhere).

use std::fmt;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;

use windows::Win32::System::SystemInformation::GetLocalTime;

struct Sink {
    stdout: bool,
    file: Option<File>,
}

static SINK: Mutex<Sink> = Mutex::new(Sink { stdout: true, file: None });

/// Redirects all further log lines to `path` (appending) instead of stdout.
pub fn to_file(path: &Path) -> std::io::Result<()> {
    let file = OpenOptions::new().create(true).append(true).open(path)?;
    let mut sink = SINK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    sink.stdout = false;
    sink.file = Some(file);
    Ok(())
}

pub fn write(args: fmt::Arguments<'_>) {
    // SAFETY: GetLocalTime has no preconditions.
    let t = unsafe { GetLocalTime() };
    let current = std::thread::current();
    let thread = match current.name() {
        Some(name) => name.to_owned(),
        None => format!("{:?}", current.id()),
    };
    let line = format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:03} [{thread}] {args}\n",
        t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond, t.wMilliseconds
    );
    let mut sink = SINK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if sink.stdout {
        let mut out = std::io::stdout().lock();
        let _ = out.write_all(line.as_bytes());
        let _ = out.flush();
    }
    if let Some(file) = sink.file.as_mut() {
        // Flush every line: the point of the file is post-mortem reading.
        let _ = file.write_all(line.as_bytes());
        let _ = file.flush();
    }
}

macro_rules! logln {
    ($($arg:tt)*) => {
        $crate::log::write(format_args!($($arg)*))
    };
}
