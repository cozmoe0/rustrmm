//! Remote tools end to end with a scripted agent over real sockets: signed request/response
//! commands (success and refusal), and a tunnel download through `/agent/v1/tunnel/{id}`
//! including rejection of a wrong tunnel token.

use std::net::SocketAddr;
use std::time::Duration;

use clap::Parser;
use futures::{SinkExt, StreamExt};
use rustrmm_crypto::sign::SigningKey;
use rustrmm_proto::commands::{
    Command, CommandPayload, CommandResult, SignedCommand, command_signing_bytes,
};
use rustrmm_proto::deploy::{EnrollRequest, EnrollResponse};
use rustrmm_proto::handshake::{self, Challenge, Hello, Proof, Welcome};
use rustrmm_proto::remote::{TUNNEL_TOKEN_HEADER, TunnelControl, TunnelKind};
use rustrmm_proto::{Frame, Message as _};
use rustrmm_server::agents::commands::{self, RequestError};
use rustrmm_server::state::AppState;
use serde_json::json;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn start() -> (AppState, SocketAddr, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("tempdir");
    let args = rustrmm_server::config::Cli::parse_from([
        "rustrmm-server",
        "--data-dir",
        dir.path().to_str().expect("utf8"),
        "--tls-mode",
        "proxy",
        "--agent-noise",
        "auto",
        "--console-url",
        "https://rmm.test",
    ])
    .serve;
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
    (state, addr, dir)
}

async fn enroll(state: &AppState, addr: SocketAddr, key: &SigningKey) -> String {
    let now = rustrmm_common::now();
    let (client, site, token_id) = (
        rustrmm_common::new_id(),
        rustrmm_common::new_id(),
        rustrmm_common::new_id(),
    );
    sqlx::query("INSERT INTO clients (id, name, slug, notes, created_at, updated_at) VALUES (?, 'Remote Co', 'remote-co', '', ?, ?)")
        .bind(&client).bind(now).bind(now).execute(&state.db).await.expect("client");
    sqlx::query(
        "INSERT INTO sites (id, client_id, name, created_at, updated_at) VALUES (?, ?, 'HQ', ?, ?)",
    )
    .bind(&site)
    .bind(&client)
    .bind(now)
    .bind(now)
    .execute(&state.db)
    .await
    .expect("site");
    let secret = rustrmm_crypto::random::token()[..24].to_string();
    sqlx::query("INSERT INTO enrollment_tokens (id, site_id, name, secret_hash, secret, require_approval, created_at) VALUES (?, ?, 't', ?, ?, 0, ?)")
        .bind(&token_id)
        .bind(&site)
        .bind(rustrmm_crypto::random::sha256_hex(secret.as_bytes()))
        .bind(state.cipher.encrypt_str(&secret, &rustrmm_server::agents::enroll::secret_aad(&token_id)))
        .bind(now)
        .execute(&state.db)
        .await
        .expect("token");
    let resp: EnrollResponse = reqwest::Client::new()
        .post(format!("http://{addr}/agent/v1/enroll"))
        .json(&EnrollRequest {
            secret,
            public_key: key.public_key().to_string(),
            hostname: "WS-REMOTE".into(),
            os_family: "windows".into(),
            os_name: "Windows 11 Pro".into(),
            os_version: "10.0.26100".into(),
            arch: "x86_64".into(),
            hardware_uuid: Some("UUID-REMOTE".into()),
            serial: Some("SN-REMOTE".into()),
            domain: None,
            agent_version: "0.1.0".into(),
        })
        .send()
        .await
        .expect("enroll")
        .json()
        .await
        .expect("json");
    assert_eq!(resp.status, "active");
    resp.device_id
}

async fn recv(ws: &mut Ws) -> Frame {
    loop {
        match ws.next().await.expect("open").expect("frame") {
            WsMessage::Binary(b) => return Frame::decode(&b).expect("decode"),
            WsMessage::Close(_) => panic!("closed"),
            _ => continue,
        }
    }
}

async fn connect(state: &AppState, addr: SocketAddr, device_id: &str, key: &SigningKey) -> Ws {
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/agent/v1/connect"))
        .await
        .expect("ws");
    let nonce = rustrmm_crypto::random::bytes::<32>().to_vec();
    let hello = Hello {
        device_id: device_id.into(),
        agent_nonce: nonce.clone(),
        protocol_major: rustrmm_proto::PROTOCOL_MAJOR,
        protocol_minor: rustrmm_proto::PROTOCOL_MINOR,
        agent_version: "0.1.0".into(),
        os_family: "windows".into(),
        hostname: "WS-REMOTE".into(),
        capabilities: vec!["remote".into(), "tunnels".into()],
    };
    ws.send(WsMessage::Binary(
        rustrmm_proto::encode(&hello).expect("hello").into(),
    ))
    .await
    .expect("send");
    let challenge: Challenge = recv(&mut ws).await.body().expect("challenge");
    let signed = handshake::challenge_message(
        &nonce,
        &challenge.server_nonce,
        device_id,
        challenge.server_time,
    );
    state
        .keys
        .identity_public()
        .verify(&signed, &challenge.signature)
        .expect("identity");
    let proof = Proof {
        signature: key.sign(&handshake::proof_message(
            &challenge.server_nonce,
            &nonce,
            device_id,
        )),
    };
    ws.send(WsMessage::Binary(
        rustrmm_proto::encode(&proof).expect("proof").into(),
    ))
    .await
    .expect("send");
    let _welcome: Welcome = recv(&mut ws).await.body().expect("welcome");
    ws
}

/// Scripted agent: answers list_processes, refuses kill_process, serves a download tunnel.
async fn fake_agent(mut ws: Ws, state: AppState, addr: SocketAddr) {
    let command_key = state.keys.command.public_key();
    loop {
        let Some(Ok(msg)) = ws.next().await else {
            return;
        };
        let WsMessage::Binary(bytes) = msg else {
            continue;
        };
        let frame = Frame::decode(&bytes).expect("frame");
        if frame.t != SignedCommand::TYPE {
            continue;
        }
        let signed: SignedCommand = frame.body().expect("signed");
        command_key
            .verify(&command_signing_bytes(&signed.payload), &signed.signature)
            .expect("command is signed by the server's command key");
        let payload: CommandPayload = rmp_serde::from_slice(&signed.payload).expect("payload");
        let reply = |status: &str, message: &str, data: serde_json::Value| CommandResult {
            cmd_id: payload.cmd_id.clone(),
            status: status.into(),
            message: message.into(),
            data,
        };
        let result = match payload.command {
            Command::ListProcesses => reply(
                "succeeded",
                "",
                json!({ "count": 1, "items": [{ "pid": 42, "name": "notepad.exe" }] }),
            ),
            Command::KillProcess { .. } => {
                reply("failed", "access denied", serde_json::Value::Null)
            }
            Command::OpenTunnel(open) => {
                // Wrong token first: the broker must refuse it without burning the tunnel.
                let mut bad = format!("ws://{addr}/agent/v1/tunnel/{}", open.tunnel_id)
                    .into_client_request()
                    .expect("request");
                bad.headers_mut().insert(
                    TUNNEL_TOKEN_HEADER,
                    "not-the-token".parse().expect("header"),
                );
                assert!(
                    tokio_tungstenite::connect_async(bad).await.is_err(),
                    "wrong token refused"
                );

                let mut request = format!("ws://{addr}/agent/v1/tunnel/{}", open.tunnel_id)
                    .into_client_request()
                    .expect("request");
                request
                    .headers_mut()
                    .insert(TUNNEL_TOKEN_HEADER, open.token.parse().expect("header"));
                let (mut tunnel, _) = tokio_tungstenite::connect_async(request)
                    .await
                    .expect("tunnel");
                assert!(matches!(open.kind, TunnelKind::Download { .. }));
                tokio::spawn(async move {
                    let send_text = |m: TunnelControl| WsMessage::Text(m.to_text().into());
                    tunnel
                        .send(send_text(TunnelControl::Meta {
                            name: "report.txt".into(),
                            size: 11,
                        }))
                        .await
                        .expect("meta");
                    tunnel
                        .send(WsMessage::Binary(b"hello world".to_vec().into()))
                        .await
                        .expect("data");
                    tunnel
                        .send(send_text(TunnelControl::Eof))
                        .await
                        .expect("eof");
                    let _ = tunnel.next().await;
                });
                reply("succeeded", "tunnel connected", serde_json::Value::Null)
            }
            _ => reply("rejected", "unsupported in test", serde_json::Value::Null),
        };
        ws.send(WsMessage::Binary(
            rustrmm_proto::encode(&result).expect("result").into(),
        ))
        .await
        .expect("send result");
    }
}

#[tokio::test]
async fn request_response_and_tunnels() {
    let (state, addr, _dir) = start().await;
    let key = SigningKey::generate();
    let device_id = enroll(&state, addr, &key).await;

    // Offline devices fail fast.
    let offline = commands::request(
        &state,
        &device_id,
        Command::ListProcesses,
        None,
        "List",
        false,
        Duration::from_secs(2),
    )
    .await;
    assert!(matches!(offline, Err(RequestError::Offline)));

    let ws = connect(&state, addr, &device_id, &key).await;
    tokio::spawn(fake_agent(ws, state.clone(), addr));

    let listed = commands::request(
        &state,
        &device_id,
        Command::ListProcesses,
        None,
        "List processes",
        false,
        Duration::from_secs(5),
    )
    .await
    .expect("processes");
    assert_eq!(listed.data["items"][0]["name"], "notepad.exe");
    let recorded: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM commands WHERE kind = 'list_processes'")
            .fetch_one(&state.db)
            .await
            .expect("count");
    assert_eq!(
        recorded, 0,
        "read-only queries are not written to command history"
    );

    let refused = commands::request(
        &state,
        &device_id,
        Command::KillProcess {
            pid: 42,
            tree: false,
        },
        None,
        "Terminate process 42",
        true,
        Duration::from_secs(5),
    )
    .await;
    match refused {
        Err(RequestError::Refused(message)) => assert_eq!(message, "access denied"),
        other => panic!("expected refusal, got {other:?}"),
    }
    let status: String =
        sqlx::query_scalar("SELECT status FROM commands WHERE kind = 'kill_process'")
            .fetch_one(&state.db)
            .await
            .expect("kill row");
    assert_eq!(
        status, "failed",
        "state-changing commands are recorded with their outcome"
    );

    let mut tunnel = rustrmm_server::agents::tunnels::open(
        &state,
        &device_id,
        TunnelKind::Download {
            path: "C:\\reports\\report.txt".into(),
        },
        "test-user",
        "Download report",
    )
    .await
    .expect("tunnel opens");
    use axum::extract::ws::Message;
    let mut text = Vec::new();
    let mut data = Vec::new();
    while let Some(Ok(msg)) = tokio::time::timeout(Duration::from_secs(5), tunnel.recv())
        .await
        .expect("tunnel traffic")
    {
        match msg {
            Message::Text(t) => {
                let control: TunnelControl = serde_json::from_str(&t).expect("control");
                let eof = control == TunnelControl::Eof;
                text.push(control);
                if eof {
                    break;
                }
            }
            Message::Binary(b) => data.extend_from_slice(&b),
            _ => {}
        }
    }
    assert_eq!(
        text.first(),
        Some(&TunnelControl::Meta {
            name: "report.txt".into(),
            size: 11
        })
    );
    assert_eq!(data, b"hello world");
}
