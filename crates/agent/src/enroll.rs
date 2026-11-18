//! Enrollment: deploy key → device key → `POST /agent/v1/enroll` → stored configuration.

use anyhow::{Context, Result, bail};
use rustrmm_proto::deploy::{DeployKey, EnrollRequest, EnrollResponse};

use crate::config::AgentConfig;
use crate::paths::Paths;

pub async fn enroll(paths: &Paths, key_text: &str) -> Result<AgentConfig> {
    let deploy = DeployKey::parse(key_text).context("the deploy key is not valid")?;
    if let Some(existing) = AgentConfig::load(paths)? {
        tracing::warn!(device = %existing.device_id, "agent is already enrolled; enrolling again replaces the existing identity");
    }
    std::fs::create_dir_all(&paths.data_dir)?;
    crate::util::harden_data_dir(paths);

    let device_key = crate::identity::create(paths)?;
    // The end-to-end channel key is registered on the first connection (signed by the device
    // key); a new enrollment also means a new server, so any old pin goes.
    crate::identity::create_noise(paths)?;
    let _ = std::fs::remove_file(paths.noise_pin_file());
    let facts = crate::collectors::enrollment_facts();
    let request = EnrollRequest {
        secret: deploy.secret.clone(),
        public_key: device_key.public_key().to_string(),
        hostname: facts.hostname,
        os_family: crate::collectors::os_family().to_string(),
        os_name: facts.os_name,
        os_version: facts.os_version,
        arch: std::env::consts::ARCH.to_string(),
        hardware_uuid: facts.hardware_uuid,
        serial: facts.serial,
        domain: facts.domain,
        agent_version: crate::AGENT_VERSION.to_string(),
    };

    let client = crate::tls::http_client(crate::tls::enrollment_config(deploy.ca_pin.as_deref())?)?;
    let mut last_error = None;
    for base in &deploy.urls {
        let url = format!("{}/agent/v1/enroll", base.trim_end_matches('/'));
        tracing::info!(%url, "enrolling");
        match client.post(&url).json(&request).send().await {
            Ok(resp) if resp.status().is_success() => {
                let body: EnrollResponse =
                    resp.json().await.context("invalid enrollment response")?;
                if body.identity != deploy.identity {
                    bail!(
                        "the server's identity key does not match the deploy key — refusing to enroll"
                    );
                }
                let config = AgentConfig {
                    device_id: body.device_id.clone(),
                    server_urls: deploy.urls.clone(),
                    identity_key: body.identity,
                    command_key: body.command_key,
                    release_key: body.release_key,
                    escrow_recipient: body.escrow_recipient,
                    ca_cert_pem: if deploy.ca_pin.is_some() {
                        body.ca_cert_pem
                    } else {
                        None
                    },
                    client_name: body.client_name,
                    site_name: body.site_name,
                    enrolled_at: chrono::Utc::now(),
                };
                if let Some(pem) = &config.ca_cert_pem {
                    let pin = rustrmm_crypto::pki::inspect_cert(pem)?.spki_sha256;
                    if Some(pin.as_str()) != deploy.ca_pin.as_deref() {
                        bail!(
                            "the CA certificate returned by the server does not match the deploy key pin"
                        );
                    }
                }
                config.save(paths)?;
                let status = if body.status == "pending" {
                    " (waiting for administrator approval)"
                } else {
                    ""
                };
                println!(
                    "Enrolled as {} in {} / {}{status}",
                    config.device_id, config.client_name, config.site_name
                );
                return Ok(config);
            }
            Ok(resp) => {
                let status = resp.status();
                let text = resp.text().await.unwrap_or_default();
                let message = serde_json::from_str::<serde_json::Value>(&text)
                    .ok()
                    .and_then(|v| {
                        v.pointer("/error/message")
                            .and_then(|m| m.as_str())
                            .map(str::to_string)
                    })
                    .unwrap_or(text);
                last_error = Some(anyhow::anyhow!("enrollment rejected ({status}): {message}"));
            }
            Err(e) => last_error = Some(anyhow::anyhow!("cannot reach {url}: {e}")),
        }
    }
    let _ = std::fs::remove_file(paths.key_file());
    Err(last_error.unwrap_or_else(|| anyhow::anyhow!("no gateway URL in deploy key")))
}

/// Finds a deploy key provided out-of-band (MSI property, sidecar file, or a key file).
pub fn discover_deploy_key(paths: &Paths) -> Option<String> {
    let file = paths.data_dir.join("deploy.key");
    if let Ok(text) = std::fs::read_to_string(&file) {
        let text = text.trim().to_string();
        if !text.is_empty() {
            return Some(text);
        }
    }
    #[cfg(windows)]
    {
        if let Some(key) = windows_registry_deploy_key() {
            return Some(key);
        }
        if let Some(key) = crate::collectors::windows::msi_sidecar_deploy_key() {
            return Some(key);
        }
    }
    None
}

#[cfg(windows)]
fn windows_registry_deploy_key() -> Option<String> {
    use winreg::RegKey;
    use winreg::enums::HKEY_LOCAL_MACHINE;
    let key = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey(r"SOFTWARE\RustRMM\Agent")
        .ok()?;
    let value: String = key.get_value("DeployKey").ok()?;
    let value = value.trim().to_string();
    (!value.is_empty()).then_some(value)
}

/// Removes out-of-band deploy key copies after a successful enrollment.
pub fn forget_deploy_key(paths: &Paths) {
    let _ = std::fs::remove_file(paths.data_dir.join("deploy.key"));
    #[cfg(windows)]
    {
        use winreg::RegKey;
        use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_SET_VALUE};
        if let Ok(key) = RegKey::predef(HKEY_LOCAL_MACHINE)
            .open_subkey_with_flags(r"SOFTWARE\RustRMM\Agent", KEY_SET_VALUE)
        {
            let _ = key.delete_value("DeployKey");
        }
    }
}
