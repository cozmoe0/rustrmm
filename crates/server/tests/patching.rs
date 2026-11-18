//! Patching and software end to end with scripted agents over real sockets: a `PatchReport`
//! fills the catalog and device states; an auto-approval rule (with ring delays) and a client
//! override decide what is effective-approved; a window opening (test hook) sends a signed
//! `PatchInstall` with exactly those keys; the result updates states, the patch run and raises
//! an alert; an uploaded file is deployed with a single-use download token; compliance adds up.

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
use rustrmm_proto::handshake::{self, Challenge, Hello, Proof, Welcome};
use rustrmm_proto::patching::{
    AgentPatch, PatchInstall, PatchInstallOutcome, PatchKeyResult, PatchReport, PatchScan,
};
use rustrmm_proto::software::{SoftwareAction, SoftwareActionOutcome};
use rustrmm_proto::{Frame, Message as _};
use rustrmm_server::state::AppState;
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tower::ServiceExt;

const ORIGIN: &str = "https://rmm.test";
const KEY_A: &str = "0a000000-0000-4000-8000-00000000000a";
const KEY_B: &str = "0b000000-0000-4000-8000-00000000000b";
const KEY_C: &str = "0c000000-0000-4000-8000-00000000000c";
const INSTALLER: &[u8] = b"MZ\x90\x00 pretend installer for the RustRMM integration test";

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

// ------------------------------------------------------------------ console client

struct Client {
    router: Router,
    cookie: Option<String>,
    csrf: Option<String>,
}

impl Client {
    async fn send(&mut self, req: axum::http::request::Builder, body: Body) -> (StatusCode, Value) {
        let mut req = req.header(header::ORIGIN, ORIGIN);
        if let Some(cookie) = &self.cookie {
            req = req.header(header::COOKIE, cookie);
        }
        if let Some(csrf) = &self.csrf {
            req = req.header("x-csrf-token", csrf);
        }
        let response = self
            .router
            .clone()
            .oneshot(req.body(body).expect("request"))
            .await
            .expect("response");
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
        (status, value)
    }

    async fn call(
        &mut self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let req = Request::builder().method(method).uri(path);
        match body {
            Some(b) => {
                self.send(
                    req.header(header::CONTENT_TYPE, "application/json"),
                    Body::from(b.to_string()),
                )
                .await
            }
            None => self.send(req, Body::empty()).await,
        }
    }

    async fn get(&mut self, path: &str) -> (StatusCode, Value) {
        self.call(Method::GET, path, None).await
    }

    async fn post(&mut self, path: &str, body: Value) -> (StatusCode, Value) {
        self.call(Method::POST, path, Some(body)).await
    }

    async fn upload(
        &mut self,
        path: &str,
        name: &str,
        bytes: &'static [u8],
    ) -> (StatusCode, Value) {
        let req = Request::builder()
            .method(Method::POST)
            .uri(path)
            .header("x-file-name", name)
            .header(header::CONTENT_LENGTH, bytes.len().to_string())
            .header(header::CONTENT_TYPE, "application/octet-stream");
        self.send(req, Body::from(bytes)).await
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

// ------------------------------------------------------------------ server and agents

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
    // The patching scheduler is driven by hand through `tick_at` (the test hook).
    let console = rustrmm_server::listeners::console_router(state.clone());
    (state, console, addr, dir)
}

async fn enroll(addr: SocketAddr, secret: &str, key: &SigningKey, host: &str, os: &str) -> String {
    let resp: EnrollResponse = reqwest::Client::new()
        .post(format!("http://{addr}/agent/v1/enroll"))
        .json(&EnrollRequest {
            secret: secret.to_string(),
            public_key: key.public_key().to_string(),
            hostname: host.into(),
            os_family: os.into(),
            os_name: if os == "windows" {
                "Windows 11 Pro"
            } else {
                "Ubuntu 24.04"
            }
            .into(),
            os_version: "1".into(),
            arch: "x86_64".into(),
            hardware_uuid: Some(format!("UUID-{host}")),
            serial: Some(format!("SN-{host}")),
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

async fn connect(
    state: &AppState,
    addr: SocketAddr,
    device_id: &str,
    key: &SigningKey,
    os: &str,
    host: &str,
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
        os_family: os.into(),
        hostname: host.into(),
        capabilities: vec!["patching".into(), "software".into()],
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

/// What a scripted agent saw.
#[derive(Debug)]
enum Seen {
    Scan(PatchScan),
    Install(PatchInstall),
    Software {
        action: Box<SoftwareAction>,
        downloaded: bool,
        second_status: u16,
    },
}

/// Scripted agent: verifies every signed command, reports what it saw, answers installs
/// (`fail_key` fails) and software actions (downloading the file twice with its token).
async fn fake_agent(
    ws: Ws,
    state: AppState,
    device_id: String,
    addr: SocketAddr,
    fail_key: Option<String>,
    seen: mpsc::UnboundedSender<Seen>,
    mut outgoing: mpsc::UnboundedReceiver<Vec<u8>>,
) {
    let command_key = state.keys.command.public_key();
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
                let results = match payload.command {
                    Command::PatchScan(scan) => {
                        let _ = seen.send(Seen::Scan(scan));
                        vec![reply("succeeded", json!({ "available": 0 }))]
                    }
                    Command::PatchInstall(install) => {
                        let outcome = PatchInstallOutcome {
                            results: install
                                .keys
                                .iter()
                                .map(|k| {
                                    let fail = fail_key.as_deref() == Some(k.as_str());
                                    PatchKeyResult {
                                        key: k.clone(),
                                        status: if fail { "failed" } else { "installed" }.into(),
                                        hresult: fail.then_some(0x8024_2016_u32 as i32 as i64),
                                        error: fail.then(|| "Windows Update reported a failure".into()),
                                    }
                                })
                                .collect(),
                            reboot_required: false,
                            rebooting: false,
                            deferrals_used: 0,
                            phase: None,
                        };
                        let _ = seen.send(Seen::Install(install));
                        vec![
                            reply("running", Value::Null),
                            reply("succeeded", serde_json::to_value(&outcome).expect("outcome")),
                        ]
                    }
                    Command::SoftwareAction(action) => {
                        let download = action.download.clone().expect("a file download");
                        let url = format!("http://{addr}{}", download.url);
                        let client = reqwest::Client::new();
                        let first = client
                            .get(&url)
                            .header("x-rustrmm-device-id", &device_id)
                            .send()
                            .await
                            .expect("download");
                        let ok = first.status() == reqwest::StatusCode::OK;
                        let body = first.bytes().await.expect("bytes");
                        let downloaded = ok
                            && body.len() as u64 == download.size
                            && rustrmm_crypto::random::sha256_hex(&body) == download.sha256;
                        let second = client
                            .get(&url)
                            .header("x-rustrmm-device-id", &device_id)
                            .send()
                            .await
                            .expect("second download");
                        let outcome = SoftwareActionOutcome {
                            exit_code: Some(0),
                            output: "installed".into(),
                            duration_ms: 1200,
                            ..SoftwareActionOutcome::default()
                        };
                        let _ = seen.send(Seen::Software {
                            action: Box::new(action),
                            downloaded,
                            second_status: second.status().as_u16(),
                        });
                        vec![
                            reply("running", Value::Null),
                            reply("succeeded", serde_json::to_value(&outcome).expect("outcome")),
                        ]
                    }
                    _ => vec![reply("succeeded", Value::Null)],
                };
                for r in results {
                    sink.send(WsMessage::Binary(rustrmm_proto::encode(&r).expect("result").into()))
                        .await
                        .expect("send result");
                }
            }
        }
    }
}

async fn next_seen(
    rx: &mut mpsc::UnboundedReceiver<Seen>,
    what: &str,
    want: fn(&Seen) -> bool,
) -> Seen {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let item = tokio::time::timeout_at(deadline, rx.recv())
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for {what}"))
            .expect("agent channel");
        if want(&item) {
            return item;
        }
    }
}

async fn wait_for<F>(client: &mut Client, path: &str, what: &str, mut done: F) -> Value
where
    F: FnMut(&Value) -> bool,
{
    let mut last = Value::Null;
    for _ in 0..100 {
        let (status, body) = client.get(path).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        if done(&body) {
            return body;
        }
        last = body;
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("timed out waiting for {what}: {last}");
}

fn days_ago(days: i64) -> String {
    (chrono::Utc::now() - chrono::Duration::days(days)).to_rfc3339()
}

fn windows_patch(
    key: &str,
    kb: &str,
    classification: &str,
    severity: Option<&str>,
    released_days_ago: i64,
) -> AgentPatch {
    AgentPatch {
        key: key.into(),
        kb: Some(kb.into()),
        title: format!("2026-11 Update ({kb})"),
        classification: classification.into(),
        severity: severity.map(str::to_string),
        size_bytes: Some(50_000_000),
        reboot_required: true,
        release_date: Some(days_ago(released_days_ago)),
        ..AgentPatch::default()
    }
}

fn item_for<'a>(list: &'a Value, key: &str) -> &'a Value {
    list["items"]
        .as_array()
        .expect("items")
        .iter()
        .find(|i| i["patch"]["key"] == key || i["key"] == key)
        .unwrap_or_else(|| panic!("{key} in {list}"))
}

#[tokio::test]
async fn patch_reports_approvals_windows_deployments_and_compliance() {
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

    // ---- a patching policy: weekly window, broad ring, Windows security updates auto-approved
    let (status, body) = owner
        .post(
            "/api/v1/policies",
            json!({ "name": "Bad patching", "document": { "patching": { "ring": "early" } } }),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["error"]["details"]["path"], "patching.ring");
    let (status, policy) = owner
        .post(
            "/api/v1/policies",
            json!({ "name": "Workstation patching", "document": { "patching": {
                "enabled": true, "scan_interval_hours": 12,
                "window": { "cron": "0 2 * * 3", "duration_minutes": 180, "timezone": "UTC" },
                "ring": "broad",
                "auto_approve": [{ "platform": "windows", "classifications": ["SecurityUpdates"],
                                   "delay_days": { "pilot": 0, "broad": 7, "late": 21 } }],
                "reboot": { "mode": "prompt", "prompt_deferrals": 2, "force_at_window_end": true }
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
    let (_, rules) = owner.get("/api/v1/patch-approval-rules").await;
    assert_eq!(rules["items"][0]["policy_name"], "Workstation patching");
    assert_eq!(rules["items"][0]["delay_days"]["broad"], 7);

    // ---- enroll a Windows and a Linux device
    let (site_id, client_id): (String, String) =
        sqlx::query_as("SELECT id, client_id FROM sites LIMIT 1")
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
    let win_key = SigningKey::generate();
    let win = enroll(addr, &secret, &win_key, "WS-PATCH", "windows").await;
    let lin_key = SigningKey::generate();
    let lin = enroll(addr, &secret, &lin_key, "LNX-PATCH", "linux").await;

    let (win_seen_tx, mut win_seen) = mpsc::unbounded_channel();
    let (win_out, win_out_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let ws = connect(&state, addr, &win, &win_key, "windows", "WS-PATCH").await;
    let win_agent = tokio::spawn(fake_agent(
        ws,
        state.clone(),
        win.clone(),
        addr,
        Some(KEY_B.to_string()),
        win_seen_tx,
        win_out_rx,
    ));
    // Patching is enabled and no scan was ever requested: connecting triggers one.
    let scan = next_seen(&mut win_seen, "a scan on connect", |s| {
        matches!(s, Seen::Scan(_))
    })
    .await;
    assert!(matches!(scan, Seen::Scan(s) if !s.include_drivers));

    let (lin_seen_tx, mut lin_seen) = mpsc::unbounded_channel();
    let (lin_out, lin_out_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let ws = connect(&state, addr, &lin, &lin_key, "linux", "LNX-PATCH").await;
    let lin_agent = tokio::spawn(fake_agent(
        ws,
        state.clone(),
        lin.clone(),
        addr,
        None,
        lin_seen_tx,
        lin_out_rx,
    ));
    next_seen(&mut lin_seen, "a Linux scan on connect", |s| {
        matches!(s, Seen::Scan(_))
    })
    .await;

    // ---- 1. reports fill the catalog and the device states
    let report = PatchReport {
        scanned_at: chrono::Utc::now().timestamp_millis(),
        source: "windows_update".into(),
        available: vec![
            windows_patch(KEY_A, "KB5000001", "SecurityUpdates", Some("Critical"), 10),
            windows_patch(KEY_B, "KB5000002", "Updates", None, 30),
            windows_patch(KEY_C, "KB5000003", "SecurityUpdates", Some("Important"), 1),
        ],
        installed_recent: vec![],
        pending_reboot: false,
        reboot_reasons: vec![],
        last_install_at: None,
        error: None,
        cmd_id: None,
    };
    win_out
        .send(rustrmm_proto::encode(&report).expect("report"))
        .expect("queue");
    let lin_report = PatchReport {
        scanned_at: chrono::Utc::now().timestamp_millis(),
        source: "apt".into(),
        available: vec![AgentPatch {
            key: "apt:openssl:3.0.13-0ubuntu3.4".into(),
            title: "openssl 3.0.13-0ubuntu3.4".into(),
            classification: "security".into(),
            package: Some("openssl".into()),
            version: Some("3.0.13-0ubuntu3.4".into()),
            ..AgentPatch::default()
        }],
        ..PatchReport::default()
    };
    lin_out
        .send(rustrmm_proto::encode(&lin_report).expect("report"))
        .expect("queue");
    let catalog = wait_for(
        &mut owner,
        "/api/v1/patches?status=missing",
        "the catalog",
        |b| b["items"].as_array().is_some_and(|i| i.len() == 4),
    )
    .await;
    let a = item_for(&catalog, KEY_A);
    assert_eq!(a["kb"], "KB5000001");
    assert_eq!(a["classification"], "SecurityUpdates");
    assert_eq!(a["severity"], "Critical");
    assert_eq!(a["devices"]["missing"], 1);
    let patch_id =
        |list: &Value, key: &str| item_for(list, key)["id"].as_str().expect("id").to_string();
    let (_id_a, id_b, id_c) = (
        patch_id(&catalog, KEY_A),
        patch_id(&catalog, KEY_B),
        patch_id(&catalog, KEY_C),
    );
    let (_, linux_only) = owner.get("/api/v1/patches?platform=linux").await;
    assert_eq!(linux_only["items"].as_array().map(Vec::len), Some(1));

    // ---- 2. the auto-approval rule applied, with the broad ring delay
    let device_path = format!("/api/v1/devices/{win}/patches");
    let (_, device) = owner.get(&device_path).await;
    assert_eq!(device["source"], "windows_update");
    assert_eq!(device["items"].as_array().map(Vec::len), Some(3));
    let a = item_for(&device, KEY_A);
    assert_eq!(a["state"], "missing");
    assert_eq!(a["patch"]["approval"]["status"], "approved");
    assert_eq!(a["patch"]["approval"]["source"], "rule");
    assert_eq!(
        a["effective_approved"], true,
        "released 10 days ago, broad delay 7"
    );
    let c = item_for(&device, KEY_C);
    assert_eq!(c["patch"]["approval"]["status"], "approved");
    assert_eq!(
        c["effective_approved"], false,
        "released yesterday: still inside the ring delay"
    );
    let b = item_for(&device, KEY_B);
    assert_eq!(
        b["patch"]["approval"]["status"], "none",
        "Updates are not auto-approved"
    );
    let (_, lin_device) = owner.get(&format!("/api/v1/devices/{lin}/patches")).await;
    assert_eq!(lin_device["items"][0]["effective_approved"], false);

    // A global decline, then a client-level approval that overrides it for this client.
    let (status, body) = owner
        .post(
            "/api/v1/patches/approve",
            json!({ "ids": [id_b], "decision": "declined" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (_, global) = owner.get(&format!("/api/v1/patches/{id_b}")).await;
    assert_eq!(global["patch"]["approval"]["status"], "declined");
    assert_eq!(global["devices"][0]["hostname"], "WS-PATCH");
    let (status, body) = owner
        .post(
            "/api/v1/patches/approve",
            json!({ "ids": [id_b], "client_id": client_id, "decision": "approved" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = owner
        .post(
            "/api/v1/patches/approve",
            json!({ "ids": [id_c], "decision": "deferred" }),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "a deferral needs `until`: {body}"
    );
    let (_, device) = owner.get(&device_path).await;
    assert_eq!(item_for(&device, KEY_B)["effective_approved"], true);
    assert_eq!(
        item_for(&device, KEY_B)["patch"]["approval"]["client_id"],
        client_id
    );
    let (_, by_client) = owner
        .get(&format!(
            "/api/v1/patches?client_id={client_id}&approval=approved"
        ))
        .await;
    assert_eq!(
        by_client["items"].as_array().map(Vec::len),
        Some(3),
        "{by_client}"
    );

    // ---- 3. the window opens: exactly the effective-approved keys are sent, signed
    let next =
        rustrmm_server::automation::cron::next_after("0 2 * * 3", "UTC", rustrmm_common::now())
            .expect("next window");
    let inside = next + chrono::Duration::minutes(30);
    rustrmm_server::patching::runs::tick_at(&state, inside)
        .await
        .expect("tick");
    let install = match next_seen(&mut win_seen, "PatchInstall", |s| {
        matches!(s, Seen::Install(_))
    })
    .await
    {
        Seen::Install(i) => i,
        other => panic!("unexpected {other:?}"),
    };
    let mut keys = install.keys.clone();
    keys.sort();
    assert_eq!(keys, vec![KEY_A.to_string(), KEY_B.to_string()]);
    assert!(install.run_id.is_some());
    let window_end = (next + chrono::Duration::minutes(180)).timestamp();
    assert_eq!(install.window_end_unix, Some(window_end));
    assert_eq!(install.reboot.mode, "prompt");
    assert_eq!(install.reboot.deferrals, 2);
    assert_eq!(
        install.reboot.deadline_unix,
        Some(window_end),
        "force at window end"
    );

    // ---- 4. the result updates states and the patch run
    let runs = wait_for(&mut owner, "/api/v1/patch-runs", "the patch run", |b| {
        b["items"][0]["status"] == "completed"
    })
    .await;
    let run = &runs["items"][0];
    assert_eq!(run["policy_id"], policy_id);
    assert_eq!(run["policy_name"], "Workstation patching");
    assert_eq!(
        run["total"], 1,
        "the Linux device had nothing approved to install"
    );
    assert_eq!(run["failed"], 1);
    assert_eq!(run["succeeded"], 0);
    let run_id = run["id"].as_str().expect("id").to_string();
    assert_eq!(install.run_id.as_deref(), Some(run_id.as_str()));
    let (_, detail) = owner.get(&format!("/api/v1/patch-runs/{run_id}")).await;
    assert_eq!(detail["results"][0]["hostname"], "WS-PATCH");
    assert_eq!(detail["results"][0]["installed"], 1);
    assert_eq!(detail["results"][0]["failed"], 1);
    let (_, device) = owner.get(&device_path).await;
    assert_eq!(item_for(&device, KEY_A)["state"], "installed");
    let b = item_for(&device, KEY_B);
    assert_eq!(b["state"], "failed");
    assert!(
        b["last_error"]
            .as_str()
            .unwrap_or_default()
            .contains("0x80242016"),
        "{b}"
    );
    assert_eq!(item_for(&device, KEY_C)["state"], "missing");
    // A second tick inside the same window opens no second run.
    rustrmm_server::patching::runs::tick_at(&state, inside + chrono::Duration::minutes(5))
        .await
        .expect("tick");
    let (_, runs) = owner.get("/api/v1/patch-runs").await;
    assert_eq!(runs["items"].as_array().map(Vec::len), Some(1));
    // The failure raised a server-side alert; a successful install afterwards rescans.
    let alerts = wait_for(
        &mut owner,
        &format!("/api/v1/alerts?device_id={win}"),
        "the alert",
        |b| {
            b["items"]
                .as_array()
                .is_some_and(|i| i.iter().any(|a| a["check_id"] == "patching.install_failed"))
        },
    )
    .await;
    let alert = alerts["items"]
        .as_array()
        .expect("items")
        .iter()
        .find(|a| a["check_id"] == "patching.install_failed")
        .expect("alert");
    assert_eq!(alert["source"], "server");
    assert_eq!(alert["check_type"], "patching");
    next_seen(&mut win_seen, "the post-install scan", |s| {
        matches!(s, Seen::Scan(_))
    })
    .await;
    assert!(
        !std::iter::from_fn(|| lin_seen.try_recv().ok()).any(|s| matches!(s, Seen::Install(_))),
        "nothing was sent to the Linux device"
    );

    // ---- 5. software: upload, package, deployment with a single-use token
    let (status, file) = owner
        .upload("/api/v1/software/files", "setup.exe", INSTALLER)
        .await;
    assert_eq!(status, StatusCode::OK, "{file}");
    assert_eq!(
        file["sha256"],
        rustrmm_crypto::random::sha256_hex(INSTALLER)
    );
    assert_eq!(file["size_bytes"], INSTALLER.len());
    let stored = state
        .args
        .files_dir()
        .join(file["sha256"].as_str().expect("sha"));
    assert_eq!(std::fs::read(&stored).expect("stored"), INSTALLER);
    let (status, package) = owner
        .post(
            "/api/v1/software/packages",
            json!({ "name": "Pretend App", "publisher": "RustRMM", "platforms": ["windows"],
                    "source": { "type": "file", "file_id": file["file_id"], "installer": "exe", "install_args": "/S" },
                    "detection": { "type": "none" } }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{package}");
    assert_eq!(package["source"]["sha256"], file["sha256"]);
    let (status, body) = owner
        .post(
            "/api/v1/software/packages",
            json!({ "name": "Wrong", "platforms": ["linux"],
                    "source": { "type": "winget", "id": "7zip.7zip" } }),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    let (status, deployment) = owner
        .post(
            "/api/v1/software/deployments",
            json!({ "package_id": package["id"], "action": "install",
                    "target": { "type": "devices", "ids": [win, lin] }, "schedule": { "type": "now" } }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{deployment}");
    let deployment_id = deployment["id"].as_str().expect("id").to_string();
    let seen = next_seen(&mut win_seen, "SoftwareAction", |s| {
        matches!(s, Seen::Software { .. })
    })
    .await;
    let Seen::Software {
        action,
        downloaded,
        second_status,
    } = seen
    else {
        panic!("unexpected {seen:?}");
    };
    assert_eq!(action.action, "install");
    assert!(
        action
            .download
            .as_ref()
            .is_some_and(|d| d.url.starts_with("/agent/v1/files/"))
    );
    assert!(
        downloaded,
        "the file downloads with its token and matches its SHA-256"
    );
    assert_eq!(second_status, 403, "the token is single-use");
    let detail = wait_for(
        &mut owner,
        &format!("/api/v1/software/deployments/{deployment_id}"),
        "the deployment",
        |b| b["deployment"]["status"] == "completed",
    )
    .await;
    assert_eq!(detail["deployment"]["succeeded"], 1);
    assert_eq!(
        detail["deployment"]["skipped"], 1,
        "the Linux device cannot run an exe"
    );
    let result = detail["results"]
        .as_array()
        .expect("results")
        .iter()
        .find(|r| r["device_id"] == win)
        .expect("result");
    assert_eq!(result["status"], "succeeded");
    assert_eq!(result["exit_code"], 0);
    let (_, list) = owner.get("/api/v1/software/deployments").await;
    assert_eq!(list["items"][0]["package"]["name"], "Pretend App");
    let (_, device_deployments) = owner
        .get(&format!("/api/v1/devices/{win}/software-deployments"))
        .await;
    assert_eq!(device_deployments["items"][0]["status"], "succeeded");

    // The explorer groups installed software by normalised name and publisher.
    for (device, name, version) in [
        (&win, "7-Zip 24.08 (x64)", "24.08"),
        (&lin, "7-Zip 23.01 (x64)", "23.01"),
    ] {
        sqlx::query("INSERT INTO device_software (device_id, name, version, publisher) VALUES (?, ?, ?, 'Igor Pavlov')")
            .bind(device)
            .bind(name)
            .bind(version)
            .execute(&state.db)
            .await
            .expect("software");
    }
    let (_, software) = owner.get("/api/v1/software?q=7-zip").await;
    assert_eq!(
        software["items"].as_array().map(Vec::len),
        Some(1),
        "{software}"
    );
    assert_eq!(software["items"][0]["name"], "7-Zip");
    assert_eq!(software["items"][0]["devices"], 2);
    assert_eq!(software["items"][0]["versions"], 2);
    assert_eq!(software["items"][0]["latest_version"], "24.08");
    let (_, product) = owner
        .get("/api/v1/software/product?name=7-Zip&publisher=Igor%20Pavlov")
        .await;
    assert_eq!(product["versions"][0]["version"], "24.08");
    assert_eq!(product["devices"].as_array().map(Vec::len), Some(2));

    // ---- 6. compliance
    let (status, compliance) = owner
        .get("/api/v1/patching/compliance?group_by=client")
        .await;
    assert_eq!(status, StatusCode::OK, "{compliance}");
    let totals = &compliance["totals"];
    assert_eq!(totals["devices"], 2);
    assert_eq!(
        totals["compliant"], 1,
        "the Linux device has nothing approved missing"
    );
    assert_eq!(
        totals["non_compliant"], 1,
        "a failed install is still missing on Windows"
    );
    assert_eq!(totals["failed"], 1);
    assert_eq!(
        totals["missing_critical"], 0,
        "the critical patch installed"
    );
    assert_eq!(totals["missing_important"], 1, "KB5000003 is still missing");
    assert_eq!(totals["pending_reboot"], 0);
    let row = &compliance["rows"][0];
    assert_eq!(row["label"], "Acme Dental");
    assert_eq!(row["devices"], 2);
    assert_eq!(row["compliance_pct"], 50.0);
    assert_eq!(row["missing_by_severity"]["Important"], 1);
    assert_eq!(row["missing_by_severity"]["Unspecified"], 2);
    let (_, by_os) = owner.get("/api/v1/patching/compliance?group_by=os").await;
    assert_eq!(by_os["rows"].as_array().map(Vec::len), Some(2));

    drop(win_out);
    drop(lin_out);
    let _ = win_agent.await;
    let _ = lin_agent.await;
}
