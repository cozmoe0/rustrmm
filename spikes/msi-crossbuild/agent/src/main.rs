//! RustRMM MSI spike agent (throwaway code).
//!
//! A minimal Windows service, installed by a wixl-built MSI, that resolves its enrolment
//! ("deploy") key on first start:
//!
//! 1. `HKLM\SOFTWARE\RustRMMSpike\DeployKey`, written by the MSI from the hidden public
//!    property `DEPLOY_KEY` (`msiexec /i agent.msi DEPLOY_KEY=...`). Preferred when present.
//! 2. Otherwise `deploy.key` in the folder the MSI was installed from, located with
//!    `MsiGetProductInfoW(ProductCode, INSTALLPROPERTY_INSTALLSOURCE)`. This is the Group
//!    Policy path: GPO Software Installation cannot pass MSI properties, so the key ships as
//!    a sidecar file on the deployment share.
//!
//! Everything is logged to `%ProgramData%\RustRMMSpike\msi.log`. The key itself is never
//! logged in full.

#[cfg(windows)]
fn main() {
    win::main();
}

#[cfg(not(windows))]
fn main() {
    eprintln!("rustrmm-spike-agent only runs on Windows");
    std::process::exit(1);
}

#[cfg(windows)]
mod win {
    use std::ffi::OsString;
    use std::fs::{self, OpenOptions};
    use std::io::{self, Write};
    use std::path::{Path, PathBuf};
    use std::ptr::null_mut;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
    use std::time::Duration;

    use windows_service::service::{
        ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus,
        ServiceType,
    };
    use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
    use windows_service::{define_windows_service, service_dispatcher};
    use windows_sys::Win32::Foundation::{ERROR_MORE_DATA, ERROR_SUCCESS, SYSTEMTIME};
    use windows_sys::Win32::System::ApplicationInstallationAndServicing::{
        INSTALLPROPERTY_INSTALLSOURCE, INSTALLPROPERTY_PACKAGENAME,
        INSTALLPROPERTY_VERSIONSTRING, MsiEnumRelatedProductsW, MsiGetProductInfoW,
    };
    use windows_sys::Win32::System::Registry::{
        HKEY, HKEY_LOCAL_MACHINE, KEY_SET_VALUE, KEY_WOW64_32KEY, KEY_WOW64_64KEY, RRF_RT_REG_SZ,
        RRF_SUBKEY_WOW6432KEY, RRF_SUBKEY_WOW6464KEY, RegCloseKey, RegDeleteValueW,
        RegGetValueW, RegOpenKeyExW,
    };
    use windows_sys::Win32::System::SystemInformation::GetLocalTime;
    use windows_sys::core::PCWSTR;

    const SERVICE_NAME: &str = "RustRMMSpikeAgent";
    /// Must match `Product/@Id` in `wix/agent.wxs`. Fixed for the life of the product.
    const PRODUCT_CODE: &str = "{7C26286F-1047-4CA2-B343-2797FAD7228C}";
    /// Must match `Product/@UpgradeCode` in `wix/agent.wxs`.
    const UPGRADE_CODE: &str = "{5840E1F2-DD29-4DB7-BF38-2B9425C17909}";

    const REG_SUBKEY: &str = r"SOFTWARE\RustRMMSpike";
    /// Written by the MSI from `[DEPLOY_KEY]` (conditional component).
    const REG_DEPLOY_KEY: &str = "DeployKey";
    /// Written by the MSI from `[OriginalDatabase]`; diagnostic only (see FINDINGS.md).
    const REG_SOURCE_PACKAGE: &str = "SourcePackage";
    const DEPLOY_KEY_FILE: &str = "deploy.key";

    const RETRY_INTERVAL: Duration = Duration::from_secs(5);
    const MAX_ATTEMPTS: u32 = 60;

    /// (RegGetValueW flag, RegOpenKeyExW access flag, label)
    const VIEWS: [(u32, u32, &str); 2] = [
        (RRF_SUBKEY_WOW6464KEY, KEY_WOW64_64KEY, "64-bit view"),
        (RRF_SUBKEY_WOW6432KEY, KEY_WOW64_32KEY, "32-bit view (WOW6432Node)"),
    ];

    static CONSOLE: AtomicBool = AtomicBool::new(false);

    define_windows_service!(ffi_service_main, service_main);

    pub fn main() {
        if std::env::args().skip(1).any(|a| a == "--console") {
            CONSOLE.store(true, Ordering::Relaxed);
            log("console mode: single diagnostic pass (no config written, nothing deleted)");
            diagnostics();
            match probe(1) {
                Some(found) => log(&format!(
                    "would use deploy key from {}: {}",
                    found.source,
                    mask(&found.key)
                )),
                None => log("no deploy key found"),
            }
            return;
        }
        if let Err(e) = service_dispatcher::start(SERVICE_NAME, ffi_service_main) {
            eprintln!(
                "not started by the service control manager ({e}); \
                 use --console for a one-off diagnostic pass"
            );
            std::process::exit(1);
        }
    }

    fn service_main(_args: Vec<OsString>) {
        if let Err(e) = run_service() {
            log(&format!("service error: {e}"));
        }
    }

    fn run_service() -> windows_service::Result<()> {
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let handler = move |control| match control {
            ServiceControl::Stop | ServiceControl::Shutdown => {
                let _ = stop_tx.send(());
                ServiceControlHandlerResult::NoError
            }
            ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
            _ => ServiceControlHandlerResult::NotImplemented,
        };
        let status = service_control_handler::register(SERVICE_NAME, handler)?;
        let set_state = |state, accept| {
            status.set_service_status(ServiceStatus {
                service_type: ServiceType::OWN_PROCESS,
                current_state: state,
                controls_accepted: accept,
                exit_code: ServiceExitCode::Win32(0),
                checkpoint: 0,
                wait_hint: Duration::default(),
                process_id: None,
            })
        };

        // Report Running immediately: ServiceControl/@Wait makes msiexec block until then.
        set_state(
            ServiceState::Running,
            ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN,
        )?;
        log(&format!(
            "service running (pid {}, exe {})",
            std::process::id(),
            std::env::current_exe()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|e| format!("<{e}>"))
        ));

        let stopped = first_start(&stop_rx);
        if !stopped {
            let _ = stop_rx.recv();
        }
        log("stop requested; exiting");
        set_state(ServiceState::Stopped, ServiceControlAccept::empty())?;
        Ok(())
    }

    /// Returns true if a stop request arrived while retrying.
    fn first_start(stop: &Receiver<()>) -> bool {
        // Other spikes share %ProgramData%\RustRMMSpike, so every file name here is msi-prefixed.
        let config = data_dir().join("msi-agent.conf");
        if config.exists() {
            log(&format!(
                "{} exists: not a first start, skipping deploy-key lookup",
                config.display()
            ));
            return false;
        }
        diagnostics();
        for attempt in 1..=MAX_ATTEMPTS {
            if let Some(found) = probe(attempt) {
                log(&format!(
                    "attempt {attempt}: deploy key resolved from {}: {}",
                    found.source,
                    mask(&found.key)
                ));
                // Stand-in for enrolment: record that it happened (never the key itself).
                let body = format!(
                    "enrolled_at={}\r\nkey_source={}\r\nkey_len={}\r\n",
                    timestamp(),
                    found.source,
                    found.key.chars().count()
                );
                match fs::write(&config, body) {
                    Ok(()) => log(&format!("wrote {}", config.display())),
                    Err(e) => log(&format!("cannot write {}: {e}", config.display())),
                }
                if let Source::Registry { sam, view } = found.source {
                    // HKLM\SOFTWARE is readable by every local user; don't leave the key there.
                    let rc = reg_delete_value(REG_SUBKEY, REG_DEPLOY_KEY, sam);
                    log(&format!(
                        "deleted HKLM\\{REG_SUBKEY}\\{REG_DEPLOY_KEY} ({view}): {}",
                        describe(rc)
                    ));
                }
                diagnostics();
                return false;
            }
            match stop.recv_timeout(RETRY_INTERVAL) {
                Ok(()) | Err(RecvTimeoutError::Disconnected) => return true,
                Err(RecvTimeoutError::Timeout) => {}
            }
        }
        log(&format!(
            "no deploy key after {MAX_ATTEMPTS} attempts; idling until stopped"
        ));
        false
    }

    struct Found {
        key: String,
        source: Source,
    }

    enum Source {
        Registry { sam: u32, view: &'static str },
        File { path: PathBuf },
    }

    impl std::fmt::Display for Source {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            match self {
                Source::Registry { view, .. } => {
                    write!(f, "registry HKLM\\{REG_SUBKEY}\\{REG_DEPLOY_KEY} ({view})")
                }
                Source::File { path } => write!(f, "file {}", path.display()),
            }
        }
    }

    /// One resolution attempt: registry value (DEPLOY_KEY property) first, then the sidecar
    /// file next to the MSI.
    fn probe(attempt: u32) -> Option<Found> {
        for (rrf, sam, view) in VIEWS {
            match reg_get_sz(REG_SUBKEY, REG_DEPLOY_KEY, rrf) {
                Ok(v) if !v.trim().is_empty() => {
                    log(&format!(
                        "attempt {attempt}: registry DeployKey present ({view}); \
                         property wins, deploy.key not consulted"
                    ));
                    return Some(Found {
                        key: v.trim().to_owned(),
                        source: Source::Registry { sam, view },
                    });
                }
                Ok(_) => log(&format!("attempt {attempt}: registry DeployKey ({view}) is empty")),
                Err(e) => log(&format!(
                    "attempt {attempt}: registry DeployKey ({view}): {}",
                    describe(e)
                )),
            }
        }

        match msi_product_info(PRODUCT_CODE, INSTALLPROPERTY_INSTALLSOURCE) {
            Ok(src) => {
                log(&format!(
                    "attempt {attempt}: MsiGetProductInfoW({PRODUCT_CODE}, InstallSource) = {src:?}"
                ));
                let path = Path::new(&src).join(DEPLOY_KEY_FILE);
                match fs::read_to_string(&path) {
                    Ok(s) if !s.trim().is_empty() => {
                        return Some(Found {
                            key: s.trim().to_owned(),
                            source: Source::File { path },
                        });
                    }
                    Ok(_) => log(&format!("attempt {attempt}: {} is empty", path.display())),
                    Err(e) => log(&format!(
                        "attempt {attempt}: cannot read {}: {e}",
                        path.display()
                    )),
                }
            }
            Err(e) => log(&format!(
                "attempt {attempt}: MsiGetProductInfoW({PRODUCT_CODE}, InstallSource) failed: {}",
                describe(e)
            )),
        }
        None
    }

    /// Cross-checks logged at start and after resolution.
    fn diagnostics() {
        let related = related_products(UPGRADE_CODE);
        log(&format!(
            "diag: MsiEnumRelatedProductsW(UpgradeCode {UPGRADE_CODE}) = {related:?}"
        ));
        for (prop, name) in [
            (INSTALLPROPERTY_VERSIONSTRING, "VersionString"),
            (INSTALLPROPERTY_PACKAGENAME, "PackageName"),
            (INSTALLPROPERTY_INSTALLSOURCE, "InstallSource"),
        ] {
            let v = msi_product_info(PRODUCT_CODE, prop).map_err(describe);
            log(&format!("diag: MsiGetProductInfoW({name}) = {v:?}"));
        }
        for (rrf, _, view) in VIEWS {
            let v = reg_get_sz(REG_SUBKEY, REG_SOURCE_PACKAGE, rrf).map_err(describe);
            log(&format!(
                "diag: HKLM\\{REG_SUBKEY}\\{REG_SOURCE_PACKAGE} ({view}) = {v:?}"
            ));
        }
    }

    // ---- MSI -------------------------------------------------------------------------------

    fn msi_product_info(product: &str, property: PCWSTR) -> Result<String, u32> {
        let product = wide(product);
        let mut buf = vec![0u16; 260];
        for _ in 0..3 {
            let mut len = buf.len() as u32;
            // SAFETY: valid NUL-terminated inputs; `len` is the buffer capacity in chars.
            let rc = unsafe {
                MsiGetProductInfoW(product.as_ptr(), property, buf.as_mut_ptr(), &mut len)
            };
            match rc {
                ERROR_SUCCESS => return Ok(String::from_utf16_lossy(&buf[..len as usize])),
                // `len` now holds the required size excluding the terminator.
                ERROR_MORE_DATA => buf.resize(len as usize + 1, 0),
                e => return Err(e),
            }
        }
        Err(ERROR_MORE_DATA)
    }

    fn related_products(upgrade_code: &str) -> Vec<String> {
        let upgrade_code = wide(upgrade_code);
        let mut out = Vec::new();
        for index in 0u32.. {
            let mut buf = [0u16; 39];
            // SAFETY: the API writes a 38-char GUID plus terminator into a 39-char buffer.
            let rc = unsafe {
                MsiEnumRelatedProductsW(upgrade_code.as_ptr(), 0, index, buf.as_mut_ptr())
            };
            if rc != ERROR_SUCCESS {
                break; // ERROR_NO_MORE_ITEMS, or a real error; either way stop.
            }
            out.push(String::from_utf16_lossy(&buf[..38]));
        }
        out
    }

    // ---- Registry --------------------------------------------------------------------------

    fn reg_get_sz(subkey: &str, value: &str, view_flag: u32) -> Result<String, u32> {
        let (subkey, value) = (wide(subkey), wide(value));
        let flags = RRF_RT_REG_SZ | view_flag;
        let mut bytes = 0u32;
        // SAFETY: size query with null data pointer.
        let rc = unsafe {
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                subkey.as_ptr(),
                value.as_ptr(),
                flags,
                null_mut(),
                null_mut(),
                &mut bytes,
            )
        };
        if rc != ERROR_SUCCESS {
            return Err(rc);
        }
        let mut buf = vec![0u16; (bytes as usize).div_ceil(2) + 1];
        let mut bytes = (buf.len() * 2) as u32;
        // SAFETY: `bytes` is the buffer size in bytes.
        let rc = unsafe {
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                subkey.as_ptr(),
                value.as_ptr(),
                flags,
                null_mut(),
                buf.as_mut_ptr().cast(),
                &mut bytes,
            )
        };
        if rc != ERROR_SUCCESS {
            return Err(rc);
        }
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Ok(String::from_utf16_lossy(&buf[..end]))
    }

    fn reg_delete_value(subkey: &str, value: &str, view_sam: u32) -> u32 {
        let (subkey, value) = (wide(subkey), wide(value));
        let mut key: HKEY = null_mut();
        // SAFETY: plain Win32 calls with valid NUL-terminated strings; key closed below.
        unsafe {
            let rc = RegOpenKeyExW(
                HKEY_LOCAL_MACHINE,
                subkey.as_ptr(),
                0,
                KEY_SET_VALUE | view_sam,
                &mut key,
            );
            if rc != ERROR_SUCCESS {
                return rc;
            }
            let rc = RegDeleteValueW(key, value.as_ptr());
            RegCloseKey(key);
            rc
        }
    }

    // ---- Helpers ---------------------------------------------------------------------------

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn describe(code: u32) -> String {
        let name = match code {
            0 => "ERROR_SUCCESS",
            2 => "ERROR_FILE_NOT_FOUND",
            5 => "ERROR_ACCESS_DENIED",
            1605 => "ERROR_UNKNOWN_PRODUCT",
            1608 => "ERROR_UNKNOWN_PROPERTY",
            _ => "",
        };
        format!("{code} {name} ({})", io::Error::from_raw_os_error(code as i32))
    }

    fn mask(key: &str) -> String {
        let prefix: String = key.chars().take(4).collect();
        format!("{prefix}... (len {})", key.chars().count())
    }

    fn data_dir() -> PathBuf {
        let base = std::env::var_os("ProgramData")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"));
        base.join("RustRMMSpike")
    }

    fn timestamp() -> String {
        let mut st = SYSTEMTIME {
            wYear: 0,
            wMonth: 0,
            wDayOfWeek: 0,
            wDay: 0,
            wHour: 0,
            wMinute: 0,
            wSecond: 0,
            wMilliseconds: 0,
        };
        // SAFETY: writes into the provided struct.
        unsafe { GetLocalTime(&mut st) };
        format!(
            "{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:03}",
            st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond, st.wMilliseconds
        )
    }

    fn log(msg: &str) {
        let line = format!("[{}] [pid {}] {msg}\r\n", timestamp(), std::process::id());
        if CONSOLE.load(Ordering::Relaxed) {
            eprint!("{line}");
        }
        let dir = data_dir();
        let _ = fs::create_dir_all(&dir);
        if let Ok(mut f) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("msi.log"))
        {
            let _ = f.write_all(line.as_bytes());
        }
    }
}
