//! Token helpers: who a process runs as, and how a LocalSystem service obtains the interactive
//! user's token for `CreateProcessAsUserW`.

use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use windows::Win32::Foundation::{ERROR_NOT_ALL_ASSIGNED, GetLastError, HANDLE, LUID};
use windows::Win32::Security::{
    AdjustTokenPrivileges, DuplicateTokenEx, GetTokenInformation, LUID_AND_ATTRIBUTES,
    LookupAccountSidW, LookupPrivilegeValueW, PSID, SE_PRIVILEGE_ENABLED, SID_NAME_USE,
    SecurityImpersonation, TOKEN_ADJUST_DEFAULT, TOKEN_ADJUST_PRIVILEGES, TOKEN_ADJUST_SESSIONID,
    TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE, TOKEN_ELEVATION_TYPE, TOKEN_INFORMATION_CLASS,
    TOKEN_PRIVILEGES, TOKEN_QUERY, TOKEN_USER, TokenElevationType, TokenElevationTypeDefault,
    TokenElevationTypeFull, TokenElevationTypeLimited, TokenPrimary, TokenSessionId, TokenUser,
};
use windows::Win32::System::RemoteDesktop::{
    ProcessIdToSessionId, WTS_CONNECTSTATE_CLASS, WTS_SESSION_INFOW, WTSActive, WTSConnected,
    WTSDisconnected, WTSEnumerateSessionsW, WTSFreeMemory, WTSGetActiveConsoleSessionId, WTSListen,
    WTSQuerySessionInformationW, WTSQueryUserToken, WTSUserName,
};
use windows::Win32::System::Threading::{
    GetCurrentProcess, GetCurrentProcessId, OpenProcess, OpenProcessToken,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Shell::GetUserProfileDirectoryW;
use windows::core::{PCWSTR, PWSTR};

use crate::win::{Handle, from_wide};

/// A primary token to launch a child with, plus what we learned about it.
pub struct UserToken {
    pub token: Handle,
    pub account: String,
    pub session_id: u32,
    pub elevation: &'static str,
    pub source: String,
}

impl UserToken {
    fn describe(token: Handle, source: String) -> Result<Self> {
        let account = token_account(token.raw())?;
        let session_id = token_session_id(token.raw()).unwrap_or(u32::MAX);
        let elevation = token_elevation_type(token.raw());
        Ok(Self { token, account, session_id, elevation, source })
    }

    pub fn log(&self) {
        logln!(
            "user token: {} session {} elevation {} (from {})",
            self.account,
            self.session_id,
            self.elevation,
            self.source
        );
    }
}

/// Token of the user on the physical console, falling back to any other active (e.g. RDP)
/// session. `WTSQueryUserToken` needs SeTcbPrivilege, i.e. this only works as LocalSystem.
pub fn interactive_user_token() -> Result<UserToken> {
    // SAFETY: no preconditions.
    let console = unsafe { WTSGetActiveConsoleSessionId() };
    let mut candidates = Vec::new();
    if console != u32::MAX {
        candidates.push((console, "active console session"));
    }
    for s in sessions().unwrap_or_default() {
        if s.state == WTSActive && s.id != console && s.id != 0 {
            candidates.push((s.id, "other active WTS session"));
        }
    }
    let mut last_error = None;
    for (id, why) in candidates {
        let mut raw = HANDLE::default();
        // SAFETY: `raw` receives a new token handle that we own on success.
        match unsafe { WTSQueryUserToken(id, &mut raw) } {
            Ok(()) => {
                return UserToken::describe(
                    Handle::new(raw),
                    format!("WTSQueryUserToken({id}), {why}"),
                );
            }
            Err(e) => {
                logln!("WTSQueryUserToken({id}) [{why}] failed: {e}");
                last_error = Some(e);
            }
        }
    }
    match last_error {
        Some(e) => Err(e).context("no interactive user token available"),
        None => bail!("no interactive session (console session id {console:#x})"),
    }
}

/// A primary-token duplicate of this process's own token. Lets console mode exercise the
/// `CreateProcessAsUserW` + environment-block + desktop path without SeTcbPrivilege.
pub fn own_token_duplicate() -> Result<UserToken> {
    let mut raw = HANDLE::default();
    // SAFETY: pseudo-handle of the current process; `raw` receives a handle we own.
    unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_DUPLICATE | TOKEN_QUERY, &mut raw) }
        .context("OpenProcessToken")?;
    let own = Handle::new(raw);
    let mut dup = HANDLE::default();
    // SAFETY: `own` is a valid token handle; `dup` receives a handle we own.
    unsafe {
        DuplicateTokenEx(
            own.raw(),
            TOKEN_QUERY
                | TOKEN_DUPLICATE
                | TOKEN_ASSIGN_PRIMARY
                | TOKEN_ADJUST_DEFAULT
                | TOKEN_ADJUST_SESSIONID,
            None,
            SecurityImpersonation,
            TokenPrimary,
            &mut dup,
        )
    }
    .context("DuplicateTokenEx")?;
    UserToken::describe(Handle::new(dup), "DuplicateTokenEx(own process token)".into())
}

/// This process's primary token (TOKEN_QUERY | TOKEN_DUPLICATE), e.g. for CreateEnvironmentBlock.
pub fn own_token() -> Result<Handle> {
    let mut raw = HANDLE::default();
    // SAFETY: pseudo-handle of the current process; `raw` receives a handle we own.
    unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE, &mut raw) }
        .context("OpenProcessToken")?;
    Ok(Handle::new(raw))
}

/// `DOMAIN\user` of this process.
pub fn current_account() -> Result<String> {
    let mut raw = HANDLE::default();
    // SAFETY: as above.
    unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) }
        .context("OpenProcessToken")?;
    let token = Handle::new(raw);
    token_account(token.raw())
}

pub fn console_session_id() -> u32 {
    // SAFETY: no preconditions.
    unsafe { WTSGetActiveConsoleSessionId() }
}

pub fn current_session_id() -> u32 {
    let mut id = u32::MAX;
    // SAFETY: `id` is a valid out pointer.
    let _ = unsafe { ProcessIdToSessionId(GetCurrentProcessId(), &mut id) };
    id
}

pub fn token_account(token: HANDLE) -> Result<String> {
    let buf = token_info(token, TokenUser)?;
    // SAFETY: the buffer holds a TOKEN_USER (8-byte aligned) whose SID points into the buffer.
    let user = unsafe { &*buf.as_ptr().cast::<TOKEN_USER>() };
    sid_account(user.User.Sid)
}

fn token_info(token: HANDLE, class: TOKEN_INFORMATION_CLASS) -> Result<Vec<u64>> {
    let mut len = 0u32;
    // Size query: expected to fail with ERROR_INSUFFICIENT_BUFFER.
    // SAFETY: a null buffer with length 0 is allowed.
    let _ = unsafe { GetTokenInformation(token, class, None, 0, &mut len) };
    if len == 0 {
        return Err(windows::core::Error::from_thread()).context("GetTokenInformation size query");
    }
    let mut buf = vec![0u64; (len as usize).div_ceil(8)];
    // SAFETY: `buf` provides at least `len` writable bytes.
    unsafe { GetTokenInformation(token, class, Some(buf.as_mut_ptr().cast()), len, &mut len) }
        .context("GetTokenInformation")?;
    Ok(buf)
}

pub fn sid_account(sid: PSID) -> Result<String> {
    let mut name = [0u16; 256];
    let mut name_len = name.len() as u32;
    let mut domain = [0u16; 256];
    let mut domain_len = domain.len() as u32;
    let mut kind = SID_NAME_USE::default();
    // SAFETY: buffers and lengths match; `sid` is valid for the call.
    unsafe {
        LookupAccountSidW(
            PCWSTR::null(),
            sid,
            Some(PWSTR(name.as_mut_ptr())),
            &mut name_len,
            Some(PWSTR(domain.as_mut_ptr())),
            &mut domain_len,
            &mut kind,
        )
    }
    .context("LookupAccountSidW")?;
    Ok(format!("{}\\{}", from_wide(&domain), from_wide(&name)))
}

pub fn token_session_id(token: HANDLE) -> Result<u32> {
    let mut id = 0u32;
    let mut len = 0u32;
    // SAFETY: `id` is a valid 4-byte buffer.
    unsafe {
        GetTokenInformation(token, TokenSessionId, Some((&raw mut id).cast()), 4, &mut len)
    }
    .context("GetTokenInformation(TokenSessionId)")?;
    Ok(id)
}

#[allow(non_upper_case_globals)] // Win32 constant names in patterns
pub fn token_elevation_type(token: HANDLE) -> &'static str {
    let mut kind = TOKEN_ELEVATION_TYPE::default();
    let mut len = 0u32;
    // SAFETY: `kind` is a valid buffer of the stated size.
    let ok = unsafe {
        GetTokenInformation(
            token,
            TokenElevationType,
            Some((&raw mut kind).cast()),
            size_of::<TOKEN_ELEVATION_TYPE>() as u32,
            &mut len,
        )
    }
    .is_ok();
    match kind {
        _ if !ok => "unknown",
        TokenElevationTypeDefault => "default (no split token)",
        TokenElevationTypeFull => "full (elevated)",
        TokenElevationTypeLimited => "limited (UAC-filtered admin; linked elevated token exists)",
        _ => "unknown",
    }
}

/// `pid 123 as DOMAIN\user in session 1` for a process handle we hold.
pub fn process_identity(process: HANDLE, pid: u32) -> String {
    let mut raw = HANDLE::default();
    // SAFETY: `process` is a valid process handle; `raw` receives a handle we own.
    let account = match unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut raw) } {
        Ok(()) => {
            let token = Handle::new(raw);
            token_account(token.raw()).unwrap_or_else(|e| format!("<{e:#}>"))
        }
        Err(e) => format!("<OpenProcessToken: {e}>"),
    };
    let mut session = u32::MAX;
    // SAFETY: `session` is a valid out pointer.
    let _ = unsafe { ProcessIdToSessionId(pid, &mut session) };
    format!("pid {pid} as {account} in session {session}")
}

pub fn pid_identity(pid: u32) -> String {
    // SAFETY: plain open by id; the handle is owned below.
    match unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) } {
        Ok(h) => {
            let process = Handle::new(h);
            process_identity(process.raw(), pid)
        }
        Err(e) => format!("pid {pid} <OpenProcess: {e}>"),
    }
}

pub struct SessionInfo {
    pub id: u32,
    pub state: WTS_CONNECTSTATE_CLASS,
    pub station: String,
    pub user: String,
}

impl SessionInfo {
    #[allow(non_upper_case_globals)] // Win32 constant names in patterns
    pub fn state_name(&self) -> &'static str {
        match self.state {
            WTSActive => "active",
            WTSConnected => "connected",
            WTSDisconnected => "disconnected",
            WTSListen => "listen",
            _ => "other",
        }
    }
}

pub fn sessions() -> Result<Vec<SessionInfo>> {
    let mut list: *mut WTS_SESSION_INFOW = std::ptr::null_mut();
    let mut count = 0u32;
    // SAFETY: out pointers are valid; the list is freed with WTSFreeMemory below.
    unsafe { WTSEnumerateSessionsW(None, 0, 1, &mut list, &mut count) }
        .context("WTSEnumerateSessionsW")?;
    // SAFETY: WTSEnumerateSessionsW returned `count` entries at `list`.
    let entries = unsafe { std::slice::from_raw_parts(list, count as usize) };
    let out = entries
        .iter()
        .map(|s| SessionInfo {
            id: s.SessionId,
            state: s.State,
            // SAFETY: valid NUL-terminated string owned by the list.
            station: unsafe { s.pWinStationName.to_string() }.unwrap_or_default(),
            user: session_user(s.SessionId),
        })
        .collect();
    // SAFETY: allocated by WTSEnumerateSessionsW.
    unsafe { WTSFreeMemory(list.cast()) };
    Ok(out)
}

fn session_user(id: u32) -> String {
    let mut buf = PWSTR::null();
    let mut bytes = 0u32;
    // SAFETY: out pointers are valid; the buffer is freed with WTSFreeMemory.
    if unsafe { WTSQuerySessionInformationW(None, id, WTSUserName, &mut buf, &mut bytes) }.is_err() {
        return String::new();
    }
    // SAFETY: valid NUL-terminated string allocated by WTS.
    let user = unsafe { buf.to_string() }.unwrap_or_default();
    // SAFETY: allocated by WTSQuerySessionInformationW.
    unsafe { WTSFreeMemory(buf.0.cast()) };
    user
}

/// Enables `name` on this process's token. Ok(false) means the token does not hold it.
pub fn enable_privilege(name: PCWSTR) -> Result<bool> {
    let mut raw = HANDLE::default();
    // SAFETY: as above.
    unsafe {
        OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, &mut raw)
    }
    .context("OpenProcessToken")?;
    let token = Handle::new(raw);
    let mut luid = LUID::default();
    // SAFETY: `name` is a valid privilege name constant.
    unsafe { LookupPrivilegeValueW(PCWSTR::null(), name, &mut luid) }
        .context("LookupPrivilegeValueW")?;
    let privileges = TOKEN_PRIVILEGES {
        PrivilegeCount: 1,
        Privileges: [LUID_AND_ATTRIBUTES { Luid: luid, Attributes: SE_PRIVILEGE_ENABLED }],
    };
    // SAFETY: `privileges` is a valid TOKEN_PRIVILEGES with one entry.
    unsafe { AdjustTokenPrivileges(token.raw(), false, Some(&privileges), 0, None, None) }
        .context("AdjustTokenPrivileges")?;
    // AdjustTokenPrivileges "succeeds" even when nothing was enabled; the real answer is here.
    // SAFETY: no preconditions.
    Ok(unsafe { GetLastError() } != ERROR_NOT_ALL_ASSIGNED)
}

pub fn user_profile_dir(token: HANDLE) -> Result<PathBuf> {
    let mut len = 0u32;
    // Size query: expected to fail with ERROR_INSUFFICIENT_BUFFER.
    // SAFETY: a null buffer is allowed for the size query.
    let _ = unsafe { GetUserProfileDirectoryW(token, None, &mut len) };
    if len == 0 {
        bail!("GetUserProfileDirectoryW size query returned 0");
    }
    let mut buf = vec![0u16; len as usize];
    // SAFETY: `buf` holds `len` UTF-16 units.
    unsafe { GetUserProfileDirectoryW(token, Some(PWSTR(buf.as_mut_ptr())), &mut len) }
        .context("GetUserProfileDirectoryW")?;
    Ok(PathBuf::from(from_wide(&buf)))
}
