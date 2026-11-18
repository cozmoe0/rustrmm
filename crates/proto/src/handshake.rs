//! Mutual authentication on every agent connection.
//!
//! 1. Agent → `Hello { device_id, agent_nonce, protocol, … }`
//! 2. Server → `Challenge { server_nonce, server_time, signature }` — signed by the server
//!    identity key over [`challenge_message`]; the agent verifies it against the key pinned at
//!    enrollment, so a TLS-intercepting proxy cannot impersonate the server.
//! 3. Agent → `Proof { signature }` — signed by the device key over [`proof_message`].
//! 4. Server → `Welcome` or `Rejected`.

use serde::{Deserialize, Serialize};

use crate::Message;
use crate::messages::AgentSettings;

const CHALLENGE_CONTEXT: &[u8] = b"rustrmm/v1/handshake/challenge";
const PROOF_CONTEXT: &[u8] = b"rustrmm/v1/handshake/proof";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Hello {
    pub device_id: String,
    #[serde(with = "serde_bytes")]
    pub agent_nonce: Vec<u8>,
    pub protocol_major: u16,
    pub protocol_minor: u16,
    pub agent_version: String,
    pub os_family: String,
    pub hostname: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
}

impl Message for Hello {
    const TYPE: &'static str = "hello";
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Challenge {
    #[serde(with = "serde_bytes")]
    pub server_nonce: Vec<u8>,
    /// Server clock, unix milliseconds (agents use it to correct their own clock skew).
    pub server_time: i64,
    #[serde(with = "serde_bytes")]
    pub signature: Vec<u8>,
    /// The server's Noise static key, offered only to agents that advertise the `noise`
    /// capability (`crate::noise`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub noise: Option<crate::noise::NoiseOffer>,
}

impl Message for Challenge {
    const TYPE: &'static str = "challenge";
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Proof {
    #[serde(with = "serde_bytes")]
    pub signature: Vec<u8>,
}

impl Message for Proof {
    const TYPE: &'static str = "proof";
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Welcome {
    pub session_id: String,
    pub server_time: i64,
    pub settings: AgentSettings,
    /// Inventory section hashes the server already holds (agent skips unchanged sections).
    #[serde(default)]
    pub inventory_hashes: std::collections::BTreeMap<String, String>,
}

impl Message for Welcome {
    const TYPE: &'static str = "welcome";
}

/// Why a connection was refused.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rejected {
    /// `pending_approval`, `revoked`, `unknown_device`, `bad_signature`, `protocol_unsupported`.
    pub code: String,
    pub message: String,
    /// Suggested delay before reconnecting.
    #[serde(default)]
    pub retry_after_secs: u32,
}

impl Message for Rejected {
    const TYPE: &'static str = "rejected";
}

/// Bytes the server signs for the challenge.
pub fn challenge_message(
    agent_nonce: &[u8],
    server_nonce: &[u8],
    device_id: &str,
    server_time: i64,
) -> Vec<u8> {
    let mut m = Vec::with_capacity(CHALLENGE_CONTEXT.len() + 64 + device_id.len() + 8);
    m.extend_from_slice(CHALLENGE_CONTEXT);
    m.extend_from_slice(&(agent_nonce.len() as u32).to_be_bytes());
    m.extend_from_slice(agent_nonce);
    m.extend_from_slice(&(server_nonce.len() as u32).to_be_bytes());
    m.extend_from_slice(server_nonce);
    m.extend_from_slice(&(device_id.len() as u32).to_be_bytes());
    m.extend_from_slice(device_id.as_bytes());
    m.extend_from_slice(&server_time.to_be_bytes());
    m
}

/// Bytes the agent signs for its proof.
pub fn proof_message(server_nonce: &[u8], agent_nonce: &[u8], device_id: &str) -> Vec<u8> {
    let mut m = Vec::with_capacity(PROOF_CONTEXT.len() + 64 + device_id.len());
    m.extend_from_slice(PROOF_CONTEXT);
    m.extend_from_slice(&(server_nonce.len() as u32).to_be_bytes());
    m.extend_from_slice(server_nonce);
    m.extend_from_slice(&(agent_nonce.len() as u32).to_be_bytes());
    m.extend_from_slice(agent_nonce);
    m.extend_from_slice(&(device_id.len() as u32).to_be_bytes());
    m.extend_from_slice(device_id.as_bytes());
    m
}

#[cfg(test)]
mod tests {
    use super::*;
    use rustrmm_crypto::sign::SigningKey;

    #[test]
    fn handshake_signatures_verify_and_bind_context() {
        let server = SigningKey::generate();
        let device = SigningKey::generate();
        let (agent_nonce, server_nonce) = ([1u8; 32], [2u8; 32]);

        let challenge = challenge_message(&agent_nonce, &server_nonce, "dev-1", 1_700_000_000_000);
        let sig = server.sign(&challenge);
        server
            .public_key()
            .verify(&challenge, &sig)
            .expect("server signature");
        // A challenge for another device or time must not verify.
        assert!(
            server
                .public_key()
                .verify(
                    &challenge_message(&agent_nonce, &server_nonce, "dev-2", 1_700_000_000_000),
                    &sig
                )
                .is_err()
        );
        assert!(
            server
                .public_key()
                .verify(
                    &challenge_message(&agent_nonce, &server_nonce, "dev-1", 1),
                    &sig
                )
                .is_err()
        );

        let proof = proof_message(&server_nonce, &agent_nonce, "dev-1");
        let psig = device.sign(&proof);
        device
            .public_key()
            .verify(&proof, &psig)
            .expect("device signature");
        // Proof and challenge messages are domain-separated.
        assert!(server.public_key().verify(&proof, &sig).is_err());
    }
}
