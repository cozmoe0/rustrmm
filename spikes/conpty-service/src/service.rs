//! Windows service plumbing (windows-service crate): install / uninstall / SCM entry point, plus
//! `service-test`, which drives a full install -> start -> stop -> uninstall cycle.

use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use windows::Win32::Foundation::{ERROR_SUCCESS, HLOCAL, LocalFree};
use windows::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, GetNamedSecurityInfoW, SDDL_REVISION_1,
    SE_FILE_OBJECT,
};
use windows::Win32::Security::{
    OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES,
};
use windows::Win32::Storage::FileSystem::CreateDirectoryW;
use windows::core::{PCWSTR, w};
use windows_service::service::{
    Service, ServiceAccess, ServiceControl, ServiceControlAccept, ServiceErrorControl,
    ServiceExitCode, ServiceInfo, ServiceStartType, ServiceState, ServiceStatus, ServiceType,
};
use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};
use windows_service::{define_windows_service, service_dispatcher};

use crate::demo::{self, Options, Outcome, Verdict};
use crate::token;
use crate::win::wide_os;

pub const SERVICE_NAME: &str = "RustRMMConPtySpike";
const DISPLAY_NAME: &str = "RustRMM ConPTY spike (throwaway)";
const SERVICE_TYPE: ServiceType = ServiceType::OWN_PROCESS;
const PHASE_HOLDING: &str = "PHASE: holding";

const ERROR_ACCESS_DENIED: i32 = 5;
const ERROR_SERVICE_DOES_NOT_EXIST: i32 = 1060;
const ERROR_FAILED_SERVICE_CONTROLLER_CONNECT: i32 = 1063;

/// Shared by the Phase-0 spikes (the DXGI capture spike writes `logs\` and `frames\` here).
fn log_root() -> PathBuf {
    std::env::var_os("ProgramData")
        .map_or_else(|| PathBuf::from(r"C:\ProgramData"), PathBuf::from)
        .join("RustRMMSpike")
}

pub fn log_dir() -> PathBuf {
    log_root().join("conpty-service")
}

pub fn log_path() -> PathBuf {
    log_dir().join("conpty-service.log")
}

fn install_dir() -> PathBuf {
    std::env::var_os("ProgramFiles")
        .map_or_else(|| PathBuf::from(r"C:\Program Files"), PathBuf::from)
        .join("RustRMMSpike")
}

fn installed_exe() -> PathBuf {
    install_dir().join("conpty-service-spike.exe")
}

fn os_code(e: &windows_service::Error) -> Option<i32> {
    match e {
        windows_service::Error::Winapi(io) => io.raw_os_error(),
        _ => None,
    }
}

fn scm_error(e: windows_service::Error, what: &str) -> anyhow::Error {
    if os_code(&e) == Some(ERROR_ACCESS_DENIED) {
        anyhow!("{what}: access denied - run this from an elevated (Run as administrator) shell")
    } else {
        anyhow!(e).context(what.to_string())
    }
}

/// Creates the log directory with an explicit, protected DACL: SYSTEM and Administrators full
/// control, Authenticated Users read. ProgramData's inherited ACL lets any user create files in
/// new subfolders, i.e. plant files or links where a SYSTEM process writes.
fn prepare_log_dir(dir: &Path) -> Result<()> {
    if dir.exists() {
        return Ok(());
    }
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    // SAFETY: constant SDDL; the descriptor is freed with LocalFree below.
    unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            w!("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FR;;;AU)"),
            SDDL_REVISION_1,
            &mut descriptor,
            None,
        )
    }
    .context("ConvertStringSecurityDescriptorToSecurityDescriptorW")?;
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: false.into(),
    };
    let path = wide_os(dir.as_os_str());
    // SAFETY: valid path and security attributes for the duration of the call.
    let created = unsafe { CreateDirectoryW(PCWSTR(path.as_ptr()), Some(&attributes)) };
    // SAFETY: allocated by ConvertStringSecurityDescriptorToSecurityDescriptorW.
    unsafe { LocalFree(Some(HLOCAL(descriptor.0))) };
    created.with_context(|| format!("CreateDirectoryW({})", dir.display()))
}

pub fn install() -> Result<()> {
    let manager = ServiceManager::local_computer(
        None::<&str>,
        ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE,
    )
    .map_err(|e| scm_error(e, "OpenSCManager"))?;
    let source = std::env::current_exe().context("current_exe")?;
    let target = installed_exe();
    fs::create_dir_all(install_dir())
        .with_context(|| format!("create {}", install_dir().display()))?;
    // Run from an admin-only location: a LocalSystem service whose binary sits in a
    // user-writable folder (target\debug under the profile) is a privilege escalation.
    fs::copy(&source, &target)
        .with_context(|| format!("copy {} -> {}", source.display(), target.display()))?;
    let info = ServiceInfo {
        name: SERVICE_NAME.into(),
        display_name: DISPLAY_NAME.into(),
        service_type: SERVICE_TYPE,
        start_type: ServiceStartType::OnDemand,
        error_control: ServiceErrorControl::Normal,
        executable_path: target.clone(),
        launch_arguments: vec![OsString::from("run-service")],
        dependencies: vec![],
        account_name: None, // LocalSystem
        account_password: None,
    };
    let service = manager
        .create_service(&info, ServiceAccess::CHANGE_CONFIG)
        .map_err(|e| scm_error(e, "CreateService"))?;
    service
        .set_description(
            "Phase-0 spike: hosts cmd/PowerShell through a hand-written ConPTY from LocalSystem. Safe to delete.",
        )
        .map_err(|e| scm_error(e, "ChangeServiceConfig2(description)"))?;
    println!("installed {SERVICE_NAME} (LocalSystem, manual start): {}", target.display());
    println!("log file: {}", log_path().display());
    Ok(())
}

pub fn uninstall() -> Result<()> {
    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
        .map_err(|e| scm_error(e, "OpenSCManager"))?;
    let access = ServiceAccess::QUERY_STATUS | ServiceAccess::STOP | ServiceAccess::DELETE;
    match manager.open_service(SERVICE_NAME, access) {
        Ok(service) => {
            let status = service.query_status().map_err(|e| scm_error(e, "QueryServiceStatus"))?;
            if status.current_state != ServiceState::Stopped {
                let _ = service.stop();
                wait_for_state(&service, ServiceState::Stopped, Duration::from_secs(30))?;
            }
            service.delete().map_err(|e| scm_error(e, "DeleteService"))?;
            drop(service);
            let deadline = Instant::now() + Duration::from_secs(10);
            while Instant::now() < deadline {
                match manager.open_service(SERVICE_NAME, ServiceAccess::QUERY_STATUS) {
                    Err(e) if os_code(&e) == Some(ERROR_SERVICE_DOES_NOT_EXIST) => break,
                    _ => thread::sleep(Duration::from_millis(250)),
                }
            }
            println!("deleted service {SERVICE_NAME}");
        }
        Err(e) if os_code(&e) == Some(ERROR_SERVICE_DOES_NOT_EXIST) => {
            println!("service {SERVICE_NAME} is not installed");
        }
        Err(e) => return Err(scm_error(e, "OpenService")),
    }
    remove_installed_copy();
    Ok(())
}

fn remove_installed_copy() {
    let exe = installed_exe();
    if !install_dir().exists() {
        return;
    }
    // The service process can take a moment to exit after reporting Stopped.
    for _ in 0..20 {
        if !exe.exists() || fs::remove_file(&exe).is_ok() {
            break;
        }
        thread::sleep(Duration::from_millis(250));
    }
    let _ = fs::remove_dir(install_dir());
    if exe.exists() {
        println!("could not delete {}; remove it by hand", exe.display());
    } else {
        println!("removed {}", install_dir().display());
    }
}

fn wait_for_state(service: &Service, want: ServiceState, timeout: Duration) -> Result<Duration> {
    let start = Instant::now();
    loop {
        let status = service.query_status().map_err(|e| scm_error(e, "QueryServiceStatus"))?;
        if status.current_state == want {
            return Ok(start.elapsed());
        }
        if start.elapsed() > timeout {
            bail!("service did not reach {want:?} within {timeout:?} (state {:?})", status.current_state);
        }
        thread::sleep(Duration::from_millis(100));
    }
}

define_windows_service!(ffi_service_main, service_main);

pub fn run_dispatcher() -> Result<()> {
    service_dispatcher::start(SERVICE_NAME, ffi_service_main).map_err(|e| {
        if os_code(&e) == Some(ERROR_FAILED_SERVICE_CONTROLLER_CONNECT) {
            anyhow!(
                "`run-service` is the SCM entry point: install the service and start it with `sc.exe start {SERVICE_NAME}`, or use `console`"
            )
        } else {
            anyhow!(e).context("StartServiceCtrlDispatcher")
        }
    })
}

fn service_main(_arguments: Vec<OsString>) {
    // No console in a service: everything goes to the log file. If that fails there is nowhere
    // to report it, but the SCM still gets status updates below.
    let _ = prepare_log_dir(&log_root())
        .and_then(|()| prepare_log_dir(&log_dir()))
        .and_then(|()| crate::log::to_file(&log_path()).context("open log file"));
    log_directory_owners();
    if let Err(e) = run_service() {
        logln!("service failed: {e:#}");
    }
}

/// A SYSTEM process writing under a directory a standard user owns can be redirected (swap a
/// subfolder for a junction). The spike only warns; the agent must refuse to start.
fn log_directory_owners() {
    for dir in [log_root(), log_dir()] {
        match directory_owner(&dir) {
            Ok(owner) => {
                let trusted = owner.eq_ignore_ascii_case(r"NT AUTHORITY\SYSTEM")
                    || owner.eq_ignore_ascii_case(r"BUILTIN\Administrators");
                logln!(
                    "{} is owned by {owner}{}",
                    dir.display(),
                    if trusted {
                        ""
                    } else {
                        " - WARNING: not SYSTEM/Administrators, so a standard user could redirect these SYSTEM-written files"
                    }
                );
            }
            Err(e) => logln!("owner of {}: {e:#}", dir.display()),
        }
    }
}

fn directory_owner(dir: &Path) -> Result<String> {
    let path = wide_os(dir.as_os_str());
    let mut owner = PSID::default();
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    // SAFETY: valid path; `owner` points into `descriptor`, which is freed below.
    let rc = unsafe {
        GetNamedSecurityInfoW(
            PCWSTR(path.as_ptr()),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION,
            Some(&raw mut owner),
            None,
            None,
            None,
            &mut descriptor,
        )
    };
    if rc != ERROR_SUCCESS {
        bail!("GetNamedSecurityInfoW: {}", windows::core::Error::from_hresult(rc.to_hresult()));
    }
    let account = token::sid_account(owner);
    // SAFETY: allocated by GetNamedSecurityInfoW.
    unsafe { LocalFree(Some(HLOCAL(descriptor.0))) };
    account
}

fn run_service() -> Result<()> {
    let (stop_sender, stop_receiver) = mpsc::channel::<()>();
    let stop_flag = Arc::new(AtomicBool::new(false));
    let handler_flag = Arc::clone(&stop_flag);
    let handler = move |control| -> ServiceControlHandlerResult {
        match control {
            ServiceControl::Stop | ServiceControl::Shutdown => {
                handler_flag.store(true, Ordering::SeqCst);
                let _ = stop_sender.send(());
                ServiceControlHandlerResult::NoError
            }
            ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
            _ => ServiceControlHandlerResult::NotImplemented,
        }
    };
    let status = service_control_handler::register(SERVICE_NAME, handler)
        .map_err(|e| anyhow!(e).context("RegisterServiceCtrlHandlerEx"))?;
    let set_status = |state, accepted, exit_code, checkpoint, wait_hint| {
        status.set_service_status(ServiceStatus {
            service_type: SERVICE_TYPE,
            current_state: state,
            controls_accepted: accepted,
            exit_code,
            checkpoint,
            wait_hint,
            process_id: None,
        })
    };
    set_status(
        ServiceState::Running,
        ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN,
        ServiceExitCode::Win32(0),
        0,
        Duration::ZERO,
    )?;

    demo::log_environment("service");
    let opts = Options::default();
    // First learn whether the SCM hands services an "ignore Ctrl+C" flag, then clear it.
    let mut outcomes = vec![demo::observe_inherited_ctrl_c(opts)];
    demo::reset_ctrl_c_inheritance();
    let stop_requested = || stop_flag.load(Ordering::SeqCst);
    outcomes.extend(demo::service_scenarios(opts, &stop_requested));
    let held = if stop_requested() {
        None
    } else {
        match demo::start_held_session(opts) {
            Ok(session) => Some(session),
            Err(e) => {
                logln!("held session failed: {e:#}");
                outcomes.push(Outcome::failed("service-stop/held-session-teardown"));
                None
            }
        }
    };

    logln!("{PHASE_HOLDING}: scenarios done, waiting for SERVICE_CONTROL_STOP");
    let _ = stop_receiver.recv();
    logln!("stop requested: tearing down the held session");
    set_status(
        ServiceState::StopPending,
        ServiceControlAccept::empty(),
        ServiceExitCode::Win32(0),
        1,
        Duration::from_secs(15),
    )?;
    if let Some(session) = held {
        outcomes.push(demo::stop_held_session(session));
    }
    let passed = demo::summarize(&outcomes);
    let failed = outcomes.iter().filter(|o| o.verdict == Verdict::Fail).count();
    let exit_code = if passed {
        ServiceExitCode::Win32(0)
    } else {
        ServiceExitCode::ServiceSpecific(u32::try_from(failed).unwrap_or(u32::MAX))
    };
    logln!("reporting SERVICE_STOPPED ({failed} failed)");
    set_status(ServiceState::Stopped, ServiceControlAccept::empty(), exit_code, 0, Duration::ZERO)?;
    Ok(())
}

/// Prints complete new log lines written since `offset`; returns everything since `offset`.
fn show_new_log(log: &Path, offset: u64, shown: &mut usize) -> String {
    let bytes = fs::read(log).unwrap_or_default();
    let section = bytes.get(usize::try_from(offset).unwrap_or(usize::MAX)..).unwrap_or_default();
    if let Some(last_newline) = section.iter().rposition(|&b| b == b'\n')
        && last_newline + 1 > *shown
    {
        let mut out = std::io::stdout().lock();
        let _ = out.write_all(&section[*shown..=last_newline]);
        let _ = out.flush();
        *shown = last_newline + 1;
    }
    String::from_utf8_lossy(section).into_owned()
}

/// Elevated one-shot: install, start, wait for the scenarios, stop (tearing down a live
/// session), print this run's log, uninstall.
pub fn service_test() -> Result<bool> {
    let manager = ServiceManager::local_computer(
        None::<&str>,
        ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE,
    )
    .map_err(|e| scm_error(e, "OpenSCManager"))?;
    if manager.open_service(SERVICE_NAME, ServiceAccess::QUERY_STATUS).is_ok() {
        println!("{SERVICE_NAME} already installed; reinstalling");
        uninstall()?;
    }
    install()?;

    let log = log_path();
    let offset = fs::metadata(&log).map(|m| m.len()).unwrap_or(0);
    let mut shown = 0usize;
    let service = manager
        .open_service(SERVICE_NAME, ServiceAccess::START | ServiceAccess::STOP | ServiceAccess::QUERY_STATUS)
        .map_err(|e| scm_error(e, "OpenService"))?;
    println!("starting {SERVICE_NAME}; streaming {}", log.display());
    service.start::<&OsStr>(&[]).map_err(|e| scm_error(e, "StartService"))?;

    let started = Instant::now();
    let mut reached = false;
    while started.elapsed() < Duration::from_secs(240) {
        if show_new_log(&log, offset, &mut shown).contains(PHASE_HOLDING) {
            reached = true;
            break;
        }
        if service.query_status().is_ok_and(|s| s.current_state == ServiceState::Stopped) {
            println!("service stopped on its own");
            break;
        }
        thread::sleep(Duration::from_millis(500));
    }
    if !reached {
        println!("never saw '{PHASE_HOLDING}' in the log; stopping anyway");
    }

    println!("stopping {SERVICE_NAME} (tears down a live SYSTEM shell session)");
    let _ = service.stop();
    let stopped = wait_for_state(&service, ServiceState::Stopped, Duration::from_secs(60));
    match &stopped {
        Ok(took) => println!("service stopped {:.1} s after the stop request", took.as_secs_f64()),
        Err(e) => println!("{e:#}"),
    }
    drop(service);
    let section = show_new_log(&log, offset, &mut shown);
    uninstall()?;

    let passed = reached && stopped.is_ok() && section.contains("RESULT: PASS");
    println!("service-test: {}", if passed { "PASS" } else { "FAIL" });
    Ok(passed)
}

#[cfg(test)]
mod tests {
    /// Exercises the SDDL -> SECURITY_ATTRIBUTES -> CreateDirectoryW path and the owner lookup on
    /// a scratch directory (never on ProgramData from an unelevated shell: that would pre-create
    /// the real log directory with a standard-user owner, the very thing the DACL guards against).
    #[test]
    fn creates_directory_with_protected_dacl() {
        let dir = std::env::temp_dir().join(format!("rrmm-spike-acl-{}", std::process::id()));
        super::prepare_log_dir(&dir).expect("prepare_log_dir");
        assert!(dir.is_dir());
        println!("owner: {}", super::directory_owner(&dir).expect("directory_owner"));
        if let Ok(out) = std::process::Command::new("icacls").arg(&dir).output() {
            println!("{}", String::from_utf8_lossy(&out.stdout));
        }
        std::fs::remove_dir(&dir).expect("cleanup");
    }
}
