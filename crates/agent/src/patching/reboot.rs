//! Reboot negotiation after patch installs, handled entirely by the agent service.
//!
//! * `never`: nothing happens.
//! * `force`: `shutdown /r /t 300` (Windows) or `wall` plus `shutdown -r +5` (Unix).
//! * `prompt`: with nobody signed in the device restarts at once; otherwise the user is asked
//!   (Windows `WTSSendMessageW` with Yes/No and a timeout). "No" or no answer postpones by 60
//!   minutes; when the deferrals run out or the deadline (window end) passes, the restart is
//!   forced. Unix has no interactive prompt, so `prompt` behaves like `force` there.

use std::time::Duration;

use anyhow::Result;
use rustrmm_proto::patching::{DEFERRAL_MINUTES, RebootSpec};

/// How long a prompt waits for an answer.
const PROMPT_TIMEOUT_SECS: u32 = 600;

/// What to do next.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// No reboot (mode `never`, or nothing needs one).
    Nothing,
    /// Restart now (nobody is signed in, or the user agreed).
    Now,
    /// Warn and restart in five minutes.
    Force,
    /// Ask the signed-in user.
    Ask,
}

/// The user's answer to a prompt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(unix, allow(dead_code))] // only Windows can prompt
pub enum Answer {
    Yes,
    No,
    Timeout,
    /// The prompt could not be shown (no session).
    Unavailable,
}

/// Decides the next step of the negotiation.
pub fn next_step(
    spec: &RebootSpec,
    reboot_required: bool,
    user_present: bool,
    deferrals_used: u32,
    now_unix: i64,
    can_prompt: bool,
) -> Step {
    if !reboot_required || spec.mode == "never" {
        return Step::Nothing;
    }
    if !user_present {
        return Step::Now;
    }
    if spec.mode == "force" || !can_prompt {
        return Step::Force;
    }
    let deadline_passed = spec.deadline_unix.is_some_and(|d| now_unix >= d);
    if deferrals_used >= spec.deferrals || deadline_passed {
        return Step::Force;
    }
    Step::Ask
}

/// How long to wait after a postponement (60 minutes, or until the deadline).
pub fn defer_for(spec: &RebootSpec, now_unix: i64) -> Duration {
    let full = i64::from(DEFERRAL_MINUTES) * 60;
    let secs = match spec.deadline_unix {
        Some(d) => (d - now_unix).clamp(0, full),
        None => full,
    };
    Duration::from_secs(secs.max(0) as u64)
}

/// Result of the negotiation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Negotiated {
    pub rebooting: bool,
    pub deferrals_used: u32,
}

/// Runs the negotiation and triggers the restart. Blocking (prompts wait for the user).
pub fn negotiate(spec: &RebootSpec, reboot_required: bool) -> Negotiated {
    let mut used = 0u32;
    loop {
        let now = chrono::Utc::now().timestamp();
        let user_present = platform::user_present();
        match next_step(
            spec,
            reboot_required,
            user_present,
            used,
            now,
            platform::CAN_PROMPT,
        ) {
            Step::Nothing => {
                return Negotiated {
                    rebooting: false,
                    deferrals_used: used,
                };
            }
            Step::Now => {
                // A short delay lets the final result reach the server first.
                return restart(&spec.message, 30, used);
            }
            Step::Force => {
                return restart(&spec.message, 300, used);
            }
            Step::Ask => match platform::ask(&spec.message, PROMPT_TIMEOUT_SECS) {
                Answer::Yes => return restart(&spec.message, 60, used),
                Answer::Unavailable => return restart(&spec.message, 30, used),
                Answer::No | Answer::Timeout => {
                    used += 1;
                    tracing::info!(deferrals_used = used, "the user postponed the restart");
                    std::thread::sleep(defer_for(spec, chrono::Utc::now().timestamp()));
                }
            },
        }
    }
}

fn restart(message: &str, delay_secs: u32, used: u32) -> Negotiated {
    match platform::restart(message, delay_secs) {
        Ok(()) => {
            tracing::warn!(delay_secs, "restarting to finish installing updates");
            Negotiated {
                rebooting: true,
                deferrals_used: used,
            }
        }
        Err(e) => {
            tracing::error!(error = %format!("{e:#}"), "could not schedule the restart");
            Negotiated {
                rebooting: false,
                deferrals_used: used,
            }
        }
    }
}

fn clean_message(message: &str) -> String {
    let text: String = message
        .chars()
        .filter(|c| !c.is_control())
        .take(500)
        .collect();
    if text.trim().is_empty() {
        "Your IT team installed updates. Please restart to finish.".into()
    } else {
        text
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use crate::util::{run_capture, system_tool};
    use windows::Win32::System::RemoteDesktop::{
        WTS_CURRENT_SERVER_HANDLE, WTSGetActiveConsoleSessionId, WTSSendMessageW,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        IDYES, MB_ICONQUESTION, MB_SETFOREGROUND, MB_TOPMOST, MB_YESNO, MESSAGEBOX_RESULT,
    };
    use windows::core::PCWSTR;

    pub const CAN_PROMPT: bool = true;

    pub fn user_present() -> bool {
        // SAFETY: no preconditions.
        let session = unsafe { WTSGetActiveConsoleSessionId() };
        session != u32::MAX && crate::collectors::console_user().is_some()
    }

    pub fn ask(message: &str, timeout_secs: u32) -> Answer {
        // SAFETY: no preconditions.
        let session = unsafe { WTSGetActiveConsoleSessionId() };
        if session == u32::MAX {
            return Answer::Unavailable;
        }
        let title: Vec<u16> = "Restart required".encode_utf16().collect();
        let body: Vec<u16> = format!(
            "{}\n\nRestart now? Choose No to be reminded in {} minutes.",
            clean_message(message),
            DEFERRAL_MINUTES
        )
        .encode_utf16()
        .collect();
        let mut response = MESSAGEBOX_RESULT(0);
        // SAFETY: buffers outlive the call; lengths are in bytes; bWait=true blocks this
        // (dedicated) thread until the user answers or the timeout passes.
        let sent = unsafe {
            WTSSendMessageW(
                Some(WTS_CURRENT_SERVER_HANDLE),
                session,
                PCWSTR(title.as_ptr()),
                (title.len() * 2) as u32,
                PCWSTR(body.as_ptr()),
                (body.len() * 2) as u32,
                MB_YESNO | MB_ICONQUESTION | MB_SETFOREGROUND | MB_TOPMOST,
                timeout_secs,
                &mut response,
                true,
            )
        };
        match sent {
            Err(_) => Answer::Unavailable,
            Ok(()) if response == IDYES => Answer::Yes,
            // IDTIMEOUT (32000) means nobody answered.
            Ok(()) if response.0 == 32000 => Answer::Timeout,
            Ok(()) => Answer::No,
        }
    }

    pub fn restart(message: &str, delay_secs: u32) -> Result<()> {
        let delay = delay_secs.to_string();
        let message = clean_message(message);
        let out = run_capture(
            &system_tool("shutdown"),
            &["/r", "/t", &delay, "/d", "p:2:17", "/c", &message],
            Duration::from_secs(30),
        )?;
        if out.code == Some(0) {
            Ok(())
        } else {
            anyhow::bail!("shutdown failed: {}", out.stderr.trim())
        }
    }
}

#[cfg(unix)]
mod platform {
    use std::io::Write;
    use std::process::{Command, Stdio};

    use super::*;
    use crate::util::{run_capture, system_tool};

    pub const CAN_PROMPT: bool = false;

    pub fn user_present() -> bool {
        crate::collectors::console_user().is_some()
    }

    pub fn ask(_message: &str, _timeout_secs: u32) -> Answer {
        Answer::Unavailable
    }

    pub fn restart(message: &str, delay_secs: u32) -> Result<()> {
        let message = clean_message(message);
        if delay_secs > 0
            && let Ok(mut child) = Command::new(system_tool("wall"))
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
        {
            if let Some(stdin) = child.stdin.as_mut() {
                let minutes = delay_secs.div_ceil(60);
                let _ = writeln!(
                    stdin,
                    "{message}\n\nThis computer restarts in {minutes} minute(s)."
                );
            }
            let _ = child.wait();
        }
        let when = if delay_secs == 0 {
            "now".to_string()
        } else {
            format!("+{}", delay_secs.div_ceil(60))
        };
        let out = run_capture(
            &system_tool("shutdown"),
            &["-r", &when, &message],
            Duration::from_secs(30),
        )?;
        if out.code == Some(0) {
            Ok(())
        } else {
            anyhow::bail!("shutdown failed: {}", out.stderr.trim())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(mode: &str, deferrals: u32, deadline: Option<i64>) -> RebootSpec {
        RebootSpec {
            mode: mode.into(),
            deferrals,
            message: String::new(),
            deadline_unix: deadline,
        }
    }

    #[test]
    fn negotiation_steps() {
        let now = 1_700_000_000;
        assert_eq!(
            next_step(&spec("prompt", 3, None), false, true, 0, now, true),
            Step::Nothing
        );
        assert_eq!(
            next_step(&spec("never", 3, None), true, true, 0, now, true),
            Step::Nothing
        );
        assert_eq!(
            next_step(&spec("prompt", 3, None), true, false, 0, now, true),
            Step::Now
        );
        assert_eq!(
            next_step(&spec("force", 3, None), true, false, 0, now, true),
            Step::Now
        );
        assert_eq!(
            next_step(&spec("force", 3, None), true, true, 0, now, true),
            Step::Force
        );
        assert_eq!(
            next_step(&spec("prompt", 3, None), true, true, 0, now, true),
            Step::Ask
        );
        assert_eq!(
            next_step(&spec("prompt", 3, None), true, true, 3, now, true),
            Step::Force
        );
        assert_eq!(
            next_step(&spec("prompt", 3, Some(now - 1)), true, true, 0, now, true),
            Step::Force,
            "the window closed"
        );
        assert_eq!(
            next_step(&spec("prompt", 3, None), true, true, 0, now, false),
            Step::Force,
            "no prompt on this platform"
        );
        assert_eq!(
            defer_for(&spec("prompt", 3, None), now),
            Duration::from_secs(3600)
        );
        assert_eq!(
            defer_for(&spec("prompt", 3, Some(now + 600)), now),
            Duration::from_secs(600)
        );
        assert_eq!(
            defer_for(&spec("prompt", 3, Some(now - 5)), now),
            Duration::ZERO
        );
        assert!(clean_message("").contains("restart"));
        assert_eq!(clean_message("a\u{7}b"), "ab");
    }
}
