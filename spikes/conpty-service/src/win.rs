//! Small Win32 helpers shared by the spike modules.

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::path::PathBuf;

use windows::Win32::Foundation::{CloseHandle, ERROR_SUCCESS, HANDLE, WIN32_ERROR};
use windows::Win32::System::Registry::{HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD, RRF_RT_REG_SZ, RegGetValueW};
use windows::Win32::System::SystemInformation::GetSystemDirectoryW;
use windows::core::{HRESULT, PCWSTR, w};

/// Owned kernel handle, closed exactly once on drop.
#[derive(Debug)]
pub struct Handle(HANDLE);

// SAFETY: a kernel handle is a process-wide value with no thread affinity; this wrapper is the
// single owner and closes it once.
unsafe impl Send for Handle {}
// SAFETY: shared access only hands out the raw value; all mutation goes through the kernel.
unsafe impl Sync for Handle {}

impl Handle {
    /// Takes ownership of `raw`.
    pub fn new(raw: HANDLE) -> Self {
        Self(raw)
    }

    pub fn raw(&self) -> HANDLE {
        self.0
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            // SAFETY: we own the handle and close it exactly once.
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

/// NUL-terminated UTF-16 copy of `s`.
pub fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// NUL-terminated UTF-16 copy of an OS string (paths).
pub fn wide_os(s: &OsStr) -> Vec<u16> {
    s.encode_wide().chain(std::iter::once(0)).collect()
}

/// String from a (possibly NUL-terminated) UTF-16 buffer.
pub fn from_wide(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

pub fn is_win32(err: &windows::core::Error, code: WIN32_ERROR) -> bool {
    err.code() == HRESULT::from_win32(code.0)
}

/// `C:\Windows\System32`, resolved via the API rather than PATH or environment variables, so a
/// SYSTEM process never launches a binary from a user-influenced location.
pub fn system_dir() -> PathBuf {
    let mut buf = [0u16; 260];
    // SAFETY: the buffer is valid for its full length.
    let n = unsafe { GetSystemDirectoryW(Some(&mut buf)) } as usize;
    if n == 0 || n >= buf.len() {
        return PathBuf::from(r"C:\Windows\System32");
    }
    PathBuf::from(String::from_utf16_lossy(&buf[..n]))
}

/// e.g. `26200.7171 (25H2)`.
pub fn windows_build() -> String {
    let key = w!(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion");
    let build = reg_string(key, w!("CurrentBuildNumber")).unwrap_or_else(|| "?".into());
    let ubr = reg_dword(key, w!("UBR")).map_or_else(|| "?".into(), |v| v.to_string());
    let display = reg_string(key, w!("DisplayVersion")).unwrap_or_default();
    format!("{build}.{ubr} ({display})")
}

fn reg_string(key: PCWSTR, value: PCWSTR) -> Option<String> {
    let mut buf = [0u16; 128];
    let mut len = std::mem::size_of_val(&buf) as u32;
    // SAFETY: the buffer and length describe valid writable memory.
    let rc = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            key,
            value,
            RRF_RT_REG_SZ,
            None,
            Some(buf.as_mut_ptr().cast()),
            Some(&raw mut len),
        )
    };
    (rc == ERROR_SUCCESS).then(|| from_wide(&buf))
}

fn reg_dword(key: PCWSTR, value: PCWSTR) -> Option<u32> {
    let mut data = 0u32;
    let mut len = 4u32;
    // SAFETY: `data` is a valid 4-byte buffer.
    let rc = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            key,
            value,
            RRF_RT_REG_DWORD,
            None,
            Some((&raw mut data).cast()),
            Some(&raw mut len),
        )
    };
    (rc == ERROR_SUCCESS).then_some(data)
}

/// Debug-escaped prefix of raw terminal output, for logs.
pub fn escape_bytes(bytes: &[u8], max: usize) -> String {
    let cut = &bytes[..bytes.len().min(max)];
    let mut s = String::from_utf8_lossy(cut).escape_debug().to_string();
    if bytes.len() > max {
        s.push_str(&format!("...(+{} bytes)", bytes.len() - max));
    }
    s
}
