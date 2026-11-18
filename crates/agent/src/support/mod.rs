//! End-user "Request support" (`rustrmm-agent support`, `docs/api-tickets.md`).
//!
//! The command runs in the signed-in user's session. A native dialog collects a subject, a
//! description, an optional e-mail address and whether to attach a screenshot (captured
//! in-process with the Phase 8 capture code before the dialog opens). The request is then sent:
//!
//! * directly to `POST /agent/v1/support-request`, signed with the device key, when this
//!   process can read the key (elevated, or a development `--data-dir`);
//! * otherwise through the running agent service over a local channel (a named pipe on
//!   Windows, a Unix socket elsewhere). The service takes the account name from the operating
//!   system (never from the client), rate-limits per user, signs and forwards the request.

mod dialog;
mod local;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use base64::Engine;
use rustrmm_crypto::sign::SigningKey;
use rustrmm_proto::support::{self as proto, SupportRequest, SupportResponse};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::config::AgentConfig;
use crate::paths::Paths;

pub use local::Endpoint;

/// Screenshots are downscaled to this width.
const SCREENSHOT_WIDTH: u32 = 1280;
/// Requests a user may relay through the service per hour (the server also limits per device).
const LOCAL_LIMIT: usize = 5;

/// What the user entered.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct Draft {
    #[serde(default)]
    pub subject: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub screenshot: bool,
}

/// The request handed to the service over the local channel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalRequest {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub email: Option<String>,
    pub subject: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub screenshot_jpeg_b64: Option<String>,
}

/// The service's answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalResult {
    pub ok: bool,
    #[serde(default)]
    pub number: Option<i64>,
    #[serde(default)]
    pub ticket_id: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

/// Command-line options of `rustrmm-agent support`.
#[derive(Debug, Clone, Default)]
pub struct Options {
    pub no_dialog: bool,
    pub subject: Option<String>,
    pub description: Option<String>,
    pub email: Option<String>,
    pub screenshot: bool,
}

/// The signed-in account (`DOMAIN\user` or `user`) and a display name when known.
pub fn current_user() -> (String, String) {
    #[cfg(windows)]
    {
        let user = std::env::var("USERNAME").unwrap_or_default();
        let domain = std::env::var("USERDOMAIN").unwrap_or_default();
        let account = if domain.is_empty() {
            user
        } else {
            format!("{domain}\\{user}")
        };
        (account, String::new())
    }
    #[cfg(unix)]
    {
        // SAFETY: getuid has no preconditions.
        let uid = unsafe { libc::getuid() };
        match local::passwd(uid) {
            Some((name, gecos)) => (name, gecos),
            None => (std::env::var("USER").unwrap_or_default(), String::new()),
        }
    }
}

fn clean(text: &str, max: usize) -> String {
    text.chars()
        .filter(|c| *c == '\n' || *c == '\t' || !c.is_control())
        .take(max)
        .collect::<String>()
        .trim()
        .to_string()
}

/// Normalises a draft: the subject falls back to the first line of the description.
pub fn normalize(draft: &Draft) -> Option<(String, String, Option<String>)> {
    let description = clean(&draft.description, 20_000);
    let mut subject = clean(&draft.subject, 200).replace(['\r', '\n'], " ");
    if subject.is_empty() {
        subject = description
            .lines()
            .find(|l| !l.trim().is_empty())
            .map(|l| l.trim().chars().take(120).collect())
            .unwrap_or_default();
    }
    if subject.is_empty() {
        return None;
    }
    let email = draft
        .email
        .as_deref()
        .map(str::trim)
        .filter(|e| e.contains('@') && e.len() <= 254 && !e.contains(char::is_whitespace))
        .map(str::to_string);
    Some((subject, description, email))
}

/// Builds the signed body for an account.
pub fn build(user: &str, req: &LocalRequest) -> SupportRequest {
    SupportRequest {
        user: clean(user, 256),
        name: clean(&req.name, 200),
        email: req.email.clone(),
        subject: clean(&req.subject, 200),
        description: clean(&req.description, 20_000),
        screenshot_jpeg_b64: req.screenshot_jpeg_b64.clone(),
        timestamp: chrono::Utc::now().timestamp(),
        nonce: proto::new_nonce(),
    }
}

/// Signs and posts a request to the first server that answers.
pub async fn send_signed(
    config: &AgentConfig,
    key: &SigningKey,
    request: &SupportRequest,
) -> Result<SupportResponse> {
    let body = serde_json::to_vec(request)?;
    let signature = proto::encode_signature(&key.sign(&proto::signing_bytes(&body)));
    let tls = crate::tls::client_config(config.ca_cert_pem.as_deref())?;
    let client = crate::tls::http_client(tls)?;
    let mut last = None;
    for base in &config.server_urls {
        let url = format!("{}{}", base.trim_end_matches('/'), proto::PATH);
        let sent = client
            .post(&url)
            .header(proto::DEVICE_HEADER, &config.device_id)
            .header(proto::SIGNATURE_HEADER, &signature)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body.clone())
            .send()
            .await;
        match sent {
            Ok(response) if response.status().is_success() => {
                return response
                    .json::<SupportResponse>()
                    .await
                    .context("the server's answer could not be read");
            }
            Ok(response) => {
                let status = response.status();
                let text = response.text().await.unwrap_or_default();
                let message = serde_json::from_str::<serde_json::Value>(&text)
                    .ok()
                    .and_then(|v| {
                        v.pointer("/error/message")
                            .and_then(|m| m.as_str())
                            .map(str::to_string)
                    })
                    .unwrap_or(text);
                bail!("the server refused the request ({status}): {message}");
            }
            Err(e) => last = Some(e),
        }
    }
    Err(last
        .map(anyhow::Error::from)
        .unwrap_or_else(|| anyhow::anyhow!("no server URL is configured")))
    .context("cannot reach the RustRMM server")
}

/// One JPEG of this session's screen.
async fn capture() -> Result<Vec<u8>> {
    #[cfg(any(windows, target_os = "linux"))]
    {
        tokio::task::spawn_blocking(|| crate::desktop::capture_own_screen(SCREENSHOT_WIDTH)).await?
    }
    #[cfg(target_os = "macos")]
    {
        tokio::task::spawn_blocking(dialog::macos_screenshot).await?
    }
}

/// `rustrmm-agent support`.
pub async fn run(paths: &Paths, options: Options) -> Result<()> {
    let (user, name) = current_user();
    let interactive = !options.no_dialog;
    let mut early_shot = None;
    let draft = if interactive {
        // Capture first, so the dialog does not cover the screen.
        early_shot = match capture().await {
            Ok(jpeg) => Some(jpeg),
            Err(e) => {
                tracing::debug!(error = %format!("{e:#}"), "screenshot unavailable");
                None
            }
        };
        match tokio::task::spawn_blocking(dialog::ask).await?? {
            Some(d) => d,
            None => {
                println!("Request cancelled.");
                return Ok(());
            }
        }
    } else {
        Draft {
            subject: options.subject.clone().unwrap_or_default(),
            description: options.description.clone().unwrap_or_default(),
            email: options.email.clone(),
            screenshot: options.screenshot,
        }
    };
    let Some((subject, description, email)) = normalize(&draft) else {
        if interactive {
            dialog::notify(false, "Please describe the problem before sending.");
        }
        bail!("a subject or description is required");
    };
    let screenshot = if draft.screenshot {
        match early_shot {
            Some(jpeg) => Some(jpeg),
            None => match capture().await {
                Ok(jpeg) => Some(jpeg),
                Err(e) => {
                    eprintln!("warning: the screenshot could not be captured: {e:#}");
                    None
                }
            },
        }
    } else {
        None
    };
    let request = LocalRequest {
        name,
        email,
        subject,
        description,
        screenshot_jpeg_b64: screenshot
            .filter(|j| j.len() <= 5 * 1024 * 1024)
            .map(|j| base64::engine::general_purpose::STANDARD.encode(j)),
    };
    match deliver(paths, &user, &request).await {
        Ok(response) => {
            println!(
                "Ticket #{} created ({})",
                response.number, response.ticket_id
            );
            if interactive {
                dialog::notify(
                    true,
                    &format!(
                        "Thank you. Your request was received as ticket #{}.",
                        response.number
                    ),
                );
            }
            Ok(())
        }
        Err(e) => {
            if interactive {
                dialog::notify(false, &format!("The request could not be sent: {e:#}"));
            }
            Err(e)
        }
    }
}

/// Direct when the device key is readable, otherwise through the service.
async fn deliver(paths: &Paths, user: &str, request: &LocalRequest) -> Result<SupportResponse> {
    if let (Ok(Some(config)), Ok(key)) = (AgentConfig::load(paths), crate::identity::load(paths)) {
        tracing::debug!("sending the support request directly");
        return send_signed(&config, &key, &build(user, request)).await;
    }
    let result = local::request(&Endpoint::for_paths(paths), request).await?;
    match result {
        LocalResult {
            ok: true,
            number: Some(number),
            ticket_id: Some(ticket_id),
            ..
        } => Ok(SupportResponse { ticket_id, number }),
        other => bail!(
            "{}",
            other
                .error
                .unwrap_or_else(|| "the agent service refused the request".into())
        ),
    }
}

// ------------------------------------------------------------------ service side

/// Relays local requests: signs them with the device key and posts them.
pub struct Relay {
    config: AgentConfig,
    key: SigningKey,
    recent: Mutex<HashMap<String, Vec<Instant>>>,
}

impl Relay {
    /// Per-user limit: true when the user may send another request now.
    fn allow(&self, user: &str) -> bool {
        let Ok(mut recent) = self.recent.lock() else {
            return false;
        };
        let now = Instant::now();
        let entry = recent.entry(user.to_ascii_lowercase()).or_default();
        entry.retain(|t| now.duration_since(*t) < Duration::from_secs(3600));
        if entry.len() >= LOCAL_LIMIT {
            return false;
        }
        entry.push(now);
        true
    }

    pub async fn handle(&self, user: &str, payload: &[u8]) -> LocalResult {
        let failed = |e: String| LocalResult {
            ok: false,
            number: None,
            ticket_id: None,
            error: Some(e),
        };
        let request: LocalRequest = match serde_json::from_slice(payload) {
            Ok(r) => r,
            Err(e) => return failed(format!("invalid request: {e}")),
        };
        if user.is_empty() {
            return failed("the requesting account could not be identified".into());
        }
        if !self.allow(user) {
            return failed("too many support requests; try again later".into());
        }
        match send_signed(&self.config, &self.key, &build(user, &request)).await {
            Ok(r) => {
                tracing::info!(user, ticket = r.number, "support request relayed");
                LocalResult {
                    ok: true,
                    number: Some(r.number),
                    ticket_id: Some(r.ticket_id),
                    error: None,
                }
            }
            Err(e) => {
                tracing::warn!(user, error = %format!("{e:#}"), "relaying a support request failed");
                failed(format!("{e:#}"))
            }
        }
    }
}

/// Starts the local channel in the service.
pub fn spawn_service(paths: &Paths, config: &AgentConfig, shutdown: CancellationToken) {
    let key = match crate::identity::load(paths) {
        Ok(k) => k,
        Err(e) => {
            tracing::warn!(error = %format!("{e:#}"), "support requests are unavailable");
            return;
        }
    };
    let relay = Arc::new(Relay {
        config: config.clone(),
        key,
        recent: Mutex::new(HashMap::new()),
    });
    let endpoint = Endpoint::for_paths(paths);
    tokio::spawn(async move {
        let handler = move |user: String, payload: Vec<u8>| {
            let relay = relay.clone();
            async move { relay.handle(&user, &payload).await }
        };
        if let Err(e) = local::serve(endpoint, handler, shutdown).await {
            tracing::warn!(error = %format!("{e:#}"), "the support request channel stopped");
        }
    });
}

/// Selftest: a round trip over a temporary local channel with a stub handler.
pub async fn selftest() -> Result<String> {
    let started = Instant::now();
    let endpoint = Endpoint::temporary()?;
    let shutdown = CancellationToken::new();
    let server = {
        let endpoint = endpoint.clone();
        let shutdown = shutdown.clone();
        tokio::spawn(async move {
            local::serve(
                endpoint,
                |user: String, payload: Vec<u8>| async move {
                    let req: LocalRequest =
                        serde_json::from_slice(&payload).unwrap_or(LocalRequest {
                            name: String::new(),
                            email: None,
                            subject: String::new(),
                            description: String::new(),
                            screenshot_jpeg_b64: None,
                        });
                    LocalResult {
                        ok: !user.is_empty() && req.subject == "selftest",
                        number: Some(1),
                        ticket_id: Some(user),
                        error: None,
                    }
                },
                shutdown,
            )
            .await
        })
    };
    let request = LocalRequest {
        name: String::new(),
        email: None,
        subject: "selftest".into(),
        description: String::new(),
        screenshot_jpeg_b64: None,
    };
    let result =
        tokio::time::timeout(Duration::from_secs(10), local::request(&endpoint, &request)).await;
    shutdown.cancel();
    let _ = tokio::time::timeout(Duration::from_secs(5), server).await;
    endpoint.cleanup();
    let result = result.context("the local channel did not answer")??;
    if !result.ok {
        bail!("the local channel round trip failed: {:?}", result.error);
    }
    Ok(format!(
        "local channel round trip as {} ({} ms)",
        result.ticket_id.unwrap_or_default(),
        started.elapsed().as_millis()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drafts_normalise() {
        let d = Draft {
            subject: "  ".into(),
            description: "\n Printer jams on page 2 \nmore".into(),
            email: Some(" alex@example.com ".into()),
            screenshot: true,
        };
        let (subject, description, email) = normalize(&d).expect("valid");
        assert_eq!(subject, "Printer jams on page 2");
        assert_eq!(description, "Printer jams on page 2 \nmore");
        assert_eq!(email.as_deref(), Some("alex@example.com"));
        assert!(normalize(&Draft::default()).is_none());
        let bad_email = Draft {
            subject: "x\ny".into(),
            email: Some("not an email".into()),
            ..Draft::default()
        };
        let (subject, _, email) = normalize(&bad_email).expect("valid");
        assert_eq!(subject, "x y");
        assert!(email.is_none());
    }

    #[test]
    fn built_requests_carry_a_fresh_nonce_and_timestamp() {
        let req = LocalRequest {
            name: "Alex".into(),
            email: None,
            subject: "Printer".into(),
            description: "jam".into(),
            screenshot_jpeg_b64: None,
        };
        let a = build("CORP\\alex", &req);
        let b = build("CORP\\alex", &req);
        assert_eq!(a.user, "CORP\\alex");
        assert_ne!(a.nonce, b.nonce);
        assert!((a.timestamp - chrono::Utc::now().timestamp()).abs() < 5);
    }

    #[tokio::test]
    async fn local_channel_round_trips() {
        let summary = selftest().await.expect("round trip");
        assert!(summary.contains("round trip"), "{summary}");
    }

    /// The direct path against a scripted HTTP server: the server can verify the signature
    /// over the context and the exact body it received.
    #[tokio::test]
    async fn send_signed_posts_a_verifiable_request() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let key = SigningKey::generate();
        let public = key.public_key();
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.expect("accept");
            let mut raw = Vec::new();
            let mut buf = [0u8; 4096];
            let header_end = loop {
                let n = sock.read(&mut buf).await.expect("read");
                assert!(n > 0, "connection closed early");
                raw.extend_from_slice(&buf[..n]);
                if let Some(i) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                    break i + 4;
                }
            };
            let head = String::from_utf8_lossy(&raw[..header_end]).to_string();
            let header = |name: &str| {
                head.lines()
                    .find_map(|l| {
                        let (k, v) = l.split_once(':')?;
                        k.trim()
                            .eq_ignore_ascii_case(name)
                            .then(|| v.trim().to_string())
                    })
                    .unwrap_or_default()
            };
            let length: usize = header("content-length").parse().expect("length");
            while raw.len() < header_end + length {
                let n = sock.read(&mut buf).await.expect("read");
                raw.extend_from_slice(&buf[..n]);
            }
            let body = raw[header_end..header_end + length].to_vec();
            let signature =
                proto::decode_signature(&header(proto::SIGNATURE_HEADER)).expect("signature");
            public
                .verify(&proto::signing_bytes(&body), &signature)
                .expect("verifiable signature");
            let answer = r#"{"ticket_id":"t-1","number":1042}"#;
            sock.write_all(
                format!(
                    "HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{answer}",
                    answer.len()
                )
                .as_bytes(),
            )
            .await
            .expect("answer");
            (head, body)
        });
        let config = AgentConfig {
            device_id: "dev-1".into(),
            server_urls: vec![format!("http://127.0.0.1:{port}")],
            identity_key: String::new(),
            command_key: String::new(),
            release_key: String::new(),
            escrow_recipient: String::new(),
            ca_cert_pem: None,
            client_name: "Acme".into(),
            site_name: "Main".into(),
            enrolled_at: chrono::Utc::now(),
        };
        let request = build(
            "CORP\\alex",
            &LocalRequest {
                name: "Alex".into(),
                email: Some("alex@example.com".into()),
                subject: "Printer".into(),
                description: "jam".into(),
                screenshot_jpeg_b64: None,
            },
        );
        let response = send_signed(&config, &key, &request).await.expect("sent");
        assert_eq!(response.number, 1042);
        let (head, body) = server.await.expect("server");
        assert!(
            head.starts_with("POST /agent/v1/support-request HTTP/1.1"),
            "{head}"
        );
        assert!(
            head.to_ascii_lowercase()
                .contains("x-rustrmm-device: dev-1"),
            "{head}"
        );
        let sent: SupportRequest = serde_json::from_slice(&body).expect("json");
        assert_eq!(sent, request);
    }
}
