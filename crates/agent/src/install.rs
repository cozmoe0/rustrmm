//! Installing and removing the agent as a system service.

use std::time::Duration;

use anyhow::{Context, Result, bail};

use crate::config::LocalPolicy;
use crate::paths::Paths;

pub async fn install(paths: &Paths, key: &str, disable_features: &str) -> Result<()> {
    if paths.custom {
        bail!(
            "install uses the system locations; omit --data-dir (use `enroll` + `run --console` for development)"
        );
    }
    if !crate::util::is_elevated() {
        bail!("installation requires administrator (Windows) or root (Linux/macOS) rights");
    }
    std::fs::create_dir_all(&paths.install_dir)
        .with_context(|| format!("creating {}", paths.install_dir.display()))?;
    std::fs::create_dir_all(&paths.data_dir)?;
    crate::util::harden_data_dir(paths);

    // Copy this binary into place unless we are already running from there.
    let current = std::env::current_exe()?;
    let target = paths.installed_binary();
    if current.canonicalize().ok() != target.canonicalize().ok() {
        stop_service();
        std::fs::copy(&current, &target)
            .with_context(|| format!("copying agent to {}", target.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755))?;
        }
    }

    let policy = LocalPolicy {
        disabled_features: disable_features
            .split(',')
            .map(|s| s.trim().to_lowercase())
            .filter(|s| !s.is_empty())
            .collect(),
    };
    policy.save(paths)?;

    crate::enroll::enroll(paths, key).await?;
    set_sas_policy(paths);
    register_service(paths)?;
    println!("RustRMM agent installed and running.");
    Ok(())
}

pub fn uninstall(paths: &Paths, keep_data: bool) -> Result<()> {
    if !crate::util::is_elevated() {
        bail!("uninstall requires administrator (Windows) or root (Linux/macOS) rights");
    }
    stop_service();
    unregister_service()?;
    if !keep_data && !paths.custom {
        let _ = std::fs::remove_dir_all(&paths.data_dir);
        let _ = std::fs::remove_dir_all(&paths.log_dir);
    }
    // The running binary cannot delete itself on Windows; schedule cleanup instead.
    #[cfg(windows)]
    {
        let dir = paths.install_dir.to_string_lossy().to_string();
        let _ = std::process::Command::new("cmd")
            .args([
                "/C",
                &format!("ping 127.0.0.1 -n 3 > nul & rmdir /S /Q \"{dir}\""),
            ])
            .spawn();
    }
    #[cfg(not(windows))]
    {
        let _ = std::fs::remove_dir_all(&paths.install_dir);
    }
    println!("RustRMM agent removed.");
    Ok(())
}

// ------------------------------------------------------------------ Ctrl+Alt+Del policy

/// Marker so the policy is applied once per installation; an administrator who later removes
/// it keeps it removed. Uninstall leaves the policy alone.
const SAS_MARKER: &str = "sas-policy-applied";

/// Lets services send Ctrl+Alt+Del (`SendSAS`) for remote desktop:
/// `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System\SoftwareSASGeneration`
/// = 3 (services and ease-of-access applications). An existing value that already allows
/// services (1 or 3) is kept.
#[cfg(windows)]
pub fn set_sas_policy(paths: &Paths) {
    use winreg::RegKey;
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WRITE};
    let result = RegKey::predef(HKEY_LOCAL_MACHINE)
        .create_subkey_with_flags(
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System",
            KEY_READ | KEY_WRITE,
        )
        .and_then(|(key, _)| {
            let current: Option<u32> = key.get_value("SoftwareSASGeneration").ok();
            if matches!(current, Some(1) | Some(3)) {
                Ok(())
            } else {
                key.set_value("SoftwareSASGeneration", &3u32)
            }
        });
    match result {
        Ok(()) => {
            let _ = std::fs::write(paths.data_dir.join(SAS_MARKER), b"3");
        }
        Err(e) => tracing::warn!(error = %e, "could not set the SoftwareSASGeneration policy"),
    }
}

#[cfg(not(windows))]
pub fn set_sas_policy(_paths: &Paths) {}

/// MSI installs never run `install`: the service applies the policy on its first start.
pub fn ensure_sas_policy_once(paths: &Paths) {
    if !paths.custom && !paths.data_dir.join(SAS_MARKER).exists() {
        set_sas_policy(paths);
    }
}

// ------------------------------------------------------------------ Windows

#[cfg(windows)]
fn register_service(paths: &Paths) -> Result<()> {
    use std::ffi::OsString;
    use windows_service::service::{
        ServiceAccess, ServiceAction, ServiceActionType, ServiceErrorControl,
        ServiceFailureActions, ServiceFailureResetPeriod, ServiceInfo, ServiceStartType,
        ServiceType,
    };
    use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};

    use crate::paths::{SERVICE_DISPLAY_NAME, SERVICE_NAME};

    let manager = ServiceManager::local_computer(
        None::<&str>,
        ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE,
    )?;
    let access = ServiceAccess::QUERY_STATUS
        | ServiceAccess::START
        | ServiceAccess::STOP
        | ServiceAccess::CHANGE_CONFIG
        | ServiceAccess::DELETE;
    let service = match manager.open_service(SERVICE_NAME, access) {
        Ok(existing) => existing,
        Err(_) => manager.create_service(
            &ServiceInfo {
                name: OsString::from(SERVICE_NAME),
                display_name: OsString::from(SERVICE_DISPLAY_NAME),
                service_type: ServiceType::OWN_PROCESS,
                start_type: ServiceStartType::AutoStart,
                error_control: ServiceErrorControl::Normal,
                // windows-service quotes the path, avoiding the unquoted-service-path weakness.
                executable_path: paths.installed_binary(),
                launch_arguments: vec![OsString::from("service")],
                dependencies: vec![],
                account_name: None, // LocalSystem
                account_password: None,
            },
            access,
        )?,
    };
    service.set_description("RustRMM remote monitoring and management agent")?;
    service.update_failure_actions(ServiceFailureActions {
        reset_period: ServiceFailureResetPeriod::After(Duration::from_secs(86_400)),
        reboot_msg: None,
        command: None,
        actions: Some(vec![
            ServiceAction {
                action_type: ServiceActionType::Restart,
                delay: Duration::from_secs(10),
            },
            ServiceAction {
                action_type: ServiceActionType::Restart,
                delay: Duration::from_secs(30),
            },
            ServiceAction {
                action_type: ServiceActionType::Restart,
                delay: Duration::from_secs(120),
            },
        ]),
    })?;
    service.start::<&str>(&[])?;
    Ok(())
}

#[cfg(windows)]
fn stop_service() {
    let _ = crate::util::run(
        "sc.exe",
        &["stop", crate::paths::SERVICE_NAME],
        Duration::from_secs(30),
    );
    std::thread::sleep(Duration::from_secs(2));
}

#[cfg(windows)]
fn unregister_service() -> Result<()> {
    use windows_service::service::ServiceAccess;
    use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};
    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)?;
    if let Ok(service) = manager.open_service(crate::paths::SERVICE_NAME, ServiceAccess::DELETE) {
        service.delete()?;
    }
    Ok(())
}

#[cfg(windows)]
pub fn service_state() -> String {
    crate::util::run_any(
        "sc.exe",
        &["query", crate::paths::SERVICE_NAME],
        Duration::from_secs(10),
    )
    .and_then(|out| {
        out.lines()
            .find(|l| l.contains("STATE"))
            .map(|l| l.split_whitespace().last().unwrap_or("unknown").to_string())
    })
    .unwrap_or_else(|| "not installed".into())
}

// ------------------------------------------------------------------ Linux

#[cfg(all(unix, not(target_os = "macos")))]
fn register_service(paths: &Paths) -> Result<()> {
    let binary = paths.installed_binary();
    if std::path::Path::new("/run/systemd/system").exists() {
        let unit = format!(
            "[Unit]\nDescription=RustRMM agent\nAfter=network-online.target\nWants=network-online.target\n\n\
             [Service]\nType=simple\nExecStart={bin} service\nRestart=always\nRestartSec=10\nUser=root\n\
             NoNewPrivileges=false\nLimitNOFILE=65536\n\n[Install]\nWantedBy=multi-user.target\n",
            bin = binary.display()
        );
        std::fs::write(
            format!("/etc/systemd/system/{}", crate::paths::SYSTEMD_UNIT),
            unit,
        )?;
        crate::util::run("systemctl", &["daemon-reload"], Duration::from_secs(30));
        crate::util::run(
            "systemctl",
            &["enable", "--now", crate::paths::SYSTEMD_UNIT],
            Duration::from_secs(60),
        )
        .context("systemctl enable failed")?;
    } else if std::path::Path::new("/sbin/openrc-run").exists() {
        let script = format!(
            "#!/sbin/openrc-run\nname=\"RustRMM agent\"\ncommand=\"{bin}\"\ncommand_args=\"service\"\ncommand_background=true\n\
             pidfile=\"/run/rustrmm-agent.pid\"\ndepend() {{ need net; }}\n",
            bin = binary.display()
        );
        std::fs::write("/etc/init.d/rustrmm-agent", script)?;
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            "/etc/init.d/rustrmm-agent",
            std::fs::Permissions::from_mode(0o755),
        )?;
        crate::util::run(
            "rc-update",
            &["add", "rustrmm-agent", "default"],
            Duration::from_secs(30),
        );
        crate::util::run(
            "rc-service",
            &["rustrmm-agent", "start"],
            Duration::from_secs(30),
        )
        .context("rc-service start failed")?;
    } else {
        bail!("no supported init system found (systemd or OpenRC)");
    }
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn stop_service() {
    let _ = crate::util::run(
        "systemctl",
        &["stop", crate::paths::SYSTEMD_UNIT],
        Duration::from_secs(30),
    );
    let _ = crate::util::run(
        "rc-service",
        &["rustrmm-agent", "stop"],
        Duration::from_secs(30),
    );
}

#[cfg(all(unix, not(target_os = "macos")))]
fn unregister_service() -> Result<()> {
    let _ = crate::util::run(
        "systemctl",
        &["disable", crate::paths::SYSTEMD_UNIT],
        Duration::from_secs(30),
    );
    let _ = std::fs::remove_file(format!(
        "/etc/systemd/system/{}",
        crate::paths::SYSTEMD_UNIT
    ));
    let _ = crate::util::run("systemctl", &["daemon-reload"], Duration::from_secs(30));
    let _ = crate::util::run(
        "rc-update",
        &["del", "rustrmm-agent", "default"],
        Duration::from_secs(30),
    );
    let _ = std::fs::remove_file("/etc/init.d/rustrmm-agent");
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
pub fn service_state() -> String {
    crate::util::run_any(
        "systemctl",
        &["is-active", crate::paths::SYSTEMD_UNIT],
        Duration::from_secs(10),
    )
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty())
    .unwrap_or_else(|| "unknown".into())
}

// ------------------------------------------------------------------ macOS

#[cfg(target_os = "macos")]
fn plist_path() -> String {
    format!(
        "/Library/LaunchDaemons/{}.plist",
        crate::paths::LAUNCHD_LABEL
    )
}

#[cfg(target_os = "macos")]
fn register_service(paths: &Paths) -> Result<()> {
    let plist = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>{label}</string>
  <key>ProgramArguments</key><array><string>{bin}</string><string>service</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardErrorPath</key><string>/Library/Logs/RustRMM/agent.stderr.log</string>
</dict></plist>
"#,
        label = crate::paths::LAUNCHD_LABEL,
        bin = paths.installed_binary().display()
    );
    std::fs::create_dir_all("/Library/Logs/RustRMM")?;
    std::fs::write(plist_path(), plist)?;
    let _ = crate::util::run(
        "launchctl",
        &["bootout", "system", &plist_path()],
        Duration::from_secs(30),
    );
    crate::util::run(
        "launchctl",
        &["bootstrap", "system", &plist_path()],
        Duration::from_secs(30),
    )
    .context("launchctl bootstrap failed")?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn stop_service() {
    let _ = crate::util::run(
        "launchctl",
        &["bootout", "system", &plist_path()],
        Duration::from_secs(30),
    );
}

#[cfg(target_os = "macos")]
fn unregister_service() -> Result<()> {
    let _ = std::fs::remove_file(plist_path());
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn service_state() -> String {
    crate::util::run_any(
        "launchctl",
        &["print", &format!("system/{}", crate::paths::LAUNCHD_LABEL)],
        Duration::from_secs(10),
    )
    .and_then(|out| {
        out.lines()
            .find(|l| l.trim_start().starts_with("state ="))
            .map(|l| l.trim().to_string())
    })
    .unwrap_or_else(|| "not loaded".into())
}
