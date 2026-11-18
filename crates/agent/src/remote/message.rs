//! Pop-up messages for the signed-in user.

use anyhow::{Result, bail};
use serde_json::{Value, json};

pub fn show(title: &str, body: &str, timeout_secs: u32) -> Result<Value> {
    let clean = |s: &str, max: usize| -> String {
        s.chars()
            .filter(|c| *c == '\n' || !c.is_control())
            .take(max)
            .collect()
    };
    let title = clean(title, 120);
    let body = clean(body, 2000);
    if body.trim().is_empty() {
        bail!("the message is empty");
    }
    let title = if title.trim().is_empty() {
        "Message from IT".to_string()
    } else {
        title
    };
    platform::show(&title, &body, timeout_secs.min(3600))?;
    Ok(json!({ "delivered": true }))
}

#[cfg(windows)]
mod platform {
    use anyhow::{Result, bail};
    use windows::Win32::System::RemoteDesktop::{
        WTS_CURRENT_SERVER_HANDLE, WTSGetActiveConsoleSessionId, WTSSendMessageW,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        MB_ICONINFORMATION, MB_OK, MB_SETFOREGROUND, MB_TOPMOST, MESSAGEBOX_RESULT,
    };
    use windows::core::PCWSTR;

    pub fn show(title: &str, body: &str, timeout_secs: u32) -> Result<()> {
        // SAFETY: no preconditions.
        let session = unsafe { WTSGetActiveConsoleSessionId() };
        if session == u32::MAX {
            bail!("no interactive console session");
        }
        let title_w: Vec<u16> = title.encode_utf16().collect();
        let body_w: Vec<u16> = body.encode_utf16().collect();
        let mut response = MESSAGEBOX_RESULT(0);
        // SAFETY: buffers outlive the call; lengths are in bytes as the API requires; bWait=false
        // returns immediately so the agent never blocks on the user.
        unsafe {
            WTSSendMessageW(
                Some(WTS_CURRENT_SERVER_HANDLE),
                session,
                PCWSTR(title_w.as_ptr()),
                (title_w.len() * 2) as u32,
                PCWSTR(body_w.as_ptr()),
                (body_w.len() * 2) as u32,
                MB_OK | MB_ICONINFORMATION | MB_SETFOREGROUND | MB_TOPMOST,
                timeout_secs,
                &mut response,
                false,
            )
        }
        .map_err(|e| anyhow::anyhow!("WTSSendMessage failed: {e}"))
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use std::io::Write;
    use std::process::{Command, Stdio};

    use anyhow::{Context, Result};

    pub fn show(title: &str, body: &str, _timeout_secs: u32) -> Result<()> {
        // `wall` reaches every terminal; desktop notifications need the user's session bus.
        let mut child = Command::new(crate::util::system_tool("wall"))
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .context("cannot run wall")?;
        if let Some(stdin) = child.stdin.as_mut() {
            writeln!(stdin, "{title}\n\n{body}")?;
        }
        child.wait()?;
        Ok(())
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::time::Duration;

    use anyhow::{Result, bail};

    pub fn show(title: &str, body: &str, timeout_secs: u32) -> Result<()> {
        let uid = crate::util::run_capture(
            &crate::util::system_tool("stat"),
            &["-f", "%u", "/dev/console"],
            Duration::from_secs(5),
        )?
        .stdout
        .trim()
        .to_string();
        if uid.is_empty() || uid == "0" {
            bail!("no interactive user is signed in");
        }
        let escape = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
        let script = format!(
            "display dialog \"{}\" with title \"{}\" buttons {{\"OK\"}} giving up after {}",
            escape(body),
            escape(title),
            if timeout_secs == 0 { 600 } else { timeout_secs }
        );
        // Fire and forget in the user's GUI session.
        std::process::Command::new(crate::util::system_tool("launchctl"))
            .args(["asuser", &uid, "/usr/bin/osascript", "-e", &script])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()?;
        Ok(())
    }
}
