//! Hardening pass: browser security headers on every console response type, rate limits on
//! login, MFA, enrollment, support requests and API tokens, the code-signing status endpoint and
//! the debounced `device.offline` webhook event.

use std::net::SocketAddr;

use axum::Router;
use axum::body::Body;
use axum::http::{HeaderMap, Method, Request, StatusCode, header};
use clap::Parser;
use futures::{SinkExt, StreamExt};
use http_body_util::BodyExt;
use rustrmm_crypto::sign::SigningKey;
use rustrmm_proto::deploy::{EnrollRequest, EnrollResponse};
use rustrmm_proto::handshake::{self, Challenge, Hello, Proof, Welcome};
use rustrmm_proto::support::{self as proto, SupportRequest};
use rustrmm_server::state::AppState;
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tower::ServiceExt;

const ORIGIN: &str = "https://rmm.test";

struct Server {
    state: AppState,
    console: Router,
    agents: Router,
    addr: SocketAddr,
    _dir: tempfile::TempDir,
}

async fn server(agent_dist: Option<&std::path::Path>) -> Server {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut args = vec![
        "rustrmm-server".to_string(),
        "--data-dir".into(),
        dir.path().to_str().expect("utf8").into(),
        "--tls-mode".into(),
        "proxy".into(),
        "--agent-noise".into(),
        "auto".into(),
        "--console-url".into(),
        ORIGIN.into(),
    ];
    if let Some(d) = agent_dist {
        args.push("--agent-dist".into());
        args.push(d.to_str().expect("utf8").into());
    }
    let args = rustrmm_server::config::Cli::parse_from(args).serve;
    let prepared = rustrmm_server::prepare(args, false).await.expect("prepare");
    let state = prepared.state.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    let agents = rustrmm_server::listeners::agent_router(state.clone());
    let served = agents.clone();
    tokio::spawn(async move {
        axum::serve(
            listener,
            served.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .expect("serve");
    });
    let console = rustrmm_server::listeners::console_router(state.clone());
    let token = state.setup.current_token().expect("setup token");
    let (status, body) = request(
        &console,
        Method::POST,
        "/api/v1/setup/complete",
        None,
        Some(json!({
            "setup_token": token, "organization_name": "Hardening MSP",
            "owner": { "name": "Olivia Owner", "email": "owner@example.com", "password": "correct-horse-battery-staple" },
            "first_client": { "name": "Client A" }, "first_site": { "name": "Site A" }
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
    Server {
        state,
        console,
        agents,
        addr,
        _dir: dir,
    }
}

/// `(cookie header, csrf token)` of a fresh, stepped-up owner session.
async fn owner_session(state: &AppState) -> (String, String) {
    let owner: String =
        sqlx::query_scalar("SELECT id FROM users WHERE email = 'owner@example.com'")
            .fetch_one(&state.db)
            .await
            .expect("owner");
    let (token, record) = rustrmm_server::auth::session::create(state, &owner, None, None, true)
        .await
        .expect("session");
    (format!("__Host-rustrmm_session={token}"), record.csrf_token)
}

async fn raw(router: &Router, req: Request<Body>) -> (StatusCode, HeaderMap, Vec<u8>) {
    let response = router.clone().oneshot(req).await.expect("response");
    let status = response.status();
    let headers = response.headers().clone();
    let body = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes()
        .to_vec();
    (status, headers, body)
}

async fn request(
    router: &Router,
    method: Method,
    uri: &str,
    session: Option<&(String, String)>,
    body: Option<Value>,
) -> (StatusCode, Option<Value>) {
    let mut req = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::ORIGIN, ORIGIN);
    if let Some((cookie, csrf)) = session {
        req = req
            .header(header::COOKIE, cookie)
            .header("x-csrf-token", csrf);
    }
    let req = match body {
        Some(b) => req
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(b.to_string())),
        None => req.body(Body::empty()),
    }
    .expect("request");
    let (status, _, bytes) = raw(router, req).await;
    (status, serde_json::from_slice(&bytes).ok())
}

async fn enroll(s: &Server, key: &SigningKey, host: &str) -> String {
    let site: String = sqlx::query_scalar("SELECT id FROM sites LIMIT 1")
        .fetch_one(&s.state.db)
        .await
        .expect("site");
    let token_id = rustrmm_common::new_id();
    let secret = rustrmm_crypto::random::token()[..24].to_string();
    sqlx::query("INSERT INTO enrollment_tokens (id, site_id, name, secret_hash, secret, require_approval, created_at) VALUES (?, ?, 't', ?, ?, 0, ?)")
        .bind(&token_id)
        .bind(&site)
        .bind(rustrmm_crypto::random::sha256_hex(secret.as_bytes()))
        .bind(s.state.cipher.encrypt_str(&secret, &rustrmm_server::agents::enroll::secret_aad(&token_id)))
        .bind(rustrmm_common::now())
        .execute(&s.state.db)
        .await
        .expect("token");
    let resp: EnrollResponse = reqwest::Client::new()
        .post(format!("http://{}/agent/v1/enroll", s.addr))
        .json(&EnrollRequest {
            secret,
            public_key: key.public_key().to_string(),
            hostname: host.into(),
            os_family: "windows".into(),
            os_name: "Windows 11 Pro".into(),
            os_version: "10.0.26100".into(),
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
    resp.device_id
}

// ------------------------------------------------------------------ security headers

fn assert_hardened(what: &str, headers: &HeaderMap) {
    let get = |name: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_else(|| panic!("{what}: missing {name}"))
            .to_string()
    };
    let csp = get("content-security-policy");
    assert!(
        csp.contains("frame-ancestors 'none'") || csp.contains("sandbox"),
        "{what}: CSP must forbid framing or sandbox the response: {csp}"
    );
    assert!(
        csp.contains("default-src 'self'")
            || csp.contains("default-src 'none'")
            || csp == "sandbox",
        "{what}: CSP needs a restrictive default-src: {csp}"
    );
    assert!(!csp.contains("'unsafe-eval'"), "{what}: no unsafe-eval");
    if csp.contains("script-src") {
        assert!(
            csp.contains("script-src 'self'") && !csp.contains("script-src 'self' 'unsafe-inline'"),
            "{what}: scripts only from the console origin: {csp}"
        );
    }
    let hsts = get("strict-transport-security");
    let max_age: u64 = hsts
        .split(';')
        .find_map(|p| p.trim().strip_prefix("max-age="))
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    assert!(max_age >= 31_536_000, "{what}: HSTS max-age {hsts}");
    assert_eq!(get("x-content-type-options"), "nosniff", "{what}");
    assert_eq!(get("x-frame-options"), "DENY", "{what}");
    assert_eq!(get("referrer-policy"), "no-referrer", "{what}");
    let permissions = get("permissions-policy");
    for feature in ["camera=()", "microphone=()", "geolocation=()"] {
        assert!(
            permissions.contains(feature),
            "{what}: Permissions-Policy {permissions}"
        );
    }
    assert_eq!(get("cross-origin-opener-policy"), "same-origin", "{what}");
    let corp = get("cross-origin-resource-policy");
    assert!(
        corp == "same-origin" || (what.starts_with("branding file") && corp == "cross-origin"),
        "{what}: CORP {corp}"
    );
}

#[tokio::test]
async fn security_headers_on_every_console_response_type() {
    let s = server(None).await;
    let session = owner_session(&s.state).await;
    let (cookie, csrf) = &session;
    let get = |uri: String, authed: bool| {
        let mut req = Request::builder().uri(uri).header(header::ORIGIN, ORIGIN);
        if authed {
            req = req.header(header::COOKIE, cookie.as_str());
        }
        req.body(Body::empty()).expect("request")
    };

    // A ticket with an attachment, and a branding logo.
    let client: String = sqlx::query_scalar("SELECT id FROM clients LIMIT 1")
        .fetch_one(&s.state.db)
        .await
        .expect("client");
    let (status, ticket) = request(
        &s.console,
        Method::POST,
        "/api/v1/tickets",
        Some(&session),
        Some(json!({ "client_id": client, "subject": "Printer" })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{ticket:?}");
    let ticket = ticket.expect("ticket")["id"]
        .as_str()
        .expect("id")
        .to_string();
    let content = b"<html><script>alert(1)</script></html>";
    let sha = rustrmm_crypto::random::sha256_hex(content);
    std::fs::write(s.state.args.files_dir().join(&sha), content).expect("blob");
    let attachment = rustrmm_common::new_id();
    sqlx::query("INSERT INTO ticket_attachments (id, ticket_id, sha256, size_bytes, file_name, content_type, created_at) VALUES (?, ?, ?, ?, 'page.html', 'text/html', ?)")
        .bind(&attachment)
        .bind(&ticket)
        .bind(&sha)
        .bind(content.len() as i64)
        .bind(rustrmm_common::now())
        .execute(&s.state.db)
        .await
        .expect("attachment");
    let boundary = "hardeningboundary";
    let mut multipart = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"logo.svg\"\r\nContent-Type: image/svg+xml\r\n\r\n"
    )
    .into_bytes();
    multipart.extend_from_slice(b"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"8\" height=\"8\"><rect width=\"8\" height=\"8\"/></svg>");
    multipart.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    let (status, _, body) = raw(
        &s.console,
        Request::builder()
            .method(Method::POST)
            .uri("/api/v1/files/branding")
            .header(header::ORIGIN, ORIGIN)
            .header(header::COOKIE, cookie.as_str())
            .header("x-csrf-token", csrf.as_str())
            .header(
                header::CONTENT_TYPE,
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(Body::from(multipart))
            .expect("request"),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "{}",
        String::from_utf8_lossy(&body)
    );
    let logo: Value = serde_json::from_slice(&body).expect("json");
    let logo_id = logo["id"].as_str().expect("id").to_string();
    let token_id: String = {
        let (status, created) = request(
            &s.console,
            Method::POST,
            &format!("/api/v1/sites/{}/enrollment-tokens", {
                let site: String = sqlx::query_scalar("SELECT id FROM sites LIMIT 1")
                    .fetch_one(&s.state.db)
                    .await
                    .expect("site");
                site
            }),
            Some(&session),
            Some(json!({ "name": "Deploy" })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{created:?}");
        created.expect("token")["id"]
            .as_str()
            .expect("id")
            .to_string()
    };

    let cases: Vec<(&str, Request<Body>, StatusCode)> = vec![
        ("SPA HTML", get("/".into(), false), StatusCode::OK),
        (
            "SPA client route",
            get("/devices/abc".into(), false),
            StatusCode::OK,
        ),
        (
            "JSON API",
            get("/api/v1/auth/me".into(), true),
            StatusCode::OK,
        ),
        (
            "JSON error 401",
            get("/api/v1/auth/me".into(), false),
            StatusCode::UNAUTHORIZED,
        ),
        (
            "JSON error 404",
            get("/api/v1/no-such-route".into(), true),
            StatusCode::NOT_FOUND,
        ),
        (
            "static 404",
            get("/assets/missing.js".into(), false),
            StatusCode::NOT_FOUND,
        ),
        (
            "CA certificate (none in proxy mode)",
            get("/api/v1/system/ca.crt".into(), false),
            StatusCode::NOT_FOUND,
        ),
        (
            "download (audit export)",
            get("/api/v1/audit/export?format=csv".into(), true),
            StatusCode::OK,
        ),
        (
            "download (installer)",
            get(
                format!("/api/v1/enrollment-tokens/{token_id}/installer/powershell"),
                true,
            ),
            StatusCode::OK,
        ),
        (
            "attachment",
            get(format!("/api/v1/tickets/attachments/{attachment}"), true),
            StatusCode::OK,
        ),
        ("API docs", get("/api/docs".into(), false), StatusCode::OK),
        (
            "API docs script",
            get("/api/docs/app.js".into(), false),
            StatusCode::OK,
        ),
        (
            "OpenAPI document",
            get("/api/openapi.json".into(), false),
            StatusCode::OK,
        ),
        (
            "branding (public JSON)",
            get("/api/v1/branding".into(), false),
            StatusCode::OK,
        ),
        (
            "branding file",
            get(format!("/api/v1/branding/files/{logo_id}"), false),
            StatusCode::OK,
        ),
        (
            "health probe",
            get("/healthz".into(), false),
            StatusCode::OK,
        ),
    ];
    for (what, req, expected) in cases {
        let (status, headers, body) = raw(&s.console, req).await;
        assert_eq!(
            status,
            expected,
            "{what}: {}",
            String::from_utf8_lossy(&body)
        );
        assert_hardened(what, &headers);
        if what == "attachment" || what == "branding file" {
            // User-supplied content is sandboxed and never sniffed.
            let csp = headers["content-security-policy"].to_str().expect("csp");
            assert!(csp.contains("sandbox"), "{what}: {csp}");
        }
        if what == "attachment" {
            let disposition = headers
                .get(header::CONTENT_DISPOSITION)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("");
            assert!(
                disposition.starts_with("attachment"),
                "{what}: {disposition}"
            );
        }
    }
    // The same policy is exported for the console build (index.html meta tags must not relax it).
    assert!(rustrmm_server::web::CONTENT_SECURITY_POLICY.contains("script-src 'self'"));
}

// ------------------------------------------------------------------ rate limits

async fn hammer(
    router: &Router,
    attempts: usize,
    mut make: impl FnMut(usize) -> Request<Body>,
) -> Vec<StatusCode> {
    let mut out = Vec::with_capacity(attempts);
    for i in 0..attempts {
        let (status, _, _) = raw(router, make(i)).await;
        out.push(status);
    }
    out
}

/// Index of the first `429`: the bucket refills while we hammer it, so it lands at or a little
/// after the burst size.
fn first_limited(statuses: &[StatusCode], burst: usize) -> usize {
    let first = statuses
        .iter()
        .position(|s| *s == StatusCode::TOO_MANY_REQUESTS)
        .unwrap_or_else(|| panic!("never rate limited after {} requests", statuses.len()));
    assert!(
        first >= burst,
        "limited after only {first} requests (burst {burst})"
    );
    first
}

fn json_post(uri: &str, body: Value) -> Request<Body> {
    Request::builder()
        .method(Method::POST)
        .uri(uri)
        .header(header::ORIGIN, ORIGIN)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .expect("request")
}

#[tokio::test]
async fn login_mfa_enrollment_support_and_api_tokens_are_rate_limited() {
    let s = server(None).await;

    // Login: 10 attempts per minute per address.
    // (Distinct accounts, so the per-account lockout does not answer first.)
    let statuses = hammer(&s.console, 12, |i| {
        json_post(
            "/api/v1/auth/login",
            json!({ "email": format!("user{i}@example.com"), "password": "wrong-password-123" }),
        )
    })
    .await;
    assert!(
        statuses[..10]
            .iter()
            .all(|s| *s == StatusCode::UNAUTHORIZED),
        "{statuses:?}"
    );
    assert_eq!(statuses[10], StatusCode::TOO_MANY_REQUESTS, "{statuses:?}");

    // MFA: 20 code attempts per minute per address.
    let statuses = hammer(&s.console, 22, |_| {
        json_post(
            "/api/v1/auth/mfa/totp",
            json!({ "challenge_token": "bogus", "code": "123456" }),
        )
    })
    .await;
    assert!(
        statuses[..20]
            .iter()
            .all(|s| *s != StatusCode::TOO_MANY_REQUESTS),
        "{statuses:?}"
    );
    assert_eq!(statuses[20], StatusCode::TOO_MANY_REQUESTS, "{statuses:?}");

    // Enrollment: 120 attempts per minute per address.
    let statuses = hammer(&s.agents, 160, |i| {
        Request::builder()
            .method(Method::POST)
            .uri("/agent/v1/enroll")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                serde_json::to_vec(&EnrollRequest {
                    secret: format!("not-a-valid-secret-{i:04}"),
                    public_key: SigningKey::generate().public_key().to_string(),
                    hostname: "WS".into(),
                    os_family: "windows".into(),
                    os_name: String::new(),
                    os_version: String::new(),
                    arch: String::new(),
                    hardware_uuid: None,
                    serial: None,
                    domain: None,
                    agent_version: "0.1.0".into(),
                })
                .expect("json"),
            ))
            .expect("request")
    })
    .await;
    let first = first_limited(&statuses, 120);
    assert!(
        statuses[..first]
            .iter()
            .all(|s| *s == StatusCode::FORBIDDEN),
        "{:?}",
        &statuses[..5]
    );

    // Support requests: five per device per hour.
    let key = SigningKey::generate();
    let device = enroll(&s, &key, "WS-SUPPORT").await;
    let statuses = hammer(&s.agents, 6, |i| {
        let body = serde_json::to_vec(&SupportRequest {
            user: "ACME\\dana".into(),
            name: "Dana".into(),
            email: None,
            subject: format!("Request {i}"),
            description: "Help".into(),
            screenshot_jpeg_b64: None,
            timestamp: chrono::Utc::now().timestamp(),
            nonce: proto::new_nonce(),
        })
        .expect("json");
        let signature = proto::encode_signature(&key.sign(&proto::signing_bytes(&body)));
        Request::builder()
            .method(Method::POST)
            .uri(proto::PATH)
            .header(proto::DEVICE_HEADER, device.as_str())
            .header(proto::SIGNATURE_HEADER, signature)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body))
            .expect("request")
    })
    .await;
    assert!(
        statuses[..5].iter().all(|s| *s == StatusCode::CREATED),
        "{statuses:?}"
    );
    assert_eq!(statuses[5], StatusCode::TOO_MANY_REQUESTS, "{statuses:?}");

    // API tokens: 600 requests per minute per token.
    let session = owner_session(&s.state).await;
    let (status, created) = request(
        &s.console,
        Method::POST,
        "/api/v1/api-tokens",
        Some(&session),
        Some(json!({ "name": "busy", "permissions": ["devices.view"] })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let token = created.expect("json")["token"]
        .as_str()
        .expect("token")
        .to_string();
    let statuses = hammer(&s.console, 900, |_| {
        Request::builder()
            .uri("/api/v1/devices")
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .body(Body::empty())
            .expect("request")
    })
    .await;
    let first = first_limited(&statuses, 600);
    assert!(statuses[..first].iter().all(|s| *s == StatusCode::OK));
}

// ------------------------------------------------------------------ code signing status

#[tokio::test]
async fn signing_status_reports_the_agent_bundle() {
    let dist = tempfile::tempdir().expect("dist");
    let windows = dist.path().join("windows-x86_64");
    let linux = dist.path().join("linux-x86_64");
    std::fs::create_dir_all(&windows).expect("mkdir");
    std::fs::create_dir_all(&linux).expect("mkdir");
    // A minimal unsigned PE32+ and an ELF with a detached minisign signature.
    let mut pe = vec![0u8; 512];
    pe[0..2].copy_from_slice(b"MZ");
    pe[0x3c..0x40].copy_from_slice(&0x80u32.to_le_bytes());
    pe[0x80..0x84].copy_from_slice(b"PE\0\0");
    pe[0x98..0x9a].copy_from_slice(&0x20bu16.to_le_bytes());
    pe[0x98 + 108..0x98 + 112].copy_from_slice(&16u32.to_le_bytes());
    std::fs::write(windows.join("rustrmm-agent.exe"), &pe).expect("exe");
    std::fs::write(linux.join("rustrmm-agent"), b"\x7fELF\x02\x01\x01\0").expect("elf");
    use base64::Engine as _;
    let mut sig = b"Ed".to_vec();
    sig.extend_from_slice(&0x0102_0304_0506_0708u64.to_le_bytes());
    sig.extend_from_slice(&[0u8; 64]);
    std::fs::write(
        linux.join("rustrmm-agent.minisig"),
        format!(
            "untrusted comment: signature\n{}\ntrusted comment: RustRMM test\nAAAA\n",
            base64::engine::general_purpose::STANDARD.encode(sig)
        ),
    )
    .expect("minisig");

    let s = server(Some(dist.path())).await;
    let session = owner_session(&s.state).await;
    let (status, body) = request(
        &s.console,
        Method::GET,
        "/api/v1/settings/signing-status",
        Some(&session),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body:?}");
    let body = body.expect("json");
    assert_eq!(body["source"], "distribution", "{body}");
    assert!(body["version"].is_null());
    let platforms = body["platforms"].as_array().expect("platforms");
    let platform = |name: &str| {
        platforms
            .iter()
            .find(|p| p["platform"] == name)
            .unwrap_or_else(|| panic!("{name} in {body}"))
            .clone()
    };
    let win = platform("windows-x86_64");
    assert_eq!(win["status"], "unsigned");
    assert_eq!(win["files"][0]["file"], "rustrmm-agent.exe");
    assert_eq!(win["files"][0]["format"], "pe");
    assert_eq!(win["files"][0]["status"], "unsigned");
    assert!(win["files"][0]["signer"].is_null());
    let lin = platform("linux-x86_64");
    assert_eq!(lin["status"], "signed", "{lin}");
    assert_eq!(
        lin["files"].as_array().map(Vec::len),
        Some(1),
        "sidecars are not listed"
    );
    assert_eq!(lin["files"][0]["method"], "minisign");
    assert_eq!(
        lin["files"][0]["signer"]["subject"],
        "minisign key 0102030405060708"
    );
}

// ------------------------------------------------------------------ webhook noise

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn next_frame(ws: &mut Ws) -> rustrmm_proto::Frame {
    loop {
        if let WsMessage::Binary(b) = ws.next().await.expect("open").expect("frame") {
            return rustrmm_proto::Frame::decode(&b).expect("frame");
        }
    }
}

/// A legacy agent (no Noise) completing the handshake.
async fn connect_legacy(s: &Server, device_id: &str, key: &SigningKey) -> Ws {
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{}/agent/v1/connect", s.addr))
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
        hostname: "WS-FLAP".into(),
        capabilities: vec![],
    };
    ws.send(WsMessage::Binary(
        rustrmm_proto::encode(&hello).expect("hello").into(),
    ))
    .await
    .expect("send");
    let challenge: Challenge = next_frame(&mut ws).await.body().expect("challenge");
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
    let _welcome: Welcome = next_frame(&mut ws).await.body().expect("welcome");
    ws
}

async fn wait_offline(s: &Server, device: &str) {
    for _ in 0..50 {
        if !s.state.agents.is_online(device) {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("device stayed online");
}

#[tokio::test]
async fn device_offline_webhook_is_debounced() {
    let s = server(None).await;
    let key = SigningKey::generate();
    let device = enroll(&s, &key, "WS-FLAP").await;
    let mut events = s.state.events.subscribe();
    let offline_events =
        |events: &mut tokio::sync::broadcast::Receiver<rustrmm_server::events::Event>| {
            let mut found = Vec::new();
            while let Ok(e) = events.try_recv() {
                if e.topic == "device.offline" {
                    found.push(e.data);
                }
            }
            found
        };

    // Flapping: three quick reconnects publish nothing.
    for _ in 0..3 {
        let mut ws = connect_legacy(&s, &device, &key).await;
        ws.close(None).await.expect("close");
        wait_offline(&s, &device).await;
    }
    rustrmm_server::monitoring::server_checks::check_offline(&s.state)
        .await
        .expect("check");
    assert!(
        offline_events(&mut events).is_empty(),
        "no event for short disconnects"
    );

    // Offline for longer than the threshold (15 minutes by default): exactly one event.
    sqlx::query("UPDATE devices SET last_seen_at = ? WHERE id = ?")
        .bind(rustrmm_common::now() - chrono::Duration::minutes(20))
        .bind(&device)
        .execute(&s.state.db)
        .await
        .expect("age");
    rustrmm_server::monitoring::server_checks::check_offline(&s.state)
        .await
        .expect("check");
    let found = offline_events(&mut events);
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0]["device_id"], device.as_str());
    assert_eq!(found[0]["reason"], "disconnected");
    assert_eq!(found[0]["offline_minutes"], 15);
    assert_eq!(found[0]["hostname"], "WS-FLAP");
    rustrmm_server::monitoring::server_checks::check_offline(&s.state)
        .await
        .expect("check");
    assert!(
        offline_events(&mut events).is_empty(),
        "sent once per offline period"
    );

    // Coming back re-arms it.
    let ws = connect_legacy(&s, &device, &key).await;
    let notified: Option<String> =
        sqlx::query_scalar("SELECT offline_notified_at FROM devices WHERE id = ?")
            .bind(&device)
            .fetch_one(&s.state.db)
            .await
            .expect("row");
    assert!(notified.is_none(), "reconnect clears the debounce marker");
    drop(ws);
    wait_offline(&s, &device).await;
    rustrmm_server::monitoring::server_checks::check_offline(&s.state)
        .await
        .expect("check");
    assert!(
        offline_events(&mut events).is_empty(),
        "a fresh disconnect is not reported yet"
    );
}
