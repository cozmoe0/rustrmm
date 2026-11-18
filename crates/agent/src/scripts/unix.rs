//! Unix containment: the script leads its own process group, which is signalled as a whole.

use std::ffi::OsString;
use std::io::Read;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command};
use std::time::{Duration, Instant};

use anyhow::Result;

use super::Contained;

pub struct ContainedChild {
    child: Child,
    pgid: i32,
}

/// Starts the command as the leader of a new process group.
pub fn spawn(cmd: &mut Command) -> Result<ContainedChild> {
    cmd.process_group(0);
    let child = cmd.spawn()?;
    let pgid = i32::try_from(child.id()).unwrap_or(0);
    Ok(ContainedChild { child, pgid })
}

impl ContainedChild {
    fn signal_group(&self, signal: i32) {
        if self.pgid > 1 {
            // SAFETY: kill(2) with a negative pid signals the process group we created.
            unsafe {
                libc::kill(-self.pgid, signal);
            }
        }
    }
}

impl Contained for ContainedChild {
    fn take_stdout(&mut self) -> Option<Box<dyn Read + Send>> {
        self.child
            .stdout
            .take()
            .map(|s| Box::new(s) as Box<dyn Read + Send>)
    }

    fn take_stderr(&mut self) -> Option<Box<dyn Read + Send>> {
        self.child
            .stderr
            .take()
            .map(|s| Box::new(s) as Box<dyn Read + Send>)
    }

    fn try_wait(&mut self) -> Result<Option<Option<i32>>> {
        Ok(self.child.try_wait()?.map(|status| status.code()))
    }

    fn wait(&mut self) -> Option<i32> {
        self.child.wait().ok().and_then(|s| s.code())
    }

    fn kill_tree(&mut self, graceful: bool) {
        if graceful {
            self.signal_group(libc::SIGTERM);
            let started = Instant::now();
            while started.elapsed() < Duration::from_secs(2) {
                if matches!(self.child.try_wait(), Ok(Some(_))) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        self.signal_group(libc::SIGKILL);
    }

    fn active_processes(&self) -> Option<u32> {
        if self.pgid <= 1 {
            return None;
        }
        // SAFETY: signal 0 only checks whether any process of our group still exists.
        let alive = unsafe { libc::kill(-self.pgid, 0) } == 0;
        Some(u32::from(alive))
    }
}

impl Drop for ContainedChild {
    fn drop(&mut self) {
        self.signal_group(libc::SIGKILL);
        let _ = self.child.try_wait();
    }
}

/// The per-command directory is private to the agent's user (root when installed).
pub fn restrict_dir(dir: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
}

/// A fixed, minimal environment; nothing from the agent's own environment.
pub fn default_environment(dir: &Path, program: &Path) -> Vec<(OsString, OsString)> {
    let root = crate::util::is_elevated();
    let home = if root {
        if cfg!(target_os = "macos") {
            "/var/root"
        } else {
            "/root"
        }
    } else {
        "/"
    };
    let lang = if cfg!(target_os = "macos") {
        "en_US.UTF-8"
    } else {
        "C.UTF-8"
    };
    let mut env: Vec<(OsString, OsString)> = vec![
        (
            "PATH".into(),
            "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin".into(),
        ),
        ("HOME".into(), home.into()),
        ("LANG".into(), lang.into()),
        ("TERM".into(), "dumb".into()),
        ("SHELL".into(), program.as_os_str().to_owned()),
        ("TMPDIR".into(), dir.as_os_str().to_owned()),
    ];
    if root {
        env.push(("USER".into(), "root".into()));
        env.push(("LOGNAME".into(), "root".into()));
    }
    env
}
