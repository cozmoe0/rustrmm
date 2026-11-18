//! Deploy keys and the enrollment exchange.
//!
//! A deploy key is one copy-paste string — `rrmm1_<base64url(JSON)>` — that carries everything an
//! installer needs: the gateway URL(s), the enrollment secret, the server identity public key
//! (always pinned) and, in internal-CA mode, the SPKI pin of the CA.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rustrmm_crypto::sign::PublicKey;
use serde::{Deserialize, Serialize};

use crate::{ProtoError, Result};

pub const DEPLOY_KEY_PREFIX: &str = "rrmm1_";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DeployKey {
    /// Format version.
    pub v: u8,
    /// Agent gateway base URLs (`https://host:port`), tried in order.
    pub urls: Vec<String>,
    /// Enrollment secret (base64url, 128 bits).
    pub secret: String,
    /// Server identity public key (`ed25519:…`).
    pub identity: String,
    /// base64 SHA-256 of the internal CA's SubjectPublicKeyInfo, when the server uses its own CA.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ca_pin: Option<String>,
    /// Display label (client / site) shown by installers.
    #[serde(default)]
    pub label: String,
}

impl DeployKey {
    pub fn encode(&self) -> String {
        let json = serde_json::to_vec(self).expect("deploy key serializes");
        format!("{DEPLOY_KEY_PREFIX}{}", URL_SAFE_NO_PAD.encode(json))
    }

    pub fn parse(text: &str) -> Result<Self> {
        let text = text.trim();
        let body = text
            .strip_prefix(DEPLOY_KEY_PREFIX)
            .ok_or_else(|| ProtoError::DeployKey("expected the key to start with rrmm1_".into()))?;
        let json = URL_SAFE_NO_PAD
            .decode(body.trim())
            .map_err(|e| ProtoError::DeployKey(format!("not valid base64url: {e}")))?;
        let key: Self = serde_json::from_slice(&json)
            .map_err(|e| ProtoError::DeployKey(format!("malformed: {e}")))?;
        if key.v != 1 {
            return Err(ProtoError::DeployKey(format!(
                "unsupported version {}",
                key.v
            )));
        }
        if key.urls.is_empty() {
            return Err(ProtoError::DeployKey("no gateway URL".into()));
        }
        for u in &key.urls {
            let parsed = url::Url::parse(u)
                .map_err(|e| ProtoError::DeployKey(format!("bad URL {u}: {e}")))?;
            if parsed.scheme() != "https" {
                return Err(ProtoError::DeployKey("gateway URLs must use https".into()));
            }
        }
        PublicKey::parse(&key.identity)
            .map_err(|e| ProtoError::DeployKey(format!("bad identity key: {e}")))?;
        if key.secret.len() < 16 {
            return Err(ProtoError::DeployKey("secret too short".into()));
        }
        Ok(key)
    }

    pub fn identity_key(&self) -> Result<PublicKey> {
        PublicKey::parse(&self.identity).map_err(|e| ProtoError::DeployKey(e.to_string()))
    }
}

/// `POST /agent/v1/enroll` request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnrollRequest {
    pub secret: String,
    pub public_key: String,
    pub hostname: String,
    pub os_family: String,
    #[serde(default)]
    pub os_name: String,
    #[serde(default)]
    pub os_version: String,
    #[serde(default)]
    pub arch: String,
    #[serde(default)]
    pub hardware_uuid: Option<String>,
    #[serde(default)]
    pub serial: Option<String>,
    #[serde(default)]
    pub domain: Option<String>,
    pub agent_version: String,
}

/// `POST /agent/v1/enroll` response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnrollResponse {
    pub device_id: String,
    /// `active` or `pending` (waiting for an administrator).
    pub status: String,
    pub identity: String,
    pub command_key: String,
    pub release_key: String,
    pub escrow_recipient: String,
    /// PEM of the internal CA (internal TLS mode) — trusted for all later connections.
    #[serde(default)]
    pub ca_cert_pem: Option<String>,
    pub client_name: String,
    pub site_name: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use rustrmm_crypto::sign::SigningKey;

    fn sample() -> DeployKey {
        DeployKey {
            v: 1,
            urls: vec!["https://rmm.example.test:8444".into()],
            secret: "c2VjcmV0LXNlY3JldC1zZWNyZXQ".into(),
            identity: SigningKey::generate().public_key().to_string(),
            ca_pin: Some("5OubjbfCyuLeyNRm3dIrXj30I0t6AqIeNKzk9lTKEhM=".into()),
            label: "Acme / HQ".into(),
        }
    }

    #[test]
    fn roundtrip() {
        let key = sample();
        let text = key.encode();
        assert!(text.starts_with("rrmm1_"));
        assert!(!text.contains('='), "url-safe, unpadded");
        assert_eq!(
            DeployKey::parse(&format!("  {text}\n")).expect("parse"),
            key
        );
    }

    #[test]
    fn rejects_bad_keys() {
        assert!(DeployKey::parse("rrmm2_abc").is_err());
        assert!(DeployKey::parse("rrmm1_!!!").is_err());
        let mut key = sample();
        key.urls = vec!["http://insecure.example".into()];
        assert!(DeployKey::parse(&key.encode()).is_err());
        let mut key = sample();
        key.identity = "ed25519:short".into();
        assert!(DeployKey::parse(&key.encode()).is_err());
    }
}
