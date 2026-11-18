//! Screen capture back ends. Both produce tightly packed top-down BGRA.

pub mod dxgi;
pub mod gdi;

use std::fmt;

use windows::Win32::Foundation::E_ACCESSDENIED;
use windows::Win32::Graphics::Dxgi::{
    DXGI_ERROR_ACCESS_DENIED, DXGI_ERROR_ACCESS_LOST, DXGI_ERROR_NOT_CURRENTLY_AVAILABLE,
    DXGI_ERROR_SESSION_DISCONNECTED, DXGI_ERROR_UNSUPPORTED,
};

#[derive(Debug)]
pub enum CaptureError {
    /// DXGI_ERROR_ACCESS_LOST: desktop switch, mode change, full-screen
    /// exclusive app... The duplication must be recreated.
    AccessLost,
    /// DXGI_ERROR_UNSUPPORTED: Desktop Duplication cannot serve this desktop
    /// or display (old RDP, some drivers, transient during a switch).
    Unsupported,
    /// E_ACCESSDENIED: the thread is not on the input desktop, or the secure
    /// desktop is up and the caller is not LocalSystem.
    AccessDenied,
    /// DXGI_ERROR_SESSION_DISCONNECTED.
    SessionDisconnected,
    /// DXGI_ERROR_NOT_CURRENTLY_AVAILABLE: too many duplication clients, or transient.
    NotCurrentlyAvailable,
    /// No output matched the selection.
    NoOutput,
    /// The duplicated surface is not 8-bit BGRA.
    UnexpectedFormat(i32),
    Other(windows::core::Error),
}

impl CaptureError {
    pub fn from_win(e: windows::core::Error) -> Self {
        let code = e.code();
        if code == DXGI_ERROR_ACCESS_LOST {
            Self::AccessLost
        } else if code == DXGI_ERROR_UNSUPPORTED {
            Self::Unsupported
        } else if code == E_ACCESSDENIED || code == DXGI_ERROR_ACCESS_DENIED {
            Self::AccessDenied
        } else if code == DXGI_ERROR_SESSION_DISCONNECTED {
            Self::SessionDisconnected
        } else if code == DXGI_ERROR_NOT_CURRENTLY_AVAILABLE {
            Self::NotCurrentlyAvailable
        } else {
            Self::Other(e)
        }
    }
}

impl fmt::Display for CaptureError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AccessLost => f.write_str("DXGI_ERROR_ACCESS_LOST"),
            Self::Unsupported => f.write_str("DXGI_ERROR_UNSUPPORTED"),
            Self::AccessDenied => f.write_str("E_ACCESSDENIED"),
            Self::SessionDisconnected => f.write_str("DXGI_ERROR_SESSION_DISCONNECTED"),
            Self::NotCurrentlyAvailable => f.write_str("DXGI_ERROR_NOT_CURRENTLY_AVAILABLE"),
            Self::NoOutput => f.write_str("no matching DXGI output"),
            Self::UnexpectedFormat(fmt) => {
                write!(f, "unexpected surface format DXGI_FORMAT({fmt})")
            }
            Self::Other(e) => write!(f, "{e}"),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FrameStatus {
    /// The desktop image changed; `image()` holds the new content.
    New,
    /// Only the mouse pointer moved or changed shape.
    PointerOnly,
    /// Nothing changed within the timeout (or the GDI pacing interval).
    Timeout,
}

/// Tightly packed, top-down BGRA.
pub struct Image<'a> {
    pub width: u32,
    pub height: u32,
    pub bgra: &'a [u8],
}

pub enum Capturer {
    Dxgi(dxgi::DxgiCapturer),
    Gdi(gdi::GdiCapturer),
}

impl Capturer {
    pub fn method(&self) -> &'static str {
        match self {
            Self::Dxgi(_) => "dxgi",
            Self::Gdi(_) => "gdi",
        }
    }

    pub fn next_frame(&mut self, timeout_ms: u32) -> Result<FrameStatus, CaptureError> {
        match self {
            Self::Dxgi(c) => c.next_frame(timeout_ms),
            Self::Gdi(c) => c.next_frame(timeout_ms),
        }
    }

    /// Latest captured image, if any frame has been captured yet.
    pub fn image(&self) -> Option<Image<'_>> {
        match self {
            Self::Dxgi(c) => c.image(),
            Self::Gdi(c) => c.image(),
        }
    }

    /// Time from "frame available" to "BGRA in system memory" for the last new frame.
    pub fn last_process_ms(&self) -> f64 {
        match self {
            Self::Dxgi(c) => c.last_process_ms,
            Self::Gdi(c) => c.last_process_ms,
        }
    }
}
