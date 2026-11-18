//! Ticketing end to end against the real routers and local fake mail servers: SLA due times
//! on a new ticket; the "created" and public-comment e-mails reach a scripted SMTP server with
//! the reply tag; a scripted IMAP server delivers a reply that threads as a contact comment, a
//! new message from a known contact that opens a ticket, and mail the loop protection ignores;
//! an alert-to-ticket rule creates exactly one ticket and resolves it with the alert; a signed
//! support request from a fake device opens a ticket and its replay is refused; time entries
//! total correctly; and a client-scoped technician sees only their client's tickets.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode, header};
use clap::Parser;
use http_body_util::BodyExt;
use rustrmm_crypto::sign::SigningKey;
use rustrmm_proto::deploy::{EnrollRequest, EnrollResponse};
use rustrmm_proto::support::{self as proto, SupportRequest};
use rustrmm_server::state::AppState;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;
use tower::ServiceExt;

const ORIGIN: &str = "https://rmm.test";
const SUPPORT: &str = "support@rmm.test";

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

    async fn raw(
        &mut self,
        method: Method,
        path: &str,
        content_type: Option<&str>,
        body: Vec<u8>,
    ) -> (StatusCode, Vec<u8>, axum::http::HeaderMap) {
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
        if let Some(ct) = content_type {
            req = req.header(header::CONTENT_TYPE, ct);
        }
        let response = self
            .router
            .clone()
            .oneshot(req.body(Body::from(body)).expect("request"))
            .await
            .expect("response");
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
            .to_bytes()
            .to_vec();
        (status, bytes, headers)
    }

    async fn call(
        &mut self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let (ct, bytes) = match body {
            Some(b) => (Some("application/json"), b.to_string().into_bytes()),
            None => (None, Vec::new()),
        };
        let (status, bytes, _) = self.raw(method, path, ct, bytes).await;
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

    async fn patch(&mut self, path: &str, body: Value) -> (StatusCode, Value) {
        self.call(Method::PATCH, path, Some(body)).await
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

async fn set_step_up(state: &AppState, email: &str) {
    sqlx::query(
        "UPDATE sessions SET stepped_up_until = ? WHERE user_id = (SELECT id FROM users WHERE email = ?)",
    )
    .bind(rustrmm_common::now() + chrono::Duration::minutes(5))
    .bind(email)
    .execute(&state.db)
    .await
    .expect("step-up");
}

// ------------------------------------------------------------------ server and fakes

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
    // The outbound worker runs; the IMAP poll is triggered explicitly below.
    rustrmm_server::tickets::email::spawn_worker(state.clone());
    let console = rustrmm_server::listeners::console_router(state.clone());
    (state, console, addr, dir)
}

/// A scripted SMTP server: every delivered message (the DATA section) is sent on the channel.
async fn fake_smtp() -> (u16, mpsc::UnboundedReceiver<String>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        loop {
            let Ok((sock, _)) = listener.accept().await else {
                return;
            };
            let tx = tx.clone();
            tokio::spawn(async move {
                let (read, mut write) = sock.into_split();
                let mut lines = BufReader::new(read).lines();
                write.write_all(b"220 fake ESMTP\r\n").await.expect("greet");
                let mut data: Option<String> = None;
                while let Ok(Some(line)) = lines.next_line().await {
                    if let Some(buf) = data.as_mut() {
                        if line == "." {
                            let _ = tx.send(data.take().unwrap_or_default());
                            write.write_all(b"250 queued\r\n").await.expect("queued");
                        } else {
                            buf.push_str(line.strip_prefix('.').unwrap_or(&line));
                            buf.push('\n');
                        }
                        continue;
                    }
                    let reply: &[u8] = if line.starts_with("EHLO") {
                        b"250-fake\r\n250 PIPELINING\r\n"
                    } else if line == "DATA" {
                        data = Some(String::new());
                        b"354 go ahead\r\n"
                    } else if line == "QUIT" {
                        write.write_all(b"221 bye\r\n").await.expect("bye");
                        return;
                    } else {
                        b"250 ok\r\n"
                    };
                    write.write_all(reply).await.expect("reply");
                }
            });
        }
    });
    (port, rx)
}

async fn next_mail(rx: &mut mpsc::UnboundedReceiver<String>) -> String {
    tokio::time::timeout(Duration::from_secs(15), rx.recv())
        .await
        .expect("an e-mail in time")
        .expect("mail")
}

/// A scripted IMAP server for one session over the given messages. Records moved UIDs.
async fn fake_imap(messages: Vec<Vec<u8>>) -> (u16, Arc<Mutex<Vec<u32>>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let moved = Arc::new(Mutex::new(Vec::new()));
    let seen = moved.clone();
    tokio::spawn(async move {
        let (sock, _) = listener.accept().await.expect("accept");
        let (read, mut write) = sock.into_split();
        let mut reader = BufReader::new(read);
        write
            .write_all(b"* OK fake IMAP ready\r\n")
            .await
            .expect("greet");
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).await.unwrap_or(0) == 0 {
                return;
            }
            let line = line.trim_end().to_string();
            let (tag, cmd) = line.split_once(' ').unwrap_or((&line, ""));
            let upper = cmd.to_ascii_uppercase();
            let uid_of = |cmd: &str| -> usize {
                cmd.split_whitespace()
                    .nth(2)
                    .and_then(|n| n.parse().ok())
                    .unwrap_or(0)
            };
            let mut out: Vec<u8> = Vec::new();
            if upper == "CAPABILITY" {
                out.extend_from_slice(b"* CAPABILITY IMAP4rev1 MOVE\r\n");
            } else if upper.starts_with("LOGIN") {
                if cmd != format!("LOGIN \"{SUPPORT}\" \"imap-pass\"") {
                    out.extend_from_slice(format!("{tag} NO bad credentials\r\n").as_bytes());
                    write.write_all(&out).await.expect("write");
                    continue;
                }
            } else if upper.starts_with("SELECT") {
                out.extend_from_slice(format!("* {} EXISTS\r\n", messages.len()).as_bytes());
            } else if upper == "UID SEARCH ALL" {
                let moved = seen.lock().expect("lock").clone();
                let uids: Vec<String> = (1..=messages.len() as u32)
                    .filter(|u| !moved.contains(u))
                    .map(|u| u.to_string())
                    .collect();
                out.extend_from_slice(format!("* SEARCH {}\r\n", uids.join(" ")).as_bytes());
            } else if upper.starts_with("UID FETCH") && upper.contains("RFC822.SIZE") {
                let uid = uid_of(cmd);
                let size = messages.get(uid - 1).map(Vec::len).unwrap_or(0);
                out.extend_from_slice(
                    format!("* {uid} FETCH (UID {uid} RFC822.SIZE {size})\r\n").as_bytes(),
                );
            } else if upper.starts_with("UID FETCH") && upper.contains("BODY.PEEK[]") {
                let uid = uid_of(cmd);
                let body = messages.get(uid - 1).cloned().unwrap_or_default();
                out.extend_from_slice(
                    format!("* {uid} FETCH (UID {uid} BODY[] {{{}}}\r\n", body.len()).as_bytes(),
                );
                out.extend_from_slice(&body);
                out.extend_from_slice(b")\r\n");
            } else if upper.starts_with("UID MOVE") {
                seen.lock().expect("lock").push(uid_of(cmd) as u32);
            } else if upper == "LOGOUT" {
                out.extend_from_slice(format!("* BYE\r\n{tag} OK bye\r\n").as_bytes());
                write.write_all(&out).await.expect("write");
                return;
            }
            out.extend_from_slice(format!("{tag} OK done\r\n").as_bytes());
            write.write_all(&out).await.expect("write");
        }
    });
    (port, moved)
}

fn mail(from: &str, to: &str, subject: &str, message_id: &str, extra: &str, body: &str) -> Vec<u8> {
    format!(
        "From: {from}\r\nTo: {to}\r\nSubject: {subject}\r\nMessage-ID: <{message_id}>\r\nDate: Wed, 18 Nov 2026 10:00:00 +0000\r\n{extra}MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{body}\r\n"
    )
    .into_bytes()
}

async fn enroll(state: &AppState, addr: SocketAddr, key: &SigningKey) -> String {
    let site_id: String = sqlx::query_scalar("SELECT id FROM sites ORDER BY created_at LIMIT 1")
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
            hostname: "WS-HELP".into(),
            os_family: "windows".into(),
            os_name: "Windows 11 Pro".into(),
            os_version: "10.0.26100".into(),
            arch: "x86_64".into(),
            hardware_uuid: Some("UUID-WS-HELP".into()),
            serial: Some("SN-WS-HELP".into()),
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

fn parse_time(v: &Value) -> chrono::DateTime<chrono::Utc> {
    chrono::DateTime::parse_from_rfc3339(v.as_str().expect("time"))
        .expect("rfc3339")
        .with_timezone(&chrono::Utc)
}

fn multipart(boundary: &str, fields: &[(&str, &str)], files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut out = Vec::new();
    for (name, value) in fields {
        out.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
            )
            .as_bytes(),
        );
    }
    for (file_name, data) in files {
        out.extend_from_slice(
            format!("--{boundary}\r\nContent-Disposition: form-data; name=\"files\"; filename=\"{file_name}\"\r\nContent-Type: application/octet-stream\r\n\r\n").as_bytes(),
        );
        out.extend_from_slice(data);
        out.extend_from_slice(b"\r\n");
    }
    out.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    out
}

// ------------------------------------------------------------------ the test

#[tokio::test]
async fn tickets_sla_email_imap_alert_rules_support_time_and_scope() {
    let (state, router, addr, _dir) = start().await;
    let mut owner = Client::new(router.clone());
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
    set_step_up(&state, "owner@example.com").await;

    let acme: String = sqlx::query_scalar("SELECT id FROM clients WHERE name = 'Acme Dental'")
        .fetch_one(&state.db)
        .await
        .expect("acme");
    let (status, globex) = owner
        .post("/api/v1/clients", json!({ "name": "Globex" }))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{globex}");
    let globex = globex["id"].as_str().expect("id").to_string();

    // Defaults are seeded.
    let (_, queues) = owner.get("/api/v1/ticket-queues").await;
    assert_eq!(queues["items"][0]["name"], "Support");
    let (_, policies) = owner.get("/api/v1/sla-policies").await;
    assert_eq!(policies["items"][0]["id"], "builtin-default-sla");
    assert_eq!(policies["items"][0]["business_hours"], Value::Null);

    // ---- mail settings: the fake SMTP server and the fake IMAP mailbox (plain, loopback)
    let (smtp_port, mut mails) = fake_smtp().await;
    let (status, body) = owner
        .put(
            "/api/v1/settings/smtp",
            json!({ "host": "127.0.0.1", "port": smtp_port, "security": "none", "username": "",
                    "from_address": SUPPORT, "from_name": "Northwind Support" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = owner
        .put(
            "/api/v1/settings/ticket-email",
            json!({ "outbound": { "enabled": true, "notify_contact_on_create": true, "notify_on_public_comment": true,
                                  "notify_on_resolve": true, "notify_technician_on_assign": true, "reply_address": SUPPORT },
                    "signature": "Thanks, {{technician.name}}" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = owner
        .put(
            "/api/v1/settings/ticket-email",
            json!({ "inbound": { "enabled": true, "host": "mail.example.com", "port": 143, "security": "none",
                                 "username": SUPPORT, "password": "imap-pass" } }),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "plain IMAP only on loopback: {body}"
    );

    // ---- contacts (and CSV import)
    let (status, dana) = owner
        .post(
            "/api/v1/contacts",
            json!({ "client_id": acme, "name": "Dana Reyes", "email": "dana@acme.test", "title": "Office manager", "is_primary": true }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{dana}");
    let dana_id = dana["id"].as_str().expect("id").to_string();
    let (status, dup) = owner
        .post(
            "/api/v1/contacts",
            json!({ "client_id": acme, "name": "Dana 2", "email": "DANA@acme.test" }),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{dup}");
    let csv = "name,email,phone,title,site\nBo Chen,bo@acme.test,555-0101,Dentist,Main Office\nDana Reyes,dana@acme.test,555-0100,Office manager,\nBad,not-an-email,,,\n";
    let (status, imported, _) = owner
        .raw(
            Method::POST,
            &format!("/api/v1/contacts/import?client_id={acme}"),
            Some("text/csv"),
            csv.as_bytes().to_vec(),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&imported)
    );
    let imported: Value = serde_json::from_slice(&imported).expect("json");
    assert_eq!(imported["created"], 1);
    assert_eq!(imported["updated"], 1);
    assert_eq!(imported["errors"][0]["row"], 4);

    // ---- 1. a ticket gets SLA due times from the default 24x7 policy
    let (status, ticket) = owner
        .post(
            "/api/v1/tickets",
            json!({ "subject": "Printer offline in reception", "description": "It shows **error 41**.",
                    "client_id": acme, "contact_id": dana_id, "priority": "normal", "type": "incident", "tags": ["printers"] }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{ticket}");
    let ticket_id = ticket["id"].as_str().expect("id").to_string();
    let number = ticket["number"].as_i64().expect("number");
    assert_eq!(number, 1001);
    assert_eq!(ticket["status"], "new");
    assert_eq!(ticket["queue"]["name"], "Support");
    assert_eq!(ticket["contact"]["email"], "dana@acme.test");
    let created = parse_time(&ticket["created_at"]);
    assert_eq!(ticket["sla"]["policy_id"], "builtin-default-sla");
    assert_eq!(
        parse_time(&ticket["sla"]["first_response_due"]) - created,
        chrono::Duration::minutes(240)
    );
    assert_eq!(
        parse_time(&ticket["sla"]["resolution_due"]) - created,
        chrono::Duration::minutes(1440)
    );
    assert_eq!(ticket["sla"]["paused"], false);
    // A client-specific business-hours policy applies to that client's tickets.
    let (status, policy) = owner
        .post(
            "/api/v1/sla-policies",
            json!({ "name": "Globex business hours", "client_ids": [globex],
                    "business_hours": { "timezone": "Europe/Berlin", "days": [1,2,3,4,5], "start": "08:00", "end": "18:00", "holidays": ["2026-12-25"] },
                    "targets": { "urgent": { "first_response_minutes": 30, "resolution_minutes": 240 },
                                 "high": { "first_response_minutes": 60, "resolution_minutes": 480 },
                                 "normal": { "first_response_minutes": 120, "resolution_minutes": 960 },
                                 "low": { "first_response_minutes": 480, "resolution_minutes": 2400 } } }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{policy}");
    let (status, globex_ticket) = owner
        .post(
            "/api/v1/tickets",
            json!({ "subject": "VPN down", "client_id": globex, "priority": "high" }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{globex_ticket}");
    assert_eq!(globex_ticket["sla"]["policy_id"], policy["id"]);
    assert!(
        parse_time(&globex_ticket["sla"]["resolution_due"])
            > parse_time(&globex_ticket["created_at"])
    );
    let globex_ticket_id = globex_ticket["id"].as_str().expect("id").to_string();

    // ---- 2. the contact receives the "created" mail; a public comment is mailed with the tag
    let created_mail = next_mail(&mut mails).await;
    assert!(
        created_mail.contains("Subject: [#1001] Printer offline in reception"),
        "{created_mail}"
    );
    assert!(
        created_mail.contains("To: dana@acme.test"),
        "{created_mail}"
    );
    let tag = rustrmm_server::tickets::email::tagged_address(
        SUPPORT,
        &rustrmm_server::tickets::email::tag_key(&state)[..],
        number,
    )
    .expect("tag");
    assert!(tag.starts_with("support+t1001."), "{tag}");
    assert!(
        created_mail.contains(&format!("Reply-To: {tag}")),
        "{created_mail}"
    );
    assert!(created_mail.contains("Auto-Submitted: auto-generated"));

    let boundary = "rustrmm-test-boundary";
    let (status, refused, _) = owner
        .raw(
            Method::POST,
            &format!("/api/v1/tickets/{ticket_id}/comments"),
            Some(&format!("multipart/form-data; boundary={boundary}")),
            multipart(
                boundary,
                &[("body", "see file"), ("visibility", "public")],
                &[("tool.exe", b"MZ\x90\x00")],
            ),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "{}",
        String::from_utf8_lossy(&refused)
    );
    let (status, comment, _) = owner
        .raw(
            Method::POST,
            &format!("/api/v1/tickets/{ticket_id}/comments"),
            Some(&format!("multipart/form-data; boundary={boundary}")),
            multipart(
                boundary,
                &[
                    ("body", "Please power-cycle the printer."),
                    ("visibility", "public"),
                ],
                &[("steps.txt", b"1. Off\n2. On\n")],
            ),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "{}",
        String::from_utf8_lossy(&comment)
    );
    let comment: Value = serde_json::from_slice(&comment).expect("json");
    assert_eq!(comment["author"]["type"], "user");
    assert_eq!(comment["attachments"][0]["file_name"], "steps.txt");
    let attachment_id = comment["attachments"][0]["id"]
        .as_str()
        .expect("id")
        .to_string();
    let comment_mail = next_mail(&mut mails).await;
    assert!(
        comment_mail.contains("Subject: [#1001] Printer offline in reception"),
        "{comment_mail}"
    );
    assert!(
        comment_mail.contains(&format!("Reply-To: {tag}")),
        "{comment_mail}"
    );
    assert!(
        comment_mail.contains("In-Reply-To: <ticket-1001-"),
        "{comment_mail}"
    );
    assert!(
        comment_mail.contains("filename=\"steps.txt\""),
        "{comment_mail}"
    );
    // Internal notes are never mailed.
    let (status, _) = owner
        .post(
            &format!("/api/v1/tickets/{ticket_id}/comments"),
            json!({ "body": "internal only", "visibility": "internal" }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let (_, detail) = owner.get(&format!("/api/v1/tickets/{ticket_id}")).await;
    assert_eq!(
        detail["ticket"]["status"], "open",
        "a public reply opens a new ticket"
    );
    assert!(detail["ticket"]["sla"]["first_response_at"].is_string());
    assert!(
        detail["activity"]
            .as_array()
            .expect("activity")
            .iter()
            .any(|a| a["kind"] == "status" && a["to"] == "open")
    );
    // The attachment downloads with safe headers.
    let (status, bytes, headers) = owner
        .raw(
            Method::GET,
            &format!("/api/v1/tickets/attachments/{attachment_id}"),
            None,
            Vec::new(),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(bytes, b"1. Off\n2. On\n");
    assert!(
        headers[header::CONTENT_DISPOSITION]
            .to_str()
            .expect("cd")
            .starts_with("attachment;")
    );
    assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
    assert_eq!(headers[header::CONTENT_SECURITY_POLICY], "sandbox");

    // Waiting on the customer pauses the SLA.
    let (status, pending) = owner
        .patch(
            &format!("/api/v1/tickets/{ticket_id}"),
            json!({ "status": "pending" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{pending}");
    assert_eq!(pending["sla"]["paused"], true);

    // ---- 3. IMAP: a tagged reply threads as a contact comment; known sender opens a ticket
    let reply = mail(
        "Dana Reyes <dana@acme.test>",
        &tag,
        "Re: [#1001] Printer offline in reception",
        "reply-1@acme.test",
        "In-Reply-To: <ticket-1001-x@rmm.test>\r\n",
        "Thanks, the printer works again.\r\n\r\nOn Wed, Nov 18, 2026 at 9:00 AM Northwind Support <support@rmm.test> wrote:\r\n> Please power-cycle the printer.\r\n",
    );
    let fresh = mail(
        "Dana Reyes <dana@acme.test>",
        SUPPORT,
        "Scanner not working",
        "new-1@acme.test",
        "",
        "The scanner shows a red light.",
    );
    let looped = mail(
        SUPPORT,
        SUPPORT,
        "[#1001] loop",
        "loop-1@rmm.test",
        "",
        "own mail",
    );
    let auto = mail(
        "Dana Reyes <dana@acme.test>",
        SUPPORT,
        "Out of office",
        "ooo-1@acme.test",
        "Auto-Submitted: auto-replied\r\n",
        "I am away.",
    );
    let duplicate = fresh.clone();
    let stranger = mail(
        "Eve <eve@unknown.test>",
        SUPPORT,
        "Hello",
        "eve-1@unknown.test",
        "",
        "Who are you?",
    );
    let (imap_port, moved) = fake_imap(vec![reply, fresh, looped, auto, duplicate, stranger]).await;
    let (status, body) = owner
        .put(
            "/api/v1/settings/ticket-email",
            json!({ "inbound": { "enabled": true, "host": "127.0.0.1", "port": imap_port, "security": "none",
                                 "username": SUPPORT, "password": "imap-pass", "folder": "INBOX",
                                 "processed_folder": "Processed", "unknown_sender": "drop" } }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["inbound"]["password"], "••••••");
    let handled = rustrmm_server::tickets::imap::poll_once(&state)
        .await
        .expect("poll");
    assert_eq!(handled, 6);
    assert_eq!(*moved.lock().expect("lock"), vec![1, 2, 3, 4, 5, 6]);
    let (_, detail) = owner.get(&format!("/api/v1/tickets/{ticket_id}")).await;
    let comments = detail["comments"].as_array().expect("comments");
    let from_dana = comments
        .iter()
        .find(|c| c["author"]["type"] == "contact")
        .expect("contact comment");
    assert_eq!(
        from_dana["body"], "Thanks, the printer works again.",
        "quotes stripped"
    );
    assert_eq!(from_dana["author"]["name"], "Dana Reyes");
    assert_eq!(from_dana["visibility"], "public");
    assert_eq!(
        detail["ticket"]["status"], "open",
        "a customer reply reopens a pending ticket"
    );
    let (_, scanners) = owner.get("/api/v1/tickets?q=Scanner").await;
    assert_eq!(
        scanners["items"].as_array().map(Vec::len),
        Some(1),
        "{scanners}"
    );
    let scanner = &scanners["items"][0];
    assert_eq!(scanner["source"], "email");
    assert_eq!(scanner["client_id"], acme.as_str());
    assert_eq!(scanner["contact"]["id"], dana_id.as_str());
    let outcomes: Vec<(String, String)> =
        sqlx::query_as("SELECT message_id, outcome FROM processed_emails ORDER BY message_id")
            .fetch_all(&state.db)
            .await
            .expect("processed");
    let outcome = |id: &str| {
        outcomes
            .iter()
            .find(|(m, _)| m == id)
            .map(|(_, o)| o.as_str())
    };
    assert_eq!(outcome("reply-1@acme.test"), Some("comment"));
    assert_eq!(outcome("new-1@acme.test"), Some("ticket"));
    assert_eq!(outcome("loop-1@rmm.test"), Some("ignored"));
    assert_eq!(outcome("ooo-1@acme.test"), Some("ignored"));
    assert_eq!(outcome("eve-1@unknown.test"), Some("dropped"));
    assert_eq!(outcomes.len(), 5, "the duplicate is not recorded twice");
    // The "created" mail of the e-mailed ticket went out too.
    let scanner_mail = next_mail(&mut mails).await;
    assert!(
        scanner_mail.contains("Scanner not working"),
        "{scanner_mail}"
    );

    // ---- 4. an alert-to-ticket rule creates one ticket, linked, and resolves it with the alert
    let key = SigningKey::generate();
    let device = enroll(&state, addr, &key).await;
    let (status, rule) = owner
        .post(
            "/api/v1/alert-ticket-rules",
            json!({ "name": "Critical alerts", "filters": { "severities": ["critical"] }, "after_minutes": 0,
                    "ticket": { "priority": "urgent" }, "close_ticket_on_resolve": true }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{rule}");
    let raise = |severity: &str, repeat: bool| rustrmm_server::monitoring::alerts::Raise {
        device_id: device.clone(),
        source: "check",
        check_id: "disk-c".into(),
        check_type: "disk".into(),
        severity: severity.into(),
        title: "Low disk space on C:".into(),
        message: "3% free".into(),
        policy_id: None,
        remediation: None,
        repeat,
    };
    let alert_id = rustrmm_server::monitoring::alerts::raise(&state, raise("critical", false))
        .await
        .expect("raise")
        .expect("alert");
    rustrmm_server::monitoring::alerts::raise(&state, raise("critical", true))
        .await
        .expect("repeat");
    let (_, alert) = owner.get(&format!("/api/v1/alerts/{alert_id}")).await;
    let alert_ticket = alert["alert"]["ticket_id"]
        .as_str()
        .expect("ticket linked")
        .to_string();
    assert!(
        alert["events"]
            .as_array()
            .expect("events")
            .iter()
            .any(|e| e["kind"] == "ticket_created")
    );
    let linked: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM ticket_links WHERE kind = 'alert' AND target_id = ?",
    )
    .bind(&alert_id)
    .fetch_one(&state.db)
    .await
    .expect("count");
    assert_eq!(linked, 1, "exactly one ticket per alert");
    let (_, t) = owner.get(&format!("/api/v1/tickets/{alert_ticket}")).await;
    assert_eq!(t["ticket"]["source"], "alert");
    assert_eq!(t["ticket"]["type"], "alert");
    assert_eq!(t["ticket"]["priority"], "urgent");
    assert_eq!(t["ticket"]["devices"][0]["id"], device.as_str());
    assert_eq!(t["ticket"]["alerts"][0]["id"], alert_id.as_str());
    let (status, again) = owner
        .post(&format!("/api/v1/alerts/{alert_id}/ticket"), json!({}))
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{again}");
    assert_eq!(again["error"]["code"], "ticket_exists");
    rustrmm_server::monitoring::alerts::clear(&state, &device, "disk-c", "OK again")
        .await
        .expect("clear");
    let (_, t) = owner.get(&format!("/api/v1/tickets/{alert_ticket}")).await;
    assert_eq!(t["ticket"]["status"], "resolved", "{t}");
    // A manual ticket from another alert is prefilled.
    rustrmm_server::monitoring::alerts::raise(
        &state,
        rustrmm_server::monitoring::alerts::Raise {
            check_id: "cpu-high".into(),
            check_type: "cpu".into(),
            severity: "warning".into(),
            title: "CPU high".into(),
            ..raise("warning", false)
        },
    )
    .await
    .expect("raise");
    let warning_alert: String =
        sqlx::query_scalar("SELECT id FROM alerts WHERE check_id = 'cpu-high'")
            .fetch_one(&state.db)
            .await
            .expect("alert");
    let (status, manual) = owner
        .post(&format!("/api/v1/alerts/{warning_alert}/ticket"), json!({}))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{manual}");
    assert_eq!(manual["subject"], "CPU high (WS-HELP)");
    assert_eq!(manual["priority"], "normal");

    // ---- 5. a signed support request opens a ticket; the replay is refused
    let request = SupportRequest {
        user: "ACME\\dana".into(),
        name: "Dana Reyes".into(),
        email: Some("dana@acme.test".into()),
        subject: "Outlook keeps crashing".into(),
        description: "Since this morning.".into(),
        screenshot_jpeg_b64: Some(base64_jpeg()),
        timestamp: chrono::Utc::now().timestamp(),
        nonce: proto::new_nonce(),
    };
    let body = serde_json::to_vec(&request).expect("json");
    let signature = proto::encode_signature(&key.sign(&proto::signing_bytes(&body)));
    let send = |body: Vec<u8>, signature: String| {
        let device = device.clone();
        async move {
            reqwest::Client::new()
                .post(format!("http://{addr}{}", proto::PATH))
                .header(proto::DEVICE_HEADER, device)
                .header(proto::SIGNATURE_HEADER, signature)
                .header("content-type", "application/json")
                .body(body)
                .send()
                .await
                .expect("send")
        }
    };
    let response = send(body.clone(), signature.clone()).await;
    assert_eq!(response.status().as_u16(), 201);
    let created: Value = response.json().await.expect("json");
    let support_ticket = created["ticket_id"].as_str().expect("id").to_string();
    let replay = send(body.clone(), signature.clone()).await;
    assert_eq!(replay.status().as_u16(), 409);
    let forged = send(
        body.clone(),
        proto::encode_signature(&SigningKey::generate().sign(&proto::signing_bytes(&body))),
    )
    .await;
    assert_eq!(forged.status().as_u16(), 401);
    let stale_body = serde_json::to_vec(&SupportRequest {
        timestamp: chrono::Utc::now().timestamp() - 600,
        nonce: proto::new_nonce(),
        ..request.clone()
    })
    .expect("json");
    let stale_sig = proto::encode_signature(&key.sign(&proto::signing_bytes(&stale_body)));
    assert_eq!(send(stale_body, stale_sig).await.status().as_u16(), 401);
    let (_, t) = owner
        .get(&format!("/api/v1/tickets/{support_ticket}"))
        .await;
    assert_eq!(t["ticket"]["source"], "agent");
    assert_eq!(t["ticket"]["devices"][0]["id"], device.as_str());
    assert_eq!(
        t["ticket"]["contact"]["id"],
        dana_id.as_str(),
        "matched by e-mail"
    );
    assert_eq!(
        t["comments"][0]["attachments"][0]["file_name"],
        "screenshot.jpg"
    );
    assert_eq!(
        t["comments"][0]["attachments"][0]["content_type"],
        "image/jpeg"
    );
    let (_, device_tickets) = owner
        .get(&format!("/api/v1/devices/{device}/tickets"))
        .await;
    assert!(device_tickets["items"].as_array().expect("items").len() >= 2);

    // ---- 6. time entries total correctly (and export as CSV)
    for (minutes, billable) in [(30, true), (15, false)] {
        let (status, entry) = owner
            .post(
                &format!("/api/v1/tickets/{ticket_id}/time"),
                json!({ "minutes": minutes, "billable": billable, "note": "Replaced toner" }),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{entry}");
    }
    let (status, entry) = owner
        .post(
            &format!("/api/v1/tickets/{globex_ticket_id}/time"),
            json!({ "minutes": 60 }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{entry}");
    let (_, t) = owner.get(&format!("/api/v1/tickets/{ticket_id}")).await;
    assert_eq!(t["ticket"]["time_spent_minutes"], 45);
    assert_eq!(t["ticket"]["billable_minutes"], 30);
    assert_eq!(t["time_entries"].as_array().map(Vec::len), Some(2));
    let (_, report) = owner
        .get(&format!("/api/v1/time-entries?client_id={acme}"))
        .await;
    assert_eq!(report["totals"]["minutes"], 45);
    assert_eq!(report["totals"]["billable_minutes"], 30);
    let (_, all) = owner.get("/api/v1/time-entries").await;
    assert_eq!(all["totals"]["minutes"], 105);
    assert_eq!(all["totals"]["by_client"].as_array().map(Vec::len), Some(2));
    assert_eq!(all["totals"]["by_user"][0]["minutes"], 105);
    let (status, csv, headers) = owner
        .raw(
            Method::GET,
            &format!("/api/v1/time-entries?client_id={acme}&format=csv"),
            None,
            Vec::new(),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        headers[header::CONTENT_TYPE]
            .to_str()
            .expect("ct")
            .starts_with("text/csv")
    );
    let csv = String::from_utf8(csv).expect("utf8");
    assert!(
        csv.starts_with("date,started_at,client,ticket,subject,user,minutes,billable,note"),
        "{csv}"
    );
    assert_eq!(csv.lines().count(), 3);

    // Merge: the second ticket's comments move, and it closes.
    let (_, other) = owner
        .post(
            "/api/v1/tickets",
            json!({ "subject": "Printer again", "client_id": acme }),
        )
        .await;
    let other_id = other["id"].as_str().expect("id").to_string();
    owner
        .post(
            &format!("/api/v1/tickets/{other_id}/comments"),
            json!({ "body": "dup", "visibility": "internal" }),
        )
        .await;
    let (status, merged) = owner
        .post(
            &format!("/api/v1/tickets/{other_id}/merge"),
            json!({ "into_ticket_id": ticket_id }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{merged}");
    let (_, gone) = owner.get(&format!("/api/v1/tickets/{other_id}")).await;
    assert_eq!(gone["ticket"]["status"], "closed");
    assert_eq!(gone["ticket"]["merged_into"]["number"], number);
    assert!(gone["comments"].as_array().expect("comments").is_empty());

    // Fleet Pulse counts open tickets.
    let (_, fleet) = owner.get("/api/v1/fleet/summary").await;
    assert!(
        fleet["open_tickets"].as_i64().expect("count") >= 4,
        "{fleet}"
    );

    // ---- 7. a client-scoped technician sees only their client's tickets
    let (status, tech) = owner
        .post(
            "/api/v1/users",
            json!({ "name": "Gary Globex", "email": "gary@example.com", "password": "another-strong-passphrase",
                    "assignments": [{ "role_id": "builtin-technician", "scope_type": "client", "scope_id": globex }] }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{tech}");
    let mut gary = Client::new(router.clone());
    sign_in(&mut gary, "gary@example.com", "another-strong-passphrase").await;
    let (status, list) = gary.get("/api/v1/tickets?status=all").await;
    assert_eq!(status, StatusCode::OK, "{list}");
    let items = list["items"].as_array().expect("items");
    assert!(!items.is_empty());
    assert!(
        items.iter().all(|t| t["client_id"] == globex.as_str()),
        "{list}"
    );
    assert_eq!(
        list["counts"]["open"].as_i64().unwrap_or(0) + list["counts"]["new"].as_i64().unwrap_or(0),
        1
    );
    let (status, _) = gary.get(&format!("/api/v1/tickets/{ticket_id}")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = gary
        .get(&format!("/api/v1/tickets/attachments/{attachment_id}"))
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = gary
        .post(
            "/api/v1/tickets",
            json!({ "subject": "Sneaky", "client_id": acme }),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (_, contacts) = gary.get("/api/v1/contacts").await;
    assert!(contacts["items"].as_array().expect("items").is_empty());
    let (_, time) = gary.get("/api/v1/time-entries").await;
    assert_eq!(time["totals"]["minutes"], 60);
    let (_, fleet) = gary.get("/api/v1/fleet/summary").await;
    assert_eq!(fleet["open_tickets"], 1);
    let (status, _) = gary.get("/api/v1/settings/ticket-email").await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, own) = gary
        .patch(
            &format!("/api/v1/tickets/{globex_ticket_id}"),
            json!({ "status": "on_hold" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{own}");

    // Stats see the activity.
    let (status, stats) = owner.get("/api/v1/tickets/stats").await;
    assert_eq!(status, StatusCode::OK, "{stats}");
    assert!(stats["opened"].as_i64().expect("opened") >= 6);
    assert!(stats["resolved"].as_i64().expect("resolved") >= 1);
    assert_eq!(stats["backlog_trend"].as_array().map(Vec::len), Some(31));
}

/// A tiny (not necessarily decodable) JPEG payload.
fn base64_jpeg() -> String {
    use base64::Engine;
    let mut data = vec![
        0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, b'J', b'F', b'I', b'F', 0x00,
    ];
    data.extend_from_slice(&[0u8; 64]);
    data.extend_from_slice(&[0xff, 0xd9]);
    base64::engine::general_purpose::STANDARD.encode(data)
}
