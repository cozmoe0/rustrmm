//! Phase 10 end to end with a scripted agent over real sockets:
//!
//! 1. the agent escrows a BitLocker key encrypted to the server's recipient; revealing it needs
//!    step-up and a typed reason, returns the plaintext once (no-store) and is audited;
//! 2. a LAPS rotation is a signed command whose result carries no password;
//! 3. the agent becomes the site probe, a scan runs and the streamed hosts become assets with
//!    vendors and type guesses;
//! 4. SNMP devices are polled through the probe: counters become rates and a low printer toner
//!    raises an alert that names the SNMP device;
//! 5. a received trap is stored and a matching trap rule raises an alert.

use std::net::SocketAddr;
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::{HeaderMap, Method, Request, StatusCode, header};
use clap::Parser;
use futures::{SinkExt, StreamExt};
use http_body_util::BodyExt;
use rustrmm_crypto::sign::SigningKey;
use rustrmm_proto::commands::{
    Command, CommandPayload, CommandResult, SignedCommand, command_signing_bytes,
};
use rustrmm_proto::deploy::{EnrollRequest, EnrollResponse};
use rustrmm_proto::escrow::{EscrowItem, source_hash};
use rustrmm_proto::handshake::{self, Challenge, Hello, Proof, Welcome};
use rustrmm_proto::network::{
    ScanHost, ScanResults, SnmpResults, SnmpSample, SnmpSysInfo, SnmpTrap, SnmpValue, TrapVarbind,
};
use rustrmm_proto::{Frame, Message as _};
use rustrmm_server::state::AppState;
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tower::ServiceExt;

const ORIGIN: &str = "https://rmm.test";
const RECOVERY_KEY: &str = "123453-234564-345675-456786-567897-679008-790119-801130";

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

// ------------------------------------------------------------------ console client

struct Client {
    router: Router,
    cookie: Option<String>,
    csrf: Option<String>,
}

impl Client {
    async fn call_full(
        &mut self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> (StatusCode, HeaderMap, Value) {
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
        let headers = response.headers().clone();
        if let Some(set_cookie) = headers.get(header::SET_COOKIE) {
            let raw = set_cookie.to_str().expect("cookie").to_string();
            let pair = raw.split(';').next().unwrap_or_default().to_string();
            self.cookie = (!pair.ends_with('=')).then_some(pair);
        }
        let bytes = response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes();
        let value: Value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap_or(Value::Null)
        };
        if let Some(csrf) = value
            .pointer("/me/csrf_token")
            .or_else(|| value.pointer("/csrf_token"))
            .and_then(Value::as_str)
        {
            self.csrf = Some(csrf.to_string());
        }
        (status, headers, value)
    }

    async fn call(
        &mut self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let (status, _, value) = self.call_full(method, path, body).await;
        (status, value)
    }

    async fn get(&mut self, path: &str) -> (StatusCode, Value) {
        self.call(Method::GET, path, None).await
    }

    async fn post(&mut self, path: &str, body: Value) -> (StatusCode, Value) {
        self.call(Method::POST, path, Some(body)).await
    }

    async fn put(&mut self, path: &str, body: Value) -> (StatusCode, Value) {
        self.call(Method::PUT, path, Some(body)).await
    }
}

fn totp_code(secret_b32: &str) -> String {
    let secret = data_encoding::BASE32_NOPAD
        .decode(secret_b32.as_bytes())
        .expect("base32");
    let step = (chrono::Utc::now().timestamp() / 30) as u64;
    format!("{:06}", rustrmm_server::auth::totp::code_at(&secret, step))
}

async fn sign_in(client: &mut Client, email: &str, password: &str) {
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

async fn start() -> (AppState, Router, SocketAddr, tempfile::TempDir) {
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
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    let agents = rustrmm_server::listeners::agent_router(state.clone());
    tokio::spawn(async move {
        axum::serve(
            listener,
            agents.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .expect("serve");
    });
    let console = rustrmm_server::listeners::console_router(state.clone());
    (state, console, addr, dir)
}

async fn enroll(addr: SocketAddr, secret: &str, key: &SigningKey) -> String {
    let resp: EnrollResponse = reqwest::Client::new()
        .post(format!("http://{addr}/agent/v1/enroll"))
        .json(&EnrollRequest {
            secret: secret.to_string(),
            public_key: key.public_key().to_string(),
            hostname: "WS-PROBE".into(),
            os_family: "windows".into(),
            os_name: "Windows 11 Pro".into(),
            os_version: "10.0.26100".into(),
            arch: "x86_64".into(),
            hardware_uuid: Some("UUID-WS-PROBE".into()),
            serial: Some("SN-WS-PROBE".into()),
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
    assert!(
        resp.escrow_recipient.starts_with("age1"),
        "the agent learns the escrow recipient"
    );
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
        hostname: "WS-PROBE".into(),
        capabilities: vec!["escrow".into(), "network".into()],
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

/// Scripted agent: verifies every signed command against the server's command key, forwards it
/// to the test, answers it (a rotation answers with the account only, never the password, and
/// escrows the new password like the real agent), and sends whatever the test queues.
async fn fake_agent(
    ws: Ws,
    state: AppState,
    device_id: String,
    commands: mpsc::UnboundedSender<Command>,
    mut outgoing: mpsc::UnboundedReceiver<Vec<u8>>,
) {
    let command_key = state.keys.command.public_key();
    let recipient = state.keys.escrow_recipient();
    let (mut sink, mut stream) = ws.split();
    loop {
        tokio::select! {
            out = outgoing.recv() => match out {
                Some(bytes) => sink.send(WsMessage::Binary(bytes.into())).await.expect("send"),
                None => {
                    let _ = sink.close().await;
                    return;
                }
            },
            msg = stream.next() => {
                let Some(Ok(msg)) = msg else { return };
                let WsMessage::Binary(bytes) = msg else { continue };
                let frame = Frame::decode(&bytes).expect("frame");
                if frame.t != SignedCommand::TYPE {
                    continue;
                }
                let signed: SignedCommand = frame.body().expect("signed");
                command_key
                    .verify(&command_signing_bytes(&signed.payload), &signed.signature)
                    .expect("commands are signed by the server's command key");
                let payload: CommandPayload = rmp_serde::from_slice(&signed.payload).expect("payload");
                assert_eq!(payload.device_id, device_id);
                let reply = |status: &str, data: Value| CommandResult {
                    cmd_id: payload.cmd_id.clone(),
                    status: status.into(),
                    message: String::new(),
                    data,
                };
                let mut frames = Vec::new();
                match &payload.command {
                    Command::RotateLocalAdmin(r) => {
                        let password = "Gq7#mX2!pL9&vT4^wR8z";
                        let item = EscrowItem {
                            kind: "laps".into(),
                            identifier: r.account.clone(),
                            label: format!("Local administrator ({})", r.account),
                            ciphertext_age: age::encrypt(&recipient.parse::<age::x25519::Recipient>().expect("recipient"),
                                                         password.as_bytes()).expect("encrypt"),
                            captured_at: chrono::Utc::now().timestamp_millis(),
                            metadata: json!({ "account": r.account }),
                            source_hash: source_hash("laps", &r.account, password.as_bytes()),
                        };
                        frames.push(rustrmm_proto::encode(&item).expect("item"));
                        frames.push(rustrmm_proto::encode(&reply("succeeded", json!({
                            "account": r.account, "created": false, "group": "Administrators", "length": 20
                        }))).expect("result"));
                    }
                    Command::NetworkScan(_) => {
                        frames.push(rustrmm_proto::encode(&reply("running", Value::Null)).expect("result"));
                    }
                    Command::PatchScan(_) | Command::Unsupported => {
                        frames.push(rustrmm_proto::encode(&reply("rejected", Value::Null)).expect("result"));
                    }
                    _ => frames.push(rustrmm_proto::encode(&reply("succeeded", Value::Null)).expect("result")),
                }
                let _ = commands.send(payload.command.clone());
                for f in frames {
                    sink.send(WsMessage::Binary(f.into())).await.expect("send result");
                }
            }
        }
    }
}

async fn next_command<F>(
    rx: &mut mpsc::UnboundedReceiver<Command>,
    what: &str,
    mut wanted: F,
) -> Command
where
    F: FnMut(&Command) -> bool,
{
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let cmd = tokio::time::timeout_at(deadline, rx.recv())
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for {what}"))
            .expect("command");
        if wanted(&cmd) {
            return cmd;
        }
    }
}

async fn wait_for<F>(client: &mut Client, path: &str, what: &str, mut done: F) -> Value
where
    F: FnMut(&Value) -> bool,
{
    for _ in 0..100 {
        let (status, body) = client.get(path).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        if done(&body) {
            return body;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("timed out waiting for {what}");
}

fn find<'a>(list: &'a Value, key: &str, value: &str) -> Option<&'a Value> {
    list["items"].as_array()?.iter().find(|i| i[key] == value)
}

fn value(key: &str, index: Option<&str>, v: Value, kind: &str) -> SnmpValue {
    SnmpValue {
        key: key.into(),
        index: index.map(String::from),
        value: v,
        kind: kind.into(),
    }
}

#[tokio::test]
async fn escrow_laps_discovery_snmp_and_traps() {
    let (state, router, addr, _dir) = start().await;
    let mut owner = Client {
        router: router.clone(),
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
    sign_in(
        &mut owner,
        "owner@example.com",
        "correct-horse-battery-staple",
    )
    .await;

    // ---- enroll and connect the agent
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
    let key = SigningKey::generate();
    let device = enroll(addr, &secret, &key).await;
    let ws = connect(&state, addr, &device, &key).await;
    let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel();
    let (out_tx, out_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let agent = tokio::spawn(fake_agent(
        ws,
        state.clone(),
        device.clone(),
        cmd_tx,
        out_rx,
    ));
    for _ in 0..100 {
        if state.agents.is_online(&device) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // ================================================================== 1. escrow and reveal
    let recipient: age::x25519::Recipient =
        state.keys.escrow_recipient().parse().expect("recipient");
    let protector = "{2F1C1B2A-0000-4000-8000-000000000001}";
    let item = EscrowItem {
        kind: "bitlocker".into(),
        identifier: protector.into(),
        label: "C: recovery key".into(),
        ciphertext_age: age::encrypt(&recipient, RECOVERY_KEY.as_bytes()).expect("encrypt"),
        captured_at: chrono::Utc::now().timestamp_millis(),
        metadata: json!({ "volume": "C:", "mount_point": "C:", "key_protector_id": protector }),
        source_hash: source_hash("bitlocker", protector, RECOVERY_KEY.as_bytes()),
    };
    out_tx
        .send(rustrmm_proto::encode(&item).expect("item"))
        .expect("send");
    let list = wait_for(&mut owner, "/api/v1/escrow", "the escrowed key", |b| {
        find(b, "kind", "bitlocker").is_some()
    })
    .await;
    let escrowed = find(&list, "kind", "bitlocker").expect("item").clone();
    assert_eq!(escrowed["identifier"], protector);
    assert_eq!(escrowed["hostname"], "WS-PROBE");
    assert_eq!(escrowed["client_name"], "Acme Dental");
    assert_eq!(escrowed["metadata"]["volume"], "C:");
    assert_eq!(escrowed["reveal_count"], 0);
    assert!(
        !list.to_string().contains(RECOVERY_KEY),
        "listing carries no secret"
    );
    let item_id = escrowed["id"].as_str().expect("id").to_string();
    // The same key again is de-duplicated (no new row, nothing superseded).
    out_tx
        .send(rustrmm_proto::encode(&item).expect("item"))
        .expect("send");
    tokio::time::sleep(Duration::from_millis(300)).await;
    let rows: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM escrow_items WHERE kind = 'bitlocker'")
            .fetch_one(&state.db)
            .await
            .expect("count");
    assert_eq!(rows, 1);
    let stored: Vec<u8> = sqlx::query_scalar("SELECT ciphertext FROM escrow_items WHERE id = ?")
        .bind(&item_id)
        .fetch_one(&state.db)
        .await
        .expect("ciphertext");
    assert!(
        !stored.windows(6).any(|w| w == b"123453"),
        "only ciphertext in the database"
    );
    let (status, device_items) = owner.get(&format!("/api/v1/devices/{device}/escrow")).await;
    assert_eq!(status, StatusCode::OK, "{device_items}");
    assert_eq!(device_items["items"].as_array().map(Vec::len), Some(1));

    // Reveal: step-up, then a reason of at least 10 characters.
    set_step_up(&state, false).await;
    let reveal = format!("/api/v1/escrow/{item_id}/reveal");
    let (status, body) = owner
        .post(
            &reveal,
            json!({ "reason": "User locked out after BIOS update" }),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "step_up_required");
    set_step_up(&state, true).await;
    let (status, body) = owner.post(&reveal, json!({ "reason": "because" })).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    let (status, headers, body) = owner
        .call_full(
            Method::POST,
            &reveal,
            Some(json!({ "reason": "User locked out after BIOS update (ticket #1042)" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["secret"], RECOVERY_KEY);
    assert_eq!(body["kind"], "bitlocker");
    assert_eq!(body["identifier"], protector);
    assert_eq!(body["expires_in"], 60);
    assert!(
        headers
            .get(header::CACHE_CONTROL)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.contains("no-store")),
        "never cached"
    );
    let audited: String = sqlx::query_scalar(
        "SELECT details FROM audit_log WHERE action = 'secret.revealed' ORDER BY id DESC LIMIT 1",
    )
    .fetch_one(&state.db)
    .await
    .expect("audit entry");
    assert!(
        audited.contains("ticket #1042"),
        "the reason is audited: {audited}"
    );
    assert!(!audited.contains(RECOVERY_KEY), "the secret is not");
    let reveals: (String, String) =
        sqlx::query_as("SELECT user_name, reason FROM escrow_reveals WHERE item_id = ?")
            .bind(&item_id)
            .fetch_one(&state.db)
            .await
            .expect("reveal row");
    assert_eq!(reveals.0, "Olivia Owner");
    let (_, list) = owner.get("/api/v1/escrow").await;
    assert_eq!(
        find(&list, "id", &item_id).expect("item")["reveal_count"],
        1
    );
    // The whole audit chain still verifies.
    let (_, verify) = owner.post("/api/v1/audit/verify", json!({})).await;
    assert_eq!(verify["ok"], true, "{verify}");

    // ================================================================== 2. LAPS rotation
    let (status, body) = owner
        .post(
            "/api/v1/policies",
            json!({ "name": "Bad LAPS", "document": { "escrow": { "laps": { "length": 8 } } } }),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["error"]["details"]["path"], "escrow.laps.length");
    let (status, policy) = owner
        .post(
            "/api/v1/policies",
            json!({ "name": "LAPS", "document": { "escrow": { "laps": { "enabled": true, "account": "rmm-admin",
                      "length": 24, "rotate_days": 30, "rotate_after_reveal_hours": 12 } } } }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{policy}");
    let policy_id = policy["id"].as_str().expect("id").to_string();
    let (status, body) = owner
        .post(
            &format!("/api/v1/policies/{policy_id}/assignments"),
            json!({ "target_type": "device", "target_id": device }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let (_, effective) = owner
        .get(&format!("/api/v1/devices/{device}/effective-policy"))
        .await;
    assert_eq!(effective["document"]["escrow"]["laps"]["length"], 24);

    set_step_up(&state, false).await;
    let rotate = format!("/api/v1/devices/{device}/laps/rotate");
    let (status, body) = owner.post(&rotate, json!({})).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    set_step_up(&state, true).await;
    let (status, body) = owner.post(&rotate, json!({})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let cmd_id = body["cmd_id"].as_str().expect("cmd_id").to_string();
    match next_command(&mut cmd_rx, "the rotation", |c| {
        matches!(c, Command::RotateLocalAdmin(_))
    })
    .await
    {
        Command::RotateLocalAdmin(r) => {
            assert_eq!(r.account, "rmm-admin");
            assert_eq!(
                r.length, 24,
                "the policy's settings travel in the signed command"
            );
            assert!(!r.disable_other_admins);
        }
        other => panic!("unexpected {other:?}"),
    }
    let laps = wait_for(
        &mut owner,
        "/api/v1/escrow?kind=laps",
        "the LAPS item",
        |b| find(b, "kind", "laps").is_some(),
    )
    .await;
    let laps_id = find(&laps, "kind", "laps").expect("laps")["id"]
        .as_str()
        .expect("id")
        .to_string();
    let commands = wait_for(
        &mut owner,
        &format!("/api/v1/devices/{device}/commands"),
        "the rotation result",
        |b| b.to_string().contains(&cmd_id) && b.to_string().contains("succeeded"),
    )
    .await;
    assert!(
        !commands.to_string().contains("Gq7#mX2"),
        "the command result never carries the password"
    );
    let mut rotated: Option<chrono::DateTime<chrono::Utc>> = None;
    for _ in 0..50 {
        rotated = sqlx::query_scalar("SELECT last_rotated_at FROM laps_state WHERE device_id = ?")
            .bind(&device)
            .fetch_optional(&state.db)
            .await
            .expect("laps state")
            .flatten();
        if rotated.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(rotated.is_some(), "the rotation result is recorded");
    // Revealing a LAPS password schedules the next rotation within rotate_after_reveal_hours.
    let (status, body) = owner
        .post(
            &format!("/api/v1/escrow/{laps_id}/reveal"),
            json!({ "reason": "On-site repair needs local admin" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["secret"], "Gq7#mX2!pL9&vT4^wR8z");
    let next: Option<chrono::DateTime<chrono::Utc>> =
        sqlx::query_scalar("SELECT next_rotation_at FROM laps_state WHERE device_id = ?")
            .bind(&device)
            .fetch_one(&state.db)
            .await
            .expect("laps state");
    let next = next.expect("next rotation");
    assert!(
        next <= rustrmm_common::now() + chrono::Duration::hours(12) + chrono::Duration::seconds(5)
    );
    let (status, stats) = owner.get("/api/v1/escrow/stats").await;
    assert_eq!(status, StatusCode::OK, "{stats}");
    assert_eq!(stats["laps"]["enabled_devices"], 1);
    assert_eq!(stats["laps"]["rotated_within_policy"], 1);
    assert!(stats["bitlocker"]["missing"].is_array());

    // ================================================================== 3. probe and discovery
    let (status, probe) = owner
        .put(
            &format!("/api/v1/sites/{site_id}/probe"),
            json!({ "device_id": device }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{probe}");
    assert_eq!(probe["device_id"], device);
    assert_eq!(probe["online"], true);
    match next_command(&mut cmd_rx, "the probe configuration", |c| {
        matches!(c, Command::SnmpConfig(_))
    })
    .await
    {
        Command::SnmpConfig(c) => assert!(c.devices.is_empty() && !c.trap_receiver.enabled),
        other => panic!("unexpected {other:?}"),
    }
    let (status, credential) = owner
        .post(
            "/api/v1/network/snmp/credentials",
            json!({ "name": "Office v2c", "version": "v2c", "community": "s3cret-community" }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{credential}");
    assert_eq!(credential["community"], "••••••");
    let credential_id = credential["id"].as_str().expect("id").to_string();
    let (_, credentials) = owner.get("/api/v1/network/snmp/credentials").await;
    assert!(
        !credentials.to_string().contains("s3cret-community"),
        "write-only secrets"
    );
    let (status, body) = owner
        .post(
            "/api/v1/network/scans",
            json!({ "site_id": site_id, "name": "Internet", "ranges": ["8.8.8.0/24"] }),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "public ranges are refused: {body}"
    );
    let (status, body) = owner
        .post(
            "/api/v1/network/scans",
            json!({ "site_id": site_id, "name": "Too big", "ranges": ["10.0.0.0/16"] }),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "at most a /20: {body}"
    );
    let (status, scan) = owner
        .post(
            "/api/v1/network/scans",
            json!({ "site_id": site_id, "name": "Office LAN", "ranges": ["192.168.50.0/24"],
                    "methods": { "icmp": true, "arp": true, "tcp_ports": [22, 80, 443, 445, 3389, 9100, 161], "snmp": true, "mdns": true, "netbios": true },
                    "schedule": { "cron": "0 */6 * * *" }, "snmp_credential_ids": [credential_id] }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{scan}");
    assert!(scan["last_run"].is_null());
    assert!(scan["next_run_at"].is_string());
    let scan_id = scan["id"].as_str().expect("id").to_string();
    let (status, run) = owner
        .post(&format!("/api/v1/network/scans/{scan_id}/run"), json!({}))
        .await;
    assert_eq!(status, StatusCode::OK, "{run}");
    let run_id = run["run_id"].as_str().expect("run").to_string();
    let (status, body) = owner
        .post(&format!("/api/v1/network/scans/{scan_id}/run"), json!({}))
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "one run at a time: {body}");
    match next_command(&mut cmd_rx, "the scan", |c| {
        matches!(c, Command::NetworkScan(_))
    })
    .await
    {
        Command::NetworkScan(s) => {
            assert_eq!(s.ranges, vec!["192.168.50.0/24".to_string()]);
            assert_eq!(s.run_id.as_deref(), Some(run_id.as_str()));
            assert_eq!(
                s.snmp[0].community.as_deref(),
                Some("s3cret-community"),
                "decrypted for the probe only"
            );
            assert!(!s.allow_public);
        }
        other => panic!("unexpected {other:?}"),
    }
    let host = |ip: &str| ScanHost {
        ip: ip.into(),
        ..ScanHost::default()
    };
    let batch1 = ScanResults {
        scan_id: scan_id.clone(),
        run_id: Some(run_id.clone()),
        hosts: vec![
            ScanHost {
                mac: Some("00-1B-A9-12-34-56".into()),
                open_ports: vec![80, 9100],
                snmp: Some(SnmpSysInfo {
                    sys_descr: Some("Brother HL-L2350DW series".into()),
                    ..Default::default()
                }),
                rtt_ms: Some(1.2),
                ..host("192.168.50.20")
            },
            ScanHost {
                open_ports: vec![22, 443],
                snmp: Some(SnmpSysInfo {
                    sys_descr: Some(
                        "Cisco IOS Software, C2960 Software (C2960-LANBASEK9-M)".into(),
                    ),
                    sys_name: Some("core-sw1".into()),
                    sys_object_id: Some("1.3.6.1.4.1.9.1.1208".into()),
                }),
                ..host("192.168.50.2")
            },
        ],
        done: false,
        error: None,
    };
    let batch2 = ScanResults {
        scan_id: scan_id.clone(),
        run_id: Some(run_id.clone()),
        hosts: vec![
            ScanHost {
                mac: Some("00:11:32:aa:bb:cc".into()),
                open_ports: vec![5000, 5001],
                ..host("192.168.50.30")
            },
            ScanHost {
                open_ports: vec![445, 3389],
                netbios_name: Some("WS-ACCT-01".into()),
                ..host("192.168.50.40")
            },
            ScanHost {
                open_ports: vec![3389],
                netbios_name: Some("WS-PROBE".into()),
                ..host("192.168.50.50")
            },
        ],
        done: true,
        error: None,
    };
    out_tx
        .send(rustrmm_proto::encode(&batch1).expect("batch"))
        .expect("send");
    out_tx
        .send(rustrmm_proto::encode(&batch2).expect("batch"))
        .expect("send");
    let scans = wait_for(
        &mut owner,
        "/api/v1/network/scans",
        "the finished scan",
        |b| find(b, "id", &scan_id).is_some_and(|s| s["last_run"]["status"] == "succeeded"),
    )
    .await;
    assert_eq!(
        find(&scans, "id", &scan_id).expect("scan")["last_run"]["hosts_found"],
        5
    );
    let (_, assets) = owner
        .get(&format!("/api/v1/network/assets?site_id={site_id}"))
        .await;
    let asset = |ip: &str| {
        find(&assets, "ip", ip)
            .unwrap_or_else(|| panic!("asset {ip} in {assets}"))
            .clone()
    };
    let printer = asset("192.168.50.20");
    assert_eq!(printer["type_guess"], "printer");
    assert_eq!(printer["vendor"], "Brother");
    assert_eq!(printer["mac"], "00:1b:a9:12:34:56");
    assert_eq!(asset("192.168.50.2")["type_guess"], "switch");
    assert_eq!(asset("192.168.50.2")["hostname"], "core-sw1");
    assert_eq!(asset("192.168.50.30")["type_guess"], "nas");
    assert_eq!(asset("192.168.50.30")["vendor"], "Synology");
    assert_eq!(asset("192.168.50.40")["type_guess"], "windows");
    assert_eq!(
        asset("192.168.50.50")["managed_device_id"],
        device,
        "matched to the enrolled agent by name"
    );
    let (_, managed) = owner
        .get(&format!(
            "/api/v1/network/assets?site_id={site_id}&managed=true"
        ))
        .await;
    assert_eq!(managed["items"].as_array().map(Vec::len), Some(1));
    let (_, printers) = owner.get("/api/v1/network/assets?type=printer").await;
    assert_eq!(printers["items"].as_array().map(Vec::len), Some(1));
    let nas_id = asset("192.168.50.30")["id"]
        .as_str()
        .expect("id")
        .to_string();
    let (status, body) = owner
        .call(
            Method::PATCH,
            &format!("/api/v1/network/assets/{nas_id}"),
            Some(json!({ "notes": "Backup NAS", "type": "nas", "ignored": true })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["notes"], "Backup NAS");
    assert_eq!(body["ignored"], true);
    assert_eq!(body["type_source"], "manual");

    // ================================================================== 4. SNMP polling
    let printer_asset = printer["id"].as_str().expect("id").to_string();
    let (status, printer_device) = owner
        .post(
            &format!("/api/v1/network/assets/{printer_asset}/monitor"),
            json!({ "credential_id": credential_id }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{printer_device}");
    assert_eq!(printer_device["status"], "pending");
    let printer_id = printer_device["id"].as_str().expect("id").to_string();
    assert!(
        printer_device["template_ids"]
            .to_string()
            .contains("builtin-snmp-printer")
    );
    let (status, switch_device) = owner
        .post(
            "/api/v1/network/snmp/devices",
            json!({ "site_id": site_id, "name": "core-sw1", "ip": "192.168.50.2", "credential_id": credential_id,
                    "template_ids": ["builtin-snmp-generic", "builtin-snmp-if-mib"], "poll_interval_secs": 60 }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{switch_device}");
    let switch_id = switch_device["id"].as_str().expect("id").to_string();
    let config = next_command(
        &mut cmd_rx,
        "an SNMP configuration with both devices",
        |c| matches!(c, Command::SnmpConfig(cfg) if cfg.devices.len() == 2),
    )
    .await;
    let Command::SnmpConfig(config) = config else {
        unreachable!()
    };
    let printer_target = config
        .devices
        .iter()
        .find(|d| d.id == printer_id)
        .expect("printer target");
    assert_eq!(
        printer_target.credential.community.as_deref(),
        Some("s3cret-community")
    );
    assert!(
        printer_target
            .oids
            .iter()
            .any(|o| o.key == "prtMarkerSuppliesLevel" && o.table)
    );
    assert!(
        printer_target
            .oids
            .iter()
            .any(|o| o.key == "max:prtMarkerSuppliesLevel")
    );
    let (_, templates) = owner.get("/api/v1/network/snmp/templates").await;
    assert_eq!(templates["items"].as_array().map(Vec::len), Some(5));
    let (status, body) = owner
        .put(
            "/api/v1/network/snmp/templates/builtin-snmp-generic",
            json!({ "name": "Mine", "metrics": [] }),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "built-in templates are read-only: {body}"
    );

    let now = chrono::Utc::now().timestamp_millis();
    let sample = |device: &str, at: i64, values: Vec<SnmpValue>| SnmpSample {
        device_id: device.into(),
        at,
        values,
    };
    let first = SnmpResults {
        samples: vec![
            sample(
                &switch_id,
                now - 60_000,
                vec![
                    value("_uptime", None, json!(100_000), "timeticks"),
                    value(
                        "_sysDescr",
                        None,
                        json!("Cisco IOS Software, C2960"),
                        "string",
                    ),
                    value("ifHCInOctets", Some("1"), json!(1_000_000u64), "counter64"),
                    value(
                        "label:ifHCInOctets",
                        Some("1"),
                        json!("GigabitEthernet0/1"),
                        "string",
                    ),
                ],
            ),
            sample(
                &printer_id,
                now - 60_000,
                vec![
                    value("_uptime", None, json!(5_000), "timeticks"),
                    value("prtMarkerSuppliesLevel", Some("1.1"), json!(8), "integer"),
                    value(
                        "max:prtMarkerSuppliesLevel",
                        Some("1.1"),
                        json!(100),
                        "integer",
                    ),
                    value(
                        "label:prtMarkerSuppliesLevel",
                        Some("1.1"),
                        json!("Black Toner"),
                        "string",
                    ),
                ],
            ),
        ],
        unreachable: vec![],
    };
    out_tx
        .send(rustrmm_proto::encode(&first).expect("results"))
        .expect("send");
    let second = SnmpResults {
        samples: vec![sample(
            &switch_id,
            now,
            vec![
                value("_uptime", None, json!(106_000), "timeticks"),
                value("ifHCInOctets", Some("1"), json!(7_000_000u64), "counter64"),
            ],
        )],
        unreachable: vec![],
    };
    out_tx
        .send(rustrmm_proto::encode(&second).expect("results"))
        .expect("send");
    let metrics = wait_for(
        &mut owner,
        &format!("/api/v1/network/snmp/devices/{switch_id}/metrics?range=1h"),
        "the computed rate",
        |b| b["series"].as_array().is_some_and(|s| !s.is_empty()),
    )
    .await;
    let series = &metrics["series"][0];
    assert_eq!(series["key"], "ifHCInOctets");
    assert_eq!(series["index"], "1");
    assert_eq!(series["label"], "Inbound traffic (GigabitEthernet0/1)");
    assert_eq!(series["unit"], "B/s");
    let rate = series["points"][0][1].as_f64().expect("rate");
    assert!(
        (rate - 100_000.0).abs() < 1.0,
        "6 MB in 60 s is 100 kB/s, got {rate}"
    );
    let (_, devices) = owner
        .get(&format!("/api/v1/network/snmp/devices?site_id={site_id}"))
        .await;
    let switch = find(&devices, "id", &switch_id).expect("switch");
    assert_eq!(switch["status"], "ok");
    assert_eq!(switch["uptime_secs"], 1060);
    assert_eq!(switch["sys_descr"], "Cisco IOS Software, C2960");

    let alerts = wait_for(
        &mut owner,
        "/api/v1/alerts?source=snmp",
        "the toner alert",
        |b| find(b, "check_id", "snmp:prtMarkerSuppliesLevel:1.1").is_some(),
    )
    .await;
    let toner = find(&alerts, "check_id", "snmp:prtMarkerSuppliesLevel:1.1").expect("alert");
    assert_eq!(toner["source"], "snmp");
    assert_eq!(toner["snmp_device_id"], printer_id);
    assert!(toner["device_id"].is_null());
    assert_eq!(toner["severity"], "critical");
    assert_eq!(toner["hostname"], printer_device["name"]);
    assert!(
        toner["title"]
            .as_str()
            .expect("title")
            .contains("Black Toner"),
        "{toner}"
    );
    let toner_id = toner["id"].as_str().expect("id").to_string();
    let (status, detail) = owner.get(&format!("/api/v1/alerts/{toner_id}")).await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    let (_, devices) = owner
        .get(&format!("/api/v1/network/snmp/devices?site_id={site_id}"))
        .await;
    assert_eq!(
        find(&devices, "id", &printer_id).expect("printer")["status"],
        "alerting"
    );
    // A refilled cartridge resolves it automatically.
    let refill = SnmpResults {
        samples: vec![sample(
            &printer_id,
            now,
            vec![
                value("prtMarkerSuppliesLevel", Some("1.1"), json!(55), "integer"),
                value(
                    "max:prtMarkerSuppliesLevel",
                    Some("1.1"),
                    json!(100),
                    "integer",
                ),
            ],
        )],
        unreachable: vec![],
    };
    out_tx
        .send(rustrmm_proto::encode(&refill).expect("results"))
        .expect("send");
    wait_for(
        &mut owner,
        &format!("/api/v1/alerts/{toner_id}"),
        "the auto-resolve",
        |b| b["alert"]["status"] == "resolved" && b["alert"]["resolution"] == "auto",
    )
    .await;
    // An unreachable device raises its own alert.
    out_tx
        .send(
            rustrmm_proto::encode(&SnmpResults {
                samples: vec![],
                unreachable: vec![switch_id.clone()],
            })
            .expect("results"),
        )
        .expect("send");
    let alerts = wait_for(
        &mut owner,
        "/api/v1/alerts?source=snmp",
        "the unreachable alert",
        |b| find(b, "check_id", "snmp:unreachable").is_some(),
    )
    .await;
    assert_eq!(
        find(&alerts, "check_id", "snmp:unreachable").expect("alert")["snmp_device_id"],
        switch_id
    );

    // ================================================================== 5. traps
    let (status, probe) = owner
        .put(
            &format!("/api/v1/sites/{site_id}/probe"),
            json!({ "device_id": device, "trap_receiver": true }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{probe}");
    assert_eq!(probe["trap_receiver"], true);
    next_command(&mut cmd_rx, "the trap receiver configuration", |c| {
        matches!(c, Command::SnmpConfig(cfg) if cfg.trap_receiver.enabled && cfg.trap_receiver.port == 162)
    })
    .await;
    let (status, rule) = owner
        .post(
            "/api/v1/network/snmp/trap-rules",
            json!({ "name": "Link down", "oid_prefix": "1.3.6.1.6.3.1.1.5.3", "severity": "critical", "title": "Link down" }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{rule}");
    let rule_id = rule["id"].as_str().expect("id").to_string();
    let trap = SnmpTrap {
        from_ip: "192.168.50.20".into(),
        at: chrono::Utc::now().timestamp_millis(),
        version: "v2c".into(),
        oid: "1.3.6.1.6.3.1.1.5.3".into(),
        varbinds: vec![TrapVarbind {
            oid: "1.3.6.1.2.1.2.2.1.1.2".into(),
            kind: "integer".into(),
            value: json!(2),
        }],
    };
    out_tx
        .send(rustrmm_proto::encode(&trap).expect("trap"))
        .expect("send");
    let unmatched = SnmpTrap {
        from_ip: "192.168.50.99".into(),
        oid: "1.3.6.1.4.1.318.0.5".into(),
        ..trap.clone()
    };
    out_tx
        .send(rustrmm_proto::encode(&unmatched).expect("trap"))
        .expect("send");
    let traps = wait_for(
        &mut owner,
        &format!("/api/v1/network/snmp/traps?site_id={site_id}"),
        "both traps",
        |b| b["items"].as_array().is_some_and(|i| i.len() == 2),
    )
    .await;
    let stored = find(&traps, "oid", "1.3.6.1.6.3.1.1.5.3").expect("trap");
    assert_eq!(stored["rule_id"], rule_id);
    assert_eq!(stored["snmp_device_id"], printer_id);
    assert_eq!(stored["varbinds"][0]["value"], 2);
    assert!(find(&traps, "oid", "1.3.6.1.4.1.318.0.5").expect("trap")["alert_id"].is_null());
    let alerts = wait_for(
        &mut owner,
        "/api/v1/alerts?source=snmp",
        "the trap alert",
        |b| find(b, "check_id", "snmp:trap:1.3.6.1.6.3.1.1.5.3").is_some(),
    )
    .await;
    let trap_alert = find(&alerts, "check_id", "snmp:trap:1.3.6.1.6.3.1.1.5.3").expect("alert");
    assert_eq!(trap_alert["severity"], "critical");
    assert_eq!(trap_alert["snmp_device_id"], printer_id);
    assert_eq!(stored["alert_id"], trap_alert["id"]);
    // A repeat trap adds an occurrence to the same alert.
    out_tx
        .send(rustrmm_proto::encode(&trap).expect("trap"))
        .expect("send");
    wait_for(
        &mut owner,
        &format!("/api/v1/alerts/{}", trap_alert["id"].as_str().expect("id")),
        "the second occurrence",
        |b| b["alert"]["occurrences"] == 2,
    )
    .await;

    // Topology (best effort) shows the probe and what it found.
    let (status, topology) = owner
        .get(&format!("/api/v1/network/topology?site_id={site_id}"))
        .await;
    assert_eq!(status, StatusCode::OK, "{topology}");
    let nodes = topology["nodes"].as_array().expect("nodes");
    assert!(nodes.iter().any(|n| n["kind"] == "probe"));
    assert!(
        nodes
            .iter()
            .any(|n| n["kind"] == "snmp" && n["snmp_device_id"] == printer_id)
    );
    assert!(!topology["edges"].as_array().expect("edges").is_empty());

    // Deleting the escrowed key needs step-up and is audited.
    set_step_up(&state, false).await;
    let (status, _) = owner
        .call(Method::DELETE, &format!("/api/v1/escrow/{item_id}"), None)
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    set_step_up(&state, true).await;
    let (status, _) = owner
        .call(Method::DELETE, &format!("/api/v1/escrow/{item_id}"), None)
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let deleted: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM audit_log WHERE action = 'secret.deleted'")
            .fetch_one(&state.db)
            .await
            .expect("audit");
    assert_eq!(deleted, 1);

    drop(out_tx);
    let _ = tokio::time::timeout(Duration::from_secs(5), agent).await;
}
