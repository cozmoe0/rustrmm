//! Agent gateway: enrollment, live connections, telemetry and inventory ingestion.

pub mod channel;
pub mod commands;
pub mod enroll;
pub mod gateway;
pub mod health;
pub mod installers;
pub mod inventory;
pub mod releases;
pub mod telemetry;
pub mod tunnels;

use std::sync::Arc;
use std::sync::atomic::AtomicU64;

use chrono::{DateTime, Utc};
use dashmap::DashMap;
use rustrmm_proto::commands::CommandResult;
use serde_json::Value;
use sqlx::FromRow;
use tokio::sync::{mpsc, oneshot};

use crate::db::Db;

/// Something to send down an agent's control connection.
#[derive(Debug)]
pub enum Outbound {
    Frame(Vec<u8>),
    Close(String),
}

/// A live control connection.
#[derive(Debug, Clone)]
pub struct AgentHandle {
    pub session_id: String,
    pub tx: mpsc::Sender<Outbound>,
    pub connected_at: DateTime<Utc>,
    pub ip: Option<String>,
    /// Server nonce of this connection's handshake; commands are bound to it.
    pub session_nonce: Vec<u8>,
    /// Last command sequence number used on this connection.
    pub seq: Arc<AtomicU64>,
    /// The agent's Noise static key when the connection uses the end-to-end channel; tunnel
    /// sockets must present the same key.
    pub noise_static: Option<[u8; 32]>,
}

/// Someone waiting for a command's final result.
pub struct Waiter {
    pub device_id: String,
    pub tx: oneshot::Sender<CommandResult>,
}

/// Device id → live connection, plus in-flight request/response commands and tunnels.
#[derive(Default)]
pub struct AgentRegistry {
    connections: DashMap<String, AgentHandle>,
    /// Command id → waiter for its final result.
    waiters: DashMap<String, Waiter>,
    pub tunnels: tunnels::TunnelHub,
}

impl AgentRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers a connection, returning the one it replaced (if any).
    pub fn insert(&self, device_id: &str, handle: AgentHandle) -> Option<AgentHandle> {
        self.connections.insert(device_id.to_string(), handle)
    }

    /// Removes the entry only if it still belongs to `session_id` (a newer connection may have
    /// replaced it). Returns true when removed.
    pub fn remove_if_session(&self, device_id: &str, session_id: &str) -> bool {
        self.connections
            .remove_if(device_id, |_, h| h.session_id == session_id)
            .is_some()
    }

    pub fn get(&self, device_id: &str) -> Option<AgentHandle> {
        self.connections.get(device_id).map(|h| h.clone())
    }

    pub fn is_online(&self, device_id: &str) -> bool {
        self.connections.contains_key(device_id)
    }

    pub fn count(&self) -> usize {
        self.connections.len()
    }

    /// Queues a frame for a device; false when it is not connected or its queue is full.
    pub fn send(&self, device_id: &str, frame: Vec<u8>) -> bool {
        match self.connections.get(device_id) {
            Some(h) => h.tx.try_send(Outbound::Frame(frame)).is_ok(),
            None => false,
        }
    }

    /// Registers interest in a command's final result (`succeeded`, `failed` or `rejected`).
    pub fn wait_for(&self, cmd_id: &str, device_id: &str) -> oneshot::Receiver<CommandResult> {
        let (tx, rx) = oneshot::channel();
        self.waiters.insert(
            cmd_id.to_string(),
            Waiter {
                device_id: device_id.to_string(),
                tx,
            },
        );
        rx
    }

    pub fn forget_waiter(&self, cmd_id: &str) {
        self.waiters.remove(cmd_id);
    }

    /// Hands a final result to its waiter (only when it came from the device it was sent to).
    pub fn resolve(&self, device_id: &str, result: &CommandResult) {
        if !matches!(result.status.as_str(), "succeeded" | "failed" | "rejected") {
            return;
        }
        if let Some((_, waiter)) = self
            .waiters
            .remove_if(&result.cmd_id, |_, w| w.device_id == device_id)
        {
            let _ = waiter.tx.send(result.clone());
        }
    }

    pub fn disconnect(&self, device_id: &str, reason: &str) {
        if let Some((_, handle)) = self.connections.remove(device_id) {
            let _ = handle.tx.try_send(Outbound::Close(reason.to_string()));
        }
    }
}

/// Columns every device view needs.
#[derive(Debug, Clone, FromRow)]
pub struct DeviceRecord {
    pub id: String,
    pub site_id: String,
    pub client_id: String,
    pub status: String,
    pub hostname: String,
    pub public_key: String,
    pub agent_version: String,
    pub online: bool,
    pub last_seen_at: Option<DateTime<Utc>>,
    pub noise_public_key: Option<String>,
}

pub async fn load_device(db: &Db, id: &str) -> anyhow::Result<Option<DeviceRecord>> {
    Ok(sqlx::query_as(
        "SELECT d.id, d.site_id, s.client_id, d.status, d.hostname, d.public_key, d.agent_version, d.online, d.last_seen_at, d.noise_public_key
         FROM devices d JOIN sites s ON s.id = d.site_id WHERE d.id = ?",
    )
    .bind(id)
    .fetch_optional(db)
    .await?)
}

/// Appends a device timeline entry.
pub async fn timeline(
    db: &Db,
    device_id: &str,
    kind: &str,
    severity: &str,
    summary: &str,
    details: Value,
) -> anyhow::Result<()> {
    sqlx::query("INSERT INTO device_timeline (device_id, at, kind, severity, summary, details) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(device_id)
        .bind(rustrmm_common::now())
        .bind(kind)
        .bind(severity)
        .bind(summary)
        .bind(serde_json::to_string(&details)?)
        .execute(db)
        .await?;
    Ok(())
}
