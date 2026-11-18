//! Tunnel broker. Interactive and bulk traffic (shells, file transfers) never shares the control
//! connection: the server sends a signed `OpenTunnel` command carrying a one-time token, the agent
//! dials `/agent/v1/tunnel/{id}`, and the broker hands that socket to whoever asked for it (the
//! browser's shell socket or a server-side file transfer).

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use axum::extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{Path as AxumPath, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use dashmap::DashMap;
use rustrmm_proto::commands::Command;
use rustrmm_proto::noise;
use rustrmm_proto::remote::{MAX_TUNNEL_FROM_AGENT, OpenTunnel, TUNNEL_TOKEN_HEADER, TunnelKind};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tokio::io::AsyncWriteExt;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use super::channel::AgentSocket;
use crate::state::AppState;

/// How long an agent has to dial back after `OpenTunnel`.
const DIAL_TIMEOUT: Duration = Duration::from_secs(30);
const TICKET_TTL: Duration = Duration::from_secs(30);
/// How long the agent has to complete the tunnel's Noise handshake after the upgrade.
const NOISE_TIMEOUT: Duration = Duration::from_secs(15);

struct PendingTunnel {
    device_id: String,
    token_hash: [u8; 32],
    created: Instant,
    tx: oneshot::Sender<AgentSocket>,
}

/// One-time ticket that lets a browser attach to a remote session's socket.
pub struct SessionTicket {
    pub remote_session_id: String,
    pub user_id: String,
    pub web_session_id: String,
    expires: Instant,
}

#[derive(Default)]
pub struct TunnelHub {
    pending: DashMap<String, PendingTunnel>,
    tickets: DashMap<String, SessionTicket>,
    /// Live remote sessions → cancellation (end on demand, on logout, on revocation).
    live: DashMap<String, (String, CancellationToken)>,
}

fn hash(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}

impl TunnelHub {
    fn create(&self, device_id: &str) -> (String, String, oneshot::Receiver<AgentSocket>) {
        self.pending
            .retain(|_, p| p.created.elapsed() < DIAL_TIMEOUT * 2);
        let id = rustrmm_common::new_id();
        let token = rustrmm_crypto::random::token();
        let (tx, rx) = oneshot::channel();
        self.pending.insert(
            id.clone(),
            PendingTunnel {
                device_id: device_id.to_string(),
                token_hash: hash(&token),
                created: Instant::now(),
                tx,
            },
        );
        (id, token, rx)
    }

    /// Claims a pending tunnel when the token matches (single use).
    fn claim(&self, id: &str, token: &str) -> Option<(String, oneshot::Sender<AgentSocket>)> {
        let presented = hash(token);
        let (_, pending) = self
            .pending
            .remove_if(id, |_, p| bool::from(p.token_hash.ct_eq(&presented)))?;
        (pending.created.elapsed() < DIAL_TIMEOUT).then_some((pending.device_id, pending.tx))
    }

    pub fn issue_ticket(
        &self,
        remote_session_id: &str,
        user_id: &str,
        web_session_id: &str,
    ) -> String {
        self.tickets.retain(|_, t| t.expires > Instant::now());
        let ticket = rustrmm_crypto::random::token();
        self.tickets.insert(
            ticket.clone(),
            SessionTicket {
                remote_session_id: remote_session_id.to_string(),
                user_id: user_id.to_string(),
                web_session_id: web_session_id.to_string(),
                expires: Instant::now() + TICKET_TTL,
            },
        );
        ticket
    }

    pub fn redeem_ticket(&self, ticket: &str) -> Option<SessionTicket> {
        let (_, t) = self.tickets.remove(ticket)?;
        (t.expires > Instant::now()).then_some(t)
    }

    pub fn register_live(&self, remote_session_id: &str, device_id: &str) -> CancellationToken {
        let token = CancellationToken::new();
        self.live.insert(
            remote_session_id.to_string(),
            (device_id.to_string(), token.clone()),
        );
        token
    }

    pub fn unregister_live(&self, remote_session_id: &str) {
        self.live.remove(remote_session_id);
    }

    /// Ends a live session; false when it is not running.
    pub fn end(&self, remote_session_id: &str) -> bool {
        match self.live.get(remote_session_id) {
            Some(entry) => {
                entry.1.cancel();
                true
            }
            None => false,
        }
    }

    /// Ends every live session on a device (revocation, deletion).
    pub fn end_device(&self, device_id: &str) {
        for entry in self.live.iter() {
            if entry.0 == device_id {
                entry.1.cancel();
            }
        }
    }

    pub fn is_live(&self, remote_session_id: &str) -> bool {
        self.live.contains_key(remote_session_id)
    }

    pub fn live_count(&self) -> usize {
        self.live.len()
    }
}

/// `GET /agent/v1/tunnel/{id}` (WebSocket upgrade, agent listener).
pub async fn agent_tunnel(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let Some(token) = headers
        .get(TUNNEL_TOKEN_HEADER)
        .and_then(|v| v.to_str().ok())
    else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let Some((device_id, tx)) = state.agents.tunnels.claim(&id, token) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let Some(handle) = state.agents.get(&device_id) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    // A tunnel uses the end-to-end channel whenever its control connection does.
    let expected = handle.noise_static;
    ws.max_message_size(noise::sealed_len(MAX_TUNNEL_FROM_AGENT))
        .on_upgrade(move |socket| async move {
            let socket = match expected {
                None => AgentSocket::new(socket, None),
                Some(expected) => match noise_handshake(&state, socket, &id, &expected).await {
                    Ok(socket) => socket,
                    Err(e) => {
                        tracing::warn!(device = %device_id, tunnel = %id, error = %format!("{e:#}"), "tunnel Noise handshake failed");
                        return;
                    }
                },
            };
            // The receiver owns the socket from here; dropping it closes the connection.
            let _ = tx.send(socket);
        })
}

/// Responder side of a tunnel's Noise IK handshake: the agent must present the static key of its
/// live control connection.
async fn noise_handshake(
    state: &AppState,
    mut socket: WebSocket,
    tunnel_id: &str,
    expected: &[u8; 32],
) -> Result<AgentSocket> {
    let first = loop {
        match tokio::time::timeout(NOISE_TIMEOUT, socket.recv())
            .await
            .context("timed out")?
        {
            Some(Ok(WsMessage::Binary(bytes))) => break bytes,
            Some(Ok(WsMessage::Ping(_) | WsMessage::Pong(_))) => continue,
            Some(Ok(_)) | None => anyhow::bail!("expected the Noise handshake"),
            Some(Err(e)) => return Err(e.into()),
        }
    };
    let accepted = noise::respond(
        &state.keys.noise,
        &noise::tunnel_prologue(tunnel_id),
        &first,
    )?;
    if !rustrmm_crypto::random::ct_eq(&accepted.remote_static, expected) {
        let _ = socket.send(WsMessage::Close(None)).await;
        anyhow::bail!("the tunnel's Noise key differs from the control connection's");
    }
    socket
        .send(WsMessage::Binary(accepted.reply.into()))
        .await?;
    Ok(AgentSocket::new(socket, Some(accepted.codec)))
}

/// Asks the agent to open a tunnel and waits for its socket.
pub async fn open(
    state: &AppState,
    device_id: &str,
    kind: TunnelKind,
    user_id: &str,
    summary: &str,
) -> Result<AgentSocket, String> {
    let (tunnel_id, token, mut rx) = state.agents.tunnels.create(device_id);
    let command = Command::OpenTunnel(OpenTunnel {
        tunnel_id: tunnel_id.clone(),
        token,
        kind,
    });
    let request = super::commands::request(
        state,
        device_id,
        command,
        Some(user_id),
        summary,
        true,
        DIAL_TIMEOUT,
    );
    tokio::pin!(request);
    let deadline = tokio::time::sleep(DIAL_TIMEOUT + Duration::from_secs(5));
    tokio::pin!(deadline);
    let mut request_done = false;
    let outcome = loop {
        tokio::select! {
            socket = &mut rx => break socket.map_err(|_| "the tunnel was abandoned".to_string()),
            result = &mut request, if !request_done => {
                request_done = true;
                if let Err(e) = result {
                    break Err(e.to_string());
                }
            }
            _ = &mut deadline => break Err("the device did not open the tunnel in time".to_string()),
        }
    };
    state.agents.tunnels.pending.remove(&tunnel_id);
    outcome
}

/// asciicast v2 writer for shell recordings (output and resize events).
pub struct Recorder {
    file: tokio::io::BufWriter<tokio::fs::File>,
    started: Instant,
    carry: Vec<u8>,
    pub relative: String,
    pub path: PathBuf,
    bytes: u64,
}

impl Recorder {
    pub async fn create(
        data_dir: &Path,
        session_id: &str,
        cols: u16,
        rows: u16,
        title: &str,
    ) -> Result<Self> {
        let now = chrono::Utc::now();
        let relative = format!("{}/{session_id}.cast", now.format("%Y/%m"));
        let path = data_dir.join("recordings").join(&relative);
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let file = tokio::fs::File::create(&path)
            .await
            .with_context(|| format!("creating {}", path.display()))?;
        let mut recorder = Self {
            file: tokio::io::BufWriter::new(file),
            started: Instant::now(),
            carry: Vec::new(),
            relative,
            path,
            bytes: 0,
        };
        let header = serde_json::json!({
            "version": 2,
            "width": cols,
            "height": rows,
            "timestamp": now.timestamp(),
            "title": title,
            "env": { "TERM": "xterm-256color" },
        });
        recorder.line(&header.to_string()).await?;
        Ok(recorder)
    }

    async fn line(&mut self, text: &str) -> Result<()> {
        self.file.write_all(text.as_bytes()).await?;
        self.file.write_all(b"\n").await?;
        self.bytes += text.len() as u64 + 1;
        Ok(())
    }

    fn elapsed(&self) -> f64 {
        (self.started.elapsed().as_secs_f64() * 1000.0).round() / 1000.0
    }

    /// Records terminal output, keeping incomplete UTF-8 sequences for the next chunk.
    pub async fn output(&mut self, bytes: &[u8]) -> Result<()> {
        self.carry.extend_from_slice(bytes);
        let valid = match std::str::from_utf8(&self.carry) {
            Ok(_) => self.carry.len(),
            Err(e) if e.error_len().is_none() => e.valid_up_to(),
            Err(_) => self.carry.len(),
        };
        let chunk: Vec<u8> = self.carry.drain(..valid).collect();
        if chunk.is_empty() {
            return Ok(());
        }
        let text = String::from_utf8_lossy(&chunk);
        let event = serde_json::json!([self.elapsed(), "o", text]);
        self.line(&event.to_string()).await
    }

    pub async fn resize(&mut self, cols: u16, rows: u16) -> Result<()> {
        let event = serde_json::json!([self.elapsed(), "r", format!("{cols}x{rows}")]);
        self.line(&event.to_string()).await
    }

    /// Flushes and returns the recording size in bytes.
    pub async fn finish(mut self) -> u64 {
        if !self.carry.is_empty() {
            let rest = std::mem::take(&mut self.carry);
            let text = String::from_utf8_lossy(&rest).to_string();
            let event = serde_json::json!([self.elapsed(), "o", text]);
            let _ = self.line(&event.to_string()).await;
        }
        let _ = self.file.flush().await;
        self.bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tunnel_tokens_are_single_use_and_checked() {
        let hub = TunnelHub::default();
        let (id, token, _rx) = hub.create("dev-1");
        assert!(hub.claim(&id, "wrong").is_none());
        let (device, _tx) = hub.claim(&id, &token).expect("claim");
        assert_eq!(device, "dev-1");
        assert!(hub.claim(&id, &token).is_none(), "second use refused");
    }

    #[test]
    fn tickets_are_single_use() {
        let hub = TunnelHub::default();
        let t = hub.issue_ticket("rs-1", "u-1", "s-1");
        assert_eq!(
            hub.redeem_ticket(&t).expect("ticket").remote_session_id,
            "rs-1"
        );
        assert!(hub.redeem_ticket(&t).is_none());
    }

    #[tokio::test]
    async fn recorder_keeps_split_utf8_together() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut rec = Recorder::create(dir.path(), "s", 80, 24, "t")
            .await
            .expect("create");
        let euro = "€".as_bytes(); // 3 bytes
        rec.output(&euro[..1]).await.expect("out");
        rec.output(&euro[1..]).await.expect("out");
        rec.resize(100, 30).await.expect("resize");
        let path = rec.path.clone();
        rec.finish().await;
        let text = std::fs::read_to_string(path).expect("read");
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 3, "header, one output event, one resize");
        assert!(lines[1].contains('€'));
        assert!(lines[2].contains("100x30"));
    }
}
