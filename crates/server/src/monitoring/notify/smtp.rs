//! A small SMTP submission client on tokio-rustls (ring provider): implicit TLS, STARTTLS or
//! plain, AUTH PLAIN/LOGIN, and a multipart text + HTML message with base64 bodies.

use std::time::Duration;

use anyhow::{Context, Result, bail};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use rustls::pki_types::ServerName;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};

use crate::monitoring::settings::SmtpSettings;

const STEP_TIMEOUT: Duration = Duration::from_secs(30);

/// One message.
#[derive(Debug, Clone, Default)]
pub struct Email {
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub subject: String,
    pub text: String,
    pub html: String,
    /// `Reply-To` address.
    pub reply_to: Option<String>,
    /// `Message-ID` without angle brackets (generated when absent).
    pub message_id: Option<String>,
    /// `In-Reply-To` / `References` message id without angle brackets.
    pub in_reply_to: Option<String>,
    pub attachments: Vec<Attachment>,
}

/// A file attached to a message.
#[derive(Debug, Clone)]
pub struct Attachment {
    pub file_name: String,
    pub content_type: String,
    pub data: Vec<u8>,
}

/// A message id is `local@domain` with no spaces, brackets or control characters.
fn clean_message_id(id: &str) -> Option<String> {
    let id = id.trim().trim_start_matches('<').trim_end_matches('>');
    (id.contains('@')
        && id.len() <= 250
        && !id
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || matches!(c, '<' | '>' | '"' | ',')))
    .then(|| id.to_string())
}

/// A quoted file name for MIME headers (RFC 2047 encoded when not ASCII).
fn mime_file_name(name: &str) -> String {
    let clean: String = name
        .chars()
        .filter(|c| !c.is_control() && *c != '"' && *c != '\\')
        .take(200)
        .collect();
    if clean.is_ascii() {
        format!("\"{clean}\"")
    } else {
        format!("\"{}\"", header_text(&clean))
    }
}

trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}

struct Conn {
    stream: BufReader<Box<dyn Io>>,
    tls: bool,
}

impl Conn {
    async fn read_reply(&mut self) -> Result<(u16, String)> {
        let mut text = String::new();
        loop {
            let mut line = String::new();
            let n = tokio::time::timeout(STEP_TIMEOUT, self.stream.read_line(&mut line))
                .await
                .context("the SMTP server did not answer in time")??;
            if n == 0 {
                bail!("the SMTP server closed the connection");
            }
            if line.len() > 2048 || text.len() > 16 * 1024 {
                bail!("SMTP reply too long");
            }
            let line = line.trim_end_matches(['\r', '\n']);
            if line.len() < 3 {
                bail!("malformed SMTP reply");
            }
            let code: u16 = line[..3].parse().context("malformed SMTP reply code")?;
            text.push_str(line.get(4..).unwrap_or(""));
            text.push('\n');
            if line.as_bytes().get(3) != Some(&b'-') {
                return Ok((code, text));
            }
        }
    }

    async fn write(&mut self, data: &[u8]) -> Result<()> {
        tokio::time::timeout(STEP_TIMEOUT, async {
            self.stream.get_mut().write_all(data).await?;
            self.stream.get_mut().flush().await
        })
        .await
        .context("writing to the SMTP server timed out")??;
        Ok(())
    }

    /// Sends a command and expects a reply code in `expect`.
    async fn command(&mut self, line: &str, expect: &[u16], what: &str) -> Result<String> {
        self.write(format!("{line}\r\n").as_bytes()).await?;
        let (code, text) = self.read_reply().await?;
        if !expect.contains(&code) {
            bail!("{what} failed: {code} {}", text.trim());
        }
        Ok(text)
    }

    async fn upgrade(self, host: &str) -> Result<Self> {
        if !self.stream.buffer().is_empty() {
            bail!("unexpected data before the TLS handshake");
        }
        let inner = self.stream.into_inner();
        let tls = tls_connect(inner, host).await?;
        Ok(Self {
            stream: BufReader::new(tls),
            tls: true,
        })
    }
}

async fn tls_connect(stream: Box<dyn Io>, host: &str) -> Result<Box<dyn Io>> {
    let config = super::ssrf::tls_client_config()?;
    let connector = tokio_rustls::TlsConnector::from(std::sync::Arc::new(config));
    let name = ServerName::try_from(host.to_string()).context("invalid SMTP host name")?;
    let tls = tokio::time::timeout(STEP_TIMEOUT, connector.connect(name, stream))
        .await
        .context("TLS handshake timed out")?
        .context("TLS handshake with the SMTP server failed")?;
    Ok(Box::new(tls))
}

fn has_capability(ehlo: &str, name: &str) -> bool {
    ehlo.lines().any(|l| {
        l.split_whitespace()
            .next()
            .is_some_and(|w| w.eq_ignore_ascii_case(name))
    })
}

fn auth_mechanisms(ehlo: &str) -> Vec<String> {
    ehlo.lines()
        .filter_map(|l| {
            let mut words = l.split_whitespace();
            let first = words.next()?;
            first
                .eq_ignore_ascii_case("AUTH")
                .then(|| words.map(str::to_ascii_uppercase).collect::<Vec<_>>())
        })
        .flatten()
        .collect()
}

/// Encodes a header value as an RFC 2047 word when it is not plain ASCII.
fn header_text(value: &str) -> String {
    let clean: String = value.chars().filter(|c| !c.is_control()).collect();
    if clean.is_ascii() {
        clean
    } else {
        format!("=?UTF-8?B?{}?=", STANDARD.encode(clean.as_bytes()))
    }
}

fn wrap_base64(data: &[u8]) -> String {
    let encoded = STANDARD.encode(data);
    let mut out = String::with_capacity(encoded.len() + encoded.len() / 76 * 2 + 2);
    for chunk in encoded.as_bytes().chunks(76) {
        out.push_str(std::str::from_utf8(chunk).unwrap_or_default());
        out.push_str("\r\n");
    }
    out
}

/// Builds the RFC 5322 message (CRLF line endings, dot-stuffed for DATA).
pub fn build_message(settings: &SmtpSettings, email: &Email) -> String {
    let boundary = format!("rustrmm-{}", rustrmm_common::new_id());
    let from = if settings.from_name.is_empty() {
        format!("<{}>", settings.from_address)
    } else {
        format!(
            "\"{}\" <{}>",
            header_text(&settings.from_name).replace('"', "'"),
            settings.from_address
        )
    };
    let domain = settings
        .from_address
        .rsplit_once('@')
        .map(|(_, d)| d.to_string())
        .unwrap_or_else(|| "rustrmm.local".into());
    let mut m = String::new();
    m.push_str(&format!("From: {from}\r\n"));
    m.push_str(&format!("To: {}\r\n", email.to.join(", ")));
    if !email.cc.is_empty() {
        m.push_str(&format!("Cc: {}\r\n", email.cc.join(", ")));
    }
    if let Some(reply_to) = email
        .reply_to
        .as_deref()
        .filter(|a| crate::monitoring::settings::valid_email(a))
    {
        m.push_str(&format!("Reply-To: {reply_to}\r\n"));
    }
    m.push_str(&format!("Subject: {}\r\n", header_text(&email.subject)));
    m.push_str(&format!("Date: {}\r\n", chrono::Utc::now().to_rfc2822()));
    let message_id = email
        .message_id
        .as_deref()
        .and_then(clean_message_id)
        .unwrap_or_else(|| format!("{}@{domain}", rustrmm_common::new_id()));
    m.push_str(&format!("Message-ID: <{message_id}>\r\n"));
    if let Some(parent) = email.in_reply_to.as_deref().and_then(clean_message_id) {
        m.push_str(&format!("In-Reply-To: <{parent}>\r\n"));
        m.push_str(&format!("References: <{parent}>\r\n"));
    }
    m.push_str("MIME-Version: 1.0\r\n");
    m.push_str("Auto-Submitted: auto-generated\r\n");
    let mixed = format!("{boundary}-m");
    if !email.attachments.is_empty() {
        m.push_str(&format!(
            "Content-Type: multipart/mixed; boundary=\"{mixed}\"\r\n\r\n"
        ));
        m.push_str(&format!("--{mixed}\r\n"));
    }
    m.push_str(&format!(
        "Content-Type: multipart/alternative; boundary=\"{boundary}\"\r\n\r\n"
    ));
    for (kind, body) in [("text/plain", &email.text), ("text/html", &email.html)] {
        m.push_str(&format!("--{boundary}\r\n"));
        m.push_str(&format!("Content-Type: {kind}; charset=utf-8\r\n"));
        m.push_str("Content-Transfer-Encoding: base64\r\n\r\n");
        m.push_str(&wrap_base64(body.as_bytes()));
    }
    m.push_str(&format!("--{boundary}--\r\n"));
    if !email.attachments.is_empty() {
        for a in &email.attachments {
            let content_type = if a.content_type.contains('/')
                && a.content_type
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "/.+-_".contains(c))
            {
                a.content_type.as_str()
            } else {
                "application/octet-stream"
            };
            let name = mime_file_name(&a.file_name);
            m.push_str(&format!("--{mixed}\r\n"));
            m.push_str(&format!("Content-Type: {content_type}; name={name}\r\n"));
            m.push_str(&format!(
                "Content-Disposition: attachment; filename={name}\r\n"
            ));
            m.push_str("Content-Transfer-Encoding: base64\r\n\r\n");
            m.push_str(&wrap_base64(&a.data));
        }
        m.push_str(&format!("--{mixed}--\r\n"));
    }
    // Dot-stuffing (base64 lines never start with a dot, but headers might).
    m.split("\r\n")
        .map(|line| {
            if line.starts_with('.') {
                format!(".{line}")
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\r\n")
}

/// Delivers one message through the configured server.
pub async fn send(settings: &SmtpSettings, password: Option<&str>, email: &Email) -> Result<()> {
    if !settings.configured() {
        bail!("SMTP is not configured");
    }
    if email.to.is_empty() {
        bail!("no recipients");
    }
    for address in email
        .to
        .iter()
        .chain(&email.cc)
        .chain([&settings.from_address])
    {
        if !crate::monitoring::settings::valid_email(address) {
            bail!("invalid e-mail address {address}");
        }
    }
    if !settings.username.is_empty() && settings.security == "none" {
        bail!("refusing to send the SMTP password without TLS");
    }
    let host = settings.host.trim();
    let tcp = tokio::time::timeout(
        STEP_TIMEOUT,
        tokio::net::TcpStream::connect((host, settings.port)),
    )
    .await
    .context("connecting to the SMTP server timed out")?
    .with_context(|| format!("cannot connect to {host}:{}", settings.port))?;
    let stream: Box<dyn Io> = Box::new(tcp);
    let mut conn = if settings.security == "tls" {
        Conn {
            stream: BufReader::new(tls_connect(stream, host).await?),
            tls: true,
        }
    } else {
        Conn {
            stream: BufReader::new(stream),
            tls: false,
        }
    };
    let (code, text) = conn.read_reply().await?;
    if code != 220 {
        bail!(
            "the SMTP server refused the connection: {code} {}",
            text.trim()
        );
    }
    let helo = format!("EHLO {}", ehlo_name());
    let mut ehlo = conn.command(&helo, &[250], "EHLO").await?;
    if settings.security == "starttls" {
        if !has_capability(&ehlo, "STARTTLS") {
            bail!("the SMTP server does not offer STARTTLS");
        }
        conn.command("STARTTLS", &[220], "STARTTLS").await?;
        conn = conn.upgrade(host).await?;
        ehlo = conn.command(&helo, &[250], "EHLO").await?;
    }
    if !settings.username.is_empty() {
        if !conn.tls {
            bail!("refusing to send the SMTP password without TLS");
        }
        let password = password.unwrap_or_default();
        let mechanisms = auth_mechanisms(&ehlo);
        if mechanisms.iter().any(|m| m == "PLAIN") || mechanisms.is_empty() {
            let token = STANDARD.encode(format!("\0{}\0{password}", settings.username));
            conn.command(&format!("AUTH PLAIN {token}"), &[235], "authentication")
                .await?;
        } else if mechanisms.iter().any(|m| m == "LOGIN") {
            conn.command("AUTH LOGIN", &[334], "authentication").await?;
            conn.command(
                &STANDARD.encode(&settings.username),
                &[334],
                "authentication",
            )
            .await?;
            conn.command(&STANDARD.encode(password), &[235], "authentication")
                .await?;
        } else {
            bail!("the SMTP server offers no supported authentication method (PLAIN or LOGIN)");
        }
    }
    conn.command(
        &format!("MAIL FROM:<{}>", settings.from_address),
        &[250],
        "MAIL FROM",
    )
    .await?;
    for rcpt in email.to.iter().chain(&email.cc) {
        conn.command(&format!("RCPT TO:<{rcpt}>"), &[250, 251], "RCPT TO")
            .await?;
    }
    conn.command("DATA", &[354], "DATA").await?;
    let mut body = build_message(settings, email);
    body.push_str("\r\n.\r\n");
    conn.write(body.as_bytes()).await?;
    let (code, text) = conn.read_reply().await?;
    if code != 250 {
        bail!(
            "the SMTP server rejected the message: {code} {}",
            text.trim()
        );
    }
    let _ = conn.command("QUIT", &[221], "QUIT").await;
    Ok(())
}

fn ehlo_name() -> String {
    let name = hostname_or_default();
    if name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
        && !name.is_empty()
    {
        name
    } else {
        "rustrmm".into()
    }
}

fn hostname_or_default() -> String {
    std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .unwrap_or_else(|_| "rustrmm".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;

    fn settings(port: u16) -> SmtpSettings {
        SmtpSettings {
            host: "127.0.0.1".into(),
            port,
            security: "none".into(),
            username: String::new(),
            password_enc: None,
            from_address: "rmm@example.com".into(),
            from_name: "RustRMM Alerts".into(),
        }
    }

    #[test]
    fn messages_are_mime_encoded_and_dot_stuffed() {
        let email = Email {
            to: vec!["ops@example.com".into()],
            cc: vec!["boss@example.com".into()],
            subject: "Zürich offline\r\nBcc: evil@example.com".into(),
            text: ".hidden line".into(),
            html: "<p>hi</p>".into(),
            ..Email::default()
        };
        let m = build_message(&settings(25), &email);
        assert!(m.contains("Subject: =?UTF-8?B?"), "{m}");
        assert!(!m.contains("Bcc:"), "header injection is stripped");
        assert!(m.contains("Cc: boss@example.com"));
        assert!(m.contains("multipart/alternative"));
        assert!(m.contains(&STANDARD.encode(".hidden line")));
        assert!(m.lines().all(|l| l.len() <= 998));
    }

    #[test]
    fn threading_headers_and_attachments() {
        let email = Email {
            to: vec!["dana@example.com".into()],
            subject: "[#1042] Printer".into(),
            text: "hi".into(),
            html: "<p>hi</p>".into(),
            reply_to: Some("support+t1042.abc@example.com".into()),
            message_id: Some("<ticket-1042-x@example.com>".into()),
            in_reply_to: Some("first@example.com".into()),
            attachments: vec![Attachment {
                file_name: "steps \"1\".txt".into(),
                content_type: "text/plain".into(),
                data: b"step one".to_vec(),
            }],
            ..Email::default()
        };
        let m = build_message(&settings(25), &email);
        assert!(
            m.contains("Reply-To: support+t1042.abc@example.com\r\n"),
            "{m}"
        );
        assert!(m.contains("Message-ID: <ticket-1042-x@example.com>\r\n"));
        assert!(
            m.contains("In-Reply-To: <first@example.com>\r\nReferences: <first@example.com>\r\n")
        );
        assert!(m.contains("multipart/mixed"));
        assert!(
            m.contains("Content-Disposition: attachment; filename=\"steps 1.txt\""),
            "{m}"
        );
        assert!(m.contains(&STANDARD.encode("step one")));
        // Injected or malformed ids and reply addresses are dropped.
        let bad = Email {
            to: vec!["dana@example.com".into()],
            reply_to: Some("x@example.com\r\nBcc: evil@example.com".into()),
            in_reply_to: Some("no spaces allowed@x".into()),
            ..Email::default()
        };
        let m = build_message(&settings(25), &bad);
        assert!(!m.contains("Reply-To:") && !m.contains("In-Reply-To:") && !m.contains("Bcc:"));
        assert!(!m.contains("multipart/mixed"));
    }

    #[test]
    fn capabilities_are_parsed() {
        let ehlo = "mail.example.com\nPIPELINING\nSTARTTLS\nAUTH LOGIN PLAIN\n";
        assert!(has_capability(ehlo, "starttls"));
        assert_eq!(auth_mechanisms(ehlo), vec!["LOGIN", "PLAIN"]);
    }

    /// A scripted plain-text SMTP server: the client must walk the dialogue and deliver DATA.
    #[tokio::test]
    async fn delivers_through_a_plain_server() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.expect("accept");
            sock.write_all(b"220 test ESMTP\r\n").await.expect("greet");
            let mut buf = vec![0u8; 65536];
            let mut seen = String::new();
            loop {
                let n = sock.read(&mut buf).await.expect("read");
                if n == 0 {
                    break;
                }
                let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                seen.push_str(&chunk);
                let reply: &[u8] = if chunk.starts_with("EHLO") {
                    b"250-test\r\n250 PIPELINING\r\n"
                } else if chunk.starts_with("DATA") {
                    b"354 go ahead\r\n"
                } else if chunk.starts_with("QUIT") {
                    sock.write_all(b"221 bye\r\n").await.expect("bye");
                    break;
                } else {
                    b"250 ok\r\n"
                };
                sock.write_all(reply).await.expect("reply");
            }
            seen
        });
        let email = Email {
            to: vec!["ops@example.com".into()],
            cc: Vec::new(),
            subject: "Test".into(),
            text: "hello".into(),
            html: "<p>hello</p>".into(),
            ..Email::default()
        };
        send(&settings(port), None, &email).await.expect("sent");
        let seen = server.await.expect("server");
        assert!(seen.contains("MAIL FROM:<rmm@example.com>"));
        assert!(seen.contains("RCPT TO:<ops@example.com>"));
        assert!(seen.contains("\r\n.\r\n"));

        let mut with_auth = settings(port);
        with_auth.username = "user".into();
        let refused = send(&with_auth, Some("pw"), &email)
            .await
            .expect_err("no password without TLS");
        assert!(refused.to_string().contains("without TLS"), "{refused:#}");
    }
}
