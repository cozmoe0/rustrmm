//! Small Win32 helpers: time stamps, process identity, DPI, Ctrl+C, watchdog.

use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};

use windows::Win32::Foundation::{CloseHandle, HANDLE, HLOCAL, LocalFree};
use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
use windows::Win32::Security::{
    GetTokenInformation, IsWellKnownSid, TOKEN_ELEVATION, TOKEN_QUERY, TOKEN_USER, TokenElevation,
    TokenUser, WinLocalSystemSid,
};
use windows::Win32::System::Console::SetConsoleCtrlHandler;
use windows::Win32::System::RemoteDesktop::{ProcessIdToSessionId, WTSGetActiveConsoleSessionId};
use windows::Win32::System::SystemInformation::GetLocalTime;
use windows::Win32::System::Threading::{
    GetCurrentProcess, GetCurrentThreadId, INFINITE, OpenProcess, OpenProcessToken,
    PROCESS_SYNCHRONIZE, WaitForSingleObject,
};
use windows::Win32::UI::HiDpi::{
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetProcessDpiAwarenessContext,
};
use windows::core::{BOOL, PWSTR};

/// `2026-11-17 15:30:12.345`
pub fn timestamp() -> String {
    let t = unsafe { GetLocalTime() };
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:03}",
        t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond, t.wMilliseconds
    )
}

/// `20261117-153012-345`, for file names.
pub fn timestamp_compact() -> String {
    let t = unsafe { GetLocalTime() };
    format!(
        "{:04}{:02}{:02}-{:02}{:02}{:02}-{:03}",
        t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond, t.wMilliseconds
    )
}

pub fn thread_id() -> u32 {
    unsafe { GetCurrentThreadId() }
}

pub fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Physical-pixel coordinates for GDI and correct output rectangles on scaled
/// displays. Also documented as a prerequisite for `DuplicateOutput1`.
pub fn set_dpi_awareness() {
    if let Err(e) =
        unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) }
    {
        log!("SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2) failed: {e}");
    }
}

static STOP: AtomicBool = AtomicBool::new(false);

pub fn stop_requested() -> bool {
    STOP.load(Ordering::Relaxed)
}

unsafe extern "system" fn on_console_ctrl(_ctrl_type: u32) -> BOOL {
    // Handle Ctrl+C ourselves so the loop can unwind; the switch test must get
    // the chance to switch the console back to the original desktop.
    STOP.store(true, Ordering::Relaxed);
    BOOL(1)
}

pub fn install_ctrl_handler() {
    if let Err(e) = unsafe { SetConsoleCtrlHandler(Some(on_console_ctrl), true) } {
        log!("SetConsoleCtrlHandler failed: {e}");
    }
}

/// The helper must not outlive the service that launched it. Job objects
/// cannot span sessions (service = session 0, helper = console session), so
/// watch the parent process handle instead.
pub fn exit_when_process_exits(pid: u32) {
    let handle = match unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, pid) } {
        Ok(h) => SendHandle(h),
        Err(e) => {
            log!(
                "cannot watch parent pid {pid}: {e}; helper will rely on the service to terminate it"
            );
            return;
        }
    };
    std::thread::spawn(move || {
        let handle = handle;
        unsafe { WaitForSingleObject(handle.0, INFINITE) };
        log!("parent pid {pid} exited; helper exiting");
        std::process::exit(0);
    });
}

struct SendHandle(HANDLE);
// SAFETY: kernel handles are process-wide; the wrapper only moves it to the watchdog thread.
unsafe impl Send for SendHandle {}

pub fn is_elevated() -> bool {
    unsafe {
        let mut token = HANDLE::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return false;
        }
        let mut elevation = TOKEN_ELEVATION::default();
        let mut len = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elevation as *mut TOKEN_ELEVATION as *mut c_void),
            size_of::<TOKEN_ELEVATION>() as u32,
            &mut len,
        )
        .is_ok();
        let _ = CloseHandle(token);
        ok && elevation.TokenIsElevated != 0
    }
}

/// Returns (SID string, is LocalSystem).
fn token_user() -> (String, bool) {
    unsafe {
        let mut token = HANDLE::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return ("?".into(), false);
        }
        // u64 storage keeps TOKEN_USER (which holds a pointer) aligned.
        let mut buf = [0u64; 64];
        let mut len = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenUser,
            Some(buf.as_mut_ptr().cast()),
            size_of_val(&buf) as u32,
            &mut len,
        )
        .is_ok();
        let _ = CloseHandle(token);
        if !ok {
            return ("?".into(), false);
        }
        let user = &*(buf.as_ptr() as *const TOKEN_USER);
        let sid = user.User.Sid;
        let system = IsWellKnownSid(sid, WinLocalSystemSid).as_bool();
        let mut text = PWSTR::null();
        let sid_text = if ConvertSidToStringSidW(sid, &mut text).is_ok() {
            let s = text.to_string().unwrap_or_default();
            let _ = LocalFree(Some(HLOCAL(text.0.cast())));
            s
        } else {
            "?".into()
        };
        (sid_text, system)
    }
}

pub fn identity_summary() -> String {
    let pid = std::process::id();
    let mut session = u32::MAX;
    let _ = unsafe { ProcessIdToSessionId(pid, &mut session) };
    let console = unsafe { WTSGetActiveConsoleSessionId() };
    let (sid, system) = token_user();
    format!(
        "pid {pid}, session {session} (active console session {console}), user {sid}{}, elevated {}, \
         window station '{}', thread desktop '{}'",
        if system { " (LocalSystem)" } else { "" },
        is_elevated(),
        crate::desktop::window_station_name(),
        crate::desktop::thread_desktop_name(),
    )
}
