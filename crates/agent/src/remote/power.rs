//! Reboot, shutdown, cancel, sign-out and lock.

use std::time::Duration;

use anyhow::{Result, bail};
use rustrmm_proto::remote::PowerAction;
use serde_json::{Value, json};

use crate::util::{Captured, run_capture, system_tool};

const MAX_DELAY_SECS: u32 = 24 * 3600;

pub fn run(action: PowerAction, delay_secs: u32, message: &str) -> Result<Value> {
    let delay = delay_secs.min(MAX_DELAY_SECS);
    let message: String = message
        .chars()
        .filter(|c| !c.is_control())
        .take(500)
        .collect();
    platform::run(action, delay, &message)?;
    Ok(json!({ "action": action, "delay_secs": delay }))
}

fn check(out: Captured, what: &str) -> Result<()> {
    if out.code == Some(0) {
        return Ok(());
    }
    let detail = if out.stderr.trim().is_empty() {
        out.stdout.trim().to_string()
    } else {
        out.stderr.trim().to_string()
    };
    bail!("{what} failed: {detail}")
}

#[cfg(windows)]
mod platform {
    use super::*;
    use windows::Win32::System::RemoteDesktop::{
        WTS_CURRENT_SERVER_HANDLE, WTSDisconnectSession, WTSGetActiveConsoleSessionId,
        WTSLogoffSession,
    };

    pub fn run(action: PowerAction, delay: u32, message: &str) -> Result<()> {
        let shutdown = system_tool("shutdown");
        let delay = delay.to_string();
        match action {
            PowerAction::Reboot | PowerAction::Shutdown => {
                let flag = if action == PowerAction::Reboot {
                    "/r"
                } else {
                    "/s"
                };
                let mut args = vec![flag, "/f", "/t", delay.as_str(), "/d", "p:0:0"];
                if !message.is_empty() {
                    args.extend(["/c", message]);
                }
                check(
                    run_capture(&shutdown, &args, Duration::from_secs(30))?,
                    "shutdown",
                )
            }
            PowerAction::Cancel => check(
                run_capture(&shutdown, &["/a"], Duration::from_secs(30))?,
                "cancel",
            ),
            PowerAction::Logoff | PowerAction::Lock => {
                // SAFETY: no preconditions.
                let session = unsafe { WTSGetActiveConsoleSessionId() };
                if session == u32::MAX {
                    bail!("no interactive console session");
                }
                // SAFETY: local server handle and a session id returned by the API.
                let result = unsafe {
                    if action == PowerAction::Logoff {
                        WTSLogoffSession(Some(WTS_CURRENT_SERVER_HANDLE), session, false)
                    } else {
                        // Disconnecting the console session shows the lock screen.
                        WTSDisconnectSession(Some(WTS_CURRENT_SERVER_HANDLE), session, false)
                    }
                };
                result.map_err(|e| anyhow::anyhow!("session action failed: {e}"))
            }
        }
    }
}

#[cfg(unix)]
mod platform {
    use super::*;

    pub fn run(action: PowerAction, delay: u32, message: &str) -> Result<()> {
        let shutdown = system_tool("shutdown");
        // shutdown(8) has minute granularity; round up so the user always gets the warning.
        let when = if delay == 0 {
            "now".to_string()
        } else {
            format!("+{}", delay.div_ceil(60))
        };
        match action {
            PowerAction::Reboot | PowerAction::Shutdown => {
                let flag = if action == PowerAction::Reboot {
                    "-r"
                } else {
                    "-h"
                };
                let mut args = vec![flag, when.as_str()];
                if !message.is_empty() {
                    args.push(message);
                }
                check(
                    run_capture(&shutdown, &args, Duration::from_secs(30))?,
                    "shutdown",
                )
            }
            PowerAction::Cancel => {
                if cfg!(target_os = "macos") {
                    check(
                        run_capture(
                            &system_tool("killall"),
                            &["shutdown"],
                            Duration::from_secs(10),
                        )?,
                        "cancel",
                    )
                } else {
                    check(
                        run_capture(&shutdown, &["-c"], Duration::from_secs(30))?,
                        "cancel",
                    )
                }
            }
            PowerAction::Lock => {
                if cfg!(target_os = "macos") {
                    bail!("locking is not supported on macOS yet");
                }
                check(
                    run_capture(
                        &system_tool("loginctl"),
                        &["lock-sessions"],
                        Duration::from_secs(10),
                    )?,
                    "lock",
                )
            }
            PowerAction::Logoff => {
                if cfg!(target_os = "macos") {
                    bail!("sign-out is not supported on macOS yet");
                }
                let Some(user) = crate::collectors::console_user() else {
                    bail!("no interactive user is signed in");
                };
                check(
                    run_capture(
                        &system_tool("loginctl"),
                        &["terminate-user", "--", &user],
                        Duration::from_secs(10),
                    )?,
                    "sign-out",
                )
            }
        }
    }
}
