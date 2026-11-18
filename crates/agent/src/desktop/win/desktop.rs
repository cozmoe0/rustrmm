//! Input-desktop tracking (from the DXGI spike). Threads start on `WinSta0\Default`; when UAC or
//! the lock screen takes over, the *input* desktop becomes `Winlogon` and capture and input
//! threads must re-attach (`SetThreadDesktop`) before DXGI, GDI or `SendInput` reach it.

use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::StationsAndDesktops::{
    CloseDesktop, DESKTOP_ACCESS_FLAGS, DESKTOP_CONTROL_FLAGS, GetThreadDesktop,
    GetUserObjectInformationW, HDESK, OpenInputDesktop, SetThreadDesktop, UOI_NAME,
};
use windows::Win32::System::Threading::GetCurrentThreadId;

/// GENERIC_ALL, like Microsoft's Desktop Duplication sample. LocalSystem is granted this on
/// `Winlogon`; a normal user only on their own desktops.
const DESKTOP_GENERIC_ALL: DESKTOP_ACCESS_FLAGS = DESKTOP_ACCESS_FLAGS(0x1000_0000);

/// An owned desktop handle plus its name.
pub struct Desktop {
    handle: HDESK,
    pub name: String,
}

// SAFETY: desktop handles are process-wide and may be used from any thread.
unsafe impl Send for Desktop {}

impl Desktop {
    /// The desktop currently receiving user input. Fails with access denied for a non-SYSTEM
    /// caller while the secure desktop is up.
    pub fn open_input() -> windows::core::Result<Desktop> {
        // SAFETY: plain call; the returned handle is owned by `Desktop` and closed on drop.
        let handle =
            unsafe { OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_GENERIC_ALL)? };
        let name = object_name(HANDLE(handle.0)).unwrap_or_else(|_| "?".into());
        Ok(Desktop { handle, name })
    }

    /// Fails (ERROR_BUSY) if the calling thread owns windows or hooks on its current desktop.
    pub fn attach_current_thread(&self) -> windows::core::Result<()> {
        // SAFETY: valid desktop handle owned by `self`, which outlives the attachment because
        // callers keep it alongside the thread state.
        unsafe { SetThreadDesktop(self.handle) }
    }
}

impl Drop for Desktop {
    fn drop(&mut self) {
        // SAFETY: owned handle, closed once. Fails harmlessly while a thread is still attached.
        unsafe {
            let _ = CloseDesktop(self.handle);
        }
    }
}

fn object_name(handle: HANDLE) -> windows::core::Result<String> {
    let mut buf = [0u16; 256];
    let mut needed = 0u32;
    // SAFETY: the buffer and its byte size are valid for the call.
    unsafe {
        GetUserObjectInformationW(
            handle,
            UOI_NAME,
            Some(buf.as_mut_ptr().cast()),
            size_of_val(&buf) as u32,
            Some(&mut needed),
        )?;
    }
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    Ok(String::from_utf16_lossy(&buf[..len]))
}

/// Name of the desktop the calling thread is attached to (the handle is not owned and must
/// never be closed).
pub fn thread_desktop_name() -> String {
    // SAFETY: plain calls on the current thread.
    match unsafe { GetThreadDesktop(GetCurrentThreadId()) } {
        Ok(h) => object_name(HANDLE(h.0)).unwrap_or_else(|_| "?".into()),
        Err(_) => "?".into(),
    }
}

/// Keeps one thread attached to the input desktop. `follow` is called before each use.
pub struct Follower {
    pub current: String,
    owned: Option<Desktop>,
    last_error: Option<String>,
}

impl Follower {
    pub fn new() -> Self {
        Self {
            current: thread_desktop_name(),
            owned: None,
            last_error: None,
        }
    }

    /// Re-attaches when the input desktop changed. Returns true on a switch. `before_switch`
    /// releases desktop-bound objects (duplications, DCs) first.
    pub fn follow(&mut self, before_switch: impl FnOnce()) -> bool {
        match Desktop::open_input() {
            Ok(input) => {
                self.last_error = None;
                if input.name == self.current {
                    return false;
                }
                before_switch();
                match input.attach_current_thread() {
                    Ok(()) => {
                        tracing::info!(from = %self.current, to = %input.name, "input desktop changed");
                        self.current = input.name.clone();
                        self.owned = Some(input);
                        true
                    }
                    Err(e) => {
                        tracing::warn!(desktop = %input.name, error = %e, "SetThreadDesktop refused");
                        false
                    }
                }
            }
            Err(e) => {
                let text = e.message();
                if self.last_error.as_deref() != Some(text.as_str()) {
                    tracing::debug!(error = %text, "input desktop not accessible (secure desktop?)");
                    self.last_error = Some(text);
                }
                false
            }
        }
    }
}
