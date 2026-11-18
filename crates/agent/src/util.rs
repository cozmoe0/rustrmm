//! Small helpers: logging, command execution, directory hardening.

use std::process::{Command, Stdio};
use std::time::Duration;

use crate::paths::Paths;

/// Console logging for interactive use; daily-rotated file logs for the service.
pub fn init_logging(paths: &Paths, console: bool) {
    let format = if console {
        rustrmm_common::logging::LogFormat::Pretty
    } else {
        rustrmm_common::logging::LogFormat::Json
    };
    if !console {
        // Services have no console: send logs to a file next to the data directory.
        let _ = std::fs::create_dir_all(&paths.log_dir);
        let log_path = paths.log_dir.join("agent.log");
        rotate_if_large(&log_path);
        if let Ok(file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
        {
            use tracing_subscriber::prelude::*;
            let filter = tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
            let _ = tracing_subscriber::registry()
                .with(filter)
                .with(
                    tracing_subscriber::fmt::layer()
                        .json()
                        .with_writer(std::sync::Mutex::new(file)),
                )
                .try_init();
            return;
        }
    }
    rustrmm_common::logging::init(format, "info");
}

fn rotate_if_large(path: &std::path::Path) {
    if std::fs::metadata(path)
        .map(|m| m.len() > 10 * 1024 * 1024)
        .unwrap_or(false)
    {
        let _ = std::fs::rename(path, path.with_extension("log.1"));
    }
}

/// Runs a program with a timeout, returning stdout when it exits successfully.
pub fn run(program: &str, args: &[&str], timeout: Duration) -> Option<String> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().ok()?;
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut out = String::new();
                if let Some(mut stdout) = child.stdout.take() {
                    use std::io::Read;
                    let _ = stdout.read_to_string(&mut out);
                }
                return status.success().then_some(out);
            }
            Ok(None) if started.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(_) => return None,
        }
    }
}

/// Like [`run`] but returns stdout regardless of exit status.
pub fn run_any(program: &str, args: &[&str], timeout: Duration) -> Option<String> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let output = std::thread::scope(|scope| {
        let handle = scope.spawn(|| cmd.output());
        let started = std::time::Instant::now();
        while !handle.is_finished() {
            if started.elapsed() > timeout {
                return None;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        handle.join().ok().and_then(|r| r.ok())
    })?;
    Some(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Restricts the data directory to SYSTEM/Administrators (Windows) or root (Unix).
pub fn harden_data_dir(paths: &Paths) {
    let _ = std::fs::create_dir_all(&paths.data_dir);
    if paths.custom {
        return;
    }
    #[cfg(windows)]
    {
        let dir = paths.data_dir.to_string_lossy().to_string();
        // Well-known SIDs avoid localisation issues: S-1-5-18 = SYSTEM, S-1-5-32-544 = Administrators.
        let _ = run(
            "icacls",
            &[
                &dir,
                "/inheritance:r",
                "/grant:r",
                "*S-1-5-18:(OI)(CI)F",
                "*S-1-5-32-544:(OI)(CI)F",
                "/T",
                "/C",
                "/Q",
            ],
            Duration::from_secs(30),
        );
        let _ = run(
            "icacls",
            &[&dir, "/setowner", "*S-1-5-32-544", "/T", "/C", "/Q"],
            Duration::from_secs(30),
        );
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&paths.data_dir, std::fs::Permissions::from_mode(0o700));
    }
}

/// True when running with administrative rights.
pub fn is_elevated() -> bool {
    #[cfg(unix)]
    {
        // SAFETY: geteuid has no preconditions.
        unsafe { libc::geteuid() == 0 }
    }
    #[cfg(windows)]
    {
        // "net session" only succeeds for administrators.
        run("net", &["session"], Duration::from_secs(10)).is_some()
    }
}

/// Absolute path of a system tool, never resolved through `PATH` (a SYSTEM/root process must not
/// run a binary from a user-influenced directory). Windows: `%SystemRoot%\System32\<name>.exe`
/// via the API; Unix: the first of the standard system directories that contains it.
pub fn system_tool(name: &str) -> std::path::PathBuf {
    #[cfg(windows)]
    {
        use windows::Win32::System::SystemInformation::GetSystemDirectoryW;
        let mut buf = [0u16; 260];
        // SAFETY: the buffer is valid for its full length.
        let n = unsafe { GetSystemDirectoryW(Some(&mut buf)) } as usize;
        let dir = if n == 0 || n >= buf.len() {
            std::path::PathBuf::from(r"C:\Windows\System32")
        } else {
            std::path::PathBuf::from(String::from_utf16_lossy(&buf[..n]))
        };
        let file = if name.contains('.') {
            name.to_string()
        } else {
            format!("{name}.exe")
        };
        dir.join(file)
    }
    #[cfg(unix)]
    {
        for dir in ["/usr/bin", "/bin", "/usr/sbin", "/sbin", "/usr/local/bin"] {
            let candidate = std::path::Path::new(dir).join(name);
            if candidate.exists() {
                return candidate;
            }
        }
        std::path::PathBuf::from("/usr/bin").join(name)
    }
}

/// Output of [`run_capture`].
pub struct Captured {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

/// Runs a program with a clean, minimal environment and a timeout, capturing stdout, stderr
/// (each capped at 1 MiB) and the exit code.
pub fn run_capture(
    program: &std::path::Path,
    args: &[&str],
    timeout: Duration,
) -> anyhow::Result<Captured> {
    use std::io::Read;
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| anyhow::anyhow!("cannot start {}: {e}", program.display()))?;
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let out_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(s) = stdout.as_mut() {
            let _ = s.take(1 << 20).read_to_end(&mut buf);
        }
        buf
    });
    let err_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(s) = stderr.as_mut() {
            let _ = s.take(1 << 20).read_to_end(&mut buf);
        }
        buf
    });
    let started = std::time::Instant::now();
    let mut timed_out = false;
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) if started.elapsed() > timeout => {
                timed_out = true;
                let _ = child.kill();
                break child.wait().ok().and_then(|s| s.code());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(e) => anyhow::bail!("waiting for {}: {e}", program.display()),
        }
    };
    let stdout = out_reader.join().unwrap_or_default();
    let stderr = err_reader.join().unwrap_or_default();
    Ok(Captured {
        code,
        stdout: decode_output(&stdout),
        stderr: decode_output(&stderr),
        timed_out,
    })
}

/// Console tools on Windows may print in the OEM code page; keep valid UTF-8 and replace the rest.
fn decode_output(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).replace('\r', "")
}
