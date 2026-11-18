//! Message bodies exchanged after the handshake.

use serde::{Deserialize, Serialize};

use crate::Message;

macro_rules! message {
    ($ty:ty, $tag:literal) => {
        impl Message for $ty {
            const TYPE: &'static str = $tag;
        }
    };
}

/// Agent → server, every heartbeat interval.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Heartbeat {
    pub uptime_s: u64,
    pub cpu_pct: f32,
    pub mem_pct: f32,
    /// Highest usage among fixed volumes.
    pub disk_pct: f32,
    #[serde(default)]
    pub logged_in_user: Option<String>,
}
message!(Heartbeat, "heartbeat");

/// One metrics sample.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MetricSample {
    /// Unix seconds.
    pub ts: i64,
    pub cpu: f32,
    pub mem: f32,
    pub disk: f32,
    #[serde(default)]
    pub net_rx_bps: f64,
    #[serde(default)]
    pub net_tx_bps: f64,
    #[serde(default)]
    pub disk_read_bps: f64,
    #[serde(default)]
    pub disk_write_bps: f64,
    #[serde(default)]
    pub process_count: u32,
}

/// Agent → server, batched samples.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Metrics {
    pub samples: Vec<MetricSample>,
    /// True while live mode is active (high-frequency samples, not persisted at full rate).
    #[serde(default)]
    pub live: bool,
}
message!(Metrics, "metrics");

/// Agent → server, one inventory section whose hash changed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InventorySection {
    pub section: String,
    pub hash: String,
    pub data: serde_json::Value,
}
message!(InventorySection, "inventory");

/// Server → agent, acknowledges a stored inventory section.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InventoryAck {
    pub section: String,
    pub hash: String,
}
message!(InventoryAck, "inventory_ack");

/// Server → agent, asks for fresh inventory (empty = all sections).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RequestInventory {
    #[serde(default)]
    pub sections: Vec<String>,
}
message!(RequestInventory, "request_inventory");

/// Server → agent, stream high-frequency metrics while someone watches the device.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LiveMode {
    pub interval_secs: u32,
    pub duration_secs: u32,
}
message!(LiveMode, "live_mode");

/// Server → agent, runtime settings (also part of the welcome message).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentSettings {
    pub heartbeat_secs: u32,
    pub metrics_secs: u32,
    pub inventory_minutes: u32,
}

impl Default for AgentSettings {
    fn default() -> Self {
        Self {
            heartbeat_secs: 30,
            metrics_secs: 60,
            inventory_minutes: 240,
        }
    }
}
message!(AgentSettings, "settings");

/// Agent → server, structured log line worth surfacing (errors, warnings).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentLog {
    pub level: String,
    pub message: String,
    #[serde(default)]
    pub ts: i64,
}
message!(AgentLog, "log");

/// Either side, orderly close with a reason.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bye {
    pub reason: String,
}
message!(Bye, "bye");

/// Inventory section names.
pub mod sections {
    pub const SYSTEM: &str = "system";
    pub const HARDWARE: &str = "hardware";
    pub const STORAGE: &str = "storage";
    pub const NETWORK: &str = "network";
    pub const SOFTWARE: &str = "software";
    pub const SECURITY: &str = "security";
    pub const USERS: &str = "users";
    pub const SERVICES: &str = "services";
    pub const UPDATES: &str = "updates";

    pub const ALL: &[&str] = &[
        SYSTEM, HARDWARE, STORAGE, NETWORK, SOFTWARE, SECURITY, USERS, SERVICES, UPDATES,
    ];
}
