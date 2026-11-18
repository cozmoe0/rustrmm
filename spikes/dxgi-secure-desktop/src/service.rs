//! The LocalSystem service: supervises one capture helper in the active
//! console session, replacing it when the console session changes
//! (fast user switching, logoff -> new logon session, RDP takeover of the
//! console) and restarting it with back-off when it dies.
//! Also the install / uninstall / start / stop / status commands.

use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use anyhow::{Context, bail};
use windows::Win32::Foundation::WAIT_OBJECT_0;
use windows::Win32::System::RemoteDesktop::WTSGetActiveConsoleSessionId;
use windows::Win32::System::Threading::{
    GetExitCodeProcess, TerminateProcess, WaitForSingleObject,
};
use windows_service::service::{
    ServiceAccess, ServiceControl, ServiceControlAccept, ServiceErrorControl, ServiceExitCode,
    ServiceInfo, ServiceStartType, ServiceState, ServiceStatus, ServiceType, SessionChangeParam,
};
use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};
use windows_service::{define_windows_service, service_dispatcher};

use crate::launch::{self, OwnedHandle};
use crate::{paths, util};

pub const SERVICE_NAME: &str = "RustRMMSpikeCapture";
const DISPLAY_NAME: &str = "RustRMM spike - secure desktop capture";
const EXE_NAME: &str = "dxgi-spike.exe";
/// WTSGetActiveConsoleSessionId while no session is attached to the console.
const NO_CONSOLE_SESSION: u32 = 0xFFFF_FFFF;

define_windows_service!(ffi_service_main, service_main);

pub fn run_dispatcher() -> anyhow::Result<()> {
    service_dispatcher::start(SERVICE_NAME, ffi_service_main).context(
        "StartServiceCtrlDispatcher failed; the 'service' command is for the SCM only (use 'install' then 'start')",
    )
}

fn service_main(_arguments: Vec<OsString>) {
    let _ = crate::logging::init(&paths::logs_dir().join("service.log"), false);
    log!("service: starting; {}", util::identity_summary());
    if let Err(e) = run_service() {
        log!("service: fatal: {e:#}");
    }
    log!("service: stopped");
}

enum Event {
    Stop,
    Session(SessionChangeParam),
}

fn run_service() -> anyhow::Result<()> {
    let (tx, rx) = mpsc::channel::<Event>();
    let handler = move |control| -> ServiceControlHandlerResult {
        match control {
            ServiceControl::Stop | ServiceControl::Shutdown => {
                let _ = tx.send(Event::Stop);
                ServiceControlHandlerResult::NoError
            }
            ServiceControl::SessionChange(param) => {
                let _ = tx.send(Event::Session(param));
                ServiceControlHandlerResult::NoError
            }
            ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
            _ => ServiceControlHandlerResult::NotImplemented,
        }
    };
    let status = service_control_handler::register(SERVICE_NAME, handler)?;
    let report = |state: ServiceState, accept: ServiceControlAccept| {
        status.set_service_status(ServiceStatus {
            service_type: ServiceType::OWN_PROCESS,
            current_state: state,
            controls_accepted: accept,
            exit_code: ServiceExitCode::Win32(0),
            checkpoint: 0,
            wait_hint: Duration::from_secs(5),
            process_id: None,
        })
    };
    report(
        ServiceState::Running,
        ServiceControlAccept::STOP
            | ServiceControlAccept::SHUTDOWN
            | ServiceControlAccept::SESSION_CHANGE,
    )?;

    let mut supervisor = Supervisor::new(std::env::current_exe()?);
    loop {
        match rx.recv_timeout(Duration::from_secs(1)) {
            Ok(Event::Stop) => {
                log!("service: stop requested");
                break;
            }
            Ok(Event::Session(param)) => log!(
                "service: session change {:?} for session {}",
                param.reason,
                param.notification.session_id
            ),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
        supervisor.tick();
    }

    report(ServiceState::StopPending, ServiceControlAccept::empty())?;
    supervisor.kill_helper("service stopping");
    report(ServiceState::Stopped, ServiceControlAccept::empty())?;
    Ok(())
}

struct Helper {
    process: OwnedHandle,
    pid: u32,
    session: u32,
    started: Instant,
}

impl Helper {
    fn exit_code(&self) -> Option<u32> {
        unsafe {
            if WaitForSingleObject(self.process.0, 0) != WAIT_OBJECT_0 {
                return None;
            }
            let mut code = 0u32;
            let _ = GetExitCodeProcess(self.process.0, &mut code);
            Some(code)
        }
    }
}

struct Supervisor {
    exe: PathBuf,
    helper: Option<Helper>,
    quick_exits: u32,
    next_attempt: Instant,
}

impl Supervisor {
    fn new(exe: PathBuf) -> Self {
        Self {
            exe,
            helper: None,
            quick_exits: 0,
            next_attempt: Instant::now(),
        }
    }

    fn tick(&mut self) {
        let console = unsafe { WTSGetActiveConsoleSessionId() };

        if let Some(helper) = &self.helper {
            if let Some(code) = helper.exit_code() {
                let lived = helper.started.elapsed();
                log!(
                    "service: helper pid {} (session {}) exited with code {code:#x} after {:.1} s",
                    helper.pid,
                    helper.session,
                    lived.as_secs_f64()
                );
                self.quick_exits = if lived < Duration::from_secs(10) {
                    self.quick_exits + 1
                } else {
                    0
                };
                let backoff = Duration::from_secs(1u64 << self.quick_exits.min(5));
                self.next_attempt = Instant::now() + backoff;
                self.helper = None;
            } else if console != NO_CONSOLE_SESSION && console != helper.session {
                let reason = format!("console session moved {} -> {console}", helper.session);
                self.kill_helper(&reason);
            }
        }

        if self.helper.is_none()
            && console != NO_CONSOLE_SESSION
            && Instant::now() >= self.next_attempt
        {
            let args = format!("helper --parent-pid {}", std::process::id());
            match launch::spawn_system_in_session(console, &self.exe, &args) {
                Ok(spawned) => {
                    log!(
                        "service: launched helper pid {} into session {console} (winsta0\\default)",
                        spawned.pid
                    );
                    self.helper = Some(Helper {
                        process: spawned.process,
                        pid: spawned.pid,
                        session: console,
                        started: Instant::now(),
                    });
                }
                Err(e) => {
                    log!("service: launching helper into session {console} failed: {e:#}");
                    self.next_attempt = Instant::now() + Duration::from_secs(5);
                }
            }
        }
    }

    fn kill_helper(&mut self, reason: &str) {
        if let Some(helper) = self.helper.take() {
            log!("service: terminating helper pid {} ({reason})", helper.pid);
            unsafe {
                let _ = TerminateProcess(helper.process.0, 0);
                WaitForSingleObject(helper.process.0, 3000);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Management commands
// ---------------------------------------------------------------------------

/// windows-service errors print as "IO error in winapi call"; show the OS error too.
fn describe(e: &windows_service::Error) -> String {
    match std::error::Error::source(e) {
        Some(source) => format!("{e}: {source}"),
        None => e.to_string(),
    }
}

fn ensure_elevated(command: &str) -> anyhow::Result<()> {
    if !util::is_elevated() {
        bail!("'{command}' must run from an elevated (Run as administrator) prompt");
    }
    Ok(())
}

fn wait_for_state(
    service: &windows_service::service::Service,
    want: ServiceState,
    timeout: Duration,
) -> anyhow::Result<ServiceState> {
    let deadline = Instant::now() + timeout;
    loop {
        let state = service.query_status()?.current_state;
        if state == want || Instant::now() >= deadline {
            return Ok(state);
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

fn stop_and_wait(service: &windows_service::service::Service) -> anyhow::Result<()> {
    if service.query_status()?.current_state == ServiceState::Stopped {
        return Ok(());
    }
    if let Err(e) = service.stop() {
        println!("stop request: {}", describe(&e));
    }
    let state = wait_for_state(service, ServiceState::Stopped, Duration::from_secs(15))?;
    if state != ServiceState::Stopped {
        bail!("service did not stop (state {state:?})");
    }
    Ok(())
}

pub fn install() -> anyhow::Result<()> {
    ensure_elevated("install")?;
    let source = std::env::current_exe()?;
    let dir = paths::install_dir();
    let target = dir.join(EXE_NAME);
    let manager = ServiceManager::local_computer(
        None::<&str>,
        ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE,
    )?;

    let existing = manager
        .open_service(
            SERVICE_NAME,
            ServiceAccess::QUERY_STATUS | ServiceAccess::STOP,
        )
        .ok();
    if let Some(service) = &existing {
        println!("service already installed; stopping it to replace the binary");
        stop_and_wait(service)?;
    }

    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    if source != target {
        std::fs::copy(&source, &target)
            .with_context(|| format!("copying {} -> {}", source.display(), target.display()))?;
    }

    if existing.is_none() {
        let info = ServiceInfo {
            name: SERVICE_NAME.into(),
            display_name: DISPLAY_NAME.into(),
            service_type: ServiceType::OWN_PROCESS,
            start_type: ServiceStartType::OnDemand,
            error_control: ServiceErrorControl::Normal,
            executable_path: target.clone(),
            launch_arguments: vec!["service".into()],
            dependencies: vec![],
            account_name: None, // LocalSystem
            account_password: None,
        };
        let service = manager.create_service(&info, ServiceAccess::CHANGE_CONFIG)?;
        service.set_description(
            "Throwaway RustRMM Phase-0 spike (DXGI secure-desktop capture). Remove with 'dxgi-spike uninstall'.",
        )?;
    }
    println!(
        "installed service '{SERVICE_NAME}' (LocalSystem, manual start) -> {}",
        target.display()
    );
    println!("next: dxgi-spike start");
    Ok(())
}

pub fn start() -> anyhow::Result<()> {
    ensure_elevated("start")?;
    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)?;
    let service = manager
        .open_service(
            SERVICE_NAME,
            ServiceAccess::START | ServiceAccess::QUERY_STATUS,
        )
        .context("opening the service (is it installed?)")?;
    if service.query_status()?.current_state != ServiceState::Running {
        service.start::<&str>(&[])?;
    }
    let state = wait_for_state(&service, ServiceState::Running, Duration::from_secs(10))?;
    println!("service state: {state:?}");
    println!("frames: {}", paths::frames_dir().display());
    println!("logs:   {}", paths::logs_dir().display());
    Ok(())
}

pub fn stop() -> anyhow::Result<()> {
    ensure_elevated("stop")?;
    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)?;
    let service = manager
        .open_service(
            SERVICE_NAME,
            ServiceAccess::STOP | ServiceAccess::QUERY_STATUS,
        )
        .context("opening the service (is it installed?)")?;
    stop_and_wait(&service)?;
    println!("service stopped");
    Ok(())
}

pub fn status() -> anyhow::Result<()> {
    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)?;
    match manager.open_service(SERVICE_NAME, ServiceAccess::QUERY_STATUS) {
        Ok(service) => {
            let s = service.query_status()?;
            println!(
                "service '{SERVICE_NAME}': {:?} (pid {:?})",
                s.current_state, s.process_id
            );
        }
        Err(e) => println!("service '{SERVICE_NAME}' not available: {}", describe(&e)),
    }
    for log_name in ["service.log", "helper.log"] {
        let path = paths::logs_dir().join(log_name);
        match std::fs::read_to_string(&path) {
            Ok(text) => {
                let lines: Vec<&str> = text.lines().collect();
                println!("--- last lines of {} ---", path.display());
                for line in &lines[lines.len().saturating_sub(15)..] {
                    println!("{line}");
                }
            }
            Err(_) => println!("--- {} not found ---", path.display()),
        }
    }
    Ok(())
}

pub fn uninstall(purge: bool) -> anyhow::Result<()> {
    ensure_elevated("uninstall")?;
    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)?;
    match manager.open_service(
        SERVICE_NAME,
        ServiceAccess::QUERY_STATUS | ServiceAccess::STOP | ServiceAccess::DELETE,
    ) {
        Ok(service) => {
            stop_and_wait(&service)?;
            service.delete()?;
            drop(service);
            // Deletion completes once every handle is closed.
            for _ in 0..20 {
                if manager
                    .open_service(SERVICE_NAME, ServiceAccess::QUERY_STATUS)
                    .is_err()
                {
                    break;
                }
                std::thread::sleep(Duration::from_millis(250));
            }
            println!("service '{SERVICE_NAME}' deleted");
        }
        Err(e) => println!("service '{SERVICE_NAME}' not installed ({})", describe(&e)),
    }

    let dir = paths::install_dir();
    if dir.exists() {
        // The exe can stay locked for a moment after the service process exits.
        let mut removed = false;
        for _ in 0..20 {
            if std::fs::remove_dir_all(&dir).is_ok() {
                removed = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        if removed {
            println!("removed {}", dir.display());
        } else {
            println!("could not remove {} yet; delete it manually", dir.display());
        }
    }

    let data = paths::data_root();
    if purge {
        match std::fs::remove_dir_all(&data) {
            Ok(()) => println!("removed {}", data.display()),
            Err(e) => println!("could not remove {}: {e}", data.display()),
        }
    } else {
        println!(
            "kept frames and logs in {} (uninstall --purge removes them)",
            data.display()
        );
    }
    Ok(())
}
