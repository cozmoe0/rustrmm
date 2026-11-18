//! Remote desktop (Phase 8, `docs/api-desktop.md`).
//!
//! The platform-neutral pieces — tile diffing (`tiles`), parallel JPEG encoding (`encode`),
//! quality adaptation (`quality`), key maps (`keymap`), cursor conversion (`cursor`), the
//! streaming engine with ack-based flow control (`engine`) and the helper pipe framing (`ipc`) —
//! are shared by the Windows backend (`win`: a session helper process with DXGI/GDI capture) and
//! the Linux backend (`x11`: in-process x11rb). macOS only reports its permission state.

pub mod cursor;
pub mod encode;
pub mod engine;
#[cfg_attr(not(windows), allow(dead_code))]
pub mod ipc;
pub mod keymap;
pub mod quality;
pub mod tiles;
#[cfg(windows)]
pub(crate) mod win;
#[cfg(target_os = "linux")]
mod x11;

use anyhow::Result;
use futures::SinkExt;
use rustrmm_proto::desktop::{ConsentMode, DesktopControl, Quality, Screenshot};
use rustrmm_proto::remote::TunnelKind;
use serde_json::Value;
use tokio_tungstenite::tungstenite::Message as WsMessage;

pub(crate) type Sink = crate::remote::tunnel::Sink;
pub(crate) type Stream = crate::remote::tunnel::Stream;

/// A desktop tunnel's parameters (the signed `TunnelKind::Desktop`).
#[derive(Debug, Clone)]
#[cfg_attr(not(windows), allow(dead_code))]
pub struct Params {
    pub session_id: Option<u32>,
    pub monitor: Option<u32>,
    pub view_only: bool,
    pub quality: Quality,
    pub consent: ConsentMode,
    pub consent_timeout_secs: u32,
    pub banner: bool,
    pub technician: String,
    pub organization: String,
}

impl Params {
    pub fn from_kind(kind: TunnelKind) -> Option<Self> {
        match kind {
            TunnelKind::Desktop {
                session_id,
                monitor,
                view_only,
                quality,
                consent,
                consent_timeout_secs,
                banner,
                technician,
                organization,
            } => Some(Self {
                session_id,
                monitor,
                view_only,
                quality,
                consent,
                consent_timeout_secs: consent_timeout_secs.clamp(5, 300),
                banner,
                technician,
                organization,
            }),
            _ => None,
        }
    }
}

/// Sends one JSON control message on the tunnel.
pub(crate) async fn control(sink: &mut Sink, message: &DesktopControl) -> Result<()> {
    sink.send(WsMessage::Text(message.to_text().into())).await?;
    Ok(())
}

/// Serves a desktop tunnel until the operator or the device ends it.
pub async fn serve(sink: &mut Sink, stream: &mut Stream, params: Params) -> Result<()> {
    #[cfg(windows)]
    {
        win::serve(sink, stream, params).await
    }
    #[cfg(target_os = "linux")]
    {
        x11::serve(sink, stream, params).await
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = (sink, stream, params);
        anyhow::bail!("Remote desktop on macOS is not available yet")
    }
}

/// `desktop_sessions` command (blocking).
pub fn list_sessions() -> Result<Value> {
    #[cfg(windows)]
    {
        win::list_sessions()
    }
    #[cfg(target_os = "linux")]
    {
        x11::list_sessions()
    }
    #[cfg(target_os = "macos")]
    {
        Ok(serde_json::json!({ "items": [], "tcc": crate::collectors::macos_tcc() }))
    }
}

/// `screenshot` command.
pub async fn screenshot(request: Screenshot) -> Result<Value> {
    #[cfg(windows)]
    {
        win::screenshot(request).await
    }
    #[cfg(target_os = "linux")]
    {
        x11::screenshot(request).await
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = request;
        anyhow::bail!("Remote desktop on macOS is not available yet")
    }
}

/// One JPEG of the current user's own screen, captured in-process (`rustrmm-agent support`
/// runs in the user's session, so no helper or consent prompt is involved).
#[cfg(any(windows, target_os = "linux"))]
pub fn capture_own_screen(max_width: u32) -> Result<Vec<u8>> {
    #[cfg(windows)]
    {
        win::set_dpi_awareness();
        win::own_screenshot(max_width).map(|(_, _, jpeg)| jpeg)
    }
    #[cfg(target_os = "linux")]
    {
        x11::own_screenshot(max_width)
    }
}

/// Result of the `desktop` selftest check.
pub enum SelftestOutcome {
    /// One frame was captured and encoded; the summary has the numbers.
    Pass(String),
    /// No usable display in this session (the reason is printed).
    Skip(String),
}

/// Selftest: captures and encodes one frame of the current session.
pub async fn selftest() -> Result<SelftestOutcome> {
    #[cfg(windows)]
    {
        tokio::task::spawn_blocking(win::selftest).await?
    }
    #[cfg(target_os = "linux")]
    {
        tokio::task::spawn_blocking(x11::selftest).await?
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        Ok(SelftestOutcome::Skip(
            "remote desktop on macOS is not available yet".into(),
        ))
    }
}

/// `rustrmm-agent desktop-helper` (Windows only).
pub fn helper_main(session: u32, pipe: &str, parent: u32) -> Result<()> {
    #[cfg(windows)]
    {
        win::helper_main(session, pipe, parent)
    }
    #[cfg(not(windows))]
    {
        let _ = (session, pipe, parent);
        anyhow::bail!("the desktop helper exists only on Windows")
    }
}

/// `rustrmm-agent desktop-bench` (Windows dev mode): helper throughput with full refreshes.
pub async fn bench(frames: u32, quality: Quality, incremental: bool) -> Result<()> {
    #[cfg(windows)]
    {
        win::bench(frames, quality, incremental).await
    }
    #[cfg(not(windows))]
    {
        let _ = (frames, quality, incremental);
        anyhow::bail!("the desktop bench runs on Windows only")
    }
}
