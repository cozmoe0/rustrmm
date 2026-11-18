//! A small IMAP4rev1 client on tokio-rustls (ring provider), enough for e-mail-to-ticket:
//! implicit TLS or STARTTLS, LOGIN or AUTHENTICATE PLAIN, SELECT, UID SEARCH, UID FETCH with
//! literals, and UID MOVE (or COPY + STORE \Deleted + EXPUNGE). Plain connections are allowed
//! only to a mail server on this host.

use std::time::Duration;

use anyhow::{Context, Result, bail};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use rustls::pki_types::ServerName;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};

use super::email::{self, Inbound};
use crate::state::AppState;

const STEP_TIMEOUT: Duration = Duration::from_secs(60);
const POLL_EVERY: Duration = Duration::from_secs(60);
const MAX_LINE: u64 = 64 * 1024;
/// Messages larger than this are not fetched.
pub const MAX_MESSAGE: u64 = 25 * 1024 * 1024;
/// Messages handled per poll.
const BATCH: usize = 50;

pub trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}

/// One server response: the line text (literals replaced by `{n}` markers) and the literal
/// payloads in order.
#[derive(Debug, Clone, Default)]
pub struct Response {
    pub text: String,
    pub literals: Vec<Vec<u8>>,
}

pub struct Client {
    stream: BufReader<Box<dyn Io>>,
    tls: bool,
    tag: u32,
    capabilities: Vec<String>,
}

/// `{123}` or `{123+}` at the end of a line.
fn literal_len(line: &str) -> Option<usize> {
    let body = line.strip_suffix('}')?;
    let open = body.rfind('{')?;
    body[open + 1..].trim_end_matches('+').parse().ok()
}

/// A quoted IMAP string, or `None` when the value needs a literal.
fn quoted(value: &str) -> Option<String> {
    if value.chars().any(|c| !c.is_ascii() || c.is_ascii_control()) {
        return None;
    }
    Some(format!(
        "\"{}\"",
        value.replace('\\', "\\\\").replace('"', "\\\"")
    ))
}

impl Client {
    pub fn from_stream(stream: Box<dyn Io>, tls: bool) -> Self {
        Self {
            stream: BufReader::new(stream),
            tls,
            tag: 0,
            capabilities: Vec::new(),
        }
    }

    /// Connects, reads the greeting and (for `starttls`) upgrades the connection.
    pub async fn connect(settings: &Inbound) -> Result<Self> {
        let host = settings.host.trim();
        if settings.security == "none" && !email::is_loopback(host) {
            bail!("plain IMAP is only allowed to a mail server on this host");
        }
        let tcp = tokio::time::timeout(
            Duration::from_secs(30),
            tokio::net::TcpStream::connect((host, settings.port)),
        )
        .await
        .context("connecting to the IMAP server timed out")?
        .with_context(|| format!("cannot connect to {host}:{}", settings.port))?;
        let mut client = if settings.security == "tls" {
            Self::from_stream(tls_connect(Box::new(tcp), host).await?, true)
        } else {
            Self::from_stream(Box::new(tcp), false)
        };
        client.greeting().await?;
        if settings.security == "starttls" {
            client.command("STARTTLS").await?;
            client = client.upgrade(host).await?;
        }
        client.refresh_capabilities().await?;
        Ok(client)
    }

    pub async fn greeting(&mut self) -> Result<()> {
        let greeting = self.read_response().await?;
        if !(greeting.text.starts_with("* OK") || greeting.text.starts_with("* PREAUTH")) {
            bail!("the IMAP server refused the connection: {}", greeting.text);
        }
        Ok(())
    }

    async fn upgrade(self, host: &str) -> Result<Self> {
        if !self.stream.buffer().is_empty() {
            bail!("unexpected data before the TLS handshake");
        }
        let tls = tls_connect(self.stream.into_inner(), host).await?;
        Ok(Self {
            stream: BufReader::new(tls),
            tls: true,
            tag: self.tag,
            capabilities: Vec::new(),
        })
    }

    async fn read_response(&mut self) -> Result<Response> {
        let mut out = Response::default();
        loop {
            let mut line = Vec::new();
            let n = tokio::time::timeout(
                STEP_TIMEOUT,
                (&mut self.stream)
                    .take(MAX_LINE)
                    .read_until(b'\n', &mut line),
            )
            .await
            .context("the IMAP server did not answer in time")??;
            if n == 0 {
                bail!("the IMAP server closed the connection");
            }
            if !line.ends_with(b"\n") {
                bail!("IMAP response line too long");
            }
            let text = String::from_utf8_lossy(&line);
            let text = text.trim_end_matches(['\r', '\n']);
            out.text.push_str(text);
            match literal_len(text) {
                Some(len) => {
                    if len as u64 > MAX_MESSAGE + 1024 * 1024 {
                        bail!("IMAP literal of {len} bytes is too large");
                    }
                    let mut data = vec![0u8; len];
                    tokio::time::timeout(STEP_TIMEOUT, self.stream.read_exact(&mut data))
                        .await
                        .context("the IMAP server did not send the message in time")??;
                    out.literals.push(data);
                }
                None => return Ok(out),
            }
        }
    }

    async fn write(&mut self, data: &[u8]) -> Result<()> {
        tokio::time::timeout(STEP_TIMEOUT, async {
            self.stream.get_mut().write_all(data).await?;
            self.stream.get_mut().flush().await
        })
        .await
        .context("writing to the IMAP server timed out")??;
        Ok(())
    }

    fn next_tag(&mut self) -> String {
        self.tag += 1;
        format!("R{:04}", self.tag)
    }

    async fn finish(&mut self, tag: &str, what: &str) -> Result<Vec<Response>> {
        let mut untagged = Vec::new();
        loop {
            let r = self.read_response().await?;
            if let Some(rest) = r.text.strip_prefix(tag).and_then(|r| r.strip_prefix(' ')) {
                let status = rest.split_whitespace().next().unwrap_or_default();
                if status.eq_ignore_ascii_case("OK") {
                    return Ok(untagged);
                }
                bail!("IMAP {what} failed: {rest}");
            }
            if r.text.starts_with('+') {
                bail!("unexpected IMAP continuation during {what}");
            }
            untagged.push(r);
        }
    }

    /// Sends a command and collects untagged responses until the tagged OK.
    pub async fn command(&mut self, command: &str) -> Result<Vec<Response>> {
        let tag = self.next_tag();
        self.write(format!("{tag} {command}\r\n").as_bytes())
            .await?;
        let what = command
            .split_whitespace()
            .take(2)
            .collect::<Vec<_>>()
            .join(" ");
        self.finish(&tag, &what).await
    }

    pub async fn refresh_capabilities(&mut self) -> Result<()> {
        let responses = self.command("CAPABILITY").await?;
        self.capabilities = responses
            .iter()
            .filter_map(|r| r.text.strip_prefix("* CAPABILITY "))
            .flat_map(|caps| caps.split_whitespace().map(str::to_ascii_uppercase))
            .collect();
        Ok(())
    }

    pub fn has(&self, capability: &str) -> bool {
        self.capabilities
            .iter()
            .any(|c| c.eq_ignore_ascii_case(capability))
    }

    /// Signs in (AUTHENTICATE PLAIN when offered, LOGIN otherwise). Never over plain text to
    /// a remote host.
    pub async fn login(&mut self, username: &str, password: &str, host: &str) -> Result<()> {
        if !self.tls && !email::is_loopback(host) {
            bail!("refusing to send the IMAP password without TLS");
        }
        if self.has("AUTH=PLAIN") {
            let tag = self.next_tag();
            self.write(format!("{tag} AUTHENTICATE PLAIN\r\n").as_bytes())
                .await?;
            let cont = self.read_response().await?;
            if !cont.text.starts_with('+') {
                bail!("IMAP authentication refused: {}", cont.text);
            }
            let token = STANDARD.encode(format!("\0{username}\0{password}"));
            self.write(format!("{token}\r\n").as_bytes()).await?;
            self.finish(&tag, "authentication").await?;
        } else {
            if self.has("LOGINDISABLED") {
                bail!("the IMAP server does not allow LOGIN on this connection");
            }
            let (Some(user), Some(pass)) = (quoted(username), quoted(password)) else {
                bail!("the IMAP server offers no AUTH=PLAIN, and LOGIN needs ASCII credentials");
            };
            self.command(&format!("LOGIN {user} {pass}"))
                .await
                .map_err(|_| {
                    anyhow::anyhow!("IMAP login failed (check the user name and password)")
                })?;
        }
        self.refresh_capabilities().await
    }

    /// Selects a folder; returns the message count.
    pub async fn select(&mut self, folder: &str) -> Result<u64> {
        let name = quoted(folder).context("folder names must be ASCII")?;
        let responses = self.command(&format!("SELECT {name}")).await?;
        Ok(responses
            .iter()
            .find_map(|r| {
                let rest = r.text.strip_prefix("* ")?;
                let (n, word) = rest.split_once(' ')?;
                word.eq_ignore_ascii_case("EXISTS")
                    .then(|| n.parse().ok())
                    .flatten()
            })
            .unwrap_or(0))
    }

    /// Creates a folder; an existing folder is fine.
    pub async fn create(&mut self, folder: &str) -> Result<()> {
        let name = quoted(folder).context("folder names must be ASCII")?;
        let _ = self.command(&format!("CREATE {name}")).await;
        Ok(())
    }

    pub async fn uid_search_all(&mut self) -> Result<Vec<u32>> {
        let responses = self.command("UID SEARCH ALL").await?;
        let mut uids: Vec<u32> = responses
            .iter()
            .filter_map(|r| r.text.strip_prefix("* SEARCH"))
            .flat_map(|rest| rest.split_whitespace().filter_map(|n| n.parse().ok()))
            .collect();
        uids.sort_unstable();
        uids.dedup();
        Ok(uids)
    }

    pub async fn uid_fetch_size(&mut self, uid: u32) -> Result<Option<u64>> {
        let responses = self
            .command(&format!("UID FETCH {uid} (RFC822.SIZE)"))
            .await?;
        Ok(responses.iter().find_map(|r| {
            let upper = r.text.to_ascii_uppercase();
            let i = upper.find("RFC822.SIZE ")?;
            r.text[i + 12..]
                .split(|c: char| !c.is_ascii_digit())
                .next()?
                .parse()
                .ok()
        }))
    }

    /// The full message (`BODY.PEEK[]`, so the \Seen flag is untouched).
    pub async fn uid_fetch_message(&mut self, uid: u32) -> Result<Vec<u8>> {
        let responses = self
            .command(&format!("UID FETCH {uid} (BODY.PEEK[])"))
            .await?;
        responses
            .into_iter()
            .filter(|r| r.text.to_ascii_uppercase().contains("BODY["))
            .find_map(|r| r.literals.into_iter().next())
            .context("the IMAP server returned no message body")
    }

    /// Only the header section (for messages too large to fetch).
    pub async fn uid_fetch_header(&mut self, uid: u32) -> Result<Vec<u8>> {
        let responses = self
            .command(&format!("UID FETCH {uid} (BODY.PEEK[HEADER])"))
            .await?;
        Ok(responses
            .into_iter()
            .find_map(|r| r.literals.into_iter().next())
            .unwrap_or_default())
    }

    pub async fn uid_move(&mut self, uid: u32, folder: &str) -> Result<()> {
        let name = quoted(folder).context("folder names must be ASCII")?;
        if self.has("MOVE") {
            self.command(&format!("UID MOVE {uid} {name}")).await?;
        } else {
            self.command(&format!("UID COPY {uid} {name}")).await?;
            self.command(&format!("UID STORE {uid} +FLAGS.SILENT (\\Deleted)"))
                .await?;
            if self.has("UIDPLUS") {
                self.command(&format!("UID EXPUNGE {uid}")).await?;
            } else {
                self.command("EXPUNGE").await?;
            }
        }
        Ok(())
    }

    pub async fn logout(&mut self) {
        let _ = self.command("LOGOUT").await;
    }
}

async fn tls_connect(stream: Box<dyn Io>, host: &str) -> Result<Box<dyn Io>> {
    let config = crate::monitoring::notify::ssrf::tls_client_config()?;
    let connector = tokio_rustls::TlsConnector::from(std::sync::Arc::new(config));
    let name = ServerName::try_from(host.to_string()).context("invalid IMAP host name")?;
    let tls = tokio::time::timeout(Duration::from_secs(30), connector.connect(name, stream))
        .await
        .context("TLS handshake timed out")?
        .context("TLS handshake with the IMAP server failed")?;
    Ok(Box::new(tls))
}

/// `POST /settings/ticket-email/test-imap`: sign in and select the folder.
pub async fn test_login(settings: &Inbound, password: &str) -> Result<()> {
    let mut client = Client::connect(settings).await?;
    client
        .login(&settings.username, password, &settings.host)
        .await?;
    client
        .select(&settings.folder)
        .await
        .with_context(|| format!("selecting folder {}", settings.folder))?;
    client.logout().await;
    Ok(())
}

/// Polls the mailbox once: every message in the folder is processed (or skipped) and moved
/// to the processed folder. Returns how many messages were handled.
pub async fn poll_once(state: &AppState) -> Result<usize> {
    let _guard = state.helpdesk.imap_lock.lock().await;
    let settings = email::load(state).await?;
    let inbound = &settings.inbound;
    if !inbound.enabled || inbound.host.is_empty() {
        return Ok(0);
    }
    let password = inbound.password(state)?.unwrap_or_default();
    let mut client = Client::connect(inbound).await?;
    client
        .login(&inbound.username, &password, &inbound.host)
        .await?;
    client.create(&inbound.processed_folder).await?;
    client
        .select(&inbound.folder)
        .await
        .with_context(|| format!("selecting folder {}", inbound.folder))?;
    let uids = client.uid_search_all().await?;
    let mut handled = 0;
    for uid in uids.into_iter().take(BATCH) {
        let size = client.uid_fetch_size(uid).await?.unwrap_or(0);
        if size > MAX_MESSAGE {
            let header = client.uid_fetch_header(uid).await?;
            super::inbound::record_too_large(state, &header, size).await?;
        } else {
            let raw = client.uid_fetch_message(uid).await?;
            if let Err(e) = super::inbound::process(state, &settings, &raw).await {
                tracing::warn!(uid, error = %format!("{e:#}"), "an inbound ticket e-mail could not be processed");
                super::inbound::record_failure(state, &raw, &format!("{e:#}")).await;
            }
        }
        client.uid_move(uid, &inbound.processed_folder).await?;
        handled += 1;
    }
    client.logout().await;
    Ok(handled)
}

/// Polls every 60 s (and right after the settings change).
pub fn spawn_poller(state: AppState) {
    tokio::spawn(async move {
        loop {
            let enabled = email::load(&state)
                .await
                .map(|s| s.inbound.enabled)
                .unwrap_or(false);
            if enabled {
                let outcome = poll_once(&state).await;
                if let Ok(mut status) = state.helpdesk.poll_status.lock() {
                    status.last_poll_at = Some(rustrmm_common::now());
                    match &outcome {
                        Ok(n) => {
                            status.last_error = None;
                            status.last_processed = *n;
                        }
                        Err(e) => status.last_error = Some(format!("{e:#}")),
                    }
                }
                if let Err(e) = outcome {
                    tracing::warn!(error = %format!("{e:#}"), "IMAP poll failed");
                }
            }
            tokio::select! {
                _ = tokio::time::sleep(POLL_EVERY) => {}
                _ = state.helpdesk.imap_wake.notified() => {}
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn literals_and_quoting() {
        assert_eq!(literal_len("* 1 FETCH (UID 5 BODY[] {123}"), Some(123));
        assert_eq!(literal_len("A1 LOGIN {5+}"), Some(5));
        assert_eq!(literal_len("* OK done"), None);
        assert_eq!(quoted("in\"box\\x").as_deref(), Some("\"in\\\"box\\\\x\""));
        assert_eq!(quoted("pässword"), None);
        assert_eq!(quoted("a\r\nb"), None);
    }

    /// A scripted server over an in-memory pipe: capabilities, AUTHENTICATE PLAIN, a literal
    /// FETCH and the COPY/STORE/EXPUNGE fallback without MOVE.
    #[tokio::test]
    async fn client_speaks_imap_over_a_scripted_server() {
        let (client_end, server_end) = tokio::io::duplex(64 * 1024);
        let server = tokio::spawn(async move {
            let (read, mut write) = tokio::io::split(server_end);
            let mut lines = BufReader::new(read).lines();
            write
                .write_all(b"* OK IMAP4rev1 ready\r\n")
                .await
                .expect("greet");
            let mut seen = Vec::new();
            while let Some(line) = lines.next_line().await.expect("line") {
                seen.push(line.clone());
                let (tag, cmd) = line.split_once(' ').unwrap_or((&line, ""));
                let reply = if cmd == "CAPABILITY" {
                    format!("* CAPABILITY IMAP4rev1 AUTH=PLAIN UIDPLUS\r\n{tag} OK done\r\n")
                } else if cmd == "AUTHENTICATE PLAIN" {
                    write.write_all(b"+ \r\n").await.expect("cont");
                    let token = lines.next_line().await.expect("token").expect("token");
                    let decoded = STANDARD.decode(token).expect("b64");
                    assert_eq!(decoded, b"\0ops\0p\xc3\xa4ss");
                    format!("{tag} OK authenticated\r\n")
                } else if cmd.starts_with("SELECT") {
                    format!("* 2 EXISTS\r\n* OK [UIDVALIDITY 9]\r\n{tag} OK [READ-WRITE] done\r\n")
                } else if cmd == "UID SEARCH ALL" {
                    format!("* SEARCH 7 3\r\n{tag} OK done\r\n")
                } else if cmd.contains("RFC822.SIZE") {
                    format!("* 1 FETCH (UID 3 RFC822.SIZE 42)\r\n{tag} OK done\r\n")
                } else if cmd.contains("BODY.PEEK[]") {
                    let body = "Subject: hi\r\n\r\nline {5}\r\nend";
                    format!(
                        "* 1 FETCH (UID 3 BODY[] {{{}}}\r\n{body})\r\n{tag} OK done\r\n",
                        body.len()
                    )
                } else if cmd == "LOGOUT" {
                    write
                        .write_all(format!("* BYE\r\n{tag} OK bye\r\n").as_bytes())
                        .await
                        .expect("bye");
                    break;
                } else {
                    format!("{tag} OK done\r\n")
                };
                write.write_all(reply.as_bytes()).await.expect("reply");
            }
            seen
        });
        let mut client = Client::from_stream(Box::new(client_end), true);
        client.greeting().await.expect("greeting");
        client.refresh_capabilities().await.expect("caps");
        assert!(client.has("AUTH=PLAIN") && !client.has("MOVE"));
        client
            .login("ops", "päss", "mail.example.com")
            .await
            .expect("login");
        assert_eq!(client.select("INBOX").await.expect("select"), 2);
        assert_eq!(client.uid_search_all().await.expect("search"), vec![3, 7]);
        assert_eq!(client.uid_fetch_size(3).await.expect("size"), Some(42));
        let raw = client.uid_fetch_message(3).await.expect("body");
        assert_eq!(raw, b"Subject: hi\r\n\r\nline {5}\r\nend");
        client.uid_move(3, "Processed").await.expect("move");
        client.logout().await;
        let seen = server.await.expect("server");
        assert!(
            seen.iter().any(|l| l.ends_with("UID COPY 3 \"Processed\"")),
            "{seen:?}"
        );
        assert!(
            seen.iter()
                .any(|l| l.contains("UID STORE 3 +FLAGS.SILENT (\\Deleted)"))
        );
        assert!(seen.iter().any(|l| l.ends_with("UID EXPUNGE 3")));

        // Plain text to a remote host never carries the password.
        let (a, _b) = tokio::io::duplex(1024);
        let mut plain = Client::from_stream(Box::new(a), false);
        let refused = plain
            .login("u", "p", "mail.example.com")
            .await
            .expect_err("no TLS");
        assert!(refused.to_string().contains("without TLS"));
    }
}
