//! `rustrmm-sim` — a fleet of simulated agents for UI development and load testing.
//!
//! ```text
//! rustrmm-sim --key rrmm1_… --devices 50
//! ```
//! Identities persist in `--state` so restarting reuses the same enrolled devices. About 10 % of
//! devices stay offline, a few run hot or have security problems, so dashboards look realistic.

mod profile;
mod tls;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use clap::Parser;
use futures::{SinkExt, StreamExt};
use rustrmm_crypto::sign::{KeyAlgorithm, PublicKey, SigningKey};
use rustrmm_proto::deploy::{DeployKey, EnrollRequest, EnrollResponse};
use rustrmm_proto::handshake::{self, Challenge, Hello, Proof, Rejected, Welcome};
use rustrmm_proto::messages::{
    InventoryAck, InventorySection, LiveMode, MetricSample, Metrics, RequestInventory,
};
use rustrmm_proto::noise::tungstenite::NoiseSocket;
use rustrmm_proto::noise::{self, NoiseAccept, StaticKeypair};
use rustrmm_proto::{Frame, Message as _};
use serde::{Deserialize, Serialize};
use tokio_tungstenite::tungstenite::Message as WsMessage;

use profile::Profile;

#[derive(Parser)]
#[command(name = "rustrmm-sim", about = "Simulated RustRMM fleet")]
struct Cli {
    /// Deploy key from the console.
    #[arg(long, env = "RUSTRMM_SIM_KEY")]
    key: String,
    /// Number of devices.
    #[arg(long, default_value_t = 50)]
    devices: usize,
    /// Where simulated identities are stored.
    #[arg(long, default_value = "./sim-state")]
    state: PathBuf,
    /// Fraction of devices that stay offline.
    #[arg(long, default_value_t = 0.1)]
    offline: f64,
    /// Seconds between metrics samples.
    #[arg(long, default_value_t = 60)]
    metrics_secs: u64,
    /// Connect over TLS only, without the Noise IK end-to-end channel (like agents older than
    /// Phase 11; refused by servers in `proxy` TLS mode).
    #[arg(long)]
    no_noise: bool,
}

#[derive(Serialize, Deserialize, Clone)]
struct SimDevice {
    index: usize,
    device_id: String,
    secret_key: String,
    ca_cert_pem: Option<String>,
    identity_key: String,
    /// Noise static key (base64 secret); created on first use for identities from older runs.
    #[serde(default)]
    noise_secret: Option<String>,
    /// The server's Noise key, pinned after the first end-to-end handshake.
    #[serde(default)]
    server_noise: Option<String>,
}

#[tokio::main]
async fn main() -> Result<()> {
    rustrmm_common::logging::init(rustrmm_common::logging::LogFormat::Pretty, "info");
    let cli = Cli::parse();
    let deploy = DeployKey::parse(&cli.key).context("invalid deploy key")?;
    std::fs::create_dir_all(&cli.state)?;
    let base_url = deploy.urls[0].trim_end_matches('/').to_string();
    let enroll_client = tls::http_client(tls::enrollment_config(deploy.ca_pin.as_deref())?)?;

    let mut handles = Vec::new();
    for index in 0..cli.devices {
        let profile = Profile::generate(index);
        let mut attempt = 0u32;
        let device = loop {
            match load_or_enroll(&cli, &deploy, &enroll_client, &base_url, index, &profile).await {
                Ok(d) => break Some(d),
                Err(e) if attempt < 5 => {
                    attempt += 1;
                    tracing::warn!(index, error = %format!("{e:#}"), "enrollment failed; retrying");
                    tokio::time::sleep(Duration::from_secs(5 * u64::from(attempt))).await;
                }
                Err(e) => {
                    tracing::error!(index, error = %format!("{e:#}"), "enrollment failed");
                    break None;
                }
            }
        };
        let Some(device) = device else { continue };
        let offline = (index as f64 / cli.devices as f64) >= 1.0 - cli.offline;
        if offline {
            tracing::info!(host = %profile.hostname, "simulated device stays offline");
            continue;
        }
        let base = base_url.clone();
        let metrics_secs = cli.metrics_secs;
        let use_noise = !cli.no_noise;
        let path = cli.state.join(format!("device-{index:04}.json"));
        handles.push(tokio::spawn(async move {
            let mut device = device;
            let mut failures = 0u32;
            loop {
                match run_device(&mut device, &path, &profile, &base, metrics_secs, use_noise).await {
                    Ok(()) => failures = 0,
                    Err(e) => {
                        failures += 1;
                        tracing::warn!(host = %profile.hostname, error = %format!("{e:#}"), "session ended");
                    }
                }
                tokio::time::sleep(Duration::from_secs(2u64.pow(failures.min(6)) + (index % 7) as u64)).await;
            }
        }));
        // Stagger connections so the gateway sees a realistic ramp.
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
    tracing::info!(
        connected = handles.len(),
        "simulated fleet running (Ctrl+C to stop)"
    );
    tokio::signal::ctrl_c().await?;
    Ok(())
}

async fn load_or_enroll(
    cli: &Cli,
    deploy: &DeployKey,
    client: &reqwest::Client,
    base_url: &str,
    index: usize,
    profile: &Profile,
) -> Result<SimDevice> {
    let path = cli.state.join(format!("device-{index:04}.json"));
    if let Ok(text) = std::fs::read_to_string(&path)
        && let Ok(device) = serde_json::from_str::<SimDevice>(&text)
    {
        return Ok(device);
    }
    let key = SigningKey::generate();
    let request = EnrollRequest {
        secret: deploy.secret.clone(),
        public_key: key.public_key().to_string(),
        hostname: profile.hostname.clone(),
        os_family: profile.os_family.to_string(),
        os_name: profile.os_name.clone(),
        os_version: profile.os_version.clone(),
        arch: profile.arch.to_string(),
        hardware_uuid: Some(profile.uuid.clone()),
        serial: Some(profile.serial.clone()),
        domain: profile.domain.clone(),
        agent_version: env!("CARGO_PKG_VERSION").to_string(),
    };
    let resp = client
        .post(format!("{base_url}/agent/v1/enroll"))
        .json(&request)
        .send()
        .await?;
    if !resp.status().is_success() {
        anyhow::bail!(
            "enroll rejected: {} {}",
            resp.status(),
            resp.text().await.unwrap_or_default()
        );
    }
    let body: EnrollResponse = resp.json().await?;
    use base64::Engine as _;
    let device = SimDevice {
        index,
        device_id: body.device_id,
        secret_key: base64::engine::general_purpose::STANDARD.encode(key.secret_bytes().as_slice()),
        ca_cert_pem: body.ca_cert_pem,
        identity_key: body.identity,
        noise_secret: None,
        server_noise: None,
    };
    std::fs::write(&path, serde_json::to_vec_pretty(&device)?)?;
    tracing::info!(host = %profile.hostname, id = %device.device_id, "enrolled simulated device");
    Ok(device)
}

async fn run_device(
    device: &mut SimDevice,
    path: &std::path::Path,
    profile: &Profile,
    base_url: &str,
    metrics_secs: u64,
    use_noise: bool,
) -> Result<()> {
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD;
    let secret = b64.decode(&device.secret_key)?;
    let key = SigningKey::from_secret_bytes(KeyAlgorithm::Ed25519, &secret)?;
    let noise_key = if use_noise {
        let key = match device.noise_secret.as_deref().map(|s| b64.decode(s)) {
            Some(Ok(bytes)) => StaticKeypair::from_secret(&bytes)?,
            _ => {
                let key = StaticKeypair::generate();
                device.noise_secret = Some(b64.encode(key.secret_bytes()));
                std::fs::write(path, serde_json::to_vec_pretty(&*device)?)?;
                key
            }
        };
        Some(key)
    } else {
        None
    };
    let pinned = device
        .server_noise
        .as_deref()
        .map(noise::decode_key)
        .transpose()?;
    let tls: Arc<rustls::ClientConfig> = tls::client_config(device.ca_cert_pem.as_deref())?;
    let mut url = url::Url::parse(base_url)?;
    url.set_scheme("wss")
        .map_err(|_| anyhow::anyhow!("bad scheme"))?;
    url.set_path("/agent/v1/connect");
    let (mut ws, _) = tokio_tungstenite::connect_async_tls_with_config(
        url.as_str(),
        None,
        true,
        Some(tokio_tungstenite::Connector::Rustls(tls)),
    )
    .await?;

    let agent_nonce = rustrmm_crypto::random::bytes::<32>().to_vec();
    let mut capabilities: Vec<String> = vec!["inventory".into(), "metrics".into(), "live".into()];
    if noise_key.is_some() {
        capabilities.push(noise::CAPABILITY.into());
    }
    let hello = Hello {
        device_id: device.device_id.clone(),
        agent_nonce: agent_nonce.clone(),
        protocol_major: rustrmm_proto::PROTOCOL_MAJOR,
        protocol_minor: rustrmm_proto::PROTOCOL_MINOR,
        agent_version: env!("CARGO_PKG_VERSION").to_string(),
        os_family: profile.os_family.to_string(),
        hostname: profile.hostname.clone(),
        capabilities,
    };
    ws.send(WsMessage::Binary(rustrmm_proto::encode(&hello)?.into()))
        .await?;
    let frame = next_frame(&mut ws).await?;
    if frame.is::<Rejected>() {
        let r: Rejected = frame.body()?;
        anyhow::bail!("rejected: {} ({})", r.code, r.message);
    }
    let challenge: Challenge = frame.body()?;
    let identity = PublicKey::parse(&device.identity_key)?;
    identity
        .verify(
            &handshake::challenge_message(
                &agent_nonce,
                &challenge.server_nonce,
                &device.device_id,
                challenge.server_time,
            ),
            &challenge.signature,
        )
        .context("server identity verification failed")?;
    let server_noise = match &noise_key {
        Some(_) => noise::accept_offer(
            &identity,
            challenge.noise.as_ref(),
            pinned.as_ref(),
            &agent_nonce,
            &challenge.server_nonce,
            &device.device_id,
        )?,
        None => None,
    };
    let proof = Proof {
        signature: key.sign(&handshake::proof_message(
            &challenge.server_nonce,
            &agent_nonce,
            &device.device_id,
        )),
    };
    ws.send(WsMessage::Binary(rustrmm_proto::encode(&proof)?.into()))
        .await?;
    let mut codec = None;
    if let (Some(local), Some(server_key)) = (&noise_key, server_noise) {
        let (initiator, init) = noise::start_control(
            local,
            &key,
            &server_key,
            &agent_nonce,
            &challenge.server_nonce,
            &device.device_id,
        )?;
        ws.send(WsMessage::Binary(rustrmm_proto::encode(&init)?.into()))
            .await?;
        let frame = next_frame(&mut ws).await?;
        if frame.is::<Rejected>() {
            let r: Rejected = frame.body()?;
            anyhow::bail!("rejected: {} ({})", r.code, r.message);
        }
        let accept: NoiseAccept = frame.body()?;
        codec = Some(initiator.finish(&accept.payload)?);
        if pinned.is_none() {
            device.server_noise = Some(noise::encode_key(&server_key));
            std::fs::write(path, serde_json::to_vec_pretty(&*device)?)?;
        }
    }
    let (mut sink, mut stream) = NoiseSocket::new(ws, codec).split();
    let frame = next_frame(&mut stream).await?;
    if frame.is::<Rejected>() {
        let r: Rejected = frame.body()?;
        anyhow::bail!("rejected: {} ({})", r.code, r.message);
    }
    let welcome: Welcome = frame.body()?;

    let mut state = profile::LiveState::new(profile);
    for (section, data) in profile.inventory() {
        let hash = hex::encode(<sha2::Sha256 as sha2::Digest>::digest(serde_json::to_vec(
            &data,
        )?));
        if welcome.inventory_hashes.get(&section) != Some(&hash) {
            sink.send(WsMessage::Binary(
                rustrmm_proto::encode(&InventorySection {
                    section,
                    hash,
                    data,
                })?
                .into(),
            ))
            .await?;
        }
    }

    let mut heartbeat = tokio::time::interval(Duration::from_secs(30));
    let mut metrics = tokio::time::interval(Duration::from_secs(metrics_secs.max(5)));
    let mut live = tokio::time::interval(Duration::from_secs(2));
    let mut live_until: Option<tokio::time::Instant> = None;
    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                let hb = state.heartbeat(profile);
                sink.send(WsMessage::Binary(rustrmm_proto::encode(&hb)?.into())).await?;
            }
            _ = metrics.tick() => {
                let sample: MetricSample = state.sample();
                sink.send(WsMessage::Binary(rustrmm_proto::encode(&Metrics { samples: vec![sample], live: false })?.into())).await?;
            }
            _ = live.tick(), if live_until.is_some() => {
                if live_until.is_some_and(|t| tokio::time::Instant::now() > t) { live_until = None; continue; }
                let sample = state.sample();
                sink.send(WsMessage::Binary(rustrmm_proto::encode(&Metrics { samples: vec![sample], live: true })?.into())).await?;
            }
            incoming = stream.next() => {
                let Some(msg) = incoming else { return Ok(()) };
                if let WsMessage::Binary(bytes) = msg? {
                    let frame = Frame::decode(&bytes)?;
                    match frame.t.as_str() {
                        t if t == LiveMode::TYPE => {
                            let mode: LiveMode = frame.body()?;
                            live_until = Some(tokio::time::Instant::now() + Duration::from_secs(u64::from(mode.duration_secs)));
                        }
                        t if t == RequestInventory::TYPE => {
                            for (section, data) in profile.inventory() {
                                let hash = hex::encode(<sha2::Sha256 as sha2::Digest>::digest(serde_json::to_vec(&data)?));
                                sink.send(WsMessage::Binary(rustrmm_proto::encode(&InventorySection { section, hash, data })?.into())).await?;
                            }
                        }
                        t if t == InventoryAck::TYPE => {}
                        t if t == rustrmm_proto::commands::SignedCommand::TYPE => {
                            let signed: rustrmm_proto::commands::SignedCommand = frame.body()?;
                            let payload = rmp_serde::from_slice::<rustrmm_proto::commands::CommandPayload>(&signed.payload).ok();
                            let is_update = matches!(payload.as_ref().map(|p| &p.command), Some(rustrmm_proto::commands::Command::UpdateAgent(_)));
                            let cmd_id = payload.map(|p| p.cmd_id).unwrap_or_default();
                            // Agent updates are answered like a development agent (verified, not installed) so a
                            // simulated fleet never fails, and so never auto-pauses, a real rollout.
                            let result = if is_update {
                                rustrmm_proto::commands::CommandResult { cmd_id, status: "succeeded".into(), message: "simulated device: verified and staged (development mode: not installed)".into(), data: serde_json::Value::Null }
                            } else {
                                rustrmm_proto::commands::CommandResult { cmd_id, status: "rejected".into(), message: "simulated device".into(), data: serde_json::Value::Null }
                            };
                            sink.send(WsMessage::Binary(rustrmm_proto::encode(&result)?.into())).await?;
                        }
                        _ => {}
                    }
                }
            }
        }
    }
}

async fn next_frame<S>(stream: &mut S) -> Result<Frame>
where
    S: futures::Stream<Item = Result<WsMessage, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    loop {
        match tokio::time::timeout(Duration::from_secs(30), stream.next()).await? {
            Some(Ok(WsMessage::Binary(bytes))) => return Ok(Frame::decode(&bytes)?),
            Some(Ok(_)) => continue,
            Some(Err(e)) => return Err(e.into()),
            None => anyhow::bail!("closed"),
        }
    }
}
