//! Launching the capture helper into the active console session as SYSTEM:
//! duplicate the service's own LocalSystem token, retarget it to the console
//! session (`TokenSessionId`, needs SeTcbPrivilege) and `CreateProcessAsUserW`
//! onto `winsta0\default`. The helper then has SYSTEM's access to the
//! `Winlogon` desktop of that session, which is what makes the UAC prompt and
//! the lock screen capturable.

use std::ffi::c_void;
use std::path::Path;

use anyhow::Context;
use windows::Win32::Foundation::{CloseHandle, ERROR_NOT_ALL_ASSIGNED, GetLastError, HANDLE, LUID};
use windows::Win32::Security::{
    AdjustTokenPrivileges, DuplicateTokenEx, LUID_AND_ATTRIBUTES, LookupPrivilegeValueW,
    SE_ASSIGNPRIMARYTOKEN_NAME, SE_INCREASE_QUOTA_NAME, SE_PRIVILEGE_ENABLED, SE_TCB_NAME,
    SecurityImpersonation, SetTokenInformation, TOKEN_ADJUST_PRIVILEGES, TOKEN_ALL_ACCESS,
    TOKEN_DUPLICATE, TOKEN_PRIVILEGES, TOKEN_QUERY, TokenPrimary, TokenSessionId,
};
use windows::Win32::System::Environment::{CreateEnvironmentBlock, DestroyEnvironmentBlock};
use windows::Win32::System::Threading::{
    CREATE_NO_WINDOW, CREATE_UNICODE_ENVIRONMENT, CreateProcessAsUserW, GetCurrentProcess,
    OpenProcessToken, PROCESS_INFORMATION, STARTUPINFOW,
};
use windows::core::{PCWSTR, PWSTR};

use crate::util::wide;

/// Closes the handle on drop.
pub struct OwnedHandle(pub HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

// SAFETY: kernel handles are process-wide.
unsafe impl Send for OwnedHandle {}

pub struct Spawned {
    pub process: OwnedHandle,
    pub pid: u32,
}

pub fn spawn_system_in_session(session_id: u32, exe: &Path, args: &str) -> anyhow::Result<Spawned> {
    // LocalSystem holds these; SeTcb is enabled by default, the other two are
    // not. Enabling them up front avoids ERROR_PRIVILEGE_NOT_HELD surprises.
    for (privilege, name) in [
        (SE_TCB_NAME, "SeTcbPrivilege"),
        (SE_ASSIGNPRIMARYTOKEN_NAME, "SeAssignPrimaryTokenPrivilege"),
        (SE_INCREASE_QUOTA_NAME, "SeIncreaseQuotaPrivilege"),
    ] {
        if let Err(e) = enable_privilege(privilege) {
            log!("launch: could not enable {name}: {e}");
        }
    }

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
            &session_id as *const u32 as *const c_void,
            size_of::<u32>() as u32,
        )
        .context("SetTokenInformation(TokenSessionId) (needs SeTcbPrivilege)")?;

        let mut environment: *mut c_void = std::ptr::null_mut();
        CreateEnvironmentBlock(&mut environment, Some(primary.0), false)
            .context("CreateEnvironmentBlock")?;

        let application = wide(&exe.to_string_lossy());
        let mut command_line = wide(&format!("\"{}\" {args}", exe.display()));
        let mut desktop = wide("winsta0\\default");
        let startup = STARTUPINFOW {
            cb: size_of::<STARTUPINFOW>() as u32,
            lpDesktop: PWSTR(desktop.as_mut_ptr()),
            ..Default::default()
        };
        let mut info = PROCESS_INFORMATION::default();
        let created = CreateProcessAsUserW(
            Some(primary.0),
            PCWSTR(application.as_ptr()),
            Some(PWSTR(command_line.as_mut_ptr())),
            None,
            None,
            false,
            // Console-subsystem binary: CREATE_NO_WINDOW keeps a conhost
            // window from appearing on the user's desktop.
            CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
            Some(environment as *const c_void),
            PCWSTR::null(),
            &startup,
            &mut info,
        );
        let _ = DestroyEnvironmentBlock(environment);
        created.context("CreateProcessAsUserW")?;
        let _ = CloseHandle(info.hThread);
        Ok(Spawned {
            process: OwnedHandle(info.hProcess),
            pid: info.dwProcessId,
        })
    }
}

fn enable_privilege(name: PCWSTR) -> windows::core::Result<()> {
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
        let last = GetLastError();
        if last == ERROR_NOT_ALL_ASSIGNED {
            return Err(windows::core::Error::from_hresult(last.to_hresult()));
        }
        Ok(())
    }
}
