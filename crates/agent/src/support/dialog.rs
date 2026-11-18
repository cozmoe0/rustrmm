//! Native dialogs for `rustrmm-agent support`: a PowerShell WinForms form on Windows (run in
//! the user's own session), `zenity` on Linux and `osascript` on macOS. `ask` returns `None`
//! when the user cancels.

use anyhow::Result;

use super::Draft;

const TITLE: &str = "Request support";

/// Shows the request form.
pub fn ask() -> Result<Option<Draft>> {
    platform::ask()
}

/// Shows a short result message (best effort).
pub fn notify(success: bool, message: &str) {
    if let Err(e) = platform::notify(success, message) {
        tracing::debug!(error = %format!("{e:#}"), "could not show the result dialog");
    }
}

#[cfg(windows)]
mod platform {
    use std::process::{Command, Stdio};

    use anyhow::{Context, Result, bail};
    use base64::Engine;
    use windows::Win32::UI::WindowsAndMessaging::{
        MB_ICONERROR, MB_ICONINFORMATION, MB_OK, MB_SETFOREGROUND, MB_TOPMOST, MessageBoxW,
    };
    use windows::core::HSTRING;

    use super::super::Draft;
    use super::TITLE;

    /// The form; prints one JSON line when the user presses Send.
    const SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$f = New-Object System.Windows.Forms.Form
$f.Text = 'Request support'
$f.ClientSize = New-Object System.Drawing.Size(464, 420)
$f.StartPosition = 'CenterScreen'
$f.FormBorderStyle = 'FixedDialog'
$f.MaximizeBox = $false
$f.MinimizeBox = $false
$f.TopMost = $true
function Add-Label([string]$text, [int]$top) {
  $l = New-Object System.Windows.Forms.Label
  $l.Text = $text; $l.Left = 12; $l.Top = $top; $l.Width = 440
  $f.Controls.Add($l)
}
Add-Label 'Subject' 12
$subject = New-Object System.Windows.Forms.TextBox
$subject.Left = 12; $subject.Top = 32; $subject.Width = 440; $subject.MaxLength = 200
$f.Controls.Add($subject)
Add-Label 'What is the problem?' 64
$description = New-Object System.Windows.Forms.TextBox
$description.Left = 12; $description.Top = 84; $description.Width = 440; $description.Height = 180
$description.Multiline = $true; $description.AcceptsReturn = $true; $description.ScrollBars = 'Vertical'
$f.Controls.Add($description)
Add-Label 'Your e-mail address (optional)' 274
$email = New-Object System.Windows.Forms.TextBox
$email.Left = 12; $email.Top = 294; $email.Width = 440; $email.MaxLength = 254
$f.Controls.Add($email)
$shot = New-Object System.Windows.Forms.CheckBox
$shot.Text = 'Attach a screenshot of my screen'; $shot.Left = 12; $shot.Top = 326; $shot.Width = 440
$shot.Checked = $true
$f.Controls.Add($shot)
$send = New-Object System.Windows.Forms.Button
$send.Text = 'Send'; $send.Left = 296; $send.Top = 376; $send.DialogResult = 'OK'
$f.Controls.Add($send); $f.AcceptButton = $send
$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = 'Cancel'; $cancel.Left = 377; $cancel.Top = 376; $cancel.DialogResult = 'Cancel'
$f.Controls.Add($cancel); $f.CancelButton = $cancel
$f.Add_Shown({ $f.Activate(); $subject.Focus() })
if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  @{ subject = $subject.Text; description = $description.Text; email = $email.Text; screenshot = $shot.Checked } |
    ConvertTo-Json -Compress
}
"#;

    pub fn ask() -> Result<Option<Draft>> {
        let encoded: Vec<u8> = SCRIPT
            .encode_utf16()
            .flat_map(|u| u.to_le_bytes())
            .collect();
        let powershell = crate::util::system_tool(r"WindowsPowerShell\v1.0\powershell.exe");
        let output = Command::new(powershell)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-STA",
                "-WindowStyle",
                "Hidden",
                "-EncodedCommand",
                &base64::engine::general_purpose::STANDARD.encode(encoded),
            ])
            .stdin(Stdio::null())
            .output()
            .context("cannot start PowerShell for the support dialog")?;
        if !output.status.success() {
            bail!(
                "the support dialog failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        let text = String::from_utf8_lossy(&output.stdout);
        let text = text.trim().trim_start_matches('\u{feff}');
        if text.is_empty() {
            return Ok(None);
        }
        Ok(Some(
            serde_json::from_str(text).context("unexpected output from the support dialog")?,
        ))
    }

    pub fn notify(success: bool, message: &str) -> Result<()> {
        let icon = if success {
            MB_ICONINFORMATION
        } else {
            MB_ICONERROR
        };
        // SAFETY: the strings outlive the call; no owner window.
        unsafe {
            MessageBoxW(
                None,
                &HSTRING::from(message),
                &HSTRING::from(TITLE),
                MB_OK | icon | MB_TOPMOST | MB_SETFOREGROUND,
            );
        }
        Ok(())
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use std::process::{Command, Stdio};

    use anyhow::{Context, Result, bail};

    use super::super::Draft;
    use super::TITLE;

    const SEPARATOR: &str = "\u{1f}";

    fn zenity() -> Result<std::path::PathBuf> {
        let path = crate::util::system_tool("zenity");
        if !path.exists() {
            bail!("zenity is not installed; use `rustrmm-agent support --no-dialog --subject …`");
        }
        Ok(path)
    }

    /// Runs zenity; `None` when the user cancelled (exit code 1).
    fn run(args: &[&str]) -> Result<Option<String>> {
        let output = Command::new(zenity()?)
            .args(args)
            .stdin(Stdio::null())
            .output()
            .context("cannot run zenity")?;
        match output.status.code() {
            Some(0) => Ok(Some(String::from_utf8_lossy(&output.stdout).to_string())),
            Some(1) | Some(5) => Ok(None),
            _ => bail!(
                "zenity failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        }
    }

    pub fn ask() -> Result<Option<Draft>> {
        let title = format!("--title={TITLE}");
        let Some(form) = run(&[
            "--forms",
            &title,
            "--text=Tell us what is wrong. You can describe it in detail next.",
            "--add-entry=Subject",
            "--add-entry=Your e-mail address (optional)",
            &format!("--separator={SEPARATOR}"),
        ])?
        else {
            return Ok(None);
        };
        let mut fields = form.trim_end_matches('\n').split(SEPARATOR);
        let subject = fields.next().unwrap_or_default().to_string();
        let email = fields.next().map(str::to_string).filter(|e| !e.is_empty());
        let Some(description) = run(&[
            "--text-info",
            "--editable",
            &title,
            "--width=520",
            "--height=360",
        ])?
        else {
            return Ok(None);
        };
        let screenshot = run(&[
            "--question",
            &title,
            "--text=Attach a screenshot of your screen?",
            "--ok-label=Attach",
            "--cancel-label=No",
        ])?
        .is_some();
        Ok(Some(Draft {
            subject,
            description,
            email,
            screenshot,
        }))
    }

    pub fn notify(success: bool, message: &str) -> Result<()> {
        let kind = if success { "--info" } else { "--error" };
        run(&[
            kind,
            &format!("--title={TITLE}"),
            &format!("--text={message}"),
        ])?;
        Ok(())
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::process::{Command, Stdio};

    use anyhow::{Context, Result, bail};

    use super::super::Draft;
    use super::TITLE;

    fn quote(text: &str) -> String {
        format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
    }

    /// Runs one AppleScript expression; `None` when the user cancelled.
    fn osascript(script: &str) -> Result<Option<String>> {
        let output = Command::new("/usr/bin/osascript")
            .args(["-e", script])
            .stdin(Stdio::null())
            .output()
            .context("cannot run osascript")?;
        if output.status.success() {
            return Ok(Some(
                String::from_utf8_lossy(&output.stdout)
                    .trim_end_matches('\n')
                    .to_string(),
            ));
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("-128") {
            return Ok(None);
        }
        bail!("the support dialog failed: {}", stderr.trim())
    }

    fn prompt(text: &str, default: &str) -> Result<Option<String>> {
        osascript(&format!(
            "text returned of (display dialog {} default answer {} with title {} buttons {{\"Cancel\", \"Next\"}} default button \"Next\")",
            quote(text),
            quote(default),
            quote(TITLE)
        ))
    }

    pub fn ask() -> Result<Option<Draft>> {
        let Some(subject) = prompt("Subject", "")? else {
            return Ok(None);
        };
        let Some(description) = prompt("What is the problem?", "\n\n\n")? else {
            return Ok(None);
        };
        let Some(email) = prompt("Your e-mail address (optional)", "")? else {
            return Ok(None);
        };
        let screenshot = osascript(&format!(
            "button returned of (display dialog {} with title {} buttons {{\"No\", \"Attach\"}} default button \"Attach\")",
            quote("Attach a screenshot of your screen?"),
            quote(TITLE)
        ))?
        .is_some_and(|b| b == "Attach");
        Ok(Some(Draft {
            subject,
            description,
            email: Some(email).filter(|e| !e.trim().is_empty()),
            screenshot,
        }))
    }

    pub fn notify(_success: bool, message: &str) -> Result<()> {
        osascript(&format!(
            "display dialog {} with title {} buttons {{\"OK\"}} default button \"OK\"",
            quote(message),
            quote(TITLE)
        ))?;
        Ok(())
    }
}

/// macOS: `screencapture` of the main display, downscaled with `sips`.
#[cfg(target_os = "macos")]
pub fn macos_screenshot() -> Result<Vec<u8>> {
    use anyhow::{Context, bail};
    let path = std::env::temp_dir().join(format!(
        "rustrmm-support-{}.jpg",
        hex::encode(rustrmm_crypto::random::bytes::<8>())
    ));
    let status = std::process::Command::new("/usr/sbin/screencapture")
        .args(["-x", "-t", "jpg"])
        .arg(&path)
        .status()
        .context("cannot run screencapture")?;
    if !status.success() {
        let _ = std::fs::remove_file(&path);
        bail!("screencapture failed (screen recording permission may be missing)");
    }
    let _ = std::process::Command::new("/usr/bin/sips")
        .args(["--resampleWidth", &super::SCREENSHOT_WIDTH.to_string()])
        .arg(&path)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    let data = std::fs::read(&path).context("reading the screenshot");
    let _ = std::fs::remove_file(&path);
    data
}
