//! Noise IK end-to-end channel over a real socket: negotiation, wrapped command round trip, a
//! tunnel over Noise, rekeying under a small threshold, key-pin mismatch refusal and legacy
//! agents without the capability.

use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use axum::extract::ws::Message as AxumMessage;
use clap::Parser;
use futures::{SinkExt, StreamExt};
use rustrmm_crypto::sign::SigningKey;
use rustrmm_proto::commands::{Command, CommandPayload, CommandResult, SignedCommand};
use rustrmm_proto::deploy::{EnrollRequest, EnrollResponse};
use rustrmm_proto::handshake::{self, Challenge, Hello, Proof, Rejected, Welcome};
use rustrmm_proto::messages::{InventoryAck, InventorySection};
use rustrmm_proto::noise::tungstenite::NoiseSocket;
use rustrmm_proto::noise::{self, NoiseAccept, NoiseError, NoiseStats, StaticKeypair};
use rustrmm_proto::remote::{OpenTunnel, TUNNEL_TOKEN_HEADER, TunnelControl, TunnelKind};
use rustrmm_proto::{Frame, Message as _};
use rustrmm_server::agents::{commands, tunnels};
use rustrmm_server::state::AppState;
use serde_json::json;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

type RawWs =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
type Channel = NoiseSocket<RawWs>;

struct Harness {
    state: AppState,
    addr: SocketAddr,
    _dir: tempfile::TempDir,
}

async fn harness(extra: &[&str]) -> Harness {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut args = vec![
        "rustrmm-server",
        "--data-dir",
        dir.path().to_str().expect("utf8"),
        "--tls-mode",
        "proxy",
        "--console-url",
        "https://rmm.test",
    ];
    args.extend_from_slice(extra);
    let args = rustrmm_server::config::Cli::parse_from(args).serve;
    let prepared = rustrmm_server::prepare(args, false).await.expect("prepare");
    let state = prepared.state.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    let router = rustrmm_server::listeners::agent_router(state.clone());
    tokio::spawn(async move {
        axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .expect("serve");
    });
    Harness {
        state,
        addr,
        _dir: dir,
    }
}

async fn enroll(h: &Harness, key: &SigningKey, serial: &str) -> String {
    let now = rustrmm_common::now();
    let (client, site, token) = (
        rustrmm_common::new_id(),
        rustrmm_common::new_id(),
        rustrmm_common::new_id(),
    );
    sqlx::query("INSERT INTO clients (id, name, slug, notes, created_at, updated_at) VALUES (?, ?, ?, '', ?, ?)")
        .bind(&client)
        .bind(format!("Client {client}"))
        .bind(format!("client-{client}"))
        .bind(now)
        .bind(now)
        .execute(&h.state.db)
        .await
        .expect("client");
    sqlx::query(
        "INSERT INTO sites (id, client_id, name, created_at, updated_at) VALUES (?, ?, 'HQ', ?, ?)",
    )
    .bind(&site)
    .bind(&client)
    .bind(now)
    .bind(now)
    .execute(&h.state.db)
    .await
    .expect("site");
    let secret = rustrmm_crypto::random::token()[..24].to_string();
    sqlx::query(
        "INSERT INTO enrollment_tokens (id, site_id, name, secret_hash, secret, require_approval, created_at) VALUES (?, ?, 'test', ?, ?, 0, ?)",
    )
    .bind(&token)
    .bind(&site)
    .bind(rustrmm_crypto::random::sha256_hex(secret.as_bytes()))
    .bind(h.state.cipher.encrypt_str(&secret, &rustrmm_server::agents::enroll::secret_aad(&token)))
    .bind(now)
    .execute(&h.state.db)
    .await
    .expect("token");
    let body: EnrollResponse = reqwest::Client::new()
        .post(format!("http://{}/agent/v1/enroll", h.addr))
        .json(&EnrollRequest {
            secret,
            public_key: key.public_key().to_string(),
            hostname: format!("WS-{serial}"),
            os_family: "windows".into(),
            os_name: "Windows 11 Pro".into(),
            os_version: "10.0.26100".into(),
            arch: "x86_64".into(),
            hardware_uuid: Some(format!("UUID-{serial}")),
            serial: Some(serial.into()),
            domain: None,
            agent_version: "0.1.0".into(),
        })
        .send()
        .await
        .expect("enroll")
        .json()
        .await
        .expect("json");
    assert_eq!(body.status, "active");
    body.device_id
}

async fn next_frame<S>(stream: &mut S) -> Frame
where
    S: futures::Stream<Item = Result<WsMessage, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    loop {
        match tokio::time::timeout(Duration::from_secs(10), stream.next())
            .await
            .expect("frame in time")
            .expect("open")
            .expect("frame")
        {
            WsMessage::Binary(b) => return Frame::decode(&b).expect("decode"),
            WsMessage::Close(_) => panic!("closed"),
            _ => continue,
        }
    }
}

async fn send<S, M>(sink: &mut S, message: &M)
where
    S: futures::Sink<WsMessage, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
    M: rustrmm_proto::Message,
{
    sink.send(WsMessage::Binary(
        rustrmm_proto::encode(message).expect("encode").into(),
    ))
    .await
    .expect("send");
}

/// How the fake agent behaves during the handshake.
#[derive(Default, Clone, Copy)]
struct AgentOptions<'a> {
    /// Advertise the capability with this static key.
    noise: Option<&'a StaticKeypair>,
    /// Server Noise key pinned from an earlier connection.
    pinned: Option<[u8; 32]>,
    /// Start the IK handshake with this key instead of the offered one (a stale pin).
    initiate_with: Option<[u8; 32]>,
    /// A man in the middle removes `noise` from the Hello (downgrade attempt).
    strip_capability: bool,
}

struct Connected {
    channel: Channel,
    welcome: Welcome,
    server_key: Option<[u8; 32]>,
}

enum Outcome {
    Connected(Box<Connected>),
    Rejected(Rejected),
    /// The agent itself refused to continue (pin checks).
    Refused(NoiseError),
}

impl Outcome {
    fn connected(self) -> Connected {
        match self {
            Outcome::Connected(c) => *c,
            Outcome::Rejected(r) => panic!("rejected: {} {}", r.code, r.message),
            Outcome::Refused(e) => panic!("refused: {e}"),
        }
    }
    fn rejected(self) -> Rejected {
        match self {
            Outcome::Rejected(r) => r,
            _ => panic!("expected a rejection"),
        }
    }
}

/// The agent side of the handshake, as `crates/agent/src/connection.rs` runs it.
async fn connect(
    h: &Harness,
    device_id: &str,
    key: &SigningKey,
    opts: AgentOptions<'_>,
) -> Outcome {
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{}/agent/v1/connect", h.addr))
        .await
        .expect("ws");
    let nonce = rustrmm_crypto::random::bytes::<32>().to_vec();
    let mut capabilities = vec!["remote".to_string(), "tunnels".to_string()];
    if opts.noise.is_some() && !opts.strip_capability {
        capabilities.push(noise::CAPABILITY.into());
    }
    send(
        &mut ws,
        &Hello {
            device_id: device_id.into(),
            agent_nonce: nonce.clone(),
            protocol_major: rustrmm_proto::PROTOCOL_MAJOR,
            protocol_minor: rustrmm_proto::PROTOCOL_MINOR,
            agent_version: "0.1.0".into(),
            os_family: "windows".into(),
            hostname: "WS-NOISE".into(),
            capabilities,
        },
    )
    .await;
    let frame = next_frame(&mut ws).await;
    if frame.is::<Rejected>() {
        return Outcome::Rejected(frame.body().expect("rejected"));
    }
    let challenge: Challenge = frame.body().expect("challenge");
    let identity = h.state.keys.identity_public();
    identity
        .verify(
            &handshake::challenge_message(
                &nonce,
                &challenge.server_nonce,
                device_id,
                challenge.server_time,
            ),
            &challenge.signature,
        )
        .expect("server identity");
    let server_key = match opts.noise {
        Some(_) => match noise::accept_offer(
            &identity,
            challenge.noise.as_ref(),
            opts.pinned.as_ref(),
            &nonce,
            &challenge.server_nonce,
            device_id,
        ) {
            Ok(k) => k,
            Err(e) => return Outcome::Refused(e),
        },
        None => {
            assert!(challenge.noise.is_none(), "no offer to legacy agents");
            None
        }
    };
    send(
        &mut ws,
        &Proof {
            signature: key.sign(&handshake::proof_message(
                &challenge.server_nonce,
                &nonce,
                device_id,
            )),
        },
    )
    .await;
    let mut codec = None;
    if let (Some(local), Some(offered)) = (opts.noise, server_key) {
        let target = opts.initiate_with.unwrap_or(offered);
        let (initiator, init) = noise::start_control(
            local,
            key,
            &target,
            &nonce,
            &challenge.server_nonce,
            device_id,
        )
        .expect("start");
        send(&mut ws, &init).await;
        let frame = next_frame(&mut ws).await;
        if frame.is::<Rejected>() {
            return Outcome::Rejected(frame.body().expect("rejected"));
        }
        let accept: NoiseAccept = frame.body().expect("noise_accept");
        codec = Some(initiator.finish(&accept.payload).expect("finish"));
    }
    let mut channel = Channel::new(ws, codec);
    let frame = next_frame(&mut channel).await;
    if frame.is::<Rejected>() {
        return Outcome::Rejected(frame.body().expect("rejected"));
    }
    Outcome::Connected(Box::new(Connected {
        channel,
        welcome: frame.body().expect("welcome"),
        server_key,
    }))
}

/// Dials a tunnel like `crates/agent/src/remote/tunnel.rs`; `None` when the server refuses it.
async fn dial_tunnel(
    addr: SocketAddr,
    open: &OpenTunnel,
    keys: Option<(&StaticKeypair, [u8; 32])>,
) -> Option<Channel> {
    let mut request = format!("ws://{addr}/agent/v1/tunnel/{}", open.tunnel_id)
        .into_client_request()
        .expect("request");
    request
        .headers_mut()
        .insert(TUNNEL_TOKEN_HEADER, open.token.parse().expect("header"));
    let (mut ws, _) = tokio_tungstenite::connect_async(request)
        .await
        .expect("tunnel");
    let Some((local, server)) = keys else {
        return Some(Channel::new(ws, None));
    };
    let (initiator, first) =
        noise::Initiator::start(local, &server, &noise::tunnel_prologue(&open.tunnel_id))
            .expect("start");
    ws.send(WsMessage::Binary(first.into()))
        .await
        .expect("send");
    let reply = loop {
        match ws.next().await {
            Some(Ok(WsMessage::Binary(b))) => break b,
            Some(Ok(WsMessage::Close(_))) | Some(Err(_)) | None => return None,
            _ => continue,
        }
    };
    Some(Channel::new(
        ws,
        Some(initiator.finish(&reply).expect("finish")),
    ))
}

fn file_content() -> Vec<u8> {
    // Larger than one Noise message, so it is split into several transport chunks.
    (0..200_000u32).map(|i| (i % 253) as u8).collect()
}

/// Scripted agent: answers pings and serves a download tunnel (over Noise when `keys` is set).
fn spawn_agent(
    channel: Channel,
    state: AppState,
    addr: SocketAddr,
    keys: Option<(StaticKeypair, [u8; 32])>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let command_key = state.keys.command.public_key();
        let (mut sink, mut stream) = channel.split();
        while let Some(Ok(msg)) = stream.next().await {
            let WsMessage::Binary(bytes) = msg else {
                continue;
            };
            let frame = Frame::decode(&bytes).expect("frame");
            if frame.t != SignedCommand::TYPE {
                continue;
            }
            let signed: SignedCommand = frame.body().expect("signed");
            command_key
                .verify(
                    &rustrmm_proto::commands::command_signing_bytes(&signed.payload),
                    &signed.signature,
                )
                .expect("signed by the command key");
            let payload: CommandPayload = rmp_serde::from_slice(&signed.payload).expect("payload");
            let reply = |status: &str| CommandResult {
                cmd_id: payload.cmd_id.clone(),
                status: status.into(),
                message: String::new(),
                data: json!({ "pong": true }),
            };
            match payload.command {
                Command::Ping => send(&mut sink, &reply("succeeded")).await,
                Command::OpenTunnel(open) => {
                    let Some(mut tunnel) =
                        dial_tunnel(addr, &open, keys.as_ref().map(|(k, s)| (k, *s))).await
                    else {
                        send(&mut sink, &reply("failed")).await;
                        continue;
                    };
                    send(&mut sink, &reply("succeeded")).await;
                    tokio::spawn(async move {
                        let content = file_content();
                        let text = |m: TunnelControl| WsMessage::Text(m.to_text().into());
                        tunnel
                            .send(text(TunnelControl::Meta {
                                name: "big.bin".into(),
                                size: content.len() as u64,
                            }))
                            .await
                            .expect("meta");
                        for chunk in content.chunks(96 * 1024) {
                            tunnel
                                .send(WsMessage::Binary(chunk.to_vec().into()))
                                .await
                                .expect("chunk");
                        }
                        tunnel.send(text(TunnelControl::Eof)).await.expect("eof");
                        let _ = tokio::time::timeout(Duration::from_secs(5), tunnel.next()).await;
                    });
                }
                _ => send(&mut sink, &reply("rejected")).await,
            }
        }
    })
}

async fn ping(state: &AppState, device_id: &str) -> CommandResult {
    commands::request(
        state,
        device_id,
        Command::Ping,
        None,
        "Ping",
        false,
        Duration::from_secs(10),
    )
    .await
    .expect("ping round trip")
}

async fn download(state: &AppState, device_id: &str) -> Vec<u8> {
    let mut socket = tunnels::open(
        state,
        device_id,
        TunnelKind::Download {
            path: "C:\\big.bin".into(),
        },
        "user-test",
        "Download big.bin",
    )
    .await
    .expect("tunnel");
    let mut content = Vec::new();
    loop {
        match tokio::time::timeout(Duration::from_secs(10), socket.recv())
            .await
            .expect("tunnel message in time")
            .expect("open")
            .expect("message")
        {
            AxumMessage::Text(text) => match serde_json::from_str(&text).expect("control") {
                TunnelControl::Meta { size, .. } => assert_eq!(size, 200_000),
                TunnelControl::Eof => break,
                other => panic!("unexpected {other:?}"),
            },
            AxumMessage::Binary(bytes) => content.extend_from_slice(&bytes),
            _ => {}
        }
    }
    let _ = socket.send(AxumMessage::Close(None)).await;
    content
}

#[tokio::test]
async fn handshake_wrapped_commands_and_tunnel_over_noise() {
    // Proxy mode requires the channel by default.
    let h = harness(&[]).await;
    assert!(h.state.args.noise_required());
    let key = SigningKey::generate();
    let device = enroll(&h, &key, "N-1").await;
    let agent_noise = StaticKeypair::generate();

    let connected = connect(
        &h,
        &device,
        &key,
        AgentOptions {
            noise: Some(&agent_noise),
            ..Default::default()
        },
    )
    .await
    .connected();
    assert!(connected.welcome.inventory_hashes.is_empty());
    assert!(connected.channel.is_encrypted());
    let server_key = connected.server_key.expect("offered");
    assert_eq!(server_key, h.state.keys.noise.public_key());

    // The server registered the agent's key (vouched for by the device key) and binds tunnels to it.
    let stored: Option<String> =
        sqlx::query_scalar("SELECT noise_public_key FROM devices WHERE id = ?")
            .bind(&device)
            .fetch_one(&h.state.db)
            .await
            .expect("row");
    assert_eq!(
        stored.as_deref(),
        Some(noise::encode_key(&agent_noise.public_key()).as_str())
    );
    assert_eq!(
        h.state.agents.get(&device).expect("online").noise_static,
        Some(agent_noise.public_key())
    );

    let stats: Arc<NoiseStats> = connected.channel.stats().expect("stats");
    let agent = spawn_agent(
        connected.channel,
        h.state.clone(),
        h.addr,
        Some((agent_noise.clone(), server_key)),
    );
    let result = ping(&h.state, &device).await;
    assert_eq!(result.data["pong"], true);
    assert!(
        stats.received_messages.load(Ordering::Relaxed) >= 2,
        "welcome + command decrypted"
    );
    assert!(
        stats.sent_messages.load(Ordering::Relaxed) >= 1,
        "result encrypted"
    );

    // Tunnel over Noise: a 200 KB download split over several Noise messages per frame.
    assert_eq!(download(&h.state, &device).await, file_content());

    agent.abort();
    tokio::time::sleep(Duration::from_millis(200)).await;

    // A tunnel presenting another static key than its control connection is refused.
    let again = connect(
        &h,
        &device,
        &key,
        AgentOptions {
            noise: Some(&agent_noise),
            pinned: Some(server_key),
            ..Default::default()
        },
    )
    .await
    .connected();
    let impostor = StaticKeypair::generate();
    let agent = spawn_agent(
        again.channel,
        h.state.clone(),
        h.addr,
        Some((impostor, server_key)),
    );
    let refused = tunnels::open(
        &h.state,
        &device,
        TunnelKind::Download { path: "x".into() },
        "user-test",
        "x",
    )
    .await;
    assert!(refused.is_err(), "tunnel with a foreign static key refused");
    agent.abort();
}

#[tokio::test]
async fn plaintext_frames_after_the_handshake_are_refused() {
    let h = harness(&[]).await;
    let key = SigningKey::generate();
    let device = enroll(&h, &key, "N-2").await;
    let agent_noise = StaticKeypair::generate();
    let connected = connect(
        &h,
        &device,
        &key,
        AgentOptions {
            noise: Some(&agent_noise),
            ..Default::default()
        },
    )
    .await
    .connected();
    assert!(h.state.agents.is_online(&device));
    // Bypass the codec: an unwrapped frame cannot be decrypted, so the server drops the session.
    let raw = Channel::new(connected.channel.into_inner(), None);
    let (mut sink, _stream) = raw.split();
    send(
        &mut sink,
        &rustrmm_proto::messages::Heartbeat {
            uptime_s: 1,
            cpu_pct: 1.0,
            mem_pct: 1.0,
            disk_pct: 1.0,
            logged_in_user: None,
        },
    )
    .await;
    for _ in 0..50 {
        if !h.state.agents.is_online(&device) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(!h.state.agents.is_online(&device), "session ended");
}

#[tokio::test]
async fn rekeys_under_a_small_threshold() {
    // Test-only threshold: every codec created from here on rekeys after 1 KiB per direction.
    noise::set_rekey_bytes_for_tests(1024);
    let h = harness(&[]).await;
    let key = SigningKey::generate();
    let device = enroll(&h, &key, "N-3").await;
    let agent_noise = StaticKeypair::generate();
    let connected = connect(
        &h,
        &device,
        &key,
        AgentOptions {
            noise: Some(&agent_noise),
            ..Default::default()
        },
    )
    .await
    .connected();
    let stats = connected.channel.stats().expect("stats");
    let (mut sink, mut stream) = connected.channel.split();
    // Agent → server: 20 inventory sections of ~1.5 KB, each acknowledged by the server.
    for i in 0..20 {
        send(
            &mut sink,
            &InventorySection {
                section: "system".into(),
                hash: format!("h{i}"),
                data: json!({ "hostname": "WS-NOISE", "pad": format!("{i}{}", "x".repeat(1500)) }),
            },
        )
        .await;
        let ack: InventoryAck = loop {
            let frame = next_frame(&mut stream).await;
            if frame.t == InventoryAck::TYPE {
                break frame.body().expect("ack");
            }
        };
        assert_eq!(ack.hash, format!("h{i}"));
    }
    let channel = sink.reunite(stream).expect("reunite");
    let agent = spawn_agent(channel, h.state.clone(), h.addr, None);
    // Server → agent: signed commands until the server has rekeyed several times.
    for _ in 0..12 {
        ping(&h.state, &device).await;
    }
    let sent = stats.sent_rekeys.load(Ordering::Relaxed);
    let received = stats.received_rekeys.load(Ordering::Relaxed);
    assert!(sent >= 10, "agent rekeyed its sending key {sent} times");
    assert!(
        received >= 2,
        "server rekeyed its sending key {received} times"
    );
    agent.abort();
}

#[tokio::test]
async fn pinned_key_mismatch_is_refused() {
    let h = harness(&[]).await;
    let key = SigningKey::generate();
    let device = enroll(&h, &key, "N-4").await;
    let agent_noise = StaticKeypair::generate();

    // First use pins the key.
    let first = connect(
        &h,
        &device,
        &key,
        AgentOptions {
            noise: Some(&agent_noise),
            ..Default::default()
        },
    )
    .await
    .connected();
    let pinned = first.server_key.expect("offered");
    drop(first);
    tokio::time::sleep(Duration::from_millis(200)).await;

    // The agent refuses a server whose (validly signed) Noise key differs from its pin…
    let other = StaticKeypair::generate().public_key();
    match connect(
        &h,
        &device,
        &key,
        AgentOptions {
            noise: Some(&agent_noise),
            pinned: Some(other),
            ..Default::default()
        },
    )
    .await
    {
        Outcome::Refused(NoiseError::PinMismatch) => {}
        _ => panic!("pin mismatch must be refused"),
    }

    // …and the server refuses an agent that starts the handshake with a stale key.
    let rejected = connect(
        &h,
        &device,
        &key,
        AgentOptions {
            noise: Some(&agent_noise),
            pinned: Some(pinned),
            initiate_with: Some(other),
            ..Default::default()
        },
    )
    .await
    .rejected();
    assert_eq!(rejected.code, "noise_failed");
    let events: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM device_timeline WHERE device_id = ? AND kind = 'agent.noise_failed'",
    )
    .bind(&device)
    .fetch_one(&h.state.db)
    .await
    .expect("timeline");
    assert_eq!(events, 1);

    // With the right pin everything works again.
    let again = connect(
        &h,
        &device,
        &key,
        AgentOptions {
            noise: Some(&agent_noise),
            pinned: Some(pinned),
            ..Default::default()
        },
    )
    .await
    .connected();
    assert!(again.channel.is_encrypted());
}

#[tokio::test]
async fn legacy_agents_without_noise() {
    // Proxy mode (default `required`): a legacy agent is refused with a clear code.
    let strict = harness(&[]).await;
    let key = SigningKey::generate();
    let device = enroll(&strict, &key, "N-5").await;
    let rejected = connect(&strict, &device, &key, AgentOptions::default())
        .await
        .rejected();
    assert_eq!(rejected.code, "noise_required");

    // `--agent-noise auto` (the default in internal/custom TLS mode) keeps legacy agents working.
    let h = harness(&["--agent-noise", "auto"]).await;
    assert!(!h.state.args.noise_required());
    let key = SigningKey::generate();
    let device = enroll(&h, &key, "N-6").await;
    let legacy = connect(&h, &device, &key, AgentOptions::default())
        .await
        .connected();
    assert!(!legacy.channel.is_encrypted());
    assert_eq!(
        h.state.agents.get(&device).expect("online").noise_static,
        None
    );
    let agent = spawn_agent(legacy.channel, h.state.clone(), h.addr, None);
    ping(&h.state, &device).await;
    // Tunnels of a legacy connection stay plain too.
    assert_eq!(download(&h.state, &device).await, file_content());
    agent.abort();

    // A pinned agent refuses a session without the channel: a man in the middle stripping the
    // capability from the Hello makes the server omit the offer, which the agent treats as a
    // downgrade.
    let noise_key = StaticKeypair::generate();
    match connect(
        &h,
        &device,
        &key,
        AgentOptions {
            noise: Some(&noise_key),
            pinned: Some(h.state.keys.noise.public_key()),
            strip_capability: true,
            ..Default::default()
        },
    )
    .await
    {
        Outcome::Refused(NoiseError::Downgrade) => {}
        _ => panic!("downgrade must be refused"),
    }

    // Internal TLS mode defaults to `auto`.
    let internal = rustrmm_server::config::Cli::parse_from(["rustrmm-server"]).serve;
    assert!(!internal.noise_required());
}
