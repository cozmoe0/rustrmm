//! Well-known locations used by the spike.

use std::path::PathBuf;

fn known_folder(var: &str, fallback: &str) -> PathBuf {
    std::env::var_os(var)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(fallback))
}

/// `C:\ProgramData\RustRMMSpike`: frames and logs. Inherits the ProgramData
/// ACL, so local users can read the frames. Acceptable for a spike only.
pub fn data_root() -> PathBuf {
    known_folder("ProgramData", r"C:\ProgramData").join("RustRMMSpike")
}

pub fn frames_dir() -> PathBuf {
    data_root().join("frames")
}

pub fn logs_dir() -> PathBuf {
    data_root().join("logs")
}

/// `C:\Program Files\RustRMMSpike`: the service binary lives here because
/// only administrators can write to it. Registering a LocalSystem service
/// that points into a user-writable directory (like `target\`) would let any
/// process running as the user swap the binary, or plant a DLL next to it,
/// and get SYSTEM.
pub fn install_dir() -> PathBuf {
    known_folder("ProgramFiles", r"C:\Program Files").join("RustRMMSpike")
}
