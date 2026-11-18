//! Shared application state handed to every handler.

use std::ops::Deref;
use std::sync::Arc;
use std::time::Instant;

use rustrmm_crypto::field::FieldCipher;
use rustrmm_crypto::master::MasterKey;
use webauthn_rs::Webauthn;

use crate::agents::AgentRegistry;
use crate::agents::telemetry::Telemetry;
use crate::audit::AuditLog;
use crate::backup::BackupService;
use crate::config::{ServeArgs, TlsMode};
use crate::db::Db;
use crate::events::{EventBus, TicketStore};
use crate::keys::KeyRing;
use crate::ratelimit::RateLimiter;
use crate::setup::SetupGate;

/// Public TLS facts (no secrets).
#[derive(Debug, Clone)]
pub struct TlsInfo {
    pub mode: TlsMode,
    pub ca_cert_pem: Option<String>,
    pub ca_spki_pin: Option<String>,
    pub leaf_spki_pin: Option<String>,
}

pub struct Inner {
    pub args: ServeArgs,
    pub db: Db,
    pub master: Arc<MasterKey>,
    /// Encrypts sensitive database columns.
    pub cipher: FieldCipher,
    pub keys: KeyRing,
    pub tls: TlsInfo,
    pub audit: AuditLog,
    pub events: EventBus,
    pub tickets: TicketStore,
    pub webauthn: Webauthn,
    pub setup: SetupGate,
    pub limiter: RateLimiter,
    pub backups: BackupService,
    pub agents: AgentRegistry,
    /// Automation scheduler state (dispatch lock, wake-ups, event throttling).
    pub automation: crate::automation::Runtime,
    /// Monitoring state (pushed configurations, notification wake-ups, event throttling).
    pub monitoring: crate::monitoring::Runtime,
    /// Ticketing state (e-mail and IMAP wake-ups, poll status, event throttling).
    pub helpdesk: crate::tickets::Runtime,
    /// Network state (SNMP configuration versions pushed to probes).
    pub network: crate::network::Runtime,
    pub telemetry: Telemetry,
    pub started: Instant,
    /// Normalised browser origins allowed to make state-changing requests.
    pub allowed_origins: Vec<String>,
}

#[derive(Clone)]
pub struct AppState(Arc<Inner>);

impl AppState {
    pub fn new(inner: Inner) -> Self {
        Self(Arc::new(inner))
    }
}

impl Deref for AppState {
    type Target = Inner;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
