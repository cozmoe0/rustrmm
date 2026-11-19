//! Remote desktop end to end (Phase 8) with a scripted agent and a browser socket over real
//! listeners: a desktop session needs step-up, the agent receives a signed `OpenTunnel` of kind
//! `Desktop`, frames flow to the browser, view-only drops input, a `remote_access.desktop: false`
//! policy refuses with `disabled_by_policy`, and a denied consent ends the session and is
//! recorded. The session list and screenshot routes are exercised too.

use std::net::SocketAddr;
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode, header};
use clap::Parser;
use futures::{SinkExt, StreamExt};
use http_body_util::BodyExt;
use rustrmm_crypto::sign::SigningKey;
use rustrmm_proto::commands::{
    Command, CommandPayload, CommandResult, SignedCommand, command_signing_bytes,
};
use rustrmm_proto::deploy::{EnrollRequest, EnrollResponse};
use rustrmm_proto::desktop::{
    ConsentMode, ConsentStatus, DesktopControl, Media, MonitorInfo, Quality, encoding, tile_message,
};
use rustrmm_proto::handshake::{self, Challenge, Hello, Proof, Welcome};
use rustrmm_proto::remote::{TUNNEL_TOKEN_HEADER, TunnelKind};
use rustrmm_proto::{Frame, Message as _};
use rustrmm_server::state::AppState;
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tower::ServiceExt;

const ORIGIN: &str = "https://rmm.test";

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

// ------------------------------------------------------------------ console client

struct Client {
    router: Router,
    cookie: Option<String>,
    csrf: Option<String>,
}

impl Client {
    async fn call(
        &mut self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value, Vec<u8>) {
        let mut req = Request::builder()
            .method(method)
            .uri(path)
            .header(header::ORIGIN, ORIGIN);
        if let Some(cookie) = &self.cookie {
            req = req.header(header::COOKIE, cookie);
        }
        if let Some(csrf) = &self.csrf {
            req = req.header("x-csrf-token", csrf);
        }
        let req = match body {
            Some(b) => req
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(b.to_string())),
            None => req.body(Body::empty()),
        }
        .expect("request");
        let response = self.router.clone().oneshot(req).await.expect("response");
        let status = response.status();
        if let Some(set_cookie) = response.headers().get(header::SET_COOKIE) {
            let raw = set_cookie.to_str().expect("cookie").to_string();
            let pair = raw.split(';').next().unwrap_or_default().to_string();
            self.cookie = (!pair.ends_with('=')).then_some(pair);
        }
        let bytes = response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes()
            .to_vec();
        let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        if let Some(csrf) = value
            .pointer("/me/csrf_token")
            .or_else(|| value.pointer("/csrf_token"))
            .and_then(Value::as_str)
        {
            self.csrf = Some(csrf.to_string());
        }
        (status, value, bytes)
    }

    async fn get(&mut self, path: &str) -> (StatusCode, Value) {
        let (s, v, _) = self.call(Method::GET, path, None).await;
        (s, v)
    }

    async fn post(&mut self, path: &str, body: Value) -> (StatusCode, Value) {
        let (s, v, _) = self.call(Method::POST, path, Some(body)).await;
        (s, v)
    }
}

fn totp_code(secret_b32: &str) -> String {
    let secret = data_encoding::BASE32_NOPAD
        .decode(secret_b32.as_bytes())
        .expect("base32");
    let step = (chrono::Utc::now().timestamp() / 30) as u64;
    format!("{:06}", rustrmm_server::auth::totp::code_at(&secret, step))
}

async fn first_login(client: &mut Client, email: &str, password: &str) {
    let (status, body) = client
        .post(
            "/api/v1/auth/login",
            json!({ "email": email, "password": password }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let challenge = body["challenge_token"]
        .as_str()
        .expect("challenge")
        .to_string();
    let (_, setup) = client
        .post(
            "/api/v1/auth/mfa/setup/totp/start",
            json!({ "challenge_token": challenge }),
        )
        .await;
    let secret = setup["secret"].as_str().expect("secret").to_string();
    let (status, done) = client
        .post(
            "/api/v1/auth/mfa/setup/totp/finish",
            json!({ "challenge_token": challenge, "code": totp_code(&secret) }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{done}");
    let (status, me) = client.get("/api/v1/auth/me").await;
    assert_eq!(status, StatusCode::OK, "{me}");
}

async fn set_step_up(state: &AppState, on: bool) {
    let until = on.then(|| rustrmm_common::now() + chrono::Duration::minutes(5));
    sqlx::query("UPDATE sessions SET stepped_up_until = ?")
        .bind(until)
        .execute(&state.db)
        .await
        .expect("step-up");
}

// ------------------------------------------------------------------ server and agent

struct Server {
    state: AppState,
    console: Router,
    agent_addr: SocketAddr,
    console_addr: SocketAddr,
    _dir: tempfile::TempDir,
}

async fn start() -> Server {
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
        ORIGIN,
    ])
    .serve;
    let prepared = rustrmm_server::prepare(args, false).await.expect("prepare");
    let state = prepared.state.clone();
    let serve = |router: Router, listener: tokio::net::TcpListener| {
        tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .expect("serve");
        });
    };
    let agent_listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let agent_addr = agent_listener.local_addr().expect("addr");
    serve(
        rustrmm_server::listeners::agent_router(state.clone()),
        agent_listener,
    );
    let console = rustrmm_server::listeners::console_router(state.clone());
    let console_listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let console_addr = console_listener.local_addr().expect("addr");
    serve(console.clone(), console_listener);
    Server {
        state,
        console,
        agent_addr,
        console_addr,
        _dir: dir,
    }
}

async fn enroll(state: &AppState, addr: SocketAddr, key: &SigningKey) -> String {
    let site_id: String = sqlx::query_scalar("SELECT id FROM sites LIMIT 1")
        .fetch_one(&state.db)
        .await
        .expect("site");
    let token_id = rustrmm_common::new_id();
    let secret = rustrmm_crypto::random::token()[..24].to_string();
    sqlx::query("INSERT INTO enrollment_tokens (id, site_id, name, secret_hash, secret, require_approval, created_at) VALUES (?, ?, 't', ?, ?, 0, ?)")
        .bind(&token_id)
        .bind(&site_id)
        .bind(rustrmm_crypto::random::sha256_hex(secret.as_bytes()))
        .bind(state.cipher.encrypt_str(&secret, &rustrmm_server::agents::enroll::secret_aad(&token_id)))
        .bind(rustrmm_common::now())
        .execute(&state.db)
        .await
        .expect("token");
    let resp: EnrollResponse = reqwest::Client::new()
        .post(format!("http://{addr}/agent/v1/enroll"))
        .json(&EnrollRequest {
            secret,
            public_key: key.public_key().to_string(),
            hostname: "WS-DESKTOP".into(),
            os_family: "windows".into(),
            os_name: "Windows 11 Pro".into(),
            os_version: "10.0.26100".into(),
            arch: "x86_64".into(),
            hardware_uuid: Some("UUID-DESKTOP".into()),
            serial: Some("SN-DESKTOP".into()),
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

async fn recv_frame(ws: &mut Ws) -> Frame {
    loop {
        match ws.next().await.expect("open").expect("frame") {
            WsMessage::Binary(b) => return Frame::decode(&b).expect("decode"),
            WsMessage::Close(_) => panic!("closed"),
            _ => continue,
        }
    }
}

async fn connect_agent(
    state: &AppState,
    addr: SocketAddr,
    device_id: &str,
    key: &SigningKey,
) -> Ws {
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
        hostname: "WS-DESKTOP".into(),
        capabilities: vec!["remote".into(), "tunnels".into(), "desktop".into()],
    };
    ws.send(WsMessage::Binary(
        rustrmm_proto::encode(&hello).expect("hello").into(),
    ))
    .await
    .expect("send");
    let challenge: Challenge = recv_frame(&mut ws).await.body().expect("challenge");
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
    let _welcome: Welcome = recv_frame(&mut ws).await.body().expect("welcome");
    ws
}

fn text(m: &DesktopControl) -> WsMessage {
    WsMessage::Text(m.to_text().into())
}

/// Scripted agent: verifies every signed command; serves desktop tunnels (a ready message and
/// one frame, then reports every control message it receives), or denies consent when the policy
/// asks for it; answers the session list and screenshots.
async fn fake_agent(
    mut ws: Ws,
    state: AppState,
    addr: SocketAddr,
    opened: mpsc::UnboundedSender<TunnelKind>,
    received: mpsc::UnboundedSender<String>,
) {
    let command_key = state.keys.command.public_key();
    while let Some(Ok(msg)) = ws.next().await {
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
        let reply = |status: &str, data: Value| CommandResult {
            cmd_id: payload.cmd_id.clone(),
            status: status.into(),
            message: String::new(),
            data,
        };
        let result = match payload.command {
            Command::OpenTunnel(open) => {
                let mut request = format!("ws://{addr}/agent/v1/tunnel/{}", open.tunnel_id)
                    .into_client_request()
                    .expect("request");
                request
                    .headers_mut()
                    .insert(TUNNEL_TOKEN_HEADER, open.token.parse().expect("header"));
                let (mut tunnel, _) = tokio_tungstenite::connect_async(request)
                    .await
                    .expect("tunnel");
                let kind = open.kind.clone();
                let _ = opened.send(open.kind);
                let received = received.clone();
                tokio::spawn(async move {
                    let TunnelKind::Desktop {
                        consent, view_only, ..
                    } = kind
                    else {
                        panic!("expected a desktop tunnel, got {kind:?}");
                    };
                    if consent == ConsentMode::Always {
                        for m in [
                            DesktopControl::Consent {
                                status: ConsentStatus::Waiting,
                            },
                            DesktopControl::Consent {
                                status: ConsentStatus::Denied,
                            },
                            DesktopControl::Exit { code: None },
                        ] {
                            if tunnel.send(text(&m)).await.is_err() {
                                return;
                            }
                        }
                        let _ = tunnel.next().await;
                        return;
                    }
                    let ready = DesktopControl::Ready {
                        width: 1920,
                        height: 1080,
                        monitors: vec![MonitorInfo {
                            id: 0,
                            name: "\\\\.\\DISPLAY1".into(),
                            x: 0,
                            y: 0,
                            width: 1920,
                            height: 1080,
                            primary: true,
                            scale: 1.0,
                        }],
                        monitor: 0,
                        view_only,
                        desktop: "default".into(),
                    };
                    tunnel.send(text(&ready)).await.expect("ready");
                    tunnel
                        .send(WsMessage::Binary(
                            tile_message(0, 0, 0, 64, 64, encoding::SOLID, &[1, 2, 3, 255]).into(),
                        ))
                        .await
                        .expect("tile");
                    tunnel
                        .send(WsMessage::Binary(
                            Media::FrameEnd {
                                frame_seq: 0,
                                tiles: 1,
                            }
                            .encode()
                            .into(),
                        ))
                        .await
                        .expect("frame end");
                    while let Some(Ok(msg)) = tunnel.next().await {
                        match msg {
                            WsMessage::Text(t) => {
                                let _ = received.send(t.to_string());
                            }
                            WsMessage::Close(_) => break,
                            _ => {}
                        }
                    }
                });
                reply("succeeded", Value::Null)
            }
            Command::DesktopSessions => reply(
                "succeeded",
                json!({ "items": [{ "session_id": 1, "kind": "console", "user": "CORP\\alex", "state": "active", "monitors": null }] }),
            ),
            Command::Screenshot(request) => {
                assert_eq!(request.max_width, 1280);
                reply(
                    "succeeded",
                    json!({ "jpeg": "/9j/2Q==", "width": 1280, "height": 720, "consent": "not_required" }),
                )
            }
            _ => reply("rejected", Value::Null),
        };
        ws.send(WsMessage::Binary(
            rustrmm_proto::encode(&result).expect("result").into(),
        ))
        .await
        .expect("send result");
    }
}

async fn browser(console: SocketAddr, session_id: &str, ticket: &str) -> Ws {
    let mut request =
        format!("ws://{console}/api/v1/remote-sessions/{session_id}/ws?ticket={ticket}")
            .into_client_request()
            .expect("request");
    request
        .headers_mut()
        .insert(header::ORIGIN.as_str(), ORIGIN.parse().expect("origin"));
    let (ws, _) = tokio_tungstenite::connect_async(request)
        .await
        .expect("browser socket");
    ws
}

/// Next text message of a given `type` (skipping status/stats and binaries, which are collected).
async fn next_text(ws: &mut Ws, kind: &str, binaries: &mut Vec<Vec<u8>>) -> Value {
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(10), ws.next())
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for {kind}"))
            .expect("open")
            .expect("message");
        match msg {
            WsMessage::Text(t) => {
                let v: Value = serde_json::from_str(&t).expect("json");
                if v["type"] == kind {
                    return v;
                }
            }
            WsMessage::Binary(b) => binaries.push(b.to_vec()),
            WsMessage::Close(_) => panic!("closed while waiting for {kind}"),
            _ => {}
        }
    }
}

async fn wait_ended(state: &AppState, session_id: &str) -> (String, String, Value) {
    for _ in 0..100 {
        let row: (String, Option<String>, String) =
            sqlx::query_as("SELECT status, end_reason, detail FROM remote_sessions WHERE id = ?")
                .bind(session_id)
                .fetch_one(&state.db)
                .await
                .expect("session row");
        if row.0 == "ended" || row.0 == "failed" {
            return (
                row.0,
                row.1.unwrap_or_default(),
                serde_json::from_str(&row.2).expect("detail"),
            );
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("session {session_id} did not end");
}

async fn audit_count(state: &AppState, action: &str) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM audit_log WHERE action = ?")
        .bind(action)
        .fetch_one(&state.db)
        .await
        .expect("audit")
}

#[tokio::test]
async fn desktop_sessions_end_to_end() {
    let server = start().await;
    let state = server.state.clone();
    let mut owner = Client {
        router: server.console.clone(),
        cookie: None,
        csrf: None,
    };
    let token = state.setup.current_token().expect("setup token");
    let (status, body) = owner
        .post(
            "/api/v1/setup/complete",
            json!({
                "setup_token": token, "organization_name": "Northwind IT",
                "owner": { "name": "Olivia Owner", "email": "owner@example.com", "password": "correct-horse-battery-staple" },
                "first_client": { "name": "Acme Dental" }, "first_site": { "name": "Main Office" }
            }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    first_login(
        &mut owner,
        "owner@example.com",
        "correct-horse-battery-staple",
    )
    .await;

    let key = SigningKey::generate();
    let device = enroll(&state, server.agent_addr, &key).await;
    let ws = connect_agent(&state, server.agent_addr, &device, &key).await;
    let (opened_tx, mut opened_rx) = mpsc::unbounded_channel();
    let (received_tx, mut received_rx) = mpsc::unbounded_channel();
    tokio::spawn(fake_agent(
        ws,
        state.clone(),
        server.agent_addr,
        opened_tx,
        received_tx,
    ));

    // ---- interactive sessions and screenshots (no step-up needed)
    let (status, sessions) = owner
        .get(&format!("/api/v1/devices/{device}/desktop/sessions"))
        .await;
    assert_eq!(status, StatusCode::OK, "{sessions}");
    assert_eq!(sessions["items"][0]["user"], "CORP\\alex");
    let (status, _, jpeg) = owner
        .call(
            Method::GET,
            &format!("/api/v1/devices/{device}/screenshot"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(jpeg, vec![0xff, 0xd8, 0xff, 0xd9]);
    assert_eq!(audit_count(&state, "remote.screenshot").await, 1);

    // ---- 1. a desktop session needs a step-up
    set_step_up(&state, false).await;
    let (status, body) = owner
        .post(&format!("/api/v1/devices/{device}/desktop"), json!({}))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "step_up_required");
    set_step_up(&state, true).await;
    let (status, body) = owner
        .post(
            &format!("/api/v1/devices/{device}/desktop"),
            json!({ "quality": "ultra" }),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    let (status, created) = owner
        .post(
            &format!("/api/v1/devices/{device}/desktop"),
            json!({ "session_id": 1, "quality": "medium" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created["expires_in"], 30);
    let session_id = created["session_id"].as_str().expect("id").to_string();
    let mut browser_ws = browser(
        server.console_addr,
        &session_id,
        created["ticket"].as_str().expect("ticket"),
    )
    .await;

    // ---- 2. the agent gets a signed OpenTunnel of kind Desktop with the effective policy
    let kind = tokio::time::timeout(Duration::from_secs(10), opened_rx.recv())
        .await
        .expect("tunnel opened")
        .expect("kind");
    match kind {
        TunnelKind::Desktop {
            session_id,
            view_only,
            quality,
            consent,
            consent_timeout_secs,
            banner,
            technician,
            organization,
            ..
        } => {
            assert_eq!(session_id, Some(1));
            assert!(!view_only);
            assert_eq!(quality, Quality::Medium);
            assert_eq!(consent, ConsentMode::Never, "documented default");
            assert_eq!(consent_timeout_secs, 30);
            assert!(banner);
            assert_eq!(technician, "Olivia Owner");
            assert_eq!(organization, "Northwind IT");
        }
        other => panic!("unexpected tunnel {other:?}"),
    }

    // ---- 3. frames flow from the agent to the browser untouched
    let mut binaries = Vec::new();
    let ready = next_text(&mut browser_ws, "ready", &mut binaries).await;
    assert_eq!(ready["width"], 1920);
    assert_eq!(ready["monitors"][0]["primary"], true);
    while binaries.len() < 2 {
        match tokio::time::timeout(Duration::from_secs(10), browser_ws.next())
            .await
            .expect("frame")
            .expect("open")
            .expect("message")
        {
            WsMessage::Binary(b) => binaries.push(b.to_vec()),
            _ => continue,
        }
    }
    assert_eq!(
        Media::decode(&binaries[0]).expect("tile"),
        Media::Tile {
            frame_seq: 0,
            x: 0,
            y: 0,
            w: 64,
            h: 64,
            encoding: encoding::SOLID,
            payload: vec![1, 2, 3, 255]
        }
    );
    assert_eq!(
        Media::decode(&binaries[1]).expect("end"),
        Media::FrameEnd {
            frame_seq: 0,
            tiles: 1
        }
    );
    // Input reaches the agent when the session is interactive; Ctrl+Alt+Del is audited.
    let mouse = DesktopControl::Mouse {
        x: 10,
        y: 20,
        buttons: 1,
        wheel_x: None,
        wheel_y: None,
    };
    browser_ws.send(text(&mouse)).await.expect("mouse");
    browser_ws
        .send(text(&DesktopControl::Cad))
        .await
        .expect("cad");
    browser_ws
        .send(text(&DesktopControl::Ack { frame_seq: 0 }))
        .await
        .expect("ack");
    // Agent-to-browser messages are never accepted from the browser.
    browser_ws
        .send(text(&DesktopControl::Consent {
            status: ConsentStatus::Granted,
        }))
        .await
        .expect("bogus");
    let mut got = Vec::new();
    while got.len() < 3 {
        let t = tokio::time::timeout(Duration::from_secs(10), received_rx.recv())
            .await
            .expect("agent received input")
            .expect("text");
        got.push(serde_json::from_str::<DesktopControl>(&t).expect("control"));
    }
    assert_eq!(got[0], mouse);
    assert_eq!(got[1], DesktopControl::Cad);
    assert_eq!(got[2], DesktopControl::Ack { frame_seq: 0 });
    browser_ws.close(None).await.expect("close");
    let (status, reason, detail) = wait_ended(&state, &session_id).await;
    assert_eq!(status, "ended");
    assert_eq!(reason, "operator closed the session");
    assert_eq!(detail["consent"], "not_required");
    assert_eq!(detail["quality"], "medium");
    assert_eq!(detail["session_id"], 1);
    assert_eq!(audit_count(&state, "remote.desktop.cad").await, 1);
    assert_eq!(audit_count(&state, "remote.desktop.opened").await, 1);
    for _ in 0..50 {
        if audit_count(&state, "remote.desktop.ended").await == 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(audit_count(&state, "remote.desktop.ended").await, 1);
    let (_, history) = owner
        .get(&format!("/api/v1/remote-sessions?device_id={device}"))
        .await;
    assert_eq!(history["items"][0]["kind"], "desktop");
    assert_eq!(history["items"][0]["detail"]["consent"], "not_required");

    // ---- 4. view-only drops input but keeps acks flowing
    let (status, created) = owner
        .post(
            &format!("/api/v1/devices/{device}/desktop"),
            json!({ "view_only": true }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let session_id = created["session_id"].as_str().expect("id").to_string();
    let mut browser_ws = browser(
        server.console_addr,
        &session_id,
        created["ticket"].as_str().expect("ticket"),
    )
    .await;
    let kind = opened_rx.recv().await.expect("kind");
    assert!(matches!(
        kind,
        TunnelKind::Desktop {
            view_only: true,
            ..
        }
    ));
    let mut binaries = Vec::new();
    let ready = next_text(&mut browser_ws, "ready", &mut binaries).await;
    assert_eq!(ready["view_only"], true);
    for m in [
        mouse.clone(),
        DesktopControl::Key {
            code: "KeyA".into(),
            key: "a".into(),
            down: true,
            location: 0,
        },
        DesktopControl::Text {
            text: "hello".into(),
        },
        DesktopControl::Clipboard {
            text: "secret".into(),
        },
        DesktopControl::Cad,
        DesktopControl::Ack { frame_seq: 0 },
    ] {
        browser_ws.send(text(&m)).await.expect("send");
    }
    let first = tokio::time::timeout(Duration::from_secs(10), received_rx.recv())
        .await
        .expect("agent received something")
        .expect("text");
    assert_eq!(
        serde_json::from_str::<DesktopControl>(&first).expect("control"),
        DesktopControl::Ack { frame_seq: 0 },
        "only the ack passes a view-only session"
    );
    browser_ws.close(None).await.expect("close");
    let (_, _, detail) = wait_ended(&state, &session_id).await;
    assert_eq!(detail["view_only"], true);
    assert_eq!(
        audit_count(&state, "remote.desktop.cad").await,
        1,
        "no CAD in view-only"
    );

    // ---- 6. consent denied ends the session and is recorded
    let (status, policy) = owner
        .post(
            "/api/v1/policies",
            json!({ "name": "Ask first", "document": { "remote_access": {
                "desktop": true, "desktop_consent": "always", "consent_timeout_secs": 20,
                "desktop_banner": false
            } } }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{policy}");
    let policy_id = policy["id"].as_str().expect("id").to_string();
    let (status, body) = owner
        .post(
            &format!("/api/v1/policies/{policy_id}/assignments"),
            json!({ "target_type": "global" }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let (status, created) = owner
        .post(&format!("/api/v1/devices/{device}/desktop"), json!({}))
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let session_id = created["session_id"].as_str().expect("id").to_string();
    let mut browser_ws = browser(
        server.console_addr,
        &session_id,
        created["ticket"].as_str().expect("ticket"),
    )
    .await;
    let kind = opened_rx.recv().await.expect("kind");
    assert!(matches!(
        kind,
        TunnelKind::Desktop {
            consent: ConsentMode::Always,
            consent_timeout_secs: 20,
            banner: false,
            ..
        }
    ));
    let mut binaries = Vec::new();
    let waiting = next_text(&mut browser_ws, "consent", &mut binaries).await;
    assert_eq!(waiting["status"], "waiting");
    let denied = next_text(&mut browser_ws, "consent", &mut binaries).await;
    assert_eq!(denied["status"], "denied");
    let closed = next_text(&mut browser_ws, "closed", &mut binaries).await;
    assert_eq!(closed["reason"], "the user denied the session");
    let (status, reason, detail) = wait_ended(&state, &session_id).await;
    assert_eq!(status, "ended");
    assert_eq!(reason, "the user denied the session");
    assert_eq!(detail["consent"], "denied");
    let recorded: String = sqlx::query_scalar(
        "SELECT details FROM audit_log WHERE action = 'remote.desktop.consent' ORDER BY id DESC LIMIT 1",
    )
    .fetch_one(&state.db)
    .await
    .expect("consent audit");
    let recorded: Value = serde_json::from_str(&recorded).expect("details");
    assert_eq!(recorded["status"], "denied");
    assert_eq!(recorded["session_id"], session_id);

    // ---- 5. a policy with desktop: false refuses new sessions (and screenshots)
    let (status, body, _) = owner
        .call(
            Method::PUT,
            &format!("/api/v1/policies/{policy_id}"),
            Some(json!({ "name": "Ask first", "description": "", "document": { "remote_access": { "desktop": false } } })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = owner
        .post(&format!("/api/v1/devices/{device}/desktop"), json!({}))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "disabled_by_policy");
    assert_eq!(body["error"]["details"]["feature"], "desktop");
    assert!(
        body["error"]["message"]
            .as_str()
            .expect("message")
            .contains("Ask first")
    );
    let (status, body) = owner
        .get(&format!("/api/v1/devices/{device}/screenshot"))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "disabled_by_policy");
}
