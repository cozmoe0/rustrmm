//! One authenticated control session with the server.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use futures::{SinkExt, StreamExt};
use rustrmm_crypto::sign::{PublicKey, SigningKey};
use rustrmm_proto::commands::{
    Command, CommandPayload, CommandResult, SignedCommand, command_signing_bytes,
};
use rustrmm_proto::handshake::{self, Challenge, Hello, Proof, Rejected, Welcome};
use rustrmm_proto::messages::{
    AgentSettings, Bye, InventoryAck, InventorySection, LiveMode, Metrics, RequestInventory,
};
use rustrmm_proto::monitoring::CheckResults;
use rustrmm_proto::noise::tungstenite::NoiseSocket;
use rustrmm_proto::noise::{self, NoiseAccept, StaticKeypair};
use rustrmm_proto::{Frame, Message as _};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::{Error as WsError, Message as WsMessage};
use tokio_util::sync::CancellationToken;

use crate::config::AgentConfig;
use crate::metrics::Sampler;
use crate::paths::Paths;

/// What the outer loop should do after a session ends.
pub enum Outcome {
    Shutdown,
    /// Reconnect after (at least) this delay.
    Retry(Duration),
}

type RawWs =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
/// The control connection, Noise-wrapped when the end-to-end channel was negotiated.
type Ws = NoiseSocket<RawWs>;
type Sink = futures::stream::SplitSink<Ws, WsMessage>;
type Stream = futures::stream::SplitStream<Ws>;

async fn send<S, M>(ws: &mut S, message: &M) -> Result<()>
where
    S: futures::Sink<WsMessage, Error = WsError> + Unpin,
    M: rustrmm_proto::Message,
{
    ws.send(WsMessage::Binary(rustrmm_proto::encode(message)?.into()))
        .await?;
    Ok(())
}

async fn recv<S>(stream: &mut S, timeout: Duration) -> Result<Frame>
where
    S: futures::Stream<Item = Result<WsMessage, WsError>> + Unpin,
{
    loop {
        let next = tokio::time::timeout(timeout, stream.next())
            .await
            .context("server did not respond in time")?;
        match next {
            Some(Ok(WsMessage::Binary(bytes))) => return Ok(Frame::decode(&bytes)?),
            Some(Ok(WsMessage::Ping(_) | WsMessage::Pong(_) | WsMessage::Frame(_))) => continue,
            Some(Ok(WsMessage::Text(_))) => bail!("unexpected text frame"),
            Some(Ok(WsMessage::Close(_))) | None => bail!("connection closed"),
            Some(Err(e)) => return Err(e.into()),
        }
    }
}

fn rejected(frame: &Frame) -> Result<Option<Outcome>> {
    if !frame.is::<Rejected>() {
        return Ok(None);
    }
    let rejected: Rejected = frame.body()?;
    tracing::warn!(code = %rejected.code, message = %rejected.message, "server refused connection");
    Ok(Some(Outcome::Retry(Duration::from_secs(u64::from(
        rejected.retry_after_secs.max(30),
    )))))
}

/// Static keys a session's tunnels use for their own Noise handshakes.
#[derive(Clone)]
pub struct TunnelNoise {
    pub local: StaticKeypair,
    pub server: [u8; 32],
}

#[allow(clippy::too_many_arguments)]
pub async fn session(
    config: &AgentConfig,
    paths: &Paths,
    key: &SigningKey,
    noise_key: Option<&StaticKeypair>,
    tls: Arc<rustls::ClientConfig>,
    base_url: &str,
    monitor: &crate::checks::Handle,
    snmp: &crate::snmp::Handle,
    shutdown: &CancellationToken,
) -> Result<Outcome> {
    let mut url = url::Url::parse(base_url).context("invalid server URL")?;
    url.set_scheme("wss")
        .map_err(|_| anyhow::anyhow!("cannot use wss with {base_url}"))?;
    url.set_path("/agent/v1/connect");
    let mut ws_config = WebSocketConfig::default();
    ws_config.max_message_size = Some(rustrmm_proto::MAX_WIRE_BYTES);
    let connect = tokio_tungstenite::connect_async_tls_with_config(
        url.as_str(),
        Some(ws_config),
        true,
        Some(tokio_tungstenite::Connector::Rustls(tls.clone())),
    );
    let (mut ws, _) = tokio::time::timeout(Duration::from_secs(30), connect)
        .await
        .context("connect timed out")??;
    let pinned = match crate::identity::noise_pin(paths) {
        Ok(pin) => pin,
        Err(e) => {
            tracing::error!(error = %format!("{e:#}"), "cannot read the pinned server key; refusing to connect");
            return Ok(Outcome::Retry(Duration::from_secs(300)));
        }
    };

    // ---- handshake (on the bare socket; wrapped afterwards when Noise is negotiated)
    let agent_nonce = rustrmm_crypto::random::bytes::<32>().to_vec();
    let facts = crate::collectors::enrollment_facts();
    let mut capabilities: Vec<String> = [
        "inventory",
        "metrics",
        "live",
        "commands",
        "remote",
        "tunnels",
        "scripts",
        "patching",
        "software",
        "desktop",
        "escrow",
        "network",
    ]
    .iter()
    .map(|c| (*c).to_string())
    .collect();
    if noise_key.is_some() {
        capabilities.push(noise::CAPABILITY.to_string());
    }
    send(
        &mut ws,
        &Hello {
            device_id: config.device_id.clone(),
            agent_nonce: agent_nonce.clone(),
            protocol_major: rustrmm_proto::PROTOCOL_MAJOR,
            protocol_minor: rustrmm_proto::PROTOCOL_MINOR,
            agent_version: crate::AGENT_VERSION.to_string(),
            os_family: crate::collectors::os_family().to_string(),
            hostname: facts.hostname,
            capabilities,
        },
    )
    .await?;

    let frame = recv(&mut ws, Duration::from_secs(30)).await?;
    if let Some(outcome) = rejected(&frame)? {
        return Ok(outcome);
    }
    let challenge: Challenge = frame.body()?;
    let identity = PublicKey::parse(&config.identity_key)?;
    let challenge_bytes = handshake::challenge_message(
        &agent_nonce,
        &challenge.server_nonce,
        &config.device_id,
        challenge.server_time,
    );
    if identity
        .verify(&challenge_bytes, &challenge.signature)
        .is_err()
    {
        tracing::error!(
            "server failed identity verification — possible interception; refusing to continue"
        );
        return Ok(Outcome::Retry(Duration::from_secs(300)));
    }
    // The Noise offer is signed by the identity key; once a key is pinned, a missing or different
    // offer refuses the connection (downgrade or interception).
    let server_noise = match noise_key {
        Some(_) => match noise::accept_offer(
            &identity,
            challenge.noise.as_ref(),
            pinned.as_ref(),
            &agent_nonce,
            &challenge.server_nonce,
            &config.device_id,
        ) {
            Ok(key) => key,
            Err(e) => {
                tracing::error!(error = %e, "end-to-end channel check failed; refusing to continue");
                return Ok(Outcome::Retry(Duration::from_secs(300)));
            }
        },
        None => None,
    };
    let clock_skew_ms = challenge.server_time - chrono::Utc::now().timestamp_millis();
    if clock_skew_ms.abs() > 120_000 {
        tracing::warn!(
            skew_seconds = clock_skew_ms / 1000,
            "local clock differs from the server"
        );
    }
    let proof = handshake::proof_message(&challenge.server_nonce, &agent_nonce, &config.device_id);
    send(
        &mut ws,
        &Proof {
            signature: key.sign(&proof),
        },
    )
    .await?;

    let mut codec = None;
    let mut tunnel_noise = None;
    if let (Some(local), Some(server_key)) = (noise_key, server_noise) {
        let (initiator, init) = noise::start_control(
            local,
            key,
            &server_key,
            &agent_nonce,
            &challenge.server_nonce,
            &config.device_id,
        )?;
        send(&mut ws, &init).await?;
        let frame = recv(&mut ws, Duration::from_secs(30)).await?;
        if let Some(outcome) = rejected(&frame)? {
            return Ok(outcome);
        }
        let accept: NoiseAccept = frame.body()?;
        match initiator.finish(&accept.payload) {
            Ok(c) => codec = Some(c),
            Err(e) => {
                tracing::error!(error = %e, "end-to-end channel handshake failed; refusing to continue");
                return Ok(Outcome::Retry(Duration::from_secs(300)));
            }
        }
        if pinned.is_none() {
            crate::identity::save_noise_pin(paths, &server_key)?;
            tracing::info!(key = %noise::encode_key(&server_key), "pinned the server's end-to-end channel key");
        }
        tunnel_noise = Some(TunnelNoise {
            local: local.clone(),
            server: server_key,
        });
    }
    let channel = Ws::new(ws, codec);
    let end_to_end = channel.is_encrypted();
    let (mut sink, mut stream) = channel.split();

    let frame = recv(&mut stream, Duration::from_secs(30)).await?;
    if let Some(outcome) = rejected(&frame)? {
        return Ok(outcome);
    }
    let welcome: Welcome = frame.body()?;
    tracing::info!(session = %welcome.session_id, end_to_end, "connected to server");
    if let Some(result) = crate::update::after_connect(paths) {
        tracing::info!(status = %result.status, message = %result.message, "reporting update outcome");
        send(&mut sink, &result).await?;
    }
    let ctx = SessionCtx {
        config,
        paths,
        tls,
        base_url: base_url.to_string(),
        session_nonce: challenge.server_nonce.clone(),
        clock_skew_ms,
        monitor: Some(monitor.clone()),
        snmp: Some(snmp.clone()),
        noise: tunnel_noise,
    };
    run_session(&ctx, welcome, &mut sink, &mut stream, shutdown).await
}

/// Everything a session needs to validate and execute signed commands.
pub struct SessionCtx<'a> {
    config: &'a AgentConfig,
    paths: &'a Paths,
    tls: Arc<rustls::ClientConfig>,
    /// Server URL this session is connected to (tunnels dial the same server).
    base_url: String,
    session_nonce: Vec<u8>,
    clock_skew_ms: i64,
    /// The check engine (receives verified monitoring configurations).
    monitor: Option<crate::checks::Handle>,
    /// The SNMP poller (receives verified SNMP configurations; probes only).
    snmp: Option<crate::snmp::Handle>,
    /// Noise keys for tunnels when this session uses the end-to-end channel.
    noise: Option<TunnelNoise>,
}

/// Validates a signed command: key, device, connection binding, ordering and expiry.
fn verify_command(
    ctx: &SessionCtx<'_>,
    signed: &SignedCommand,
    last_seq: &mut u64,
) -> Result<CommandPayload> {
    let key = PublicKey::parse(&ctx.config.command_key)?;
    key.verify(&command_signing_bytes(&signed.payload), &signed.signature)
        .context("invalid command signature")?;
    let payload: CommandPayload =
        rmp_serde::from_slice(&signed.payload).context("malformed command")?;
    if payload.device_id != ctx.config.device_id {
        bail!("command is addressed to another device");
    }
    if payload.session_nonce != ctx.session_nonce {
        bail!("command belongs to another connection (replay)");
    }
    if payload.seq <= *last_seq {
        bail!(
            "command sequence {} is not newer than {} (replay)",
            payload.seq,
            last_seq
        );
    }
    let server_now = chrono::Utc::now().timestamp_millis() + ctx.clock_skew_ms;
    if server_now > payload.expires_at {
        bail!("command expired");
    }
    *last_seq = payload.seq;
    Ok(payload)
}

async fn run_session(
    ctx: &SessionCtx<'_>,
    welcome: Welcome,
    sink: &mut Sink,
    stream: &mut Stream,
    shutdown: &CancellationToken,
) -> Result<Outcome> {
    // The server is the source of truth for probe duties: every session starts without an SNMP
    // configuration and a probe receives its configuration again right after connecting.
    if let Some(snmp) = &ctx.snmp {
        snmp.apply(rustrmm_proto::network::SnmpConfig::new(
            Vec::new(),
            rustrmm_proto::network::TrapReceiver::default(),
        ));
    }
    let mut settings: AgentSettings = welcome.settings;
    let mut acked: BTreeMap<String, String> = welcome.inventory_hashes;
    let mut sampler = Sampler::new();
    let mut pending_samples = Vec::new();

    let mut heartbeat = tokio::time::interval(Duration::from_secs(u64::from(
        settings.heartbeat_secs.max(10),
    )));
    let mut metrics_tick = tokio::time::interval(Duration::from_secs(u64::from(
        settings.metrics_secs.max(10),
    )));
    let mut live_tick = tokio::time::interval(Duration::from_secs(2));
    let mut live_until: Option<tokio::time::Instant> = None;
    let mut inventory_tick = tokio::time::interval(Duration::from_secs(
        u64::from(settings.inventory_minutes.max(15)) * 60,
    ));
    let (inv_tx, mut inv_rx) = mpsc::channel::<InventorySection>(16);
    let mut inventory_running = false;
    let mut force_inventory = false;
    let (result_tx, mut result_rx) = mpsc::channel::<CommandResult>(32);
    let mut last_seq: u64 = 0;
    // Check results from the engine (queued transitions are flushed into it on attach).
    let (check_tx, mut check_rx) = mpsc::channel::<CheckResults>(64);
    if let Some(monitor) = &ctx.monitor {
        monitor.attach(check_tx);
    }
    // Results of long-running work queued while disconnected.
    flush_outbox(sink).await?;

    loop {
        tokio::select! {
            _ = shutdown.cancelled() => {
                let _ = send(sink, &Bye { reason: "agent stopping".into() }).await;
                let _ = sink.close().await;
                return Ok(Outcome::Shutdown);
            }
            _ = heartbeat.tick() => {
                let user = crate::collectors::console_user();
                send(sink, &sampler.heartbeat(user)).await?;
                flush_outbox(sink).await?;
            }
            _ = crate::outbox::notified() => {
                flush_outbox(sink).await?;
            }
            _ = metrics_tick.tick() => {
                pending_samples.push(sampler.sample());
                send(sink, &Metrics { samples: std::mem::take(&mut pending_samples), live: false }).await?;
            }
            _ = live_tick.tick(), if live_until.is_some() => {
                if live_until.is_some_and(|t| tokio::time::Instant::now() > t) {
                    live_until = None;
                } else {
                    send(sink, &Metrics { samples: vec![sampler.sample()], live: true }).await?;
                }
            }
            _ = inventory_tick.tick() => {
                if !inventory_running {
                    inventory_running = true;
                    spawn_inventory(inv_tx.clone(), acked.clone(), force_inventory);
                    force_inventory = false;
                }
            }
            Some(result) = result_rx.recv() => {
                send(sink, &result).await?;
            }
            Some(results) = check_rx.recv() => {
                send(sink, &results).await?;
            }
            Some(section) = inv_rx.recv() => {
                if section.section == DONE_MARKER {
                    inventory_running = false;
                } else {
                    // A changed security section may mean a BitLocker change: collect (de-duplicated).
                    if section.section == rustrmm_proto::messages::sections::SECURITY {
                        crate::escrow::spawn_collect(ctx.paths.clone(), ctx.config.escrow_recipient.clone());
                    }
                    send(sink, &section).await?;
                }
            }
            incoming = stream.next() => {
                let Some(msg) = incoming else { return Ok(Outcome::Retry(Duration::from_secs(5))) };
                match msg? {
                    WsMessage::Binary(bytes) => {
                        let frame = match Frame::decode(&bytes) { Ok(f) => f, Err(_) => continue };
                        match frame.t.as_str() {
                            t if t == InventoryAck::TYPE => {
                                let ack: InventoryAck = frame.body()?;
                                acked.insert(ack.section, ack.hash);
                            }
                            t if t == LiveMode::TYPE => {
                                let live: LiveMode = frame.body()?;
                                let secs = u64::from(live.duration_secs.clamp(10, 600));
                                live_until = Some(tokio::time::Instant::now() + Duration::from_secs(secs));
                                live_tick = tokio::time::interval(Duration::from_secs(u64::from(live.interval_secs.clamp(1, 30))));
                            }
                            t if t == RequestInventory::TYPE => {
                                let request: RequestInventory = frame.body()?;
                                if request.sections.is_empty() { acked.clear(); } else { for s in &request.sections { acked.remove(s); } }
                                if inventory_running { force_inventory = true; } else {
                                    inventory_running = true;
                                    spawn_inventory(inv_tx.clone(), acked.clone(), true);
                                }
                            }
                            t if t == AgentSettings::TYPE => {
                                let new: AgentSettings = frame.body()?;
                                if new != settings {
                                    heartbeat = tokio::time::interval(Duration::from_secs(u64::from(new.heartbeat_secs.max(10))));
                                    metrics_tick = tokio::time::interval(Duration::from_secs(u64::from(new.metrics_secs.max(10))));
                                    if new.inventory_minutes != settings.inventory_minutes {
                                        // Re-arm without an immediate tick: a policy push must not trigger a full collection.
                                        let period = Duration::from_secs(u64::from(new.inventory_minutes.max(15)) * 60);
                                        inventory_tick = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
                                    }
                                    settings = new;
                                }
                            }
                            t if t == SignedCommand::TYPE => {
                                let signed: SignedCommand = frame.body()?;
                                match verify_command(ctx, &signed, &mut last_seq) {
                                    Ok(payload) => dispatch(ctx, payload, result_tx.clone()),
                                    Err(e) => {
                                        tracing::warn!(error = %format!("{e:#}"), "rejected command");
                                        let cmd_id = rmp_serde::from_slice::<CommandPayload>(&signed.payload).map(|p| p.cmd_id).unwrap_or_default();
                                        send(sink, &CommandResult { cmd_id, status: "rejected".into(), message: format!("{e:#}"), data: serde_json::Value::Null }).await?;
                                    }
                                }
                            }
                            t if t == Bye::TYPE => {
                                let bye: Bye = frame.body()?;
                                tracing::info!(reason = %bye.reason, "server closed the session");
                                return Ok(Outcome::Retry(Duration::from_secs(5)));
                            }
                            other => tracing::debug!(kind = other, "ignoring unknown message"),
                        }
                    }
                    WsMessage::Close(_) => return Ok(Outcome::Retry(Duration::from_secs(5))),
                    _ => {}
                }
            }
        }
    }
}

const DONE_MARKER: &str = "__done__";

/// Sends queued frames; each leaves the queue only once it was written.
async fn flush_outbox(sink: &mut Sink) -> Result<()> {
    while let Some(frame) = crate::outbox::peek() {
        sink.send(WsMessage::Binary(frame.into())).await?;
        crate::outbox::pop();
    }
    Ok(())
}

/// Runs a verified command; the outcome is reported through `results`.
fn dispatch(ctx: &SessionCtx<'_>, payload: CommandPayload, results: mpsc::Sender<CommandResult>) {
    let cmd_id = payload.cmd_id.clone();
    tracing::info!(cmd = %cmd_id, kind = payload.command.kind(), "executing command");
    let reply = {
        let cmd_id = cmd_id.clone();
        move |status: &str, message: String, data: serde_json::Value| CommandResult {
            cmd_id: cmd_id.clone(),
            status: status.into(),
            message,
            data,
        }
    };
    // The machine-local capability lock always wins over the server.
    if let Some(feature) = payload.command.feature()
        && !crate::config::LocalPolicy::load(ctx.paths).allows(feature)
    {
        let _ = results.try_send(reply(
            "rejected",
            format!("{feature} is disabled on this device by local policy"),
            serde_json::Value::Null,
        ));
        return;
    }
    match payload.command {
        Command::Ping => {
            let _ = results.try_send(reply(
                "succeeded",
                "pong".into(),
                serde_json::json!({ "version": crate::AGENT_VERSION }),
            ));
        }
        Command::UpdateAgent(update) => {
            let (paths, config, tls) = (ctx.paths.clone(), ctx.config.clone(), ctx.tls.clone());
            let accepted = reply(
                "accepted",
                format!("updating to {}", update.version),
                serde_json::Value::Null,
            );
            tokio::spawn(async move {
                let _ = results.send(accepted).await;
                let outcome = crate::update::apply(&paths, &config, tls, &cmd_id, update).await;
                let _ = results.send(outcome).await;
            });
        }
        Command::OpenTunnel(open) => {
            let (base_url, tls, noise) = (ctx.base_url.clone(), ctx.tls.clone(), ctx.noise.clone());
            tokio::spawn(async move {
                match crate::remote::tunnel::connect(&base_url, tls, &open, noise.as_ref()).await {
                    Ok(ws) => {
                        let _ = results
                            .send(reply(
                                "succeeded",
                                "tunnel connected".into(),
                                serde_json::Value::Null,
                            ))
                            .await;
                        crate::remote::tunnel::serve(ws, open.kind).await;
                    }
                    Err(e) => {
                        let _ = results
                            .send(reply("failed", format!("{e:#}"), serde_json::Value::Null))
                            .await;
                    }
                }
            });
        }
        Command::RunScript(script) => {
            let paths = ctx.paths.clone();
            let device_id = ctx.config.device_id.clone();
            tokio::spawn(async move {
                let _ = results
                    .send(reply("running", String::new(), serde_json::Value::Null))
                    .await;
                let outcome = match crate::scripts::run(&paths, &device_id, &cmd_id, script).await {
                    crate::scripts::Outcome::Ran(data) => reply("succeeded", String::new(), data),
                    crate::scripts::Outcome::Rejected(message) => {
                        tracing::warn!(cmd = %cmd_id, %message, "script refused");
                        reply("rejected", message, serde_json::Value::Null)
                    }
                    crate::scripts::Outcome::Failed(message) => {
                        reply("failed", message, serde_json::Value::Null)
                    }
                };
                let _ = results.send(outcome).await;
            });
        }
        Command::MonitoringConfig(config) => {
            let version = config.version.clone();
            let applied = ctx.monitor.as_ref().is_some_and(|m| m.apply(config));
            let _ = results.try_send(if applied {
                reply(
                    "succeeded",
                    String::new(),
                    serde_json::json!({ "version": version }),
                )
            } else {
                reply(
                    "failed",
                    "the check engine is not running".into(),
                    serde_json::Value::Null,
                )
            });
        }
        Command::PatchScan(scan) => crate::patching::spawn_scan(cmd_id, scan),
        Command::PatchInstall(install) => crate::patching::spawn_install(cmd_id, install),
        Command::SoftwareAction(action) => crate::software::spawn_action(
            ctx.paths.clone(),
            ctx.base_url.clone(),
            ctx.tls.clone(),
            ctx.config.device_id.clone(),
            cmd_id,
            action,
        ),
        Command::Screenshot(request) => {
            let timeout =
                Duration::from_secs(u64::from(request.consent_timeout_secs.min(300)) + 45);
            tokio::spawn(async move {
                let outcome = match tokio::time::timeout(
                    timeout,
                    crate::desktop::screenshot(request),
                )
                .await
                {
                    Ok(Ok(data)) => reply("succeeded", String::new(), data),
                    Ok(Err(e)) => reply("failed", format!("{e:#}"), serde_json::Value::Null),
                    Err(_) => reply("failed", "timed out".into(), serde_json::Value::Null),
                };
                let _ = results.send(outcome).await;
            });
        }
        Command::RotateLocalAdmin(request) => crate::escrow::spawn_rotate(
            cmd_id,
            ctx.paths.clone(),
            ctx.config.escrow_recipient.clone(),
            request,
        ),
        Command::EscrowRefresh => crate::escrow::spawn_refresh(
            cmd_id,
            ctx.paths.clone(),
            ctx.config.escrow_recipient.clone(),
        ),
        Command::NetworkScan(scan) => crate::network::spawn_scan(cmd_id, scan),
        Command::SnmpConfig(config) => {
            let version = config.version.clone();
            let applied = ctx.snmp.as_ref().is_some_and(|s| s.apply(config));
            let _ = results.try_send(if applied {
                reply(
                    "succeeded",
                    String::new(),
                    serde_json::json!({ "version": version }),
                )
            } else {
                reply(
                    "failed",
                    "the SNMP poller is not running".into(),
                    serde_json::Value::Null,
                )
            });
        }
        Command::SnmpTest(target) => {
            tokio::spawn(async move {
                let data = crate::snmp::test(target).await;
                let _ = results.send(reply("succeeded", String::new(), data)).await;
            });
        }
        Command::Unsupported => {
            let _ = results.try_send(reply(
                "rejected",
                "command not supported by this agent version".into(),
                serde_json::Value::Null,
            ));
        }
        tool => {
            tokio::spawn(async move {
                let outcome = match tokio::time::timeout(
                    Duration::from_secs(120),
                    crate::remote::execute(tool),
                )
                .await
                {
                    Ok(Ok(data)) => reply("succeeded", String::new(), data),
                    Ok(Err(e)) => reply("failed", format!("{e:#}"), serde_json::Value::Null),
                    Err(_) => reply("failed", "timed out".into(), serde_json::Value::Null),
                };
                let _ = results.send(outcome).await;
            });
        }
    }
}

/// Collects inventory on a blocking thread and streams changed sections back.
fn spawn_inventory(
    tx: mpsc::Sender<InventorySection>,
    acked: BTreeMap<String, String>,
    force: bool,
) {
    tokio::task::spawn_blocking(move || {
        for name in rustrmm_proto::messages::sections::ALL {
            match crate::collectors::collect(name) {
                Ok(data) => {
                    let hash = crate::collectors::hash(&data);
                    if force || acked.get(*name) != Some(&hash) {
                        let _ = tx.blocking_send(InventorySection {
                            section: name.to_string(),
                            hash,
                            data,
                        });
                    }
                }
                Err(e) => {
                    tracing::warn!(section = name, error = %format!("{e:#}"), "inventory collection failed")
                }
            }
        }
        let _ = tx.blocking_send(InventorySection {
            section: DONE_MARKER.into(),
            hash: String::new(),
            data: serde_json::Value::Null,
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use rustrmm_proto::commands::Command;

    fn config(command_key: &SigningKey) -> AgentConfig {
        AgentConfig {
            device_id: "dev-1".into(),
            server_urls: vec!["https://rmm.test:8444".into()],
            identity_key: command_key.public_key().to_string(),
            command_key: command_key.public_key().to_string(),
            release_key: command_key.public_key().to_string(),
            escrow_recipient: String::new(),
            ca_cert_pem: None,
            client_name: "c".into(),
            site_name: "s".into(),
            enrolled_at: chrono::Utc::now(),
        }
    }

    fn signed(
        key: &SigningKey,
        device: &str,
        nonce: &[u8],
        seq: u64,
        expires_in_ms: i64,
    ) -> SignedCommand {
        let now = chrono::Utc::now().timestamp_millis();
        let payload = CommandPayload {
            cmd_id: format!("cmd-{seq}"),
            device_id: device.into(),
            session_nonce: nonce.to_vec(),
            seq,
            issued_at: now,
            expires_at: now + expires_in_ms,
            command: Command::Ping,
        };
        let bytes = rmp_serde::to_vec_named(&payload).expect("encode");
        SignedCommand {
            signature: key.sign(&command_signing_bytes(&bytes)),
            payload: bytes,
        }
    }

    #[test]
    fn command_verification_blocks_injection_and_replay() {
        let server = SigningKey::generate();
        let cfg = config(&server);
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = Paths::resolve(Some(dir.path().to_path_buf()));
        let ctx = SessionCtx {
            config: &cfg,
            paths: &paths,
            tls: crate::tls::client_config(None).expect("tls"),
            base_url: "https://localhost:8444".into(),
            session_nonce: vec![7; 32],
            clock_skew_ms: 0,
            monitor: None,
            snmp: None,
            noise: None,
        };
        let mut last = 0;
        assert!(
            verify_command(
                &ctx,
                &signed(&server, "dev-1", &[7; 32], 1, 60_000),
                &mut last
            )
            .is_ok()
        );
        assert!(
            verify_command(
                &ctx,
                &signed(&server, "dev-1", &[7; 32], 1, 60_000),
                &mut last
            )
            .is_err(),
            "replayed seq"
        );
        assert!(
            verify_command(
                &ctx,
                &signed(&server, "dev-2", &[7; 32], 2, 60_000),
                &mut last
            )
            .is_err(),
            "other device"
        );
        assert!(
            verify_command(
                &ctx,
                &signed(&server, "dev-1", &[8; 32], 3, 60_000),
                &mut last
            )
            .is_err(),
            "other connection"
        );
        assert!(
            verify_command(
                &ctx,
                &signed(&server, "dev-1", &[7; 32], 4, -1_000),
                &mut last
            )
            .is_err(),
            "expired"
        );
        assert!(
            verify_command(
                &ctx,
                &signed(&SigningKey::generate(), "dev-1", &[7; 32], 5, 60_000),
                &mut last
            )
            .is_err(),
            "forged signature"
        );
        let mut tampered = signed(&server, "dev-1", &[7; 32], 6, 60_000);
        let last_byte = tampered.payload.len() - 1;
        tampered.payload[last_byte] ^= 1;
        assert!(
            verify_command(&ctx, &tampered, &mut last).is_err(),
            "tampered payload"
        );
        assert!(
            verify_command(
                &ctx,
                &signed(&server, "dev-1", &[7; 32], 7, 60_000),
                &mut last
            )
            .is_ok(),
            "next valid command still works"
        );
    }
}
