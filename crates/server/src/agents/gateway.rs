//! `GET /agent/v1/connect` — the persistent, mutually authenticated control connection.

use std::collections::BTreeMap;
use std::time::Duration;

use axum::extract::State;
use axum::extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use futures::{SinkExt, StreamExt};
use rustrmm_crypto::sign::PublicKey;
use rustrmm_proto::commands::CommandResult;
use rustrmm_proto::escrow::EscrowItem;
use rustrmm_proto::handshake::{self, Challenge, Hello, Proof, Rejected, Welcome};
use rustrmm_proto::messages::{AgentLog, AgentSettings, Bye, Heartbeat, InventorySection, Metrics};
use rustrmm_proto::monitoring::CheckResults;
use rustrmm_proto::network::{ScanResults, SnmpResults, SnmpTrap};
use rustrmm_proto::noise::{self, NoiseAccept, NoiseInit};
use rustrmm_proto::patching::PatchReport;
use rustrmm_proto::{Frame, Message as _};
use serde_json::json;
use tokio::sync::mpsc;

use super::channel::AgentSocket;
use super::{AgentHandle, Outbound};
use crate::auth::ClientMeta;
use crate::state::AppState;

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(20);
const IDLE_TIMEOUT: Duration = Duration::from_secs(120);
const PING_EVERY: Duration = Duration::from_secs(30);

/// Upgrade handler.
pub async fn connect(
    State(state): State<AppState>,
    meta: ClientMeta,
    ws: WebSocketUpgrade,
) -> Response {
    ws.max_message_size(rustrmm_proto::MAX_WIRE_BYTES)
        .on_upgrade(move |socket| async move {
            if let Err(e) = run(state, socket, meta.ip).await {
                tracing::debug!(error = %format!("{e:#}"), "agent connection ended with error");
            }
        })
}

type Sink = futures::stream::SplitSink<AgentSocket, WsMessage>;
type Stream = futures::stream::SplitStream<AgentSocket>;

async fn send<S, M>(sink: &mut S, message: &M) -> anyhow::Result<()>
where
    S: futures::Sink<WsMessage, Error = axum::Error> + Unpin,
    M: rustrmm_proto::Message,
{
    sink.send(WsMessage::Binary(rustrmm_proto::encode(message)?.into()))
        .await?;
    Ok(())
}

async fn recv_frame<S>(stream: &mut S, timeout: Duration) -> anyhow::Result<Frame>
where
    S: futures::Stream<Item = Result<WsMessage, axum::Error>> + Unpin,
{
    loop {
        let next = tokio::time::timeout(timeout, stream.next())
            .await
            .map_err(|_| anyhow::anyhow!("timed out"))?;
        match next {
            Some(Ok(WsMessage::Binary(bytes))) => return Ok(Frame::decode(&bytes)?),
            Some(Ok(WsMessage::Ping(_) | WsMessage::Pong(_))) => continue,
            Some(Ok(WsMessage::Close(_))) | None => anyhow::bail!("connection closed"),
            Some(Ok(WsMessage::Text(_))) => anyhow::bail!("unexpected text frame"),
            Some(Err(e)) => return Err(e.into()),
        }
    }
}

async fn reject<S>(sink: &mut S, code: &str, message: &str, retry_after_secs: u32)
where
    S: futures::Sink<WsMessage, Error = axum::Error> + Unpin,
{
    let _ = send(
        sink,
        &Rejected {
            code: code.into(),
            message: message.into(),
            retry_after_secs,
        },
    )
    .await;
    let _ = sink.close().await;
}

async fn run(state: AppState, socket: WebSocket, ip: Option<String>) -> anyhow::Result<()> {
    // The handshake runs on the bare socket; the session wraps it when Noise was negotiated.
    let mut socket = socket;

    // ---- 1. hello
    let hello: Hello = recv_frame(&mut socket, HANDSHAKE_TIMEOUT).await?.body()?;
    if !rustrmm_proto::protocol_supported(hello.protocol_major, hello.protocol_minor) {
        reject(
            &mut socket,
            "protocol_unsupported",
            "Agent protocol version is not supported; reinstall the agent",
            3600,
        )
        .await;
        return Ok(());
    }
    if hello.agent_nonce.len() != 32 {
        reject(&mut socket, "bad_request", "Invalid nonce", 60).await;
        return Ok(());
    }
    let Some(device) = super::load_device(&state.db, &hello.device_id).await? else {
        reject(
            &mut socket,
            "unknown_device",
            "This device is not enrolled",
            3600,
        )
        .await;
        return Ok(());
    };
    match device.status.as_str() {
        "active" => {}
        "pending" => {
            reject(
                &mut socket,
                "pending_approval",
                "Waiting for an administrator to approve this device",
                60,
            )
            .await;
            return Ok(());
        }
        "revoked" => {
            reject(
                &mut socket,
                "revoked",
                "This device has been revoked",
                86_400,
            )
            .await;
            return Ok(());
        }
        _ => {
            reject(
                &mut socket,
                "quarantined",
                "This device is quarantined",
                300,
            )
            .await;
            return Ok(());
        }
    }
    let wants_noise = hello.capabilities.iter().any(|c| c == noise::CAPABILITY);
    if !wants_noise && state.args.noise_required() {
        tracing::warn!(device = %device.id, ip = ?ip, "agent without the Noise channel refused");
        reject(
            &mut socket,
            "noise_required",
            "This server requires the end-to-end encrypted agent channel; update the agent",
            3600,
        )
        .await;
        return Ok(());
    }

    // ---- 2. challenge (server proves its identity and, for capable agents, offers its Noise key)
    let server_nonce = rustrmm_crypto::random::bytes::<32>().to_vec();
    let server_time = chrono::Utc::now().timestamp_millis();
    let challenge_bytes =
        handshake::challenge_message(&hello.agent_nonce, &server_nonce, &device.id, server_time);
    let signature = state.keys.identity.sign(&challenge_bytes);
    let offer = wants_noise.then(|| {
        noise::offer(
            &state.keys.identity,
            &state.keys.noise,
            &hello.agent_nonce,
            &server_nonce,
            &device.id,
        )
    });
    send(
        &mut socket,
        &Challenge {
            server_nonce: server_nonce.clone(),
            server_time,
            signature,
            noise: offer,
        },
    )
    .await?;

    // ---- 3. proof (device proves possession of its enrolled key)
    let proof: Proof = recv_frame(&mut socket, HANDSHAKE_TIMEOUT).await?.body()?;
    let device_key = PublicKey::parse(&device.public_key)?;
    let proof_bytes = handshake::proof_message(&server_nonce, &hello.agent_nonce, &device.id);
    if device_key.verify(&proof_bytes, &proof.signature).is_err() {
        tracing::warn!(device = %device.id, ip = ?ip, "agent failed handshake proof");
        let _ = super::timeline(
            &state.db,
            &device.id,
            "agent.auth_failed",
            "warning",
            "Connection with an invalid device signature was refused",
            json!({ "ip": ip }),
        )
        .await;
        reject(
            &mut socket,
            "bad_signature",
            "Device authentication failed",
            300,
        )
        .await;
        return Ok(());
    }

    // ---- 3b. Noise IK handshake (the agent's static key is vouched for by its device key)
    let mut codec = None;
    let mut noise_static = None;
    if wants_noise {
        let accepted = match recv_frame(&mut socket, HANDSHAKE_TIMEOUT)
            .await?
            .body::<NoiseInit>()
        {
            Ok(init) => noise::accept_control(
                &state.keys.noise,
                &device_key,
                &init,
                &hello.agent_nonce,
                &server_nonce,
                &device.id,
            )
            .map_err(anyhow::Error::from),
            Err(e) => Err(anyhow::Error::from(e)),
        };
        match accepted {
            Ok(accepted) => {
                send(
                    &mut socket,
                    &NoiseAccept {
                        payload: accepted.reply,
                    },
                )
                .await?;
                noise_static = Some(accepted.remote_static);
                codec = Some(accepted.codec);
            }
            Err(e) => {
                tracing::warn!(device = %device.id, ip = ?ip, error = %format!("{e:#}"), "agent Noise handshake failed");
                let _ = super::timeline(
                    &state.db,
                    &device.id,
                    "agent.noise_failed",
                    "warning",
                    "The end-to-end channel handshake failed; the connection was refused",
                    json!({ "ip": ip, "error": format!("{e:#}") }),
                )
                .await;
                reject(
                    &mut socket,
                    "noise_failed",
                    "The end-to-end channel handshake failed",
                    300,
                )
                .await;
                return Ok(());
            }
        }
    }
    if let Some(key) = &noise_static {
        let text = noise::encode_key(key);
        if device.noise_public_key.as_deref() != Some(text.as_str()) {
            sqlx::query("UPDATE devices SET noise_public_key = ? WHERE id = ?")
                .bind(&text)
                .bind(&device.id)
                .execute(&state.db)
                .await?;
            let summary = if device.noise_public_key.is_some() {
                "The agent's end-to-end channel key changed"
            } else {
                "The agent registered its end-to-end channel key"
            };
            let _ = super::timeline(
                &state.db,
                &device.id,
                "agent.noise_key",
                "info",
                summary,
                json!({ "key": text, "previous": device.noise_public_key }),
            )
            .await;
        }
    }
    let channel = AgentSocket::new(socket, codec);
    let (mut sink, mut stream) = channel.split();

    // ---- 4. register + welcome
    let session_id = rustrmm_common::new_id();
    let (tx, mut rx) = mpsc::channel::<Outbound>(256);
    let handle = AgentHandle {
        session_id: session_id.clone(),
        tx,
        connected_at: rustrmm_common::now(),
        ip: ip.clone(),
        session_nonce: server_nonce.clone(),
        seq: std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0)),
        noise_static,
    };
    if let Some(previous) = state.agents.insert(&device.id, handle) {
        if previous.ip != ip {
            let _ = super::timeline(
                &state.db,
                &device.id,
                "agent.duplicate_connection",
                "warning",
                "The same device key connected from two addresses — possible cloned agent",
                json!({ "previous_ip": previous.ip, "new_ip": ip }),
            )
            .await;
        }
        let _ = previous
            .tx
            .try_send(Outbound::Close("replaced by a newer connection".into()));
    }

    let hashes: Vec<(String, String)> =
        sqlx::query_as("SELECT section, hash FROM device_inventory WHERE device_id = ?")
            .bind(&device.id)
            .fetch_all(&state.db)
            .await?;
    // Agent settings come from the device's effective policy.
    let settings: AgentSettings =
        crate::automation::policies::agent_settings_for(&state.db, &device.id).await;
    let welcome = Welcome {
        session_id: session_id.clone(),
        server_time: chrono::Utc::now().timestamp_millis(),
        settings: settings.clone(),
        inventory_hashes: hashes.into_iter().collect::<BTreeMap<_, _>>(),
    };
    send(&mut sink, &welcome).await?;

    let now = rustrmm_common::now();
    let was_offline_long = device
        .last_seen_at
        .is_none_or(|t| now - t > chrono::Duration::minutes(10));
    sqlx::query(
        "UPDATE devices SET online = 1, connected_at = ?, last_seen_at = ?, last_ip = ?, agent_version = ?, protocol = ?,
                hostname = ?, offline_reason = NULL, offline_notified_at = NULL, updated_at = ? WHERE id = ?",
    )
    .bind(now)
    .bind(now)
    .bind(&ip)
    .bind(hello.agent_version.chars().take(40).collect::<String>())
    .bind(format!("{}.{}", hello.protocol_major, hello.protocol_minor))
    .bind(hello.hostname.chars().take(253).collect::<String>())
    .bind(now)
    .bind(&device.id)
    .execute(&state.db)
    .await?;
    if was_offline_long {
        let _ = super::timeline(
            &state.db,
            &device.id,
            "agent.online",
            "info",
            "Agent came online",
            json!({ "ip": ip, "version": hello.agent_version }),
        )
        .await;
    }
    state.events.publish(
        "devices.changed",
        Some(device.client_id.clone()),
        json!({ "id": device.id, "online": true }),
    );
    state.events.publish(
        "fleet.summary",
        Some(device.client_id.clone()),
        serde_json::Value::Null,
    );
    tracing::info!(device = %device.id, host = %hello.hostname, ip = ?ip, "agent connected");
    {
        let state = state.clone();
        let device_id = device.id.clone();
        let version = hello.agent_version.clone();
        tokio::spawn(async move {
            if let Err(e) = super::releases::on_connect(&state, &device_id, &version).await {
                tracing::warn!(device = %device_id, error = %format!("{e:#}"), "rollout check failed");
            }
            crate::automation::on_connect(&state, &device_id).await;
            crate::monitoring::on_connect(&state, &device_id).await;
            crate::patching::on_connect(&state, &device_id).await;
            crate::escrow::on_connect(&state, &device_id).await;
            crate::network::on_connect(&state, &device_id).await;
        });
    }

    // ---- 5. session loop
    let result = session_loop(&state, &device, &mut sink, &mut stream, &mut rx).await;

    // ---- 6. teardown
    if state.agents.remove_if_session(&device.id, &session_id) {
        let now = rustrmm_common::now();
        // The `device.offline` webhook event is debounced: the offline check sends it once the
        // device stayed away for its offline threshold (`monitoring::server_checks`).
        let reason = if result.is_ok() {
            "disconnected"
        } else {
            "connection_lost"
        };
        let _ = sqlx::query(
            "UPDATE devices SET online = 0, last_seen_at = ?, offline_reason = ?, updated_at = ? WHERE id = ?",
        )
        .bind(now)
        .bind(reason)
        .bind(now)
        .bind(&device.id)
        .execute(&state.db)
        .await;
        state.events.publish(
            "devices.changed",
            Some(device.client_id.clone()),
            json!({ "id": device.id, "online": false }),
        );
        state.events.publish(
            "fleet.summary",
            Some(device.client_id.clone()),
            serde_json::Value::Null,
        );
        tracing::info!(device = %device.id, "agent disconnected");
        crate::automation::on_disconnect(&state, &device.id).await;
        crate::monitoring::on_disconnect(&state, &device.id);
        crate::network::on_disconnect(&state, &device.id);
        let (summary, reason) = match &result {
            Ok(()) => ("Agent disconnected".to_string(), None),
            Err(e) => ("Agent connection lost".to_string(), Some(format!("{e:#}"))),
        };
        let _ = super::timeline(
            &state.db,
            &device.id,
            "agent.offline",
            "info",
            &summary,
            json!({ "reason": reason }),
        )
        .await;
    }
    result
}

async fn session_loop(
    state: &AppState,
    device: &super::DeviceRecord,
    sink: &mut Sink,
    stream: &mut Stream,
    rx: &mut mpsc::Receiver<Outbound>,
) -> anyhow::Result<()> {
    let mut ping = tokio::time::interval(PING_EVERY);
    ping.tick().await;
    let mut last_activity = tokio::time::Instant::now();
    loop {
        tokio::select! {
            incoming = stream.next() => {
                let Some(msg) = incoming else { return Ok(()) };
                last_activity = tokio::time::Instant::now();
                match msg? {
                    WsMessage::Binary(bytes) => {
                        let frame = match Frame::decode(&bytes) {
                            Ok(f) => f,
                            Err(e) => { tracing::debug!(device = %device.id, error = %e, "undecodable frame"); continue; }
                        };
                        if let Err(e) = handle_frame(state, device, sink, frame).await {
                            tracing::warn!(device = %device.id, error = %format!("{e:#}"), "failed to process agent message");
                        }
                    }
                    WsMessage::Close(_) => return Ok(()),
                    _ => {}
                }
            }
            outbound = rx.recv() => {
                match outbound {
                    Some(Outbound::Frame(bytes)) => sink.send(WsMessage::Binary(bytes.into())).await?,
                    Some(Outbound::Close(reason)) => {
                        let _ = send(sink, &Bye { reason }).await;
                        let _ = sink.close().await;
                        return Ok(());
                    }
                    None => return Ok(()),
                }
            }
            _ = ping.tick() => {
                if last_activity.elapsed() > IDLE_TIMEOUT {
                    anyhow::bail!("agent idle timeout");
                }
                sink.send(WsMessage::Ping(Vec::new().into())).await?;
            }
        }
    }
}

async fn handle_frame(
    state: &AppState,
    device: &super::DeviceRecord,
    sink: &mut Sink,
    frame: Frame,
) -> anyhow::Result<()> {
    match frame.t.as_str() {
        t if t == Heartbeat::TYPE => {
            let hb: Heartbeat = frame.body()?;
            let now = rustrmm_common::now();
            sqlx::query(
                "UPDATE devices SET last_seen_at = ?, online = 1, uptime_s = ?, cpu_pct = ?, mem_pct = ?, disk_pct = ?,
                        last_user = COALESCE(?, last_user), updated_at = ? WHERE id = ?",
            )
            .bind(now)
            .bind(hb.uptime_s as i64)
            .bind(f64::from(hb.cpu_pct))
            .bind(f64::from(hb.mem_pct))
            .bind(f64::from(hb.disk_pct))
            .bind(hb.logged_in_user.as_deref().map(|u| u.chars().take(120).collect::<String>()))
            .bind(now)
            .bind(&device.id)
            .execute(&state.db)
            .await?;
            super::inventory::refresh_health(state, &device.id).await?;
        }
        t if t == Metrics::TYPE => {
            let metrics: Metrics = frame.body()?;
            if let Some(last) = metrics.samples.last() {
                state.events.publish(
                    "device.metrics",
                    Some(device.client_id.clone()),
                    json!({ "device_id": device.id, "live": metrics.live, "sample": last }),
                );
            }
            if !metrics.live {
                for sample in metrics.samples.into_iter().take(240) {
                    state.telemetry.record(&device.id, sample);
                }
            }
        }
        t if t == InventorySection::TYPE => {
            let section: InventorySection = frame.body()?;
            let ack = super::inventory::ingest(state, device, section).await?;
            send(sink, &ack).await?;
        }
        t if t == AgentLog::TYPE => {
            let log: AgentLog = frame.body()?;
            if matches!(log.level.as_str(), "error" | "warn" | "warning") {
                let severity = if log.level == "error" {
                    "warning"
                } else {
                    "notice"
                };
                let summary: String = log.message.chars().take(300).collect();
                super::timeline(
                    &state.db,
                    &device.id,
                    "agent.log",
                    severity,
                    &summary,
                    json!({ "level": log.level }),
                )
                .await?;
            }
        }
        t if t == CommandResult::TYPE => {
            let result: CommandResult = frame.body()?;
            // Persist first so callers see the final status in command history.
            let recorded = super::commands::record_result(state, &device.id, result.clone()).await;
            state.agents.resolve(&device.id, &result);
            recorded?;
        }
        t if t == CheckResults::TYPE => {
            let results: CheckResults = frame.body()?;
            crate::monitoring::ingest::on_results(state, device, results).await?;
        }
        t if t == PatchReport::TYPE => {
            let report: PatchReport = frame.body()?;
            crate::patching::ingest::on_report(state, device, report).await?;
        }
        t if t == EscrowItem::TYPE => {
            let item: EscrowItem = frame.body()?;
            crate::escrow::ingest(state, device, item).await?;
        }
        t if t == ScanResults::TYPE => {
            let results: ScanResults = frame.body()?;
            crate::network::scans::on_results(state, device, results).await?;
        }
        t if t == SnmpResults::TYPE => {
            let results: SnmpResults = frame.body()?;
            crate::network::metrics::on_results(state, device, results).await?;
        }
        t if t == SnmpTrap::TYPE => {
            let trap: SnmpTrap = frame.body()?;
            crate::network::traps::on_trap(state, device, trap).await?;
        }
        t if t == Bye::TYPE => {}
        other => {
            tracing::debug!(device = %device.id, kind = other, "ignoring unknown message type")
        }
    }
    Ok(())
}
