//! Windows interactive sessions (WTS), the consent prompt and Ctrl+Alt+Del (`SendSAS`).

use anyhow::{Result, bail};
use rustrmm_proto::desktop::ConsentStatus;
use serde_json::{Value, json};
use windows::Win32::System::LibraryLoader::{
    GetProcAddress, LOAD_LIBRARY_SEARCH_SYSTEM32, LoadLibraryExW,
};
use windows::Win32::System::RemoteDesktop::{
    ProcessIdToSessionId, WTS_CONNECTSTATE_CLASS, WTS_CURRENT_SERVER_HANDLE, WTS_INFO_CLASS,
    WTS_SESSION_INFOW, WTSActive, WTSConnected, WTSDisconnected, WTSDomainName,
    WTSEnumerateSessionsW, WTSFreeMemory, WTSGetActiveConsoleSessionId, WTSINFOEXW,
    WTSQuerySessionInformationW, WTSSendMessageW, WTSSessionInfoEx, WTSUserName,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, IDNO, IDTIMEOUT, IDYES, MB_ICONQUESTION, MB_SETFOREGROUND, MB_TOPMOST,
    MB_YESNO, MESSAGEBOX_RESULT, SM_CMONITORS,
};
use windows::core::{PCWSTR, PWSTR, s, w};

/// `WTSGetActiveConsoleSessionId` while no session is attached to the console.
const NO_SESSION: u32 = 0xFFFF_FFFF;
/// `WTSINFOEX_LEVEL1_W.SessionFlags`: the session is locked.
const WTS_SESSIONSTATE_LOCK: i32 = 0;

pub fn console_session() -> Option<u32> {
    // SAFETY: no preconditions.
    let id = unsafe { WTSGetActiveConsoleSessionId() };
    (id != NO_SESSION).then_some(id)
}

pub fn own_session() -> u32 {
    let mut session = 0u32;
    // SAFETY: out pointer is a local.
    let _ = unsafe { ProcessIdToSessionId(std::process::id(), &mut session) };
    session
}

fn query_string(session: u32, class: WTS_INFO_CLASS) -> Option<String> {
    let mut buf = PWSTR::null();
    let mut bytes = 0u32;
    // SAFETY: out pointers are locals; the buffer is freed with WTSFreeMemory.
    unsafe {
        WTSQuerySessionInformationW(
            Some(WTS_CURRENT_SERVER_HANDLE),
            session,
            class,
            &mut buf,
            &mut bytes,
        )
        .ok()?;
        let text = buf.to_string().ok();
        WTSFreeMemory(buf.0.cast());
        text.filter(|t| !t.is_empty())
    }
}

/// `DOMAIN\user` signed in to the session, if any.
pub fn session_user(session: u32) -> Option<String> {
    let user = query_string(session, WTSUserName)?;
    Some(match query_string(session, WTSDomainName) {
        Some(domain) => format!("{domain}\\{user}"),
        None => user,
    })
}

/// Whether the session's desktop is locked (`None` when unknown).
pub fn is_locked(session: u32) -> Option<bool> {
    let mut buf = PWSTR::null();
    let mut bytes = 0u32;
    // SAFETY: as in `query_string`; WTSSessionInfoEx returns a WTSINFOEXW.
    unsafe {
        WTSQuerySessionInformationW(
            Some(WTS_CURRENT_SERVER_HANDLE),
            session,
            WTSSessionInfoEx,
            &mut buf,
            &mut bytes,
        )
        .ok()?;
        let info = &*(buf.0 as *const WTSINFOEXW);
        let locked = (info.Level == 1)
            .then_some(info.Data.WTSInfoExLevel1.SessionFlags == WTS_SESSIONSTATE_LOCK);
        WTSFreeMemory(buf.0.cast());
        locked
    }
}

/// `GET /devices/{id}/desktop/sessions` on Windows.
pub fn list() -> Result<Value> {
    let console = console_session();
    let own = own_session();
    let mut info: *mut WTS_SESSION_INFOW = std::ptr::null_mut();
    let mut count = 0u32;
    // SAFETY: out pointers are locals; the array is freed with WTSFreeMemory.
    unsafe { WTSEnumerateSessionsW(Some(WTS_CURRENT_SERVER_HANDLE), 0, 1, &mut info, &mut count) }
        .map_err(|e| anyhow::anyhow!("WTSEnumerateSessions failed: {e}"))?;
    let mut items = Vec::new();
    for i in 0..count as usize {
        // SAFETY: `count` entries were returned.
        let entry = unsafe { &*info.add(i) };
        let id = entry.SessionId;
        // SAFETY: a NUL-terminated string inside the returned array.
        let station = unsafe { entry.pWinStationName.to_string() }.unwrap_or_default();
        let state: WTS_CONNECTSTATE_CLASS = entry.State;
        if id == 0 || !(state == WTSActive || state == WTSConnected || state == WTSDisconnected) {
            continue;
        }
        let user = session_user(id);
        if user.is_none() && state == WTSDisconnected {
            continue;
        }
        let is_console = Some(id) == console || station.eq_ignore_ascii_case("Console");
        let label = if user.is_none() {
            "login_screen"
        } else if state == WTSDisconnected {
            "disconnected"
        } else if is_locked(id) == Some(true) {
            "locked"
        } else {
            "active"
        };
        // Monitors are only visible from inside the session (dev mode).
        let monitors = (id == own).then(|| {
            // SAFETY: plain metric query.
            unsafe { GetSystemMetrics(SM_CMONITORS) }
        });
        items.push(json!({
            "session_id": id,
            "kind": if is_console { "console" } else { "rdp" },
            "user": user,
            "state": label,
            "monitors": monitors,
        }));
    }
    // SAFETY: allocated by WTSEnumerateSessionsW.
    unsafe { WTSFreeMemory(info.cast()) };
    items.sort_by_key(|i| (i["kind"] != "console", i["session_id"].as_u64()));
    Ok(json!({ "items": items }))
}

/// Whether consent must be asked in `session` under the given mode.
pub fn consent_needed(mode: rustrmm_proto::desktop::ConsentMode, session: u32) -> bool {
    use rustrmm_proto::desktop::ConsentMode;
    let signed_in = session_user(session).is_some();
    match mode {
        ConsentMode::Never => false,
        // Nobody to ask on the sign-in screen.
        ConsentMode::Always => signed_in,
        ConsentMode::WhenUserPresent => signed_in && is_locked(session) == Some(false),
    }
}

/// Asks the session's user (blocking, up to `timeout_secs`).
pub fn ask_consent(session: u32, prompt: &str, timeout_secs: u32) -> ConsentStatus {
    let title: Vec<u16> = "Remote support request".encode_utf16().collect();
    let body: Vec<u16> = prompt.encode_utf16().collect();
    let mut response = MESSAGEBOX_RESULT(0);
    // SAFETY: buffers outlive the call; lengths are in bytes; bWait = TRUE blocks until the user
    // answers or the timeout expires.
    let sent = unsafe {
        WTSSendMessageW(
            Some(WTS_CURRENT_SERVER_HANDLE),
            session,
            PCWSTR(title.as_ptr()),
            (title.len() * 2) as u32,
            PCWSTR(body.as_ptr()),
            (body.len() * 2) as u32,
            MB_YESNO | MB_ICONQUESTION | MB_TOPMOST | MB_SETFOREGROUND,
            timeout_secs.max(1),
            &mut response,
            true,
        )
    };
    if let Err(e) = sent {
        tracing::warn!(error = %e, "consent prompt could not be shown");
        return ConsentStatus::Denied;
    }
    match response {
        r if r == IDYES => ConsentStatus::Granted,
        r if r == IDNO => ConsentStatus::Denied,
        r if r == IDTIMEOUT => ConsentStatus::Timeout,
        _ => ConsentStatus::Denied,
    }
}

const SAS_POLICY_KEY: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System";

/// `SoftwareSASGeneration`: 1 = services, 2 = ease-of-access apps, 3 = both.
pub fn sas_policy_allows_services() -> bool {
    use winreg::RegKey;
    use winreg::enums::HKEY_LOCAL_MACHINE;
    RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey(SAS_POLICY_KEY)
        .ok()
        .and_then(|k| k.get_value::<u32, _>("SoftwareSASGeneration").ok())
        .is_some_and(|v| v == 1 || v == 3)
}

/// Sends Ctrl+Alt+Del (the secure attention sequence). Only a LocalSystem service may do this,
/// and only with the `SoftwareSASGeneration` policy.
pub fn send_sas(as_service: bool) -> Result<()> {
    if !as_service {
        bail!("Ctrl+Alt+Del is available only when the agent runs as a service");
    }
    if !sas_policy_allows_services() {
        bail!("Ctrl+Alt+Del needs the SoftwareSASGeneration policy");
    }
    // SAFETY: sas.dll is a system DLL loaded from System32 by name; SendSAS has the signature
    // `void SendSAS(BOOL AsUser)`.
    unsafe {
        let module = LoadLibraryExW(w!("sas.dll"), None, LOAD_LIBRARY_SEARCH_SYSTEM32)
            .map_err(|e| anyhow::anyhow!("sas.dll: {e}"))?;
        let Some(proc) = GetProcAddress(module, s!("SendSAS")) else {
            bail!("SendSAS is not available on this system");
        };
        let send: unsafe extern "system" fn(i32) = std::mem::transmute(proc);
        send(0);
    }
    Ok(())
}
