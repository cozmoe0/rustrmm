//! Monitoring end to end with a scripted agent over real sockets: the signed monitoring
//! configuration is pushed on connect and after a policy change; a critical transition opens an
//! alert that a signed webhook delivers to a local HTTP server (allowlisted); an `ok` result
//! resolves it; an alert during a maintenance window is recorded without notifications; a check
//! with remediation runs a Phase 5 job; and the offline server check fires after the agent
//! disconnects.

use std::net::SocketAddr;
use std::time::Duration;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::http::{HeaderMap, Method, Request, StatusCode, header};
use clap::Parser;
use futures::{SinkExt, StreamExt};
use hmac::{Hmac, KeyInit, Mac};
use http_body_util::BodyExt;
use rustrmm_crypto::sign::SigningKey;
use rustrmm_proto::commands::{
    Command, CommandPayload, CommandResult, RunScript, SignedCommand, command_signing_bytes,
};
use rustrmm_proto::deploy::{EnrollRequest, EnrollResponse};
use rustrmm_proto::handshake::{self, Challenge, Hello, Proof, Welcome};
use rustrmm_proto::monitoring::{CheckResult, CheckResults, CheckState, MonitoringConfig};
use rustrmm_proto::{Frame, Message as _};
use rustrmm_server::state::AppState;
use serde_json::{Value, json};
use sha2::Sha256;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tower::ServiceExt;

const ORIGIN: &str = "https://rmm.test";
const HOOK_SECRET: &str = "hook-signing-secret";

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
    ) -> (StatusCode, Value) {
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
    let (status, me) = client.get("/api/v1/auth/me").await;
    assert_eq!(status, StatusCode::OK, "{me}");
}

// ------------------------------------------------------------------ server, agent, webhook sink

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
    rustrmm_server::automation::spawn_scheduler(state.clone());
    rustrmm_server::monitoring::spawn(state.clone());
    let console = rustrmm_server::listeners::console_router(state.clone());
    (state, console, addr, dir)
}

/// A local HTTP server standing in for the webhook receiver.
async fn webhook_sink() -> (u16, mpsc::UnboundedReceiver<(HeaderMap, Bytes)>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let app = Router::new().route(
        "/hook",
        axum::routing::post(move |headers: HeaderMap, body: Bytes| {
            let tx = tx.clone();
            async move {
                let _ = tx.send((headers, body));
                StatusCode::OK
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let port = listener.local_addr().expect("addr").port();
    tokio::spawn(async move {
        axum::serve(listener, app).await.expect("sink");
    });
    (port, rx)
}

async fn enroll(addr: SocketAddr, secret: &str, key: &SigningKey) -> String {
    let resp: EnrollResponse = reqwest::Client::new()
        .post(format!("http://{addr}/agent/v1/enroll"))
        .json(&EnrollRequest {
            secret: secret.to_string(),
            public_key: key.public_key().to_string(),
            hostname: "WS-MON".into(),
            os_family: "windows".into(),
            os_name: "Windows 11 Pro".into(),
            os_version: "10.0.26100".into(),
            arch: "x86_64".into(),
            hardware_uuid: Some("UUID-WS-MON".into()),
            serial: Some("SN-WS-MON".into()),
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
        hostname: "WS-MON".into(),
        capabilities: vec!["scripts".into()],
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

/// Scripted agent: verifies every signed command, forwards monitoring configurations and
/// scripts to the test, answers them, and sends whatever the test queues on `outgoing`. When
/// `outgoing` closes, the agent disconnects.
async fn fake_agent(
    ws: Ws,
    state: AppState,
    device_id: String,
    configs: mpsc::UnboundedSender<MonitoringConfig>,
    scripts: mpsc::UnboundedSender<RunScript>,
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
                    Command::MonitoringConfig(config) => {
                        let _ = configs.send(config);
                        vec![reply("succeeded", Value::Null)]
                    }
                    Command::RunScript(script) => {
                        let _ = scripts.send(script);
                        vec![
                            reply("running", Value::Null),
                            reply("succeeded", json!({ "exit_code": 0, "stdout": "spooler restarted\n", "stderr": "",
                                                       "duration_ms": 40, "timed_out": false, "truncated": false })),
                        ]
                    }
                    _ => vec![reply("rejected", Value::Null)],
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

fn result(check_id: &str, state: CheckState, message: &str, streak: u32) -> Vec<u8> {
    rustrmm_proto::encode(&CheckResults {
        results: vec![CheckResult {
            check_id: check_id.into(),
            state,
            message: message.into(),
            value: None,
            at: chrono::Utc::now().timestamp_millis(),
            streak,
        }],
        full: false,
    })
    .expect("encode")
}

async fn next_config(rx: &mut mpsc::UnboundedReceiver<MonitoringConfig>) -> MonitoringConfig {
    tokio::time::timeout(Duration::from_secs(10), rx.recv())
        .await
        .expect("a monitoring configuration in time")
        .expect("config")
}

async fn next_hook(rx: &mut mpsc::UnboundedReceiver<(HeaderMap, Bytes)>) -> (HeaderMap, Value) {
    let (headers, body) = tokio::time::timeout(Duration::from_secs(10), rx.recv())
        .await
        .expect("a webhook in time")
        .expect("hook");
    // The signature is an HMAC-SHA256 of the exact body.
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(HOOK_SECRET.as_bytes()).expect("hmac");
    mac.update(&body);
    let expected = format!("sha256={}", hex::encode(mac.finalize().into_bytes()));
    assert_eq!(
        headers
            .get("x-rustrmm-signature")
            .and_then(|v| v.to_str().ok()),
        Some(expected.as_str()),
        "webhook signature"
    );
    (headers, serde_json::from_slice(&body).expect("json body"))
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

fn alert_for<'a>(list: &'a Value, check_id: &str) -> Option<&'a Value> {
    list["items"]
        .as_array()?
        .iter()
        .find(|a| a["check_id"] == check_id)
}

#[tokio::test]
async fn monitoring_alerts_notifications_maintenance_remediation_and_offline() {
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

    // The baseline policy exists and is assigned globally.
    let (_, policies) = owner.get("/api/v1/policies").await;
    let baseline = policies["items"]
        .as_array()
        .expect("items")
        .iter()
        .find(|p| p["name"] == "Baseline monitoring")
        .expect("baseline policy")
        .clone();
    assert_eq!(baseline["assignments"][0]["target_type"], "global");
    let (_, types) = owner.get("/api/v1/monitoring/check-types").await;
    assert_eq!(types["items"].as_array().map(Vec::len), Some(18));

    // ---- enroll and connect: the configuration arrives as a signed command
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
    let (config_tx, mut config_rx) = mpsc::unbounded_channel();
    let (script_tx, mut script_rx) = mpsc::unbounded_channel();
    let (out_tx, out_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let agent = tokio::spawn(fake_agent(
        ws,
        state.clone(),
        device.clone(),
        config_tx,
        script_tx,
        out_rx,
    ));

    let first = next_config(&mut config_rx).await;
    assert_eq!(first.version, first.content_hash());
    let ids: Vec<&str> = first.checks.iter().map(|c| c.id.as_str()).collect();
    for wanted in [
        "cpu-high",
        "memory-high",
        "disk-space-windows",
        "windows-update",
        "antivirus",
    ] {
        assert!(ids.contains(&wanted), "{wanted} in {ids:?}");
    }
    assert!(
        !ids.contains(&"disk-space"),
        "the Linux/macOS disk check is filtered out"
    );
    assert_eq!(
        first
            .checks
            .iter()
            .find(|c| c.id == "cpu-high")
            .expect("cpu")
            .config["crit_pct"],
        98
    );

    // ---- a script, a remediation policy for this device: the new configuration is pushed
    let (status, script) = owner
        .post(
            "/api/v1/scripts",
            json!({ "name": "Restart spooler", "description": "", "category": "Monitoring", "language": "powershell",
                    "platforms": ["windows"], "timeout_secs": 60, "risk": "normal",
                    "content": "Restart-Service Spooler\n", "parameters": [] }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{script}");
    let script_id = script["id"].as_str().expect("id").to_string();
    let (status, body) = owner
        .post(
            "/api/v1/policies",
            json!({ "name": "Broken monitors", "document": { "monitoring": { "checks": [
                { "id": "x", "type": "tcp_port", "config": { "host": "db1" } }
            ] } } }),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(
        body["error"]["details"]["path"],
        "monitoring.checks[0].config.port"
    );
    let (status, policy) = owner
        .post(
            "/api/v1/policies",
            json!({ "name": "Print servers", "document": { "monitoring": { "checks": [
                { "id": "svc-spooler", "type": "service", "name": "Print spooler", "severity": "critical",
                  "interval_secs": 60, "config": { "name": "Spooler" },
                  "remediation": { "script_id": script_id, "max_attempts": 1 } },
                { "id": "cpu-high", "config": { "warn_pct": 80 } }
            ] } } }),
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
    let second = next_config(&mut config_rx).await;
    assert_ne!(second.version, first.version);
    let cpu = second
        .checks
        .iter()
        .find(|c| c.id == "cpu-high")
        .expect("cpu");
    assert_eq!(
        cpu.config["warn_pct"], 80,
        "the device layer overrides one field"
    );
    assert_eq!(cpu.config["crit_pct"], 98, "and keeps the rest");
    assert!(second.checks.iter().any(|c| c.id == "svc-spooler"));
    let (_, effective) = owner
        .get(&format!("/api/v1/devices/{device}/effective-policy"))
        .await;
    assert_eq!(
        effective["origins"]["monitoring.checks.svc-spooler"],
        policy_id
    );

    // ---- a webhook channel (127.0.0.1 allowlisted) and a rule
    let (hook_port, mut hooks) = webhook_sink().await;
    let (status, body) = owner
        .put(
            "/api/v1/settings/monitoring",
            json!({ "default_offline_minutes": 15, "unknown_threshold": 3, "retention_days": 180, "webhook_allowlist": [] }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, channel) = owner
        .post(
            "/api/v1/notification-channels",
            json!({ "name": "Ops hook", "kind": "webhook",
                    "config": { "url": format!("http://127.0.0.1:{hook_port}/hook"), "secret": HOOK_SECRET } }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{channel}");
    assert_eq!(
        channel["config"]["secret"], "••••••",
        "secrets are write-only"
    );
    let channel_id = channel["id"].as_str().expect("id").to_string();
    let stored: Vec<u8> =
        sqlx::query_scalar("SELECT config FROM notification_channels WHERE id = ?")
            .bind(&channel_id)
            .fetch_one(&state.db)
            .await
            .expect("stored");
    assert!(
        !String::from_utf8_lossy(&stored).contains(HOOK_SECRET),
        "the config is encrypted"
    );

    // Without the allowlist, the guard refuses the loopback URL.
    let (_, test) = owner
        .post(
            &format!("/api/v1/notification-channels/{channel_id}/test"),
            json!({}),
        )
        .await;
    assert_eq!(test["ok"], false, "{test}");
    assert!(
        test["error"]
            .as_str()
            .unwrap_or_default()
            .contains("allowlisted"),
        "{test}"
    );
    let (status, body) = owner
        .put(
            "/api/v1/settings/monitoring",
            json!({ "default_offline_minutes": 15, "unknown_threshold": 3, "retention_days": 180,
                    "webhook_allowlist": ["127.0.0.1"] }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (_, test) = owner
        .post(
            &format!("/api/v1/notification-channels/{channel_id}/test"),
            json!({}),
        )
        .await;
    assert_eq!(test["ok"], true, "{test}");
    let (_, sample) = next_hook(&mut hooks).await;
    assert_eq!(sample["event"], "test");

    let (status, rule) = owner
        .post(
            "/api/v1/notification-rules",
            json!({ "name": "Everything to ops", "events": ["opened", "resolved"], "channel_ids": [channel_id] }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{rule}");

    // ---- a critical transition opens an alert and the webhook delivers it
    out_tx
        .send(result(
            "cpu-high",
            CheckState::Critical,
            "CPU 99% (average over 15 min)",
            1,
        ))
        .expect("queue");
    let alerts = wait_for(&mut owner, "/api/v1/alerts", "the CPU alert", |b| {
        alert_for(b, "cpu-high").is_some()
    })
    .await;
    let alert = alert_for(&alerts, "cpu-high").expect("alert").clone();
    assert_eq!(alert["severity"], "critical");
    assert_eq!(alert["status"], "open");
    assert_eq!(alert["source"], "check");
    assert_eq!(alert["hostname"], "WS-MON");
    assert_eq!(alerts["counts"]["critical"], 1);
    let alert_id = alert["id"].as_str().expect("id").to_string();
    let (headers, opened) = next_hook(&mut hooks).await;
    assert_eq!(
        headers.get("x-rustrmm-event").and_then(|v| v.to_str().ok()),
        Some("opened")
    );
    assert_eq!(opened["event"], "opened");
    assert_eq!(opened["alert"]["check_id"], "cpu-high");
    assert_eq!(
        opened["alert"]["link"],
        format!("{ORIGIN}/alerts/{alert_id}")
    );
    let (_, summary) = owner.get("/api/v1/fleet/summary").await;
    assert_eq!(summary["alerts"]["critical"], 1);
    assert_eq!(summary["critical_alerts"], 1);
    let (_, checks) = owner.get(&format!("/api/v1/devices/{device}/checks")).await;
    let cpu_state = checks["items"]
        .as_array()
        .expect("items")
        .iter()
        .find(|c| c["check_id"] == "cpu-high")
        .expect("cpu");
    assert_eq!(cpu_state["state"], "critical");
    assert_eq!(cpu_state["policy_id"], policy_id);

    // A repeat report of the same state does not count as a new occurrence.
    out_tx
        .send(result("cpu-high", CheckState::Critical, "CPU 99%", 2))
        .expect("queue");
    tokio::time::sleep(Duration::from_millis(300)).await;
    let (_, detail) = owner.get(&format!("/api/v1/alerts/{alert_id}")).await;
    assert_eq!(detail["alert"]["occurrences"], 1);
    assert_eq!(detail["check"]["state"], "critical");

    // ---- ok resolves it automatically
    out_tx
        .send(result(
            "cpu-high",
            CheckState::Ok,
            "CPU 12% (average over 15 min)",
            2,
        ))
        .expect("queue");
    let detail = wait_for(
        &mut owner,
        &format!("/api/v1/alerts/{alert_id}"),
        "auto-resolve",
        |b| b["alert"]["status"] == "resolved",
    )
    .await;
    assert_eq!(detail["alert"]["resolution"], "auto");
    let kinds: Vec<&str> = detail["events"]
        .as_array()
        .expect("events")
        .iter()
        .filter_map(|e| e["kind"].as_str())
        .collect();
    assert!(
        kinds.contains(&"opened") && kinds.contains(&"resolved") && kinds.contains(&"notified"),
        "{kinds:?}"
    );
    let (_, resolved) = next_hook(&mut hooks).await;
    assert_eq!(resolved["event"], "resolved");
    let (_, log) = owner
        .get(&format!("/api/v1/notification-log?alert_id={alert_id}"))
        .await;
    assert!(
        log["items"]
            .as_array()
            .expect("items")
            .iter()
            .all(|r| r["status"] == "sent"),
        "{log}"
    );

    // ---- during a maintenance window an alert is recorded but not delivered
    let now = chrono::Utc::now();
    let (status, window) = owner
        .post(
            "/api/v1/maintenance-windows",
            json!({ "name": "Patch night", "targets": [{ "type": "device", "id": device }],
                    "schedule": { "type": "once", "start": now - chrono::Duration::minutes(1), "end": now + chrono::Duration::hours(1) },
                    "suppress": "notifications" }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{window}");
    assert_eq!(window["active_now"], true);
    let (_, maintenance) = owner
        .get(&format!("/api/v1/devices/{device}/maintenance"))
        .await;
    assert_eq!(maintenance["active"].as_array().map(Vec::len), Some(1));
    out_tx
        .send(result("memory-high", CheckState::Critical, "Memory 99%", 1))
        .expect("queue");
    let alerts = wait_for(&mut owner, "/api/v1/alerts", "the memory alert", |b| {
        alert_for(b, "memory-high").is_some()
    })
    .await;
    let memory = alert_for(&alerts, "memory-high").expect("alert").clone();
    assert_eq!(memory["in_maintenance"], true);
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert!(
        hooks.try_recv().is_err(),
        "nothing is delivered during maintenance"
    );
    let (_, log) = owner
        .get(&format!(
            "/api/v1/notification-log?alert_id={}",
            memory["id"].as_str().expect("id")
        ))
        .await;
    assert_eq!(log["items"].as_array().map(Vec::len), Some(0));
    let window_id = window["id"].as_str().expect("id").to_string();
    let (status, _) = owner
        .call(
            Method::DELETE,
            &format!("/api/v1/maintenance-windows/{window_id}"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // ---- remediation runs the script as a Phase 5 job with trigger `policy`
    out_tx
        .send(result(
            "svc-spooler",
            CheckState::Critical,
            "Spooler is stopped (expected running)",
            1,
        ))
        .expect("queue");
    let script_run = tokio::time::timeout(Duration::from_secs(10), script_rx.recv())
        .await
        .expect("remediation dispatched in time")
        .expect("script");
    assert_eq!(script_run.content, "Restart-Service Spooler\n");
    let (job_id, trigger): (String, String) = sqlx::query_as(
        "SELECT j.id, r.trigger_kind FROM jobs j JOIN job_runs r ON r.job_id = j.id WHERE j.created_by_name = 'Monitoring'",
    )
    .fetch_one(&state.db)
    .await
    .expect("remediation job");
    assert_eq!(trigger, "policy");
    let alerts = wait_for(&mut owner, "/api/v1/alerts", "remediation outcome", |b| {
        alert_for(b, "svc-spooler").is_some_and(|a| a["remediation"]["status"] == "succeeded")
    })
    .await;
    let spooler = alert_for(&alerts, "svc-spooler").expect("alert");
    assert_eq!(
        spooler["severity"], "critical",
        "non-graded checks use the configured severity"
    );
    assert_eq!(spooler["remediation"]["job_id"], job_id);
    assert_eq!(spooler["remediation"]["attempts"], 1);
    let (_, job) = owner.get(&format!("/api/v1/jobs/{job_id}")).await;
    assert_eq!(job["runs"][0]["trigger"], "policy", "{job}");

    // Manual actions: acknowledge, then a bulk resolve.
    let spooler_id = spooler["id"].as_str().expect("id").to_string();
    let (status, acked) = owner
        .post(
            &format!("/api/v1/alerts/{spooler_id}/acknowledge"),
            json!({ "note": "on it" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{acked}");
    assert_eq!(acked["alert"]["status"], "acknowledged");
    assert_eq!(acked["alert"]["acknowledged_by_name"], "Olivia Owner");
    let (status, bulk) = owner
        .post(
            "/api/v1/alerts/bulk",
            json!({ "ids": [spooler_id], "action": "resolve", "note": "fixed" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{bulk}");
    assert_eq!(bulk["updated"], 1);
    let audit: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_log WHERE action IN ('alerts.acknowledged', 'alerts.bulk')",
    )
    .fetch_one(&state.db)
    .await
    .expect("audit");
    assert_eq!(audit, 2);

    // ---- the offline server check fires after the agent disconnects
    drop(out_tx);
    let _ = agent.await;
    for _ in 0..50 {
        if !state.agents.is_online(&device) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(!state.agents.is_online(&device));
    sqlx::query("UPDATE devices SET online = 0, last_seen_at = ? WHERE id = ?")
        .bind(rustrmm_common::now() - chrono::Duration::minutes(30))
        .bind(&device)
        .execute(&state.db)
        .await
        .expect("age the device");
    rustrmm_server::monitoring::server_checks::check_offline(&state)
        .await
        .expect("offline check");
    let (_, device_alerts) = owner.get(&format!("/api/v1/devices/{device}/alerts")).await;
    let offline = alert_for(&device_alerts, "offline").expect("offline alert");
    assert_eq!(offline["source"], "server");
    assert_eq!(offline["severity"], "critical");
    assert!(
        offline["message"]
            .as_str()
            .unwrap_or_default()
            .contains("30 minutes"),
        "{offline}"
    );
    // Earlier deliveries (the spooler alert opened and resolved) arrive first.
    let mut seen = Vec::new();
    loop {
        let (_, hook) = next_hook(&mut hooks).await;
        let check = hook["alert"]["check_id"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        seen.push(format!(
            "{check}:{}",
            hook["event"].as_str().unwrap_or_default()
        ));
        if check == "offline" {
            assert_eq!(hook["event"], "opened");
            break;
        }
        assert!(seen.len() < 5, "unexpected deliveries {seen:?}");
    }
    assert_eq!(
        seen,
        vec![
            "svc-spooler:opened",
            "svc-spooler:resolved",
            "offline:opened"
        ]
    );
}
