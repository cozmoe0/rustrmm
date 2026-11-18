//! Starting the desktop helper.
//!
//! * Service: duplicate the service's LocalSystem token, set its `TokenSessionId` to the target
//!   session (needs SeTcbPrivilege) and `CreateProcessAsUserW` on `winsta0\default` with
//!   `CREATE_NO_WINDOW`, always from the installed agent binary (never a user-writable path).
//!   The helper then has SYSTEM's access to that session's `Winlogon` desktop.
//! * Dev mode (`run --console`): spawn the current executable as the current user in the current
//!   session.
//!
//! Job objects cannot span sessions, so the helper watches the parent PID and exits with it; the
//! agent also terminates it when the session ends.

use std::ffi::c_void;
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::path::Path;

use anyhow::{Context, Result};
use windows::Win32::Foundation::{
    CloseHandle, ERROR_NOT_ALL_ASSIGNED, GetLastError, HANDLE, LUID, WAIT_OBJECT_0,
};
use windows::Win32::Security::{
    AdjustTokenPrivileges, DuplicateTokenEx, LUID_AND_ATTRIBUTES, LookupPrivilegeValueW,
    SE_ASSIGNPRIMARYTOKEN_NAME, SE_INCREASE_QUOTA_NAME, SE_PRIVILEGE_ENABLED, SE_TCB_NAME,
    SecurityImpersonation, SetTokenInformation, TOKEN_ADJUST_PRIVILEGES, TOKEN_ALL_ACCESS,
    TOKEN_DUPLICATE, TOKEN_PRIVILEGES, TOKEN_QUERY, TokenPrimary, TokenSessionId,
};
use windows::Win32::System::Environment::{CreateEnvironmentBlock, DestroyEnvironmentBlock};
use windows::Win32::System::Threading::{
    CREATE_NO_WINDOW, CREATE_UNICODE_ENVIRONMENT, CreateProcessAsUserW, GetCurrentProcess,
    OpenProcessToken, PROCESS_INFORMATION, STARTUPINFOW, TerminateProcess, WaitForSingleObject,
};
use windows::core::{PCWSTR, PWSTR};

/// Owned kernel handle, closed exactly once.
pub struct OwnedHandle(pub HANDLE);

// SAFETY: kernel handles have no thread affinity; this wrapper is the single owner.
unsafe impl Send for OwnedHandle {}
// SAFETY: shared access only reads the raw value.
unsafe impl Sync for OwnedHandle {}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_invalid() && !self.0.0.is_null() {
            // SAFETY: owned handle, closed once.
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

/// A running helper process.
pub struct Helper {
    process: HelperProcess,
    pub pid: u32,
}

enum HelperProcess {
    Raw(OwnedHandle),
    Child(std::process::Child),
}

impl Helper {
    fn handle(&self) -> HANDLE {
        match &self.process {
            HelperProcess::Raw(h) => h.0,
            HelperProcess::Child(c) => HANDLE(c.as_raw_handle()),
        }
    }

    pub fn has_exited(&self) -> bool {
        // SAFETY: valid process handle; zero timeout.
        unsafe { WaitForSingleObject(self.handle(), 0) == WAIT_OBJECT_0 }
    }

    /// Waits up to `ms` for a voluntary exit, then terminates it.
    pub fn finish(mut self, ms: u32) {
        // SAFETY: valid process handle.
        let exited = unsafe { WaitForSingleObject(self.handle(), ms) == WAIT_OBJECT_0 };
        if !exited {
            // SAFETY: our own child process.
            unsafe {
                let _ = TerminateProcess(self.handle(), 1);
            }
        }
        if let HelperProcess::Child(child) = &mut self.process {
            let _ = child.wait();
        }
    }
}

fn args(session: u32, pipe: &str) -> Vec<String> {
    vec![
        "desktop-helper".into(),
        "--session".into(),
        session.to_string(),
        "--pipe".into(),
        pipe.into(),
        "--parent".into(),
        std::process::id().to_string(),
    ]
}

/// Dev mode: the current executable as the current user.
pub fn spawn_dev(exe: &Path, session: u32, pipe: &str) -> Result<Helper> {
    let child = std::process::Command::new(exe)
        .args(args(session, pipe))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .creation_flags(CREATE_NO_WINDOW.0)
        .spawn()
        .with_context(|| format!("starting {}", exe.display()))?;
    let pid = child.id();
    Ok(Helper {
        process: HelperProcess::Child(child),
        pid,
    })
}

fn enable_privilege(name: PCWSTR) -> windows::core::Result<()> {
    // SAFETY: token of the current process, closed by OwnedHandle; locals for out values.
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY,
            &mut token,
        )?;
        let token = OwnedHandle(token);
        let mut luid = LUID::default();
        LookupPrivilegeValueW(PCWSTR::null(), name, &mut luid)?;
        let privileges = TOKEN_PRIVILEGES {
            PrivilegeCount: 1,
            Privileges: [LUID_AND_ATTRIBUTES {
                Luid: luid,
                Attributes: SE_PRIVILEGE_ENABLED,
            }],
        };
        AdjustTokenPrivileges(token.0, false, Some(&privileges), 0, None, None)?;
        // "Succeeds" with ERROR_NOT_ALL_ASSIGNED when the token lacks the privilege.
        if GetLastError() == ERROR_NOT_ALL_ASSIGNED {
            return Err(windows::core::Error::from_hresult(
                ERROR_NOT_ALL_ASSIGNED.to_hresult(),
            ));
        }
        Ok(())
    }
}

/// Service: the installed binary as LocalSystem inside `session`.
pub fn spawn_system_in_session(exe: &Path, session: u32, pipe: &str) -> Result<Helper> {
    for (privilege, label) in [
        (SE_TCB_NAME, "SeTcbPrivilege"),
        (SE_ASSIGNPRIMARYTOKEN_NAME, "SeAssignPrimaryTokenPrivilege"),
        (SE_INCREASE_QUOTA_NAME, "SeIncreaseQuotaPrivilege"),
    ] {
        if let Err(e) = enable_privilege(privilege) {
            tracing::debug!(privilege = label, error = %e, "could not enable privilege");
        }
    }
    let command_line = std::iter::once(format!("\"{}\"", exe.display()))
        .chain(args(session, pipe))
        .collect::<Vec<_>>()
        .join(" ");
    // SAFETY: every handle is owned by OwnedHandle; strings are NUL-terminated locals that
    // outlive the CreateProcessAsUserW call; the environment block is destroyed after it.
    unsafe {
        let mut own = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_DUPLICATE | TOKEN_QUERY, &mut own)
            .context("OpenProcessToken")?;
        let own = OwnedHandle(own);
        let mut primary = HANDLE::default();
        DuplicateTokenEx(
            own.0,
            TOKEN_ALL_ACCESS,
            None,
            SecurityImpersonation,
            TokenPrimary,
            &mut primary,
        )
        .context("DuplicateTokenEx")?;
        let primary = OwnedHandle(primary);
        SetTokenInformation(
            primary.0,
            TokenSessionId,
            &session as *const u32 as *const c_void,
            size_of::<u32>() as u32,
        )
        .context("SetTokenInformation(TokenSessionId)")?;
        let mut environment: *mut c_void = std::ptr::null_mut();
        CreateEnvironmentBlock(&mut environment, Some(primary.0), false)
            .context("CreateEnvironmentBlock")?;
        let application: Vec<u16> = exe
            .as_os_str()
            .to_string_lossy()
            .encode_utf16()
            .chain([0])
            .collect();
        let mut command: Vec<u16> = command_line.encode_utf16().chain([0]).collect();
        let mut desktop: Vec<u16> = "winsta0\\default".encode_utf16().chain([0]).collect();
        let startup = STARTUPINFOW {
            cb: size_of::<STARTUPINFOW>() as u32,
            lpDesktop: PWSTR(desktop.as_mut_ptr()),
            ..Default::default()
        };
        let mut info = PROCESS_INFORMATION::default();
        let created = CreateProcessAsUserW(
            Some(primary.0),
            PCWSTR(application.as_ptr()),
            Some(PWSTR(command.as_mut_ptr())),
            None,
            None,
            false,
            // Console-subsystem binary: CREATE_NO_WINDOW keeps conhost off the user's desktop.
            CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
            Some(environment as *const c_void),
            PCWSTR::null(),
            &startup,
            &mut info,
        );
        let _ = DestroyEnvironmentBlock(environment);
        created.context("CreateProcessAsUserW")?;
        let _ = CloseHandle(info.hThread);
        Ok(Helper {
            process: HelperProcess::Raw(OwnedHandle(info.hProcess)),
            pid: info.dwProcessId,
        })
    }
}
