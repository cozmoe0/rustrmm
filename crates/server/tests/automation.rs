//! Automation end to end: a script, a secret variable and a custom field are created through the
//! API; a job targets a dynamic group; a scripted agent on a real socket verifies the signed
//! `run_script` command and answers; the run completes with the right counts and a directive
//! sets the custom field. Then the mass-action guard, four-eyes approval, policy settings push
//! and the `remote_access` policy are exercised.

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
    Command, CommandPayload, CommandResult, RunScript, SignedCommand, command_signing_bytes,
};
use rustrmm_proto::deploy::{EnrollRequest, EnrollResponse};
use rustrmm_proto::handshake::{self, Challenge, Hello, Proof, Welcome};
use rustrmm_proto::messages::AgentSettings;
use rustrmm_proto::{Frame, Message as _};
use rustrmm_server::state::AppState;
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tower::ServiceExt;

const ORIGIN: &str = "https://rmm.test";
const SECRET: &str = "sup3r-s3cret-token";

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

// ------------------------------------------------------------------ console client

struct Client {
    router: Router,
    cookie: Option<String>,
    csrf: Option<String>,
}

impl Client {
    fn new(router: Router) -> Self {
        Self {
            router,
            cookie: None,
            csrf: None,
        }
    }

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

/// Password + TOTP enrollment for a user without MFA.
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

async fn set_step_up(state: &AppState, email: &str, on: bool) {
    let until = on.then(|| rustrmm_common::now() + chrono::Duration::minutes(5));
    sqlx::query(
        "UPDATE sessions SET stepped_up_until = ? WHERE user_id = (SELECT id FROM users WHERE email = ?)",
    )
    .bind(until)
    .bind(email)
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
    rustrmm_server::automation::spawn_scheduler(state.clone());
    let console = rustrmm_server::listeners::console_router(state.clone());
    (state, console, addr, dir)
}

async fn enroll(addr: SocketAddr, secret: &str, key: &SigningKey, hostname: &str) -> String {
    let resp: EnrollResponse = reqwest::Client::new()
        .post(format!("http://{addr}/agent/v1/enroll"))
        .json(&EnrollRequest {
            secret: secret.to_string(),
            public_key: key.public_key().to_string(),
            hostname: hostname.into(),
            os_family: "windows".into(),
            os_name: "Windows 11 Pro".into(),
            os_version: "10.0.26100".into(),
            arch: "x86_64".into(),
            hardware_uuid: Some(format!("UUID-{hostname}")),
            serial: Some(format!("SN-{hostname}")),
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
        hostname: "WS-ONE".into(),
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

/// Scripted agent: verifies every signed `run_script` (signature, device, content hash), reports
/// `running` then `succeeded` with output that echoes the environment, and forwards settings.
async fn fake_agent(
    mut ws: Ws,
    state: AppState,
    device_id: String,
    scripts: mpsc::UnboundedSender<RunScript>,
    settings: mpsc::UnboundedSender<AgentSettings>,
) {
    let command_key = state.keys.command.public_key();
    while let Some(Ok(msg)) = ws.next().await {
        let WsMessage::Binary(bytes) = msg else {
            continue;
        };
        let frame = Frame::decode(&bytes).expect("frame");
        if frame.t == AgentSettings::TYPE {
            let _ = settings.send(frame.body().expect("settings"));
            continue;
        }
        if frame.t != SignedCommand::TYPE {
            continue;
        }
        let signed: SignedCommand = frame.body().expect("signed");
        command_key
            .verify(&command_signing_bytes(&signed.payload), &signed.signature)
            .expect("command is signed by the server's command key");
        let payload: CommandPayload = rmp_serde::from_slice(&signed.payload).expect("payload");
        assert_eq!(payload.device_id, device_id);
        let Command::RunScript(script) = payload.command else {
            continue;
        };
        assert_eq!(
            rustrmm_proto::scripts::sha256_hex(&script.content),
            script.content_sha256,
            "the signed hash matches the content"
        );
        let ttl = payload.expires_at - payload.issued_at;
        assert_eq!(
            ttl,
            (i64::from(script.timeout_secs) + 60) * 1000,
            "TTL is timeout + 60 s"
        );
        let env = |name: &str| {
            script
                .env
                .iter()
                .rev()
                .find(|(k, _)| k == name)
                .map(|(_, v)| v.clone())
                .unwrap_or_default()
        };
        let stdout = format!(
            "greeting={}\nsecret={}\n::rustrmm::set-field disk_free_gb=42.5\n::rustrmm::set-field readonly_field=1\n",
            env("Greeting"),
            env("API_TOKEN"),
        );
        let _ = scripts.send(script);
        for result in [
            CommandResult {
                cmd_id: payload.cmd_id.clone(),
                status: "running".into(),
                message: String::new(),
                data: Value::Null,
            },
            CommandResult {
                cmd_id: payload.cmd_id.clone(),
                status: "succeeded".into(),
                message: String::new(),
                // Deliberately unmasked: the server masks again.
                data: json!({ "exit_code": 0, "stdout": stdout, "stderr": "", "duration_ms": 12,
                              "timed_out": false, "truncated": false }),
            },
        ] {
            ws.send(WsMessage::Binary(
                rustrmm_proto::encode(&result).expect("result").into(),
            ))
            .await
            .expect("send result");
        }
    }
}

async fn wait_for_run(client: &mut Client, run_id: &str) -> Value {
    for _ in 0..100 {
        let (status, body) = client.get(&format!("/api/v1/job-runs/{run_id}")).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        if body["run"]["status"] == "completed" {
            return body;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("run {run_id} did not complete");
}

fn latest_run(job: &Value) -> String {
    job["runs"][0]["id"].as_str().expect("run id").to_string()
}

#[tokio::test]
async fn scripts_jobs_groups_policies_and_guards() {
    let (state, router, addr, _dir) = start().await;
    let mut owner = Client::new(router.clone());

    // ---- setup and sign-in
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

    // ---- two enrolled Windows devices; only WS-ONE is connected
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
    let key_one = SigningKey::generate();
    let one = enroll(addr, &secret, &key_one, "WS-ONE").await;
    let two = enroll(addr, &secret, &SigningKey::generate(), "WS-TWO").await;
    let ws = connect(&state, addr, &one, &key_one).await;
    let (script_tx, mut script_rx) = mpsc::unbounded_channel();
    let (settings_tx, mut settings_rx) = mpsc::unbounded_channel();
    tokio::spawn(fake_agent(
        ws,
        state.clone(),
        one.clone(),
        script_tx,
        settings_tx,
    ));

    // ---- built-ins are seeded and read-only
    let (_, library) = owner.get("/api/v1/scripts?platform=windows").await;
    let builtin = library["items"]
        .as_array()
        .expect("items")
        .iter()
        .find(|s| s["builtin"] == true)
        .expect("a built-in script")
        .clone();
    let (status, body) = owner
        .put(
            &format!("/api/v1/scripts/{}", builtin["id"].as_str().expect("id")),
            json!({ "name": "x", "language": "powershell", "platforms": ["windows"], "content": "x" }),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "builtin_readonly");

    // ---- a script, a secret variable and a script-writable custom field
    let content = "Write-Output \"greeting=$env:Greeting\"\n";
    let (status, script) = owner
        .post(
            "/api/v1/scripts",
            json!({
                "name": "Say hello", "description": "Test script", "category": "Testing",
                "language": "powershell", "platforms": ["windows"], "timeout_secs": 120, "risk": "normal",
                "content": content,
                "parameters": [{ "name": "Greeting", "label": "Greeting", "type": "string", "required": true }]
            }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{script}");
    let script_id = script["id"].as_str().expect("id").to_string();
    assert_eq!(script["current_version"], 1);
    assert_eq!(
        script["content_sha256"],
        rustrmm_proto::scripts::sha256_hex(content)
    );
    let (status, body) = owner
        .post(
            "/api/v1/scripts",
            json!({ "name": "Bad", "language": "bash", "platforms": ["linux"], "content": "echo",
                    "parameters": [{ "name": "PATH", "type": "string" }] }),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "reserved parameter names: {body}"
    );

    let (status, variable) = owner
        .post(
            "/api/v1/variables",
            json!({ "scope": "global", "name": "API_TOKEN", "value": SECRET, "secret": true, "description": "" }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{variable}");
    assert_eq!(
        variable["value"],
        Value::Null,
        "secret values are never returned"
    );
    let (_, variables) = owner.get("/api/v1/variables").await;
    assert!(!variables.to_string().contains(SECRET));

    for (key, writable) in [("disk_free_gb", true), ("readonly_field", false)] {
        let (status, body) = owner
            .post(
                "/api/v1/custom-fields",
                json!({ "key": key, "name": key, "type": "number", "scope": "device", "script_writable": writable }),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
    }

    // ---- a dynamic group that matches both devices
    let rules = json!({ "match": "all", "conditions": [
        { "field": "os_family", "op": "eq", "value": "windows" },
        { "match": "any", "conditions": [
            { "field": "hostname", "op": "starts_with", "value": "ws-" },
            { "field": "custom.disk_free_gb", "op": "lt", "value": 1 }
        ]}
    ]});
    let (status, preview) = owner
        .post("/api/v1/groups/preview", json!({ "rules": rules }))
        .await;
    assert_eq!(status, StatusCode::OK, "{preview}");
    assert_eq!(preview["count"], 2);
    let (status, group) = owner
        .post(
            "/api/v1/groups",
            json!({ "name": "Windows workstations", "kind": "dynamic", "rules": rules }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{group}");
    assert_eq!(group["member_count"], 2);
    let group_id = group["id"].as_str().expect("id").to_string();
    let (_, filtered) = owner
        .get(&format!("/api/v1/devices?group_id={group_id}"))
        .await;
    assert_eq!(filtered["items"].as_array().expect("items").len(), 2);

    // ---- a job on the group: WS-ONE runs it, offline WS-TWO is skipped
    let job_body = |confirm: Option<i64>| {
        json!({
            "script_id": script_id, "parameters": { "Greeting": "hi there" },
            "target": { "type": "group", "ids": [group_id] }, "schedule": { "type": "now" },
            "offline_wait_minutes": 0, "concurrency": 5, "confirm_count": confirm
        })
    };
    let (status, job) = owner.post("/api/v1/jobs", job_body(None)).await;
    assert_eq!(status, StatusCode::CREATED, "{job}");
    assert_eq!(
        job["content_sha256"],
        rustrmm_proto::scripts::sha256_hex(content)
    );
    assert_eq!(job["target"]["label"], "Windows workstations (dynamic)");
    let run_id = latest_run(&job);
    let sent = tokio::time::timeout(Duration::from_secs(5), script_rx.recv())
        .await
        .expect("agent received the script")
        .expect("script");
    assert_eq!(sent.language, "powershell");
    assert_eq!(sent.content, content);
    assert!(
        sent.env
            .contains(&("Greeting".to_string(), "hi there".to_string()))
    );
    assert!(
        sent.env
            .contains(&("API_TOKEN".to_string(), SECRET.to_string()))
    );
    assert_eq!(
        sent.mask,
        vec![SECRET.to_string()],
        "secrets are masked on the device"
    );
    assert_eq!(sent.max_output_bytes, 256 * 1024);

    let run = wait_for_run(&mut owner, &run_id).await;
    assert_eq!(run["run"]["total"], 2);
    assert_eq!(run["run"]["succeeded"], 1);
    assert_eq!(run["run"]["skipped"], 1);
    assert_eq!(run["run"]["failed"], 0);
    let results = run["results"].as_array().expect("results");
    let skipped = results
        .iter()
        .find(|r| r["device_id"] == two)
        .expect("WS-TWO result");
    assert_eq!(skipped["status"], "skipped");
    assert_eq!(skipped["error"], "Device offline");
    let (status, detail) = owner
        .get(&format!("/api/v1/job-runs/{run_id}/results/{one}"))
        .await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert_eq!(detail["status"], "succeeded");
    assert_eq!(detail["exit_code"], 0);
    let stdout = detail["stdout"].as_str().expect("stdout");
    assert!(stdout.contains("greeting=hi there"));
    assert!(
        !stdout.contains(SECRET),
        "the server masks secrets too: {stdout}"
    );
    assert!(stdout.contains(&format!("secret={}", rustrmm_proto::scripts::MASK)));
    let directives = detail["directives"].as_array().expect("directives");
    assert_eq!(
        directives[0],
        json!({ "field": "disk_free_gb", "value": "42.5", "applied": true })
    );
    assert_eq!(
        directives[1]["applied"], false,
        "fields without script_writable are refused"
    );

    // The directive set the field; it shows on the device and in the device list.
    let (_, fields) = owner
        .get(&format!("/api/v1/devices/{one}/custom-fields"))
        .await;
    let disk = fields["items"]
        .as_array()
        .expect("items")
        .iter()
        .find(|f| f["field"]["key"] == "disk_free_gb")
        .expect("field");
    assert_eq!(disk["value"], 42.5);
    assert_eq!(disk["updated_by"], "script");
    let (_, device) = owner.get(&format!("/api/v1/devices/{one}")).await;
    assert_eq!(device["custom_fields"]["disk_free_gb"], 42.5);
    let (_, timeline) = owner.get(&format!("/api/v1/devices/{one}/timeline")).await;
    let kinds: Vec<&str> = timeline["items"]
        .as_array()
        .expect("items")
        .iter()
        .filter_map(|e| e["kind"].as_str())
        .collect();
    assert!(kinds.contains(&"script.succeeded") && kinds.contains(&"custom_field.changed"));
    let (_, history) = owner
        .get(&format!("/api/v1/devices/{one}/script-runs"))
        .await;
    assert_eq!(history["items"][0]["script_name"], "Say hello");
    // Script content never reaches the audit log; its hash does.
    let audit: Vec<String> = sqlx::query_scalar(
        "SELECT details FROM audit_log WHERE action IN ('script.created', 'job.created')",
    )
    .fetch_all(&state.db)
    .await
    .expect("audit");
    assert!(audit.iter().all(|d| !d.contains("Write-Output")));
    assert!(
        audit
            .iter()
            .any(|d| d.contains(&rustrmm_proto::scripts::sha256_hex(content)))
    );

    // ---- mass-action guard
    let (status, body) = owner
        .put(
            "/api/v1/settings/automation",
            json!({ "mass_action_threshold": 1, "four_eyes_jobs": false, "require_script_approval": false,
                    "allow_self_approval": false, "max_output_kb": 256, "default_offline_wait_minutes": 0 }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    set_step_up(&state, "owner@example.com", false).await;
    let (status, body) = owner.post("/api/v1/jobs", job_body(None)).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "step_up_required");
    set_step_up(&state, "owner@example.com", true).await;
    let (status, body) = owner.post("/api/v1/jobs", job_body(None)).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"]["code"], "confirmation_required");
    assert_eq!(body["error"]["details"]["count"], 2);
    let (status, body) = owner.post("/api/v1/jobs", job_body(Some(3))).await;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "a wrong count is refused: {body}"
    );
    let (status, job) = owner.post("/api/v1/jobs", job_body(Some(2))).await;
    assert_eq!(status, StatusCode::CREATED, "{job}");
    let run = wait_for_run(&mut owner, &latest_run(&job)).await;
    assert_eq!(run["run"]["succeeded"], 1);
    script_rx.recv().await.expect("second script");

    // ---- four-eyes: the job waits until another approver approves it
    let (status, body) = owner
        .put(
            "/api/v1/settings/automation",
            json!({ "mass_action_threshold": 1, "four_eyes_jobs": true, "require_script_approval": false,
                    "allow_self_approval": false, "max_output_kb": 256, "default_offline_wait_minutes": 0 }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, job) = owner.post("/api/v1/jobs", job_body(Some(2))).await;
    assert_eq!(status, StatusCode::CREATED, "{job}");
    assert_eq!(job["status"], "pending_approval");
    assert_eq!(
        job["runs"].as_array().expect("runs").len(),
        0,
        "nothing runs before approval"
    );
    let job_id = job["id"].as_str().expect("id").to_string();
    let (_, approvals) = owner.get("/api/v1/approvals?status=pending").await;
    let approval = approvals["items"][0].clone();
    assert_eq!(approval["subject"]["id"], job_id);
    let approval_id = approval["id"].as_str().expect("id").to_string();
    let (status, body) = owner
        .post(
            &format!("/api/v1/approvals/{approval_id}/approve"),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "self_approval");

    let (status, body) = owner
        .post(
            "/api/v1/users",
            json!({ "name": "Ada Approver", "email": "ada@example.com", "password": "another-strong-passphrase",
                    "assignments": [{ "role_id": "builtin-admin", "scope_type": "global" }] }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let mut ada = Client::new(router.clone());
    first_login(&mut ada, "ada@example.com", "another-strong-passphrase").await;
    set_step_up(&state, "ada@example.com", true).await;
    let (_, still) = owner.get(&format!("/api/v1/jobs/{job_id}")).await;
    assert_eq!(still["status"], "pending_approval");
    let (status, approved) = ada
        .post(
            &format!("/api/v1/approvals/{approval_id}/approve"),
            json!({ "comment": "ok" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{approved}");
    assert_eq!(approved["status"], "approved");
    assert_eq!(approved["decided_by_name"], "Ada Approver");
    let (_, job) = owner.get(&format!("/api/v1/jobs/{job_id}")).await;
    assert_eq!(job["approved_by_name"], "Ada Approver");
    let run = wait_for_run(&mut owner, &latest_run(&job)).await;
    assert_eq!(run["run"]["succeeded"], 1);
    script_rx.recv().await.expect("approved script");

    // ---- policies: settings push, effective policy with origins, remote_access enforcement
    let (status, policy) = owner
        .post(
            "/api/v1/policies",
            json!({ "name": "Baseline", "description": "", "document": {
                "agent": { "heartbeat_secs": 45 },
                "remote_access": { "system": false },
                "tasks": [{ "id": "hello", "name": "Weekly hello", "script_id": script_id,
                            "parameters": { "Greeting": "from policy" }, "cron": "0 3 * * 0", "timezone": "UTC" }]
            }}),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{policy}");
    let policy_id = policy["id"].as_str().expect("id").to_string();
    let (status, body) = owner
        .post(
            "/api/v1/policies",
            json!({ "name": "Broken", "document": { "billing": {} } }),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["error"]["details"]["path"], "billing");
    let (status, body) = owner
        .post(
            &format!("/api/v1/policies/{policy_id}/assignments"),
            json!({ "target_type": "global" }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let pushed = tokio::time::timeout(Duration::from_secs(5), settings_rx.recv())
        .await
        .expect("settings pushed")
        .expect("settings");
    assert_eq!(pushed.heartbeat_secs, 45);
    let (_, effective) = owner
        .get(&format!("/api/v1/devices/{one}/effective-policy"))
        .await;
    assert_eq!(effective["document"]["agent"]["heartbeat_secs"], 45);
    assert_eq!(effective["origins"]["agent.heartbeat_secs"], policy_id);
    assert_eq!(effective["origins"]["tasks.hello"], policy_id);
    // The seeded "Baseline monitoring" policy is global too (lower priority, so it comes first).
    assert_eq!(
        effective["sources"][0]["policy_name"],
        "Baseline monitoring"
    );
    assert_eq!(effective["sources"][1]["policy_name"], "Baseline");
    let (status, body) = owner.get(&format!("/api/v1/devices/{one}/processes")).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"]["code"], "disabled_by_policy");
    assert!(
        body["error"]["message"]
            .as_str()
            .expect("message")
            .contains("Baseline")
    );
    let (_, jobs) = owner.get("/api/v1/jobs").await;
    assert!(
        jobs["items"]
            .as_array()
            .expect("items")
            .iter()
            .any(|j| j["target"]["type"] == "policy" && j["status"] == "scheduled"),
        "the policy task became a scheduled policy job"
    );
    let (status, body) = owner
        .call(Method::DELETE, &format!("/api/v1/groups/{group_id}"), None)
        .await;
    assert_eq!(
        status,
        StatusCode::NO_CONTENT,
        "the group is not in use: {body}"
    );
}
