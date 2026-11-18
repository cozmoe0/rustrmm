//! The local channel between `rustrmm-agent support` (in the user's session) and the agent
//! service: one framed request and one framed answer per connection (the desktop helper
//! framing: `u8 kind, u32 length, payload`).
//!
//! * Windows: the named pipe `\\.\pipe\rustrmm-support`, created by LocalSystem as the first
//!   instance (nobody can squat it while the service runs), remote clients rejected. The DACL
//!   lets interactive users read and write but not create pipe instances; clients open it
//!   with exactly those rights and check that the server runs in session 0 (a service). The
//!   account is taken from the client process token.
//! * Unix: the socket `/run/rustrmm-agent/support.sock` (macOS:
//!   `/var/run/rustrmm-agent-support.sock`) in a root-owned directory; the account is taken
//!   from the peer credentials.
//!
//! Development (`--data-dir`) and the selftest use a private endpoint limited to the current
//! user.

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_util::sync::CancellationToken;

use super::{LocalRequest, LocalResult};
use crate::desktop::ipc;
use crate::paths::Paths;

const REQUEST: u8 = 0x20;
const RESULT: u8 = 0x21;
const MAX_REQUEST: usize = 8 * 1024 * 1024;

/// Where the channel lives.
#[derive(Debug, Clone)]
pub struct Endpoint {
    /// Pipe name (Windows) or socket path (Unix).
    pub address: String,
    /// Limited to the current user, and the server is not checked (development, selftest).
    pub private: bool,
}

impl Endpoint {
    pub fn for_paths(paths: &Paths) -> Self {
        if paths.custom {
            #[cfg(windows)]
            let address = format!(
                r"\\.\pipe\rustrmm-support-{}",
                &rustrmm_crypto::random::sha256_hex(paths.data_dir.to_string_lossy().as_bytes())
                    [..12]
            );
            #[cfg(unix)]
            let address = paths
                .data_dir
                .join("support.sock")
                .to_string_lossy()
                .into_owned();
            return Self {
                address,
                private: true,
            };
        }
        #[cfg(windows)]
        let address = r"\\.\pipe\rustrmm-support".to_string();
        #[cfg(target_os = "macos")]
        let address = "/var/run/rustrmm-agent-support.sock".to_string();
        #[cfg(all(unix, not(target_os = "macos")))]
        let address = "/run/rustrmm-agent/support.sock".to_string();
        Self {
            address,
            private: false,
        }
    }

    /// A fresh private endpoint (selftest).
    pub fn temporary() -> Result<Self> {
        let random = hex::encode(rustrmm_crypto::random::bytes::<8>());
        #[cfg(windows)]
        let address = format!(r"\\.\pipe\rustrmm-support-test-{random}");
        #[cfg(unix)]
        let address = std::env::temp_dir()
            .join(format!("rustrmm-support-{random}.sock"))
            .to_string_lossy()
            .into_owned();
        Ok(Self {
            address,
            private: true,
        })
    }

    pub fn cleanup(&self) {
        #[cfg(unix)]
        let _ = std::fs::remove_file(&self.address);
    }
}

/// Serves one connection: a request frame in, the handler's answer out.
async fn exchange<S, F, Fut>(mut stream: S, user: String, handler: &F)
where
    S: AsyncRead + AsyncWrite + Unpin,
    F: Fn(String, Vec<u8>) -> Fut,
    Fut: Future<Output = LocalResult>,
{
    let refused = |e: &str| LocalResult {
        ok: false,
        number: None,
        ticket_id: None,
        error: Some(e.to_string()),
    };
    let result = match tokio::time::timeout(Duration::from_secs(30), ipc::read(&mut stream)).await {
        Ok(Ok(Some((REQUEST, payload)))) if payload.len() <= MAX_REQUEST => {
            handler(user, payload).await
        }
        Ok(Ok(Some((REQUEST, _)))) => refused("the request is too large"),
        Ok(Ok(_)) => refused("unexpected message"),
        Ok(Err(e)) => refused(&format!("read failed: {e}")),
        Err(_) => refused("timed out"),
    };
    if let Ok(bytes) = serde_json::to_vec(&result) {
        let _ = ipc::write(&mut stream, RESULT, &bytes).await;
    }
}

/// Sends a request to the service and waits for its answer.
pub async fn request(endpoint: &Endpoint, request: &LocalRequest) -> Result<LocalResult> {
    let mut stream = platform::connect(endpoint).await?;
    ipc::write(&mut stream, REQUEST, &serde_json::to_vec(request)?)
        .await
        .context("sending the request to the agent service")?;
    let answer = tokio::time::timeout(Duration::from_secs(120), ipc::read(&mut stream))
        .await
        .context("the agent service did not answer in time")?
        .context("reading the agent service's answer")?;
    match answer {
        Some((RESULT, payload)) => Ok(serde_json::from_slice(&payload)?),
        _ => bail!("the agent service closed the channel without an answer"),
    }
}

/// Accepts connections until `shutdown`.
pub async fn serve<F, Fut>(
    endpoint: Endpoint,
    handler: F,
    shutdown: CancellationToken,
) -> Result<()>
where
    F: Fn(String, Vec<u8>) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = LocalResult> + Send + 'static,
{
    platform::serve(endpoint, Arc::new(handler), shutdown).await
}

/// `(user name, display name)` of a Unix account.
#[cfg(unix)]
pub fn passwd(uid: u32) -> Option<(String, String)> {
    let mut buf = vec![0 as libc::c_char; 16 * 1024];
    // SAFETY: zeroed passwd struct filled by getpwuid_r; the buffer outlives its use.
    unsafe {
        let mut pwd: libc::passwd = std::mem::zeroed();
        let mut result: *mut libc::passwd = std::ptr::null_mut();
        let rc = libc::getpwuid_r(uid, &mut pwd, buf.as_mut_ptr(), buf.len(), &mut result);
        if rc != 0 || result.is_null() || pwd.pw_name.is_null() {
            return None;
        }
        let name = std::ffi::CStr::from_ptr(pwd.pw_name)
            .to_string_lossy()
            .into_owned();
        let gecos = if pwd.pw_gecos.is_null() {
            String::new()
        } else {
            std::ffi::CStr::from_ptr(pwd.pw_gecos)
                .to_string_lossy()
                .split(',')
                .next()
                .unwrap_or_default()
                .trim()
                .to_string()
        };
        Some((name, gecos))
    }
}

#[cfg(unix)]
mod platform {
    use std::os::unix::fs::PermissionsExt;
    use std::sync::Arc;

    use anyhow::{Context, Result};
    use tokio::net::{UnixListener, UnixStream};
    use tokio_util::sync::CancellationToken;

    use super::{Endpoint, LocalResult, exchange};

    pub async fn serve<F, Fut>(
        endpoint: Endpoint,
        handler: Arc<F>,
        shutdown: CancellationToken,
    ) -> Result<()>
    where
        F: Fn(String, Vec<u8>) -> Fut + Send + Sync + 'static,
        Fut: std::future::Future<Output = LocalResult> + Send + 'static,
    {
        let path = std::path::PathBuf::from(&endpoint.address);
        if let Some(parent) = path.parent()
            && !endpoint.private
        {
            std::fs::create_dir_all(parent)?;
            std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o755))?;
        }
        let _ = std::fs::remove_file(&path);
        let listener =
            UnixListener::bind(&path).with_context(|| format!("binding {}", path.display()))?;
        let mode = if endpoint.private { 0o600 } else { 0o666 };
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode))?;
        loop {
            let accepted = tokio::select! {
                _ = shutdown.cancelled() => break,
                a = listener.accept() => a,
            };
            let Ok((stream, _)) = accepted else {
                continue;
            };
            let user = stream
                .peer_cred()
                .ok()
                .and_then(|c| super::passwd(c.uid()).map(|(name, _)| name))
                .unwrap_or_default();
            let handler = handler.clone();
            tokio::spawn(async move { exchange(stream, user, &*handler).await });
        }
        let _ = std::fs::remove_file(&path);
        Ok(())
    }

    pub async fn connect(endpoint: &Endpoint) -> Result<UnixStream> {
        // A private endpoint may still be starting (selftest); the service is not.
        let attempts = if endpoint.private { 50 } else { 1 };
        let mut last = None;
        for _ in 0..attempts {
            match UnixStream::connect(&endpoint.address).await {
                Ok(stream) => return Ok(stream),
                Err(e) => last = Some(e),
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        Err(last
            .map(anyhow::Error::from)
            .unwrap_or_else(|| anyhow::anyhow!("no connection")))
        .context("the RustRMM agent service is not running (no support channel)")
    }
}

#[cfg(windows)]
mod platform {
    use std::ffi::c_void;
    use std::os::windows::io::AsRawHandle;
    use std::sync::Arc;
    use std::time::Duration;

    use anyhow::{Context, Result, bail};
    use tokio::net::windows::named_pipe::{
        NamedPipeClient, NamedPipeServer, PipeMode, ServerOptions,
    };
    use tokio_util::sync::CancellationToken;
    use windows::Win32::Foundation::{
        CloseHandle, ERROR_FILE_NOT_FOUND, ERROR_PIPE_BUSY, HANDLE, HLOCAL, LocalFree,
    };
    use windows::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows::Win32::Security::{
        GetTokenInformation, LookupAccountSidW, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES,
        SID_NAME_USE, TOKEN_QUERY, TOKEN_USER, TokenUser,
    };
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, FILE_FLAG_OVERLAPPED, FILE_READ_DATA, FILE_SHARE_NONE, FILE_WRITE_DATA,
        OPEN_EXISTING, SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT, SYNCHRONIZE,
    };
    use windows::Win32::System::Pipes::{GetNamedPipeClientProcessId, GetNamedPipeServerSessionId};
    use windows::Win32::System::Threading::{
        OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::core::{HSTRING, PWSTR};

    use super::{Endpoint, LocalResult, exchange};

    /// Interactive users may read, write and query the pipe, but not create instances
    /// (FILE_APPEND_DATA = FILE_CREATE_PIPE_INSTANCE on pipes is deliberately left out).
    const INTERACTIVE_RIGHTS: &str = "0x12018b";

    fn sddl(endpoint: &Endpoint) -> Result<String> {
        Ok(if endpoint.private {
            format!(
                "D:P(A;;GA;;;{})",
                crate::desktop::win::pipe::current_user_sid()?
            )
        } else {
            format!("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;{INTERACTIVE_RIGHTS};;;IU)")
        })
    }

    fn create(name: &str, first: bool, sddl: &str) -> Result<NamedPipeServer> {
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        // SAFETY: valid SDDL; the descriptor is freed with LocalFree below.
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                &HSTRING::from(sddl),
                SDDL_REVISION_1,
                &mut descriptor,
                None,
            )
        }
        .context("building the support pipe security descriptor")?;
        let mut attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0,
            bInheritHandle: false.into(),
        };
        let mut options = ServerOptions::new();
        options
            .first_pipe_instance(first)
            .reject_remote_clients(true)
            .max_instances(8)
            .pipe_mode(PipeMode::Byte)
            .in_buffer_size(64 * 1024)
            .out_buffer_size(64 * 1024);
        // SAFETY: `attributes` and its descriptor outlive the call; the pipe copies them.
        let server = unsafe {
            options
                .create_with_security_attributes_raw(name, &mut attributes as *mut _ as *mut c_void)
        };
        // SAFETY: allocated by ConvertStringSecurityDescriptorToSecurityDescriptorW.
        unsafe {
            let _ = LocalFree(Some(HLOCAL(descriptor.0)));
        }
        server.with_context(|| format!("creating {name}"))
    }

    /// `DOMAIN\user` of the process at the other end of the pipe.
    fn client_account(server: &NamedPipeServer) -> Result<String> {
        let handle = HANDLE(server.as_raw_handle());
        let mut pid = 0u32;
        // SAFETY: valid pipe handle; out pointer is a local.
        unsafe { GetNamedPipeClientProcessId(handle, &mut pid) }
            .context("GetNamedPipeClientProcessId")?;
        // SAFETY: limited query rights; closed below.
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }
            .context("OpenProcess(client)")?;
        let mut token = HANDLE::default();
        // SAFETY: owned process handle; the token is closed below.
        let opened = unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) };
        // SAFETY: owned process handle.
        unsafe {
            let _ = CloseHandle(process);
        }
        opened.context("OpenProcessToken(client)")?;
        let mut buf = [0u64; 64];
        let mut len = 0u32;
        // SAFETY: the buffer and its size are valid; the SID points into `buf`.
        let info = unsafe {
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
        info.context("GetTokenInformation(TokenUser)")?;
        // SAFETY: GetTokenInformation filled a TOKEN_USER at the start of `buf`.
        let user = unsafe { &*(buf.as_ptr() as *const TOKEN_USER) };
        let mut name = [0u16; 256];
        let mut domain = [0u16; 256];
        let (mut name_len, mut domain_len) = (name.len() as u32, domain.len() as u32);
        let mut kind = SID_NAME_USE::default();
        // SAFETY: buffers and their lengths (in characters) are valid.
        unsafe {
            LookupAccountSidW(
                None,
                user.User.Sid,
                Some(PWSTR(name.as_mut_ptr())),
                &mut name_len,
                Some(PWSTR(domain.as_mut_ptr())),
                &mut domain_len,
                &mut kind,
            )
        }
        .context("LookupAccountSidW")?;
        let name = String::from_utf16_lossy(&name[..name_len as usize]);
        let domain = String::from_utf16_lossy(&domain[..domain_len as usize]);
        Ok(if domain.is_empty() {
            name
        } else {
            format!("{domain}\\{name}")
        })
    }

    pub async fn serve<F, Fut>(
        endpoint: Endpoint,
        handler: Arc<F>,
        shutdown: CancellationToken,
    ) -> Result<()>
    where
        F: Fn(String, Vec<u8>) -> Fut + Send + Sync + 'static,
        Fut: std::future::Future<Output = LocalResult> + Send + 'static,
    {
        let sddl = sddl(&endpoint)?;
        let mut server = create(&endpoint.address, true, &sddl)?;
        loop {
            let connected = tokio::select! {
                _ = shutdown.cancelled() => return Ok(()),
                c = server.connect() => c,
            };
            let next = create(&endpoint.address, false, &sddl)?;
            let current = std::mem::replace(&mut server, next);
            if connected.is_err() {
                continue;
            }
            let user = match client_account(&current) {
                Ok(u) => u,
                Err(e) => {
                    tracing::debug!(error = %format!("{e:#}"), "support pipe client unidentified");
                    String::new()
                }
            };
            let handler = handler.clone();
            tokio::spawn(async move { exchange(current, user, &*handler).await });
        }
    }

    pub async fn connect(endpoint: &Endpoint) -> Result<NamedPipeClient> {
        let name = HSTRING::from(endpoint.address.as_str());
        let mut missing = false;
        for _ in 0..50 {
            // SAFETY: valid NUL-terminated name; exact rights (no FILE_APPEND_DATA), overlapped
            // for tokio, identification-level impersonation only.
            let opened = unsafe {
                CreateFileW(
                    &name,
                    FILE_READ_DATA.0 | FILE_WRITE_DATA.0 | SYNCHRONIZE.0,
                    FILE_SHARE_NONE,
                    None,
                    OPEN_EXISTING,
                    FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                    None,
                )
            };
            match opened {
                Ok(handle) => {
                    // SAFETY: a freshly opened, overlapped pipe handle owned by the client.
                    let client = unsafe { NamedPipeClient::from_raw_handle(handle.0) }?;
                    if !endpoint.private {
                        let mut session = u32::MAX;
                        // SAFETY: valid pipe handle; out pointer is a local.
                        unsafe {
                            GetNamedPipeServerSessionId(
                                HANDLE(client.as_raw_handle()),
                                &mut session,
                            )
                        }
                        .context("GetNamedPipeServerSessionId")?;
                        if session != 0 {
                            bail!("the support pipe is not served by the RustRMM service");
                        }
                    }
                    return Ok(client);
                }
                Err(e) if e.code() == ERROR_PIPE_BUSY.to_hresult() => {
                    missing = false;
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                // A private endpoint may still be starting (selftest); the service is not.
                Err(e) if e.code() == ERROR_FILE_NOT_FOUND.to_hresult() && endpoint.private => {
                    missing = true;
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                Err(e) if e.code() == ERROR_FILE_NOT_FOUND.to_hresult() => {
                    bail!("the RustRMM agent service is not running (no support channel)")
                }
                Err(e) => return Err(e).context("opening the support pipe"),
            }
        }
        if missing {
            bail!("the RustRMM agent service is not running (no support channel)");
        }
        bail!("the support pipe stayed busy")
    }
}
