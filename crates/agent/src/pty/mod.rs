//! Pseudo-terminals for remote shells.
//!
//! Bytes pass through untouched in both directions: VT output goes to the browser's terminal and
//! keystrokes come back. The agent never parses VT.

#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

use std::path::PathBuf;

use anyhow::{Result, bail};
use tokio::sync::{mpsc, oneshot};

#[cfg(unix)]
pub use self::unix::PtySession;
#[cfg(windows)]
pub use self::windows::PtySession;

/// Output chunks, ending when the terminal closes.
pub type PtyOutput = mpsc::Receiver<Vec<u8>>;
/// Resolves with the shell's exit code.
pub type PtyExit = oneshot::Receiver<i64>;

/// Maps a well-known shell name to an absolute executable and its arguments (never via `PATH`).
pub fn resolve_shell(name: &str) -> Result<(PathBuf, Vec<String>)> {
    let name = name.trim().to_ascii_lowercase();
    #[cfg(windows)]
    {
        let system = crate::util::system_tool("cmd.exe")
            .parent()
            .map(std::path::Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows\System32"));
        match name.as_str() {
            "" | "powershell" => Ok((
                system.join(r"WindowsPowerShell\v1.0\powershell.exe"),
                vec!["-NoLogo".into()],
            )),
            "pwsh" => {
                let pwsh = PathBuf::from(r"C:\Program Files\PowerShell\7\pwsh.exe");
                if !pwsh.exists() {
                    bail!("PowerShell 7 is not installed on this device");
                }
                Ok((pwsh, vec!["-NoLogo".into()]))
            }
            "cmd" => Ok((system.join("cmd.exe"), Vec::new())),
            other => bail!("unsupported shell {other}"),
        }
    }
    #[cfg(unix)]
    {
        let find = |candidates: &[&str]| -> Option<PathBuf> {
            candidates.iter().map(PathBuf::from).find(|p| p.exists())
        };
        let (path, args): (Option<PathBuf>, Vec<String>) = match name.as_str() {
            "" | "bash" => (
                find(&["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash"])
                    .or_else(|| find(&["/bin/sh"])),
                vec!["-l".into()],
            ),
            "zsh" => (find(&["/bin/zsh", "/usr/bin/zsh"]), vec!["-l".into()]),
            "sh" => (find(&["/bin/sh", "/usr/bin/sh"]), Vec::new()),
            other => bail!("unsupported shell {other}"),
        };
        match path {
            Some(p) => Ok((p, args)),
            None => bail!("shell {name} is not installed on this device"),
        }
    }
}
