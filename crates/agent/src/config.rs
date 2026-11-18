//! Persistent agent configuration written at enrollment.

use std::path::Path;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::paths::Paths;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    pub device_id: String,
    pub server_urls: Vec<String>,
    /// Server identity key — every handshake challenge must verify against it.
    pub identity_key: String,
    pub command_key: String,
    pub release_key: String,
    pub escrow_recipient: String,
    /// Internal CA certificate; when present it is the only trusted TLS root.
    #[serde(default)]
    pub ca_cert_pem: Option<String>,
    pub client_name: String,
    pub site_name: String,
    pub enrolled_at: chrono::DateTime<chrono::Utc>,
}

impl AgentConfig {
    pub fn load(paths: &Paths) -> Result<Option<Self>> {
        let file = paths.config_file();
        if !file.exists() {
            return Ok(None);
        }
        let text = std::fs::read_to_string(&file)
            .with_context(|| format!("reading {}", file.display()))?;
        Ok(Some(
            serde_json::from_str(&text).context("agent configuration is corrupt")?,
        ))
    }

    pub fn save(&self, paths: &Paths) -> Result<()> {
        let json = serde_json::to_vec_pretty(self)?;
        write_private(&paths.config_file(), &json)
    }
}

/// Machine-local capability lock the server cannot override (set at install time).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LocalPolicy {
    #[serde(default)]
    pub disabled_features: Vec<String>,
}

impl LocalPolicy {
    pub fn load(paths: &Paths) -> Self {
        std::fs::read_to_string(paths.policy_file())
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, paths: &Paths) -> Result<()> {
        write_private(&paths.policy_file(), &serde_json::to_vec_pretty(self)?)
    }

    pub fn allows(&self, feature: &str) -> bool {
        !self
            .disabled_features
            .iter()
            .any(|f| f.eq_ignore_ascii_case(feature))
    }
}

/// Writes a file atomically, readable only by its owner on Unix.
pub fn write_private(path: &Path, contents: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    rustrmm_crypto::keyfile::write_private(path, contents)
        .with_context(|| format!("writing {}", path.display()))
}
