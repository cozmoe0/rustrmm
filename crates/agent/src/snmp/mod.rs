//! SNMP for site probes: a small, tested v1/v2c/v3 implementation (BER codec, USM with
//! HMAC-SHA-96 / HMAC-SHA-256-192 and AES-128), the poll loop driven by the server's
//! `SnmpConfig`, and the trap receiver.
//!
//! The configuration carries decrypted credentials: it lives in memory only (never written to
//! disk) and nothing here logs a community or password.

pub mod ber;
pub mod client;
pub mod pdu;
pub mod trap;
pub mod usm;

use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use rustrmm_proto::network::{
    MAX_POLL_SECS, MIN_POLL_SECS, SnmpConfig, SnmpCredential, SnmpResults, SnmpSample, SnmpSysInfo,
    SnmpTarget, SnmpValue,
};
use serde_json::json;
use tokio::sync::{Semaphore, mpsc};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use ber::Oid;
use client::{Client, Security};

pub const SYS_DESCR: &str = "1.3.6.1.2.1.1.1.0";
pub const SYS_OBJECT_ID: &str = "1.3.6.1.2.1.1.2.0";
pub const SYS_UPTIME: &str = "1.3.6.1.2.1.1.3.0";
pub const SYS_NAME: &str = "1.3.6.1.2.1.1.5.0";
/// Rows read per table column.
const MAX_TABLE_ROWS: usize = 500;
/// Devices polled at the same time.
const MAX_PARALLEL_POLLS: usize = 16;
/// Traps accepted per second (more are dropped).
const MAX_TRAPS_PER_SEC: u32 = 50;

fn oid(text: &str) -> Oid {
    Oid::parse(text).unwrap_or_else(|_| Oid(vec![1, 3]))
}

/// What a host says about itself.
#[derive(Debug, Clone, Default)]
pub struct System {
    pub info: SnmpSysInfo,
    pub uptime_ticks: Option<u32>,
}

/// `sysDescr`, `sysObjectID`, `sysUpTime` and `sysName` of one host.
pub async fn system(
    addr: SocketAddr,
    security: Security,
    timeout: Duration,
    retries: u32,
) -> Result<System> {
    let mut client = Client::new(addr, security, timeout, retries).await?;
    let wanted = [
        oid(SYS_DESCR),
        oid(SYS_OBJECT_ID),
        oid(SYS_UPTIME),
        oid(SYS_NAME),
    ];
    let values = client.get(&wanted).await?;
    let mut out = System::default();
    for (o, v) in values {
        let text = v.as_text();
        match o.to_string().as_str() {
            SYS_DESCR => out.info.sys_descr = text.map(|t| t.chars().take(1000).collect()),
            SYS_OBJECT_ID => out.info.sys_object_id = text,
            SYS_NAME => out.info.sys_name = text.map(|t| t.chars().take(255).collect()),
            SYS_UPTIME => {
                if let ber::Value::TimeTicks(t) = v {
                    out.uptime_ticks = Some(t);
                }
            }
            _ => {}
        }
    }
    Ok(out)
}

fn target_addr(target: &SnmpTarget) -> Result<SocketAddr> {
    let ip: IpAddr = target.ip.parse().context("invalid device address")?;
    Ok(SocketAddr::new(ip, target.port))
}

/// `Command::SnmpTest`: one system query through this probe.
pub async fn test(target: SnmpTarget) -> serde_json::Value {
    let outcome = async {
        let addr = target_addr(&target)?;
        let security =
            tokio::task::spawn_blocking(move || Security::from_credential(&target.credential))
                .await??;
        system(addr, security, Duration::from_secs(3), 1).await
    }
    .await;
    match outcome {
        Ok(s) => json!({
            "ok": true, "sys_descr": s.info.sys_descr, "sys_name": s.info.sys_name,
            "sys_object_id": s.info.sys_object_id, "uptime_secs": s.uptime_ticks.map(|t| t / 100),
        }),
        Err(e) => json!({ "ok": false, "error": format!("{e:#}") }),
    }
}

/// Reads every configured OID of one device. `Err` means the device did not answer at all.
pub async fn poll(target: &SnmpTarget, security: Security) -> Result<SnmpSample> {
    let addr = target_addr(target)?;
    let mut client = Client::new(addr, security, Duration::from_secs(2), 1).await?;
    let mut values = Vec::new();
    let mut reached = false;
    let mut last_error: Option<anyhow::Error> = None;
    let scalars: Vec<(&str, Oid)> = target
        .oids
        .iter()
        .filter(|o| !o.table)
        .filter_map(|o| Oid::parse(&o.oid).ok().map(|p| (o.key.as_str(), p)))
        .collect();
    for chunk in scalars.chunks(10) {
        let oids: Vec<Oid> = chunk.iter().map(|(_, o)| o.clone()).collect();
        match client.get(&oids).await {
            Ok(found) => {
                reached = true;
                for (o, v) in found {
                    for (key, _) in chunk.iter().filter(|(_, w)| *w == o) {
                        values.push(SnmpValue {
                            key: (*key).to_string(),
                            index: None,
                            value: v.to_json(),
                            kind: v.kind().to_string(),
                        });
                    }
                }
            }
            Err(e) if !reached => last_error = Some(e),
            Err(_) => {}
        }
        if !reached && last_error.is_some() {
            break;
        }
    }
    if reached || scalars.is_empty() {
        for column in target.oids.iter().filter(|o| o.table) {
            let Ok(root) = Oid::parse(&column.oid) else {
                continue;
            };
            match client.walk(&root, MAX_TABLE_ROWS).await {
                Ok(rows) => {
                    reached = true;
                    for (o, v) in rows {
                        values.push(SnmpValue {
                            key: column.key.clone(),
                            index: Some(o.suffix(&root)),
                            value: v.to_json(),
                            kind: v.kind().to_string(),
                        });
                    }
                }
                Err(e) if !reached => {
                    last_error = Some(e);
                    break;
                }
                Err(_) => {}
            }
        }
    }
    if !reached {
        return Err(last_error.unwrap_or_else(|| anyhow::anyhow!("no response")));
    }
    Ok(SnmpSample {
        device_id: target.id.clone(),
        at: chrono::Utc::now().timestamp_millis(),
        values,
    })
}

// ------------------------------------------------------------------ poller

/// Cheap handle used by connections to hand over a verified configuration.
#[derive(Clone)]
pub struct Handle {
    tx: mpsc::Sender<SnmpConfig>,
}

impl Handle {
    pub fn apply(&self, config: SnmpConfig) -> bool {
        self.tx.try_send(config).is_ok()
    }
}

struct Device {
    target: SnmpTarget,
    fingerprint: String,
    security: Option<Arc<Security>>,
    next: Instant,
}

fn fingerprint(credential: &SnmpCredential) -> String {
    let bytes = rmp_serde::to_vec(credential).unwrap_or_default();
    rustrmm_crypto::random::sha256_hex(&bytes)
}

/// Starts the poller; it runs until `shutdown`, with an empty configuration until the server
/// sends one.
pub fn spawn(shutdown: CancellationToken) -> Handle {
    let (tx, rx) = mpsc::channel(8);
    tokio::spawn(run(rx, shutdown));
    Handle { tx }
}

async fn run(mut rx: mpsc::Receiver<SnmpConfig>, shutdown: CancellationToken) {
    let mut devices: HashMap<String, Device> = HashMap::new();
    let mut trap: Option<(u16, CancellationToken)> = None;
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    type Done = (
        String,
        Option<(String, Arc<Security>)>,
        Result<SnmpSample, String>,
    );
    let (done_tx, mut done_rx) = mpsc::channel::<Done>(256);
    let permits = Arc::new(Semaphore::new(MAX_PARALLEL_POLLS));
    let mut in_flight: HashSet<String> = HashSet::new();
    let mut results = SnmpResults::default();
    loop {
        tokio::select! {
            _ = shutdown.cancelled() => {
                if let Some((_, token)) = trap.take() { token.cancel(); }
                return;
            }
            Some(config) = rx.recv() => {
                if config.devices.is_empty() && !config.trap_receiver.enabled {
                    if !devices.is_empty() || trap.is_some() {
                        tracing::info!("SNMP polling stopped");
                    }
                } else {
                    tracing::info!(devices = config.devices.len(), trap_receiver = config.trap_receiver.enabled, "SNMP configuration applied");
                }
                let mut next: HashMap<String, Device> = HashMap::new();
                for target in config.devices {
                    let fp = fingerprint(&target.credential);
                    let interval = target.poll_interval_secs.clamp(MIN_POLL_SECS, MAX_POLL_SECS);
                    let previous = devices.remove(&target.id);
                    let (security, due) = match previous {
                        Some(p) if p.fingerprint == fp => (p.security, p.next.min(Instant::now() + Duration::from_secs(u64::from(interval)))),
                        _ => (None, Instant::now()),
                    };
                    next.insert(target.id.clone(), Device { target, fingerprint: fp, security, next: due });
                }
                devices = next;
                let wanted = config.trap_receiver.enabled.then_some(config.trap_receiver.port);
                if trap.as_ref().map(|(p, _)| *p) != wanted {
                    if let Some((_, token)) = trap.take() { token.cancel(); }
                    if let Some(port) = wanted {
                        let token = shutdown.child_token();
                        tokio::spawn(trap_receiver(port, token.clone()));
                        trap = Some((port, token));
                    }
                }
            }
            _ = tick.tick() => {
                let now = Instant::now();
                for (id, device) in devices.iter_mut() {
                    if device.next > now || in_flight.contains(id) {
                        continue;
                    }
                    let interval = device.target.poll_interval_secs.clamp(MIN_POLL_SECS, MAX_POLL_SECS);
                    device.next = now + Duration::from_secs(u64::from(interval));
                    in_flight.insert(id.clone());
                    let target = device.target.clone();
                    let cached = device.security.clone();
                    let fp = device.fingerprint.clone();
                    let done = done_tx.clone();
                    let permits = permits.clone();
                    tokio::spawn(async move {
                        let _permit = permits.acquire_owned().await;
                        let derived = cached.is_none();
                        let security = match cached {
                            Some(s) => Ok(s),
                            None => {
                                let credential = target.credential.clone();
                                match tokio::task::spawn_blocking(move || Security::from_credential(&credential)).await {
                                    Ok(Ok(s)) => Ok(Arc::new(s)),
                                    Ok(Err(e)) => Err(format!("{e:#}")),
                                    Err(e) => Err(e.to_string()),
                                }
                            }
                        };
                        let (outcome, keep) = match security {
                            Ok(s) => (
                                poll(&target, s.clone_ref()).await.map_err(|e| format!("{e:#}")),
                                derived.then_some((fp, s)),
                            ),
                            Err(e) => (Err(e), None),
                        };
                        let _ = done.send((target.id.clone(), keep, outcome)).await;
                    });
                }
                if !results.samples.is_empty() || !results.unreachable.is_empty() {
                    crate::outbox::push(&std::mem::take(&mut results));
                }
            }
            Some((id, keep, outcome)) = done_rx.recv() => {
                in_flight.remove(&id);
                let Some(device) = devices.get_mut(&id) else {
                    continue;
                };
                // Keep derived SNMPv3 keys while the credential is unchanged.
                if let Some((fp, security)) = keep
                    && fp == device.fingerprint
                {
                    device.security = Some(security);
                }
                match outcome {
                    Ok(sample) => results.samples.push(sample),
                    Err(e) => {
                        tracing::debug!(device = %id, error = %e, "SNMP device did not answer");
                        results.unreachable.push(id);
                    }
                }
            }
        }
    }
}

/// Receives traps and informs on UDP `port` until cancelled.
async fn trap_receiver(port: u16, token: CancellationToken) {
    let socket = match tokio::net::UdpSocket::bind(("0.0.0.0", port)).await {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(port, error = %e, "the SNMP trap receiver could not listen");
            return;
        }
    };
    tracing::info!(port, "SNMP trap receiver listening");
    let mut buf = vec![0u8; ber::MAX_MESSAGE];
    let mut window = Instant::now();
    let mut count = 0u32;
    loop {
        tokio::select! {
            _ = token.cancelled() => return,
            received = socket.recv_from(&mut buf) => {
                let Ok((n, from)) = received else { continue };
                if window.elapsed() >= Duration::from_secs(1) {
                    window = Instant::now();
                    count = 0;
                }
                count += 1;
                if count > MAX_TRAPS_PER_SEC {
                    continue;
                }
                match trap::decode(&buf[..n], from.ip(), chrono::Utc::now().timestamp_millis()) {
                    Ok(decoded) => {
                        if let Some(reply) = decoded.reply {
                            let _ = socket.send_to(&reply, from).await;
                        }
                        crate::outbox::push(&decoded.trap);
                    }
                    Err(e) => tracing::debug!(from = %from, error = %format!("{e:#}"), "ignored an SNMP datagram"),
                }
            }
        }
    }
}

/// Self-test: BER and USM round trips plus a v2c exchange with an in-process agent on
/// loopback (no network beyond 127.0.0.1).
pub async fn selftest() -> Result<String> {
    // BER and an authenticated, encrypted SNMPv3 message.
    let request = pdu::Pdu::request(ber::GET_REQUEST, 42, &[oid(SYS_DESCR), oid(SYS_NAME)]);
    let v3 = rustrmm_proto::network::SnmpV3 {
        username: "selftest".into(),
        auth: "sha256".into(),
        auth_password: "selftest-auth".into(),
        privacy: "aes128".into(),
        privacy_password: "selftest-priv".into(),
    };
    let user = usm::User::new(&v3)?;
    let keys = user.localize(b"\x80\x00\x1f\x88\x04selftest");
    let bytes = usm::build_request(
        7,
        &user,
        &keys,
        b"\x80\x00\x1f\x88\x04selftest",
        1,
        100,
        [1; 8],
        &request.encode(),
    )?;
    let (_, back, authenticated) = usm::open(&bytes, &keys)?;
    anyhow::ensure!(
        authenticated && back == pdu::AnyPdu::Pdu(request),
        "SNMPv3 round trip mismatch"
    );

    // A v2c Get against a loopback responder.
    let socket = tokio::net::UdpSocket::bind("127.0.0.1:0").await?;
    let addr = socket.local_addr()?;
    let responder = tokio::spawn(async move {
        let mut buf = vec![0u8; 4096];
        let (n, from) = socket.recv_from(&mut buf).await?;
        let msg = pdu::decode_community(&buf[..n])?;
        let pdu::AnyPdu::Pdu(req) = msg.pdu else {
            anyhow::bail!("unexpected PDU");
        };
        let response = pdu::Pdu {
            tag: ber::RESPONSE,
            request_id: req.request_id,
            error_status: 0,
            error_index: 0,
            varbinds: req
                .varbinds
                .iter()
                .map(|(o, _)| {
                    (
                        o.clone(),
                        ber::Value::OctetString(b"RustRMM selftest".to_vec()),
                    )
                })
                .collect(),
        };
        socket
            .send_to(
                &pdu::encode_community(1, &msg.community, &response.encode()),
                from,
            )
            .await?;
        Ok(())
    });
    let security = Security::from_credential(&SnmpCredential {
        version: "v2c".into(),
        community: Some("selftest".into()),
        v3: None,
    })?;
    let mut client = Client::new(addr, security, Duration::from_secs(2), 1).await?;
    let values = client.get(&[oid(SYS_DESCR)]).await?;
    responder.await??;
    anyhow::ensure!(
        values.first().and_then(|(_, v)| v.as_text()).as_deref() == Some("RustRMM selftest"),
        "unexpected SNMP answer"
    );
    Ok(format!(
        "BER/USM round trip ({} octets, SHA-256 + AES-128) and a v2c Get over loopback",
        bytes.len()
    ))
}
