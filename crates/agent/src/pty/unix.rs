//! Unix pseudo-terminal via `openpty(3)`: the shell becomes a session leader with the PTY as
//! its controlling terminal, and starts with a clean, minimal environment.

use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use tokio::sync::{mpsc, oneshot};

use super::{PtyExit, PtyOutput};

fn winsize(cols: u16, rows: u16) -> libc::winsize {
    libc::winsize {
        ws_row: rows.clamp(5, 300),
        ws_col: cols.clamp(10, 500),
        ws_xpixel: 0,
        ws_ypixel: 0,
    }
}

fn set_cloexec(fd: i32) {
    // SAFETY: valid descriptor; only toggles FD_CLOEXEC.
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFD);
        if flags >= 0 {
            libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC);
        }
    }
}

pub struct PtySession {
    master: File,
    pid: i32,
    exited: Arc<AtomicBool>,
    input: Option<std::sync::mpsc::Sender<Vec<u8>>>,
    writer: Option<JoinHandle<()>>,
    reader: Option<JoinHandle<()>>,
    closed: bool,
}

impl PtySession {
    pub fn spawn(
        program: &Path,
        args: &[String],
        cols: u16,
        rows: u16,
    ) -> Result<(Self, PtyOutput, PtyExit)> {
        let mut master_fd: libc::c_int = -1;
        let mut slave_fd: libc::c_int = -1;
        let mut ws = winsize(cols, rows);
        // SAFETY: out pointers are valid; name/termios are optional. `winp` is `*const` on Linux
        // and `*mut` on macOS, so it is passed as a raw pointer that coerces to either.
        let rc = unsafe {
            libc::openpty(
                &mut master_fd,
                &mut slave_fd,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &raw mut ws,
            )
        };
        if rc != 0 {
            bail!("openpty failed: {}", std::io::Error::last_os_error());
        }
        set_cloexec(master_fd);
        set_cloexec(slave_fd);
        // SAFETY: freshly created descriptors we now own.
        let (master, slave) =
            unsafe { (File::from_raw_fd(master_fd), OwnedFd::from_raw_fd(slave_fd)) };

        let home = if crate::util::is_elevated() {
            if cfg!(target_os = "macos") {
                "/var/root"
            } else {
                "/root"
            }
            .to_string()
        } else {
            std::env::var("HOME").unwrap_or_else(|_| "/".into())
        };
        let mut cmd = Command::new(program);
        cmd.args(args)
            .env_clear()
            .env("TERM", "xterm-256color")
            .env("COLORTERM", "truecolor")
            .env("LANG", "C.UTF-8")
            .env(
                "PATH",
                "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            )
            .env("HOME", &home)
            .env("SHELL", program)
            .current_dir(if Path::new(&home).is_dir() {
                home.as_str()
            } else {
                "/"
            })
            .stdin(Stdio::from(slave.try_clone()?))
            .stdout(Stdio::from(slave.try_clone()?))
            .stderr(Stdio::from(slave));
        // SAFETY: only async-signal-safe calls between fork and exec.
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::ioctl(0, libc::TIOCSCTTY as _, 0) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = cmd
            .spawn()
            .with_context(|| format!("cannot start {}", program.display()))?;
        // `cmd` still holds the slave descriptors in its Stdio; drop them so EOF can happen.
        drop(cmd);
        let pid = child.id() as i32;

        let (out_tx, out_rx) = mpsc::channel::<Vec<u8>>(64);
        let mut reader_file = master.try_clone()?;
        let reader = thread::Builder::new()
            .name("pty-reader".into())
            .spawn(move || {
                let mut buf = vec![0u8; 16 * 1024];
                let mut alive = true;
                loop {
                    match reader_file.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            if alive && out_tx.blocking_send(buf[..n].to_vec()).is_err() {
                                alive = false;
                            }
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                        Err(_) => break, // EIO once the last slave descriptor closes
                    }
                }
            })?;

        let (in_tx, in_rx) = std::sync::mpsc::channel::<Vec<u8>>();
        let mut writer_file = master.try_clone()?;
        let writer = thread::Builder::new()
            .name("pty-writer".into())
            .spawn(move || {
                while let Ok(data) = in_rx.recv() {
                    if writer_file.write_all(&data).is_err() {
                        return;
                    }
                }
            })?;

        let exited = Arc::new(AtomicBool::new(false));
        let (exit_tx, exit_rx) = oneshot::channel();
        let flag = Arc::clone(&exited);
        thread::Builder::new()
            .name("pty-exit".into())
            .spawn(move || {
                let code = child.wait().ok().and_then(|s| s.code()).unwrap_or(-1);
                flag.store(true, Ordering::SeqCst);
                let _ = exit_tx.send(i64::from(code));
            })?;

        Ok((
            Self {
                master,
                pid,
                exited,
                input: Some(in_tx),
                writer: Some(writer),
                reader: Some(reader),
                closed: false,
            },
            out_rx,
            exit_rx,
        ))
    }

    pub fn write(&self, data: Vec<u8>) {
        if let Some(input) = &self.input {
            let _ = input.send(data);
        }
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        let ws = winsize(cols, rows);
        // SAFETY: valid master descriptor and winsize struct.
        let rc = unsafe { libc::ioctl(self.master.as_raw_fd(), libc::TIOCSWINSZ as _, &ws) };
        if rc != 0 {
            bail!("resize failed: {}", std::io::Error::last_os_error());
        }
        Ok(())
    }

    /// Bounded-time teardown; blocking — call from `spawn_blocking`.
    pub fn close(mut self) {
        self.shutdown();
    }

    fn shutdown(&mut self) {
        if self.closed {
            return;
        }
        self.closed = true;
        if !self.exited.load(Ordering::SeqCst) {
            // SAFETY: signalling the shell's process group (it is a session leader).
            unsafe { libc::kill(-self.pid, libc::SIGHUP) };
            let deadline = Instant::now() + Duration::from_secs(2);
            while !self.exited.load(Ordering::SeqCst) && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(20));
            }
            if !self.exited.load(Ordering::SeqCst) {
                // SAFETY: as above.
                unsafe { libc::kill(-self.pid, libc::SIGKILL) };
            }
        }
        self.input = None;
        if let Some(writer) = self.writer.take() {
            let _ = writer.join();
        }
        // The reader ends with EIO once every slave descriptor is closed; don't wait forever on
        // background jobs that kept the terminal open.
        if let Some(reader) = self.reader.take() {
            let deadline = Instant::now() + Duration::from_secs(2);
            while !reader.is_finished() && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(20));
            }
            if reader.is_finished() {
                let _ = reader.join();
            }
        }
    }
}

impl Drop for PtySession {
    fn drop(&mut self) {
        self.shutdown();
    }
}
