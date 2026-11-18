//! Input-desktop tracking. The helper's threads start on `WinSta0\Default`;
//! when UAC or the lock screen takes over, the *input* desktop becomes
//! `Winlogon` and a capture thread must re-attach (`SetThreadDesktop`) to it
//! before DXGI/GDI will show anything but a lost/black surface.

use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::StationsAndDesktops::{
    CloseDesktop, DESKTOP_ACCESS_FLAGS, DESKTOP_CONTROL_FLAGS, GetProcessWindowStation,
    GetThreadDesktop, GetUserObjectInformationW, HDESK, OpenInputDesktop, SetThreadDesktop,
    UOI_NAME,
};
use windows::Win32::System::Threading::GetCurrentThreadId;

/// GENERIC_ALL, like Microsoft's Desktop Duplication sample. LocalSystem is
/// granted this on `Winlogon`; a normal user only on their own desktops.
const DESKTOP_GENERIC_ALL: DESKTOP_ACCESS_FLAGS = DESKTOP_ACCESS_FLAGS(0x1000_0000);

/// An owned desktop handle plus its name.
pub struct Desktop {
    handle: HDESK,
    pub name: String,
}

// SAFETY: desktop handles are process-wide and may be used from any thread.
unsafe impl Send for Desktop {}

impl Desktop {
    /// The desktop currently receiving user input. Fails with access denied
    /// for a non-SYSTEM caller while the secure desktop is up.
    pub fn open_input() -> windows::core::Result<Desktop> {
        let handle =
            unsafe { OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_GENERIC_ALL)? };
        let name = object_name(HANDLE(handle.0)).unwrap_or_else(|_| "?".into());
        Ok(Desktop { handle, name })
    }

    /// Takes ownership of a handle (closed on drop).
    pub fn from_raw(handle: HDESK, name: &str) -> Desktop {
        Desktop {
            handle,
            name: name.to_owned(),
        }
    }

    pub fn handle(&self) -> HDESK {
        self.handle
    }

    /// Fails (ERROR_BUSY) if the calling thread owns windows or hooks on its
    /// current desktop.
    pub fn attach_current_thread(&self) -> windows::core::Result<()> {
        unsafe { SetThreadDesktop(self.handle) }
    }
}

impl Drop for Desktop {
    fn drop(&mut self) {
        // Fails harmlessly if a thread of this process is still attached to it.
        unsafe {
            let _ = CloseDesktop(self.handle);
        }
    }
}

pub fn object_name(handle: HANDLE) -> windows::core::Result<String> {
    let mut buf = [0u16; 256];
    let mut needed = 0u32;
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

/// Name of the desktop the calling thread is attached to (not owned; the
/// thread's initial desktop handle must never be closed).
pub fn thread_desktop_name() -> String {
    match unsafe { GetThreadDesktop(GetCurrentThreadId()) } {
        Ok(h) => object_name(HANDLE(h.0)).unwrap_or_else(|_| "?".into()),
        Err(_) => "?".into(),
    }
}

pub fn window_station_name() -> String {
    match unsafe { GetProcessWindowStation() } {
        Ok(h) => object_name(HANDLE(h.0)).unwrap_or_else(|_| "?".into()),
        Err(_) => "?".into(),
    }
}
