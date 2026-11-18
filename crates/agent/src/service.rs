//! The agent's main loop and the Windows service wrapper.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use anyhow::{Context, Result};
use tokio_util::sync::CancellationToken;

use crate::config::AgentConfig;
use crate::connection::{self, Outcome};
use crate::paths::Paths;

/// Set when the process was started by the service manager (not `run --console`).
static AS_SERVICE: AtomicBool = AtomicBool::new(false);

/// Whether the agent runs as the system service. Remote desktop launches its helper as
/// LocalSystem into the user's session only then; in development it spawns it directly.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn running_as_service() -> bool {
    AS_SERVICE.load(Ordering::Relaxed)
}

/// Runs until `shutdown` is cancelled: enroll if needed, then connect with backoff forever.
pub async fn run_agent(paths: Paths, shutdown: CancellationToken) -> Result<()> {
    crate::util::harden_data_dir(&paths);
    crate::scripts::cleanup_stale(&paths);
    apply_install_time_policy(&paths);
    if running_as_service() {
        crate::install::ensure_sas_policy_once(&paths);
    }
    // The MSI starts the service ~0.5 s before it registers the product, so the install source
    // (and its sidecar deploy.key) appears shortly after start: retry quickly, then back off.
    let mut attempt: u32 = 0;
    let config = loop {
        if let Some(cfg) = AgentConfig::load(&paths)? {
            break cfg;
        }
        match crate::enroll::discover_deploy_key(&paths) {
            Some(key) => match crate::enroll::enroll(&paths, &key).await {
                Ok(cfg) => {
                    crate::enroll::forget_deploy_key(&paths);
                    break cfg;
                }
                Err(e) => {
                    tracing::error!(error = %format!("{e:#}"), "enrollment failed; will retry")
                }
            },
            None if attempt >= 8 => {
                tracing::warn!("agent is not enrolled and no deploy key was found; waiting")
            }
            None => {}
        }
        let delay = Duration::from_millis(250u64.saturating_mul(1 << attempt.min(7)))
            .min(Duration::from_secs(300));
        let delay = if attempt >= 8 {
            Duration::from_secs(300)
        } else {
            delay
        };
        attempt = attempt.saturating_add(1);
        tokio::select! {
            _ = shutdown.cancelled() => return Ok(()),
            _ = tokio::time::sleep(delay) => {}
        }
    };

    let key = crate::identity::load(&paths).context("loading device key")?;
    let noise_key = match crate::identity::load_or_create_noise(&paths) {
        Ok(k) => Some(k),
        Err(e) => {
            tracing::error!(error = %format!("{e:#}"), "end-to-end channel key unavailable; connecting over TLS only");
            None
        }
    };
    let tls = crate::tls::client_config(config.ca_cert_pem.as_deref())?;
    tracing::info!(device = %config.device_id, version = crate::AGENT_VERSION, "RustRMM agent started");
    // Checks run independently of the connection (and keep running while offline).
    let monitor = crate::checks::spawn(paths.clone(), config.device_id.clone(), shutdown.clone());
    // SNMP polling and the trap receiver (idle until the server makes this agent a probe).
    let snmp = crate::snmp::spawn(shutdown.clone());
    // BitLocker recovery keys are escrowed at start-up (de-duplicated by the local hashes).
    crate::escrow::spawn_collect(paths.clone(), config.escrow_recipient.clone());
    // End-user "Request support" from the user's session is relayed by the service.
    crate::support::spawn_service(&paths, &config, shutdown.clone());

    let mut failures: u32 = 0;
    let mut url_index = 0usize;
    loop {
        let base = &config.server_urls[url_index % config.server_urls.len()];
        let outcome = connection::session(
            &config,
            &paths,
            &key,
            noise_key.as_ref(),
            tls.clone(),
            base,
            &monitor,
            &snmp,
            &shutdown,
        )
        .await;
        let delay = match outcome {
            Ok(Outcome::Shutdown) => return Ok(()),
            Ok(Outcome::Retry(after)) => {
                failures = 0;
                after
            }
            Err(e) => {
                failures = failures.saturating_add(1);
                url_index += 1;
                tracing::warn!(error = %format!("{e:#}"), attempt = failures, "connection failed");
                backoff(failures)
            }
        };
        tokio::select! {
            _ = shutdown.cancelled() => return Ok(()),
            _ = tokio::time::sleep(delay) => {}
        }
    }
}

/// Copies a capability lock set at install time (MSI `DISABLE_FEATURES`) into the local policy.
fn apply_install_time_policy(paths: &Paths) {
    #[cfg(windows)]
    {
        use winreg::RegKey;
        use winreg::enums::HKEY_LOCAL_MACHINE;
        let value: Option<String> = RegKey::predef(HKEY_LOCAL_MACHINE)
            .open_subkey(r"SOFTWARE\RustRMM\Agent")
            .ok()
            .and_then(|k| k.get_value("DisableFeatures").ok());
        if let Some(value) = value {
            let mut policy = crate::config::LocalPolicy::load(paths);
            for feature in value
                .split(',')
                .map(|f| f.trim().to_lowercase())
                .filter(|f| !f.is_empty())
            {
                if !policy.disabled_features.contains(&feature) {
                    policy.disabled_features.push(feature);
                }
            }
            if let Err(e) = policy.save(paths) {
                tracing::warn!(error = %format!("{e:#}"), "could not save local policy");
            }
        }
    }
    #[cfg(not(windows))]
    let _ = paths;
}

/// Exponential backoff with ±25 % jitter: 2 s, 4 s, … capped at 5 minutes.
fn backoff(failures: u32) -> Duration {
    let base = 2u64.saturating_pow(failures.min(9)).min(300);
    let jitter = (rustrmm_crypto::random::bytes::<1>()[0] as f64 / 255.0 - 0.5) * 0.5;
    Duration::from_secs_f64((base as f64 * (1.0 + jitter)).max(1.0))
}

#[cfg(windows)]
mod win {
    use std::ffi::OsString;
    use std::sync::OnceLock;
    use std::time::Duration;

    use tokio_util::sync::CancellationToken;
    use windows_service::service::{
        ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus,
        ServiceType,
    };
    use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
    use windows_service::{define_windows_service, service_dispatcher};

    use crate::paths::{Paths, SERVICE_NAME};

    static PATHS: OnceLock<Paths> = OnceLock::new();

    define_windows_service!(ffi_service_main, service_main);

    pub fn start(paths: Paths) -> anyhow::Result<()> {
        let _ = PATHS.set(paths);
        service_dispatcher::start(SERVICE_NAME, ffi_service_main)?;
        Ok(())
    }

    fn service_main(_args: Vec<OsString>) {
        let paths = PATHS.get().cloned().unwrap_or_else(|| Paths::resolve(None));
        crate::util::init_logging(&paths, false);
        if let Err(e) = run(paths) {
            tracing::error!(error = %format!("{e:#}"), "service failed");
        }
    }

    fn run(paths: Paths) -> anyhow::Result<()> {
        let token = CancellationToken::new();
        let handler_token = token.clone();
        let status =
            service_control_handler::register(SERVICE_NAME, move |control| match control {
                ServiceControl::Stop | ServiceControl::Shutdown | ServiceControl::Preshutdown => {
                    handler_token.cancel();
                    ServiceControlHandlerResult::NoError
                }
                ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
                _ => ServiceControlHandlerResult::NotImplemented,
            })?;
        let set = |state: ServiceState, accept: ServiceControlAccept| {
            status.set_service_status(ServiceStatus {
                service_type: ServiceType::OWN_PROCESS,
                current_state: state,
                controls_accepted: accept,
                exit_code: ServiceExitCode::Win32(0),
                checkpoint: 0,
                wait_hint: Duration::from_secs(10),
                process_id: None,
            })
        };
        set(
            ServiceState::Running,
            ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN,
        )?;
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()?;
        let result = rt.block_on(super::run_agent(paths, token));
        set(ServiceState::Stopped, ServiceControlAccept::empty())?;
        result
    }
}

/// `rustrmm-agent service` — entry point for the platform service manager.
pub fn run_as_service(paths: Paths) -> Result<()> {
    AS_SERVICE.store(true, Ordering::Relaxed);
    #[cfg(windows)]
    {
        win::start(paths)
    }
    #[cfg(not(windows))]
    {
        // systemd / launchd simply run the binary in the foreground.
        crate::util::init_logging(&paths, false);
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()?;
        rt.block_on(async {
            let token = CancellationToken::new();
            let stop = token.clone();
            tokio::spawn(async move {
                #[cfg(unix)]
                {
                    let mut term =
                        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                            .expect("signal handler");
                    tokio::select! {
                        _ = term.recv() => {},
                        _ = tokio::signal::ctrl_c() => {},
                    }
                }
                stop.cancel();
            });
            run_agent(paths, token).await
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_grows_and_caps() {
        assert!(backoff(1) <= Duration::from_secs(3));
        assert!(backoff(20) <= Duration::from_secs(375));
        assert!(backoff(20) >= Duration::from_secs(225));
    }
}
