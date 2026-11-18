//! Windows containment: the script starts suspended, joins a kill-on-close job object and only
//! then runs, so every process it starts is in the job from its first instruction.

use std::ffi::{OsString, c_void};
use std::io::Read;
use std::os::windows::ffi::OsStringExt;
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command};

use anyhow::{Context, Result};
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Security::{TOKEN_DUPLICATE, TOKEN_QUERY};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
};
use windows::Win32::System::Environment::{CreateEnvironmentBlock, DestroyEnvironmentBlock};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectBasicAccountingInformation,
    JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
    TerminateJobObject,
};
use windows::Win32::System::Threading::{
    CREATE_NO_WINDOW, CREATE_SUSPENDED, GetCurrentProcess, OpenProcessToken, OpenThread,
    ResumeThread, THREAD_SUSPEND_RESUME,
};
use windows::core::PCWSTR;

use super::Contained;

/// Exit code given to processes killed by the job.
const KILLED_EXIT_CODE: u32 = 1;

/// Owned kernel handle, closed exactly once.
struct Handle(HANDLE);

// SAFETY: kernel handles have no thread affinity; this wrapper is the single owner.
unsafe impl Send for Handle {}

impl Drop for Handle {
    fn drop(&mut self) {
        if !self.0.is_invalid() && !self.0.0.is_null() {
            // SAFETY: owned handle, closed once.
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

fn kill_on_close_job() -> Result<Handle> {
    // SAFETY: default security, unnamed.
    let raw = unsafe { CreateJobObjectW(None, PCWSTR::null()) }.context("CreateJobObjectW")?;
    let job = Handle(raw);
    let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    info.BasicLimitInformation.LimitFlags =
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
    // SAFETY: `info` is valid for the stated size.
    unsafe {
        SetInformationJobObject(
            job.0,
            JobObjectExtendedLimitInformation,
            (&raw const info).cast(),
            size_of_val(&info) as u32,
        )
    }
    .context("SetInformationJobObject")?;
    Ok(job)
}

/// Resumes the (only) thread of a process created suspended.
fn resume_process(pid: u32) -> Result<()> {
    // SAFETY: snapshot of all threads; the handle is owned below.
    let snapshot = Handle(
        unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) }
            .context("CreateToolhelp32Snapshot")?,
    );
    let mut entry = THREADENTRY32 {
        dwSize: size_of::<THREADENTRY32>() as u32,
        ..Default::default()
    };
    let mut resumed = 0;
    // SAFETY: valid snapshot handle and a correctly sized entry.
    let mut more = unsafe { Thread32First(snapshot.0, &mut entry) }.is_ok();
    while more {
        if entry.th32OwnerProcessID == pid {
            // SAFETY: plain open of a thread id from the snapshot.
            if let Ok(thread) =
                unsafe { OpenThread(THREAD_SUSPEND_RESUME, false, entry.th32ThreadID) }
            {
                let thread = Handle(thread);
                // SAFETY: valid thread handle with THREAD_SUSPEND_RESUME.
                if unsafe { ResumeThread(thread.0) } != u32::MAX {
                    resumed += 1;
                }
            }
        }
        // SAFETY: as above.
        more = unsafe { Thread32Next(snapshot.0, &mut entry) }.is_ok();
    }
    anyhow::ensure!(resumed > 0, "could not resume the script process");
    Ok(())
}

pub struct ContainedChild {
    child: Child,
    job: Option<Handle>,
}

/// Starts the command suspended, places it in a kill-on-close job, then lets it run.
pub fn spawn(cmd: &mut Command) -> Result<ContainedChild> {
    let job = kill_on_close_job()?;
    cmd.creation_flags(CREATE_NO_WINDOW.0 | CREATE_SUSPENDED.0);
    let mut child = cmd.spawn()?;
    let process = HANDLE(child.as_raw_handle());
    // SAFETY: valid job and process handles.
    if let Err(e) = unsafe { AssignProcessToJobObject(job.0, process) } {
        let _ = child.kill();
        let _ = child.wait();
        return Err(e).context("AssignProcessToJobObject");
    }
    if let Err(e) = resume_process(child.id()) {
        // SAFETY: valid job handle.
        let _ = unsafe { TerminateJobObject(job.0, KILLED_EXIT_CODE) };
        let _ = child.wait();
        return Err(e);
    }
    Ok(ContainedChild {
        child,
        job: Some(job),
    })
}

impl Contained for ContainedChild {
    fn take_stdout(&mut self) -> Option<Box<dyn Read + Send>> {
        self.child
            .stdout
            .take()
            .map(|s| Box::new(s) as Box<dyn Read + Send>)
    }

    fn take_stderr(&mut self) -> Option<Box<dyn Read + Send>> {
        self.child
            .stderr
            .take()
            .map(|s| Box::new(s) as Box<dyn Read + Send>)
    }

    fn try_wait(&mut self) -> Result<Option<Option<i32>>> {
        Ok(self.child.try_wait()?.map(|status| status.code()))
    }

    fn wait(&mut self) -> Option<i32> {
        self.child.wait().ok().and_then(|s| s.code())
    }

    fn kill_tree(&mut self, _graceful: bool) {
        if let Some(job) = &self.job {
            // SAFETY: valid job handle.
            let _ = unsafe { TerminateJobObject(job.0, KILLED_EXIT_CODE) };
        }
    }

    fn active_processes(&self) -> Option<u32> {
        let job = self.job.as_ref()?;
        let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        // SAFETY: valid job handle; `info` is valid for the stated size.
        unsafe {
            QueryInformationJobObject(
                Some(job.0),
                JobObjectBasicAccountingInformation,
                (&raw mut info).cast(),
                size_of_val(&info) as u32,
                None,
            )
        }
        .ok()?;
        Some(info.ActiveProcesses)
    }
}

impl Drop for ContainedChild {
    fn drop(&mut self) {
        // Closing the last job handle kills anything still inside it.
        self.job.take();
        let _ = self.child.try_wait();
    }
}

/// The data directory's ACL (SYSTEM + Administrators only, set at install) is inherited.
pub fn restrict_dir(_dir: &Path) {}

/// The default environment of this process's account (what a fresh logon would get), not the
/// agent's own environment, with TEMP/TMP pointing at the script's private directory.
pub fn default_environment(dir: &Path, _program: &Path) -> Vec<(OsString, OsString)> {
    let mut env = account_environment().unwrap_or_else(|e| {
        tracing::warn!(error = %format!("{e:#}"), "CreateEnvironmentBlock failed; using a minimal environment");
        fallback_environment()
    });
    env.retain(|(name, _)| {
        let upper = name.to_string_lossy().to_ascii_uppercase();
        upper != "TEMP" && upper != "TMP" && !upper.starts_with("RUSTRMM_")
    });
    env.push(("TEMP".into(), dir.as_os_str().to_owned()));
    env.push(("TMP".into(), dir.as_os_str().to_owned()));
    env
}

fn account_environment() -> Result<Vec<(OsString, OsString)>> {
    let mut raw = HANDLE::default();
    // SAFETY: pseudo-handle of the current process.
    unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE, &mut raw) }
        .context("OpenProcessToken")?;
    let token = Handle(raw);
    let mut block: *mut c_void = std::ptr::null_mut();
    // SAFETY: valid token; the block is freed below.
    unsafe { CreateEnvironmentBlock(&mut block, Some(token.0), false) }
        .context("CreateEnvironmentBlock")?;
    let mut vars = Vec::new();
    // SAFETY: the block is a sequence of NUL-terminated UTF-16 strings ending with an empty one.
    unsafe {
        let mut cursor = block.cast::<u16>();
        loop {
            let mut len = 0usize;
            while *cursor.add(len) != 0 {
                len += 1;
            }
            if len == 0 {
                break;
            }
            let entry = OsString::from_wide(std::slice::from_raw_parts(cursor, len));
            cursor = cursor.add(len + 1);
            let text = entry.to_string_lossy();
            // Skip the hidden per-drive entries ("=C:=C:\…").
            if let Some((name, value)) = text.split_once('=')
                && !name.is_empty()
            {
                vars.push((OsString::from(name), OsString::from(value)));
            }
        }
        let _ = DestroyEnvironmentBlock(block);
    }
    Ok(vars)
}

fn fallback_environment() -> Vec<(OsString, OsString)> {
    let system = crate::util::system_tool("cmd.exe");
    let system_dir = system
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| r"C:\Windows\System32".into());
    let windows_dir = system_dir
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| r"C:\Windows".into());
    let s = |p: &Path| p.as_os_str().to_owned();
    vec![
        ("SystemRoot".into(), s(&windows_dir)),
        ("windir".into(), s(&windows_dir)),
        ("ComSpec".into(), s(&system)),
        (
            "PATH".into(),
            format!(
                "{0};{1};{0}\\Wbem;{0}\\WindowsPowerShell\\v1.0",
                system_dir.display(),
                windows_dir.display()
            )
            .into(),
        ),
        (
            "PATHEXT".into(),
            ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC".into(),
        ),
    ]
}
