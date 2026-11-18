//! Install, data and log locations per operating system.

use std::path::PathBuf;

#[cfg_attr(not(windows), allow(dead_code))]
pub const SERVICE_NAME: &str = "RustRMMAgent";
#[cfg_attr(not(windows), allow(dead_code))]
pub const SERVICE_DISPLAY_NAME: &str = "RustRMM Agent";
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub const SYSTEMD_UNIT: &str = "rustrmm-agent.service";
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const LAUNCHD_LABEL: &str = "com.rustrmm.agent";

#[derive(Debug, Clone)]
pub struct Paths {
    /// Directory the service binary is installed into.
    pub install_dir: PathBuf,
    /// Configuration, device key and local state (restricted to SYSTEM/root).
    pub data_dir: PathBuf,
    pub log_dir: PathBuf,
    /// True when `--data-dir` overrides the system location (development mode).
    pub custom: bool,
}

impl Paths {
    pub fn resolve(data_dir_override: Option<PathBuf>) -> Self {
        let mut paths = Self::system();
        if let Some(dir) = data_dir_override {
            // Child processes (scripts, helpers) run with other working directories, so every
            // path the agent hands out must be absolute.
            let dir = std::path::absolute(&dir).unwrap_or(dir);
            paths.log_dir = dir.join("logs");
            paths.data_dir = dir;
            paths.custom = true;
        }
        paths
    }

    #[cfg(windows)]
    fn system() -> Self {
        let program_files = std::env::var_os("ProgramFiles")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Program Files"));
        let program_data = std::env::var_os("ProgramData")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"));
        let data_dir = program_data.join("RustRMM").join("Agent");
        Self {
            install_dir: program_files.join("RustRMM").join("Agent"),
            log_dir: data_dir.join("logs"),
            data_dir,
            custom: false,
        }
    }

    #[cfg(target_os = "macos")]
    fn system() -> Self {
        Self {
            install_dir: PathBuf::from("/Library/RustRMM"),
            data_dir: PathBuf::from("/Library/Application Support/RustRMM"),
            log_dir: PathBuf::from("/Library/Logs/RustRMM"),
            custom: false,
        }
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    fn system() -> Self {
        Self {
            install_dir: PathBuf::from("/opt/rustrmm"),
            data_dir: PathBuf::from("/var/lib/rustrmm"),
            log_dir: PathBuf::from("/var/log/rustrmm"),
            custom: false,
        }
    }

    pub fn config_file(&self) -> PathBuf {
        self.data_dir.join("agent.json")
    }

    pub fn key_file(&self) -> PathBuf {
        self.data_dir.join("device.key")
    }

    /// The agent's Noise static key (protected like the device key).
    pub fn noise_key_file(&self) -> PathBuf {
        self.data_dir.join("noise.key")
    }

    /// The server's Noise static key, pinned after the first end-to-end handshake.
    pub fn noise_pin_file(&self) -> PathBuf {
        self.data_dir.join("server-noise.pub")
    }

    pub fn policy_file(&self) -> PathBuf {
        self.data_dir.join("local-policy.json")
    }

    pub fn installed_binary(&self) -> PathBuf {
        if cfg!(windows) {
            self.install_dir.join("rustrmm-agent.exe")
        } else {
            self.install_dir.join("rustrmm-agent")
        }
    }
}
