//! Services / daemons: list and start/stop/restart.

use std::time::{Duration, Instant};

use anyhow::{Result, bail};
use rustrmm_proto::remote::{ServiceAction, valid_service_name};
use serde_json::{Value, json};

pub fn list() -> Result<Value> {
    crate::collectors::collect(rustrmm_proto::messages::sections::SERVICES)
}

pub fn control(name: &str, action: ServiceAction) -> Result<Value> {
    if !valid_service_name(name) {
        bail!("invalid service name");
    }
    if is_self(name) && action != ServiceAction::Start {
        bail!("the RustRMM agent cannot stop its own service; use an agent update or uninstall");
    }
    let state = platform::control(name, action)?;
    Ok(json!({ "name": name, "action": action, "state": state }))
}

/// Current state of a service (`running`, `stopped`, …), or `None` when it does not exist.
pub fn state(name: &str) -> Result<Option<String>> {
    if !valid_service_name(name) {
        bail!("invalid service name");
    }
    platform::state(name)
}

fn is_self(name: &str) -> bool {
    let name = name.trim_end_matches(".service");
    name.eq_ignore_ascii_case(crate::paths::SERVICE_NAME)
        || name.eq_ignore_ascii_case("rustrmm-agent")
        || name.eq_ignore_ascii_case("com.rustrmm.agent")
}

/// Polls `check` until it returns true or the timeout passes.
#[allow(dead_code)]
fn wait_until(timeout: Duration, mut check: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if check() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    false
}

#[cfg(windows)]
mod platform {
    use std::ffi::OsStr;
    use std::time::Duration;

    use anyhow::{Context, Result, bail};
    use rustrmm_proto::remote::ServiceAction;
    use windows_service::service::{ServiceAccess, ServiceState};
    use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};

    fn label(state: ServiceState) -> &'static str {
        match state {
            ServiceState::Stopped => "stopped",
            ServiceState::StartPending => "start pending",
            ServiceState::StopPending => "stop pending",
            ServiceState::Running => "running",
            ServiceState::ContinuePending => "continue pending",
            ServiceState::PausePending => "pause pending",
            ServiceState::Paused => "paused",
        }
    }

    pub fn state(name: &str) -> Result<Option<String>> {
        let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
            .context("cannot open the service control manager")?;
        match manager.open_service(name, ServiceAccess::QUERY_STATUS) {
            Ok(service) => Ok(Some(
                label(service.query_status()?.current_state).to_string(),
            )),
            // ERROR_SERVICE_DOES_NOT_EXIST
            Err(windows_service::Error::Winapi(e)) if e.raw_os_error() == Some(1060) => Ok(None),
            Err(e) => Err(e).with_context(|| format!("cannot open service {name}")),
        }
    }

    pub fn control(name: &str, action: ServiceAction) -> Result<String> {
        let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
            .context("cannot open the service control manager")?;
        let service = manager
            .open_service(
                name,
                ServiceAccess::QUERY_STATUS | ServiceAccess::START | ServiceAccess::STOP,
            )
            .with_context(|| format!("cannot open service {name}"))?;
        let state = || service.query_status().map(|s| s.current_state);
        if matches!(action, ServiceAction::Stop | ServiceAction::Restart)
            && state()? != ServiceState::Stopped
        {
            service.stop().context("stop failed")?;
            if !super::wait_until(Duration::from_secs(30), || {
                state().is_ok_and(|s| s == ServiceState::Stopped)
            }) {
                bail!("service did not stop within 30 seconds");
            }
        }
        if matches!(action, ServiceAction::Start | ServiceAction::Restart)
            && state()? != ServiceState::Running
        {
            service.start::<&OsStr>(&[]).context("start failed")?;
            super::wait_until(Duration::from_secs(30), || {
                state().is_ok_and(|s| s == ServiceState::Running)
            });
        }
        Ok(label(state()?).to_string())
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use std::time::Duration;

    use anyhow::{Result, bail};
    use rustrmm_proto::remote::ServiceAction;

    pub fn state(name: &str) -> Result<Option<String>> {
        let out = crate::util::run_capture(
            &crate::util::system_tool("systemctl"),
            &["show", "--property=LoadState,ActiveState", "--", name],
            Duration::from_secs(15),
        )?;
        let mut load = "";
        let mut active = "";
        for line in out.stdout.lines() {
            if let Some(v) = line.strip_prefix("LoadState=") {
                load = v.trim();
            } else if let Some(v) = line.strip_prefix("ActiveState=") {
                active = v.trim();
            }
        }
        if load.is_empty() && out.code != Some(0) {
            bail!("systemctl failed: {}", out.stderr.trim());
        }
        Ok(match (load, active) {
            ("not-found", _) => None,
            (_, "active" | "reloading") => Some("running".into()),
            (_, "inactive" | "") => Some("stopped".into()),
            (_, other) => Some(other.to_string()),
        })
    }

    pub fn control(name: &str, action: ServiceAction) -> Result<String> {
        let verb = match action {
            ServiceAction::Start => "start",
            ServiceAction::Stop => "stop",
            ServiceAction::Restart => "restart",
        };
        let systemctl = crate::util::system_tool("systemctl");
        let out =
            crate::util::run_capture(&systemctl, &[verb, "--", name], Duration::from_secs(60))?;
        if out.code != Some(0) {
            bail!("systemctl {verb} failed: {}", out.stderr.trim());
        }
        let state = crate::util::run_capture(
            &systemctl,
            &["show", "--property=SubState", "--value", "--", name],
            Duration::from_secs(10),
        )?;
        Ok(state.stdout.trim().to_string())
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::time::Duration;

    use anyhow::{Result, bail};
    use rustrmm_proto::remote::ServiceAction;

    pub fn state(name: &str) -> Result<Option<String>> {
        let target = format!("system/{name}");
        let out = crate::util::run_capture(
            &crate::util::system_tool("launchctl"),
            &["print", target.as_str()],
            Duration::from_secs(15),
        )?;
        if out.code != Some(0) {
            return Ok(None);
        }
        let running = out
            .stdout
            .lines()
            .any(|l| l.trim().replace(' ', "") == "state=running");
        Ok(Some(
            if running { "running" } else { "stopped" }.to_string(),
        ))
    }

    pub fn control(name: &str, action: ServiceAction) -> Result<String> {
        let target = format!("system/{name}");
        let args: Vec<&str> = match action {
            ServiceAction::Start => vec!["kickstart", &target],
            ServiceAction::Restart => vec!["kickstart", "-k", &target],
            ServiceAction::Stop => vec!["kill", "SIGTERM", &target],
        };
        let out = crate::util::run_capture(
            &crate::util::system_tool("launchctl"),
            &args,
            Duration::from_secs(60),
        )?;
        if out.code != Some(0) {
            bail!("launchctl failed: {}", out.stderr.trim());
        }
        Ok(match action {
            ServiceAction::Stop => "stopped".into(),
            _ => "running".into(),
        })
    }
}
