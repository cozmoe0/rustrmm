//! Live event bus feeding the console's `/api/v1/stream` WebSocket.
//!
//! Browsers obtain a one-time ticket (30 s, bound to their session) with a normal authenticated
//! POST, then open the socket with `?ticket=`; the upgrade also checks `Origin`. Events carry an
//! optional client id and are filtered by the subscriber's access scope.

use std::collections::HashSet;
use std::time::{Duration, Instant};

use axum::Json;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::response::Response;
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::broadcast;

use crate::auth::AuthCtx;
use crate::error::{ApiError, ApiResult};
use crate::rbac::{AccessScope, perm};
use crate::state::AppState;

#[derive(Debug, Clone)]
pub struct Event {
    pub topic: String,
    pub client_id: Option<String>,
    pub data: Value,
}

pub struct EventBus {
    tx: broadcast::Sender<Event>,
    /// Lossless feed of webhook-relevant topics to the webhook dispatcher (set when it starts).
    webhooks: std::sync::OnceLock<tokio::sync::mpsc::UnboundedSender<Event>>,
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new()
    }
}

impl EventBus {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(1024);
        Self {
            tx,
            webhooks: std::sync::OnceLock::new(),
        }
    }

    pub fn publish(&self, topic: impl Into<String>, client_id: Option<String>, data: Value) {
        let event = Event {
            topic: topic.into(),
            client_id,
            data,
        };
        if crate::webhooks::EVENTS.contains(&event.topic.as_str())
            && let Some(sink) = self.webhooks.get()
        {
            let _ = sink.send(event.clone());
        }
        // No receivers is fine.
        let _ = self.tx.send(event);
    }

    /// Connects the webhook dispatcher (once); returns false when one is already attached.
    pub fn attach_webhooks(&self, sink: tokio::sync::mpsc::UnboundedSender<Event>) -> bool {
        self.webhooks.set(sink).is_ok()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.tx.subscribe()
    }
}

/// A short-lived, single-use WebSocket ticket.
pub struct StreamTicket {
    pub user_id: String,
    pub session_id: String,
    pub expires: Instant,
}

#[derive(Default)]
pub struct TicketStore {
    tickets: DashMap<String, StreamTicket>,
}

impl TicketStore {
    pub fn issue(&self, user_id: &str, session_id: &str) -> String {
        self.tickets.retain(|_, t| t.expires > Instant::now());
        let ticket = rustrmm_crypto::random::token();
        self.tickets.insert(
            ticket.clone(),
            StreamTicket {
                user_id: user_id.to_string(),
                session_id: session_id.to_string(),
                expires: Instant::now() + Duration::from_secs(30),
            },
        );
        ticket
    }

    pub fn redeem(&self, ticket: &str) -> Option<StreamTicket> {
        let (_, t) = self.tickets.remove(ticket)?;
        (t.expires > Instant::now()).then_some(t)
    }
}

#[derive(Serialize)]
pub struct TicketResponse {
    ticket: String,
    expires_at: chrono::DateTime<chrono::Utc>,
}

/// `POST /api/v1/stream/ticket`
pub async fn issue_ticket(
    State(state): State<AppState>,
    ctx: AuthCtx,
) -> ApiResult<Json<TicketResponse>> {
    let ticket = state.tickets.issue(&ctx.user.id, &ctx.session.id);
    Ok(Json(TicketResponse {
        ticket,
        expires_at: rustrmm_common::now() + chrono::Duration::seconds(30),
    }))
}

#[derive(Deserialize)]
pub struct StreamQuery {
    ticket: String,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientMessage {
    Subscribe { topics: Vec<String> },
    Unsubscribe { topics: Vec<String> },
    Ping,
}

/// `GET /api/v1/stream?ticket=…` (WebSocket upgrade).
pub async fn stream(
    State(state): State<AppState>,
    Query(query): Query<StreamQuery>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> ApiResult<Response> {
    crate::auth::check_origin_headers(&state, &headers, true)?;
    let ticket = state
        .tickets
        .redeem(&query.ticket)
        .ok_or_else(ApiError::unauthenticated)?;
    // The session must still be valid at upgrade time.
    let valid: Option<String> = sqlx::query_scalar(
        "SELECT id FROM sessions WHERE id = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > ?",
    )
    .bind(&ticket.session_id)
    .bind(&ticket.user_id)
    .bind(rustrmm_common::now())
    .fetch_optional(&state.db)
    .await?;
    if valid.is_none() {
        return Err(ApiError::unauthenticated());
    }
    let scope = AccessScope::load(&state.db, &ticket.user_id).await?;
    Ok(ws.on_upgrade(move |socket| run_stream(state, socket, scope, ticket.session_id)))
}

async fn run_stream(
    state: AppState,
    mut socket: WebSocket,
    scope: AccessScope,
    session_id: String,
) {
    let mut rx = state.events.subscribe();
    let mut topics: HashSet<String> = HashSet::new();
    let mut session_check = tokio::time::interval(Duration::from_secs(30));
    session_check.tick().await;
    let _ = socket
        .send(Message::Text(
            json!({ "type": "hello", "server_time": rustrmm_common::now() })
                .to_string()
                .into(),
        ))
        .await;
    loop {
        tokio::select! {
            incoming = socket.recv() => {
                let Some(Ok(msg)) = incoming else { break };
                match msg {
                    Message::Text(text) => match serde_json::from_str::<ClientMessage>(&text) {
                        Ok(ClientMessage::Subscribe { topics: t }) => topics.extend(t.into_iter().take(64)),
                        Ok(ClientMessage::Unsubscribe { topics: t }) => { for topic in t { topics.remove(&topic); } }
                        Ok(ClientMessage::Ping) => {
                            if socket.send(Message::Text(json!({"type":"pong"}).to_string().into())).await.is_err() { break; }
                        }
                        Err(_) => {}
                    },
                    Message::Close(_) => break,
                    _ => {}
                }
            }
            event = rx.recv() => {
                match event {
                    Ok(event) => {
                        if !topics.contains(&event.topic) && !topics.contains("*") { continue; }
                        if let Some(client_id) = &event.client_id
                            && !scope.can_see_client(perm::CLIENTS_VIEW, client_id) { continue; }
                        let payload = json!({ "type": "event", "topic": event.topic, "data": event.data });
                        if socket.send(Message::Text(payload.to_string().into())).await.is_err() { break; }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        let _ = socket.send(Message::Text(json!({"type":"resync"}).to_string().into())).await;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            _ = session_check.tick() => {
                let alive: Option<String> = sqlx::query_scalar(
                    "SELECT id FROM sessions WHERE id = ? AND revoked_at IS NULL AND expires_at > ?",
                )
                .bind(&session_id)
                .bind(rustrmm_common::now())
                .fetch_optional(&state.db)
                .await
                .ok()
                .flatten();
                if alive.is_none() { break; }
            }
        }
    }
    let _ = socket.send(Message::Close(None)).await;
}
