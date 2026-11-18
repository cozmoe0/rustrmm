//! The agent ⇄ helper named pipe.
//!
//! The service creates a uniquely named pipe with `FILE_FLAG_FIRST_PIPE_INSTANCE` (nobody can
//! squat the name), `PIPE_REJECT_REMOTE_CLIENTS`, one instance, and a protected DACL granting
//! access to LocalSystem only (dev mode: the current user only). Before trusting the client it
//! checks the client's PID, session and image path. The helper connects with the default
//! `SECURITY_IDENTIFICATION` quality of service, so the server can never impersonate it.

use std::ffi::c_void;
use std::os::windows::io::AsRawHandle;
use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use tokio::net::windows::named_pipe::{
    ClientOptions, NamedPipeClient, NamedPipeServer, PipeMode, ServerOptions,
};
use windows::Win32::Foundation::{CloseHandle, HANDLE, HLOCAL, LocalFree};
use windows::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows::Win32::Security::{
    GetTokenInformation, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
    TokenUser,
};
use windows::Win32::System::Pipes::GetNamedPipeClientProcessId;
use windows::Win32::System::RemoteDesktop::ProcessIdToSessionId;
use windows::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
};
use windows::core::{HSTRING, PWSTR};

const ERROR_PIPE_BUSY: i32 = 231;

/// A fresh, unguessable pipe name.
pub fn new_name() -> String {
    let random = rustrmm_crypto::random::bytes::<16>();
    format!(r"\\.\pipe\rustrmm-desktop-{}", hex::encode(random))
}

/// The SID string of this process's user (`S-1-5-18` for LocalSystem).
pub fn current_user_sid() -> Result<String> {
    let mut token = HANDLE::default();
    // SAFETY: pseudo-handle of the current process; the token is closed below.
    unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) }
        .context("OpenProcessToken")?;
    // u64 storage keeps TOKEN_USER (which holds a pointer) aligned.
    let mut buf = [0u64; 64];
    let mut len = 0u32;
    // SAFETY: the buffer and its size are valid; the SID points into `buf`.
    let result = unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            Some(buf.as_mut_ptr().cast()),
            size_of_val(&buf) as u32,
            &mut len,
        )
    };
    // SAFETY: owned token handle.
    unsafe {
        let _ = CloseHandle(token);
    }
    result.context("GetTokenInformation(TokenUser)")?;
    // SAFETY: GetTokenInformation filled a TOKEN_USER at the start of `buf`.
    let user = unsafe { &*(buf.as_ptr() as *const TOKEN_USER) };
    let mut text = PWSTR::null();
    // SAFETY: valid SID; the returned string is freed with LocalFree.
    unsafe { ConvertSidToStringSidW(user.User.Sid, &mut text) }
        .context("ConvertSidToStringSidW")?;
    // SAFETY: a NUL-terminated string allocated by the call above.
    let sid = unsafe { text.to_string() }.unwrap_or_default();
    // SAFETY: allocated by ConvertSidToStringSidW.
    unsafe {
        let _ = LocalFree(Some(HLOCAL(text.0.cast())));
    }
    Ok(sid)
}

/// Creates the server end. `system_only`: the DACL grants LocalSystem only; otherwise the
/// current user only (dev mode, where the helper runs as that user).
pub fn create_server(name: &str, system_only: bool) -> Result<NamedPipeServer> {
    let sddl = if system_only {
        "D:P(A;;GA;;;SY)".to_string()
    } else {
        format!("D:P(A;;GA;;;{})", current_user_sid()?)
    };
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    // SAFETY: valid SDDL string; the descriptor is freed with LocalFree below.
    unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            &HSTRING::from(sddl.as_str()),
            SDDL_REVISION_1,
            &mut descriptor,
            None,
        )
    }
    .context("building the pipe security descriptor")?;
    let mut attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: false.into(),
    };
    let mut options = ServerOptions::new();
    options
        .first_pipe_instance(true)
        .reject_remote_clients(true)
        .max_instances(1)
        .pipe_mode(PipeMode::Byte)
        .in_buffer_size(1 << 20)
        .out_buffer_size(1 << 20);
    // SAFETY: `attributes` (and the descriptor it points to) outlive the call; the pipe copies
    // the security descriptor.
    let server = unsafe {
        options.create_with_security_attributes_raw(name, &mut attributes as *mut _ as *mut c_void)
    };
    // SAFETY: allocated by ConvertStringSecurityDescriptorToSecurityDescriptorW.
    unsafe {
        let _ = LocalFree(Some(HLOCAL(descriptor.0)));
    }
    server.with_context(|| format!("creating {name}"))
}

fn image_path(pid: u32) -> Result<String> {
    // SAFETY: plain open with limited query rights; closed below.
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }
        .context("OpenProcess(client)")?;
    let mut buf = [0u16; 1024];
    let mut len = buf.len() as u32;
    // SAFETY: the buffer and its length in characters are valid.
    let result = unsafe {
        QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &mut len,
        )
    };
    // SAFETY: owned process handle.
    unsafe {
        let _ = CloseHandle(process);
    }
    result.context("QueryFullProcessImageNameW")?;
    Ok(String::from_utf16_lossy(&buf[..len as usize]))
}

/// Refuses a client that is not the helper we started: other PID, other session or another
/// executable.
pub fn verify_client(server: &NamedPipeServer, pid: u32, session: u32, exe: &Path) -> Result<()> {
    let handle = HANDLE(server.as_raw_handle());
    let mut client = 0u32;
    // SAFETY: valid pipe handle; out pointer is a local.
    unsafe { GetNamedPipeClientProcessId(handle, &mut client) }
        .context("GetNamedPipeClientProcessId")?;
    if client != pid {
        bail!("unexpected pipe client (pid {client}, expected {pid})");
    }
    let mut client_session = u32::MAX;
    // SAFETY: out pointer is a local.
    unsafe { ProcessIdToSessionId(client, &mut client_session) }.context("ProcessIdToSessionId")?;
    if client_session != session {
        bail!("pipe client runs in session {client_session}, expected {session}");
    }
    let image = image_path(client)?;
    let expected = exe.to_string_lossy();
    let normalize = |p: &str| p.trim_start_matches(r"\\?\").to_ascii_lowercase();
    if normalize(&image) != normalize(&expected) {
        bail!("pipe client image {image} is not {expected}");
    }
    Ok(())
}

/// Connects the helper's end, retrying while the server is busy or not yet listening.
pub async fn connect(name: &str) -> Result<NamedPipeClient> {
    let mut last = None;
    for _ in 0..50 {
        match ClientOptions::new().open(name) {
            Ok(client) => return Ok(client),
            Err(e)
                if e.raw_os_error() == Some(ERROR_PIPE_BUSY)
                    || e.kind() == std::io::ErrorKind::NotFound =>
            {
                last = Some(e);
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            Err(e) => return Err(e).with_context(|| format!("opening {name}")),
        }
    }
    Err(last
        .map(anyhow::Error::from)
        .unwrap_or_else(|| anyhow::anyhow!("pipe unavailable")))
    .with_context(|| format!("opening {name}"))
}
