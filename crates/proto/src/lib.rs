//! RustRMM agent ⇄ server wire protocol.
//!
//! Every WebSocket binary message is a MessagePack [`Frame`] `{t, id, z, b}`: a message type
//! string, an optional correlation id, a compression flag and the MessagePack-encoded body. A
//! receiver that does not know a type skips it, so new message kinds never break older peers.
//! Bodies are encoded with field names (`to_vec_named`); new fields must be `#[serde(default)]`
//! and existing fields are never repurposed.

pub mod commands;
pub mod deploy;
pub mod desktop;
pub mod escrow;
pub mod handshake;
pub mod messages;
pub mod monitoring;
pub mod network;
pub mod noise;
pub mod patching;
pub mod remote;
pub mod scripts;
pub mod software;
pub mod support;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

/// Protocol version spoken by this build.
pub const PROTOCOL_MAJOR: u16 = 1;
pub const PROTOCOL_MINOR: u16 = 0;
/// Oldest minor version of the current major the server still accepts.
pub const MIN_SUPPORTED_MINOR: u16 = 0;

/// Whether a peer's protocol version is accepted by this build.
#[allow(clippy::absurd_extreme_comparisons)] // MIN_SUPPORTED_MINOR is 0 today; it rises over time
pub fn protocol_supported(major: u16, minor: u16) -> bool {
    major == PROTOCOL_MAJOR && minor >= MIN_SUPPORTED_MINOR
}

/// Bodies larger than this are zstd-compressed.
const COMPRESS_THRESHOLD: usize = 4096;
/// Hard limit on a decoded frame body (inventory sections can be large).
pub const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;
/// Largest WebSocket message on the control connection: a full frame plus the Noise overhead
/// (header byte and one 16-byte tag per 64 KiB chunk) when the channel is wrapped.
pub const MAX_WIRE_BYTES: usize = noise::sealed_len(MAX_BODY_BYTES + 64 * 1024);

#[derive(Debug, thiserror::Error)]
pub enum ProtoError {
    #[error("encode failed: {0}")]
    Encode(#[from] rmp_serde::encode::Error),
    #[error("decode failed: {0}")]
    Decode(#[from] rmp_serde::decode::Error),
    #[error("compression failed: {0}")]
    Compression(#[from] std::io::Error),
    #[error("frame body exceeds {MAX_BODY_BYTES} bytes")]
    TooLarge,
    #[error("unexpected message type '{0}'")]
    Unexpected(String),
    #[error("invalid deploy key: {0}")]
    DeployKey(String),
}

pub type Result<T, E = ProtoError> = std::result::Result<T, E>;

/// The on-the-wire envelope.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Frame {
    /// Message type, e.g. `"hello"`, `"heartbeat"`.
    pub t: String,
    /// Optional correlation id (requests/responses).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// Body is zstd-compressed.
    #[serde(default)]
    pub z: bool,
    /// MessagePack-encoded body.
    #[serde(with = "serde_bytes")]
    pub b: Vec<u8>,
}

/// A typed message body with a fixed type tag.
pub trait Message: Serialize + DeserializeOwned {
    const TYPE: &'static str;
}

impl Frame {
    /// Builds a frame from a typed message.
    pub fn new<M: Message>(message: &M, id: Option<String>) -> Result<Self> {
        let body = rmp_serde::to_vec_named(message)?;
        let (z, b) = if body.len() > COMPRESS_THRESHOLD {
            (true, zstd::encode_all(&body[..], 3)?)
        } else {
            (false, body)
        };
        Ok(Self {
            t: M::TYPE.to_string(),
            id,
            z,
            b,
        })
    }

    /// Serialises the frame for a WebSocket binary message.
    pub fn encode(&self) -> Result<Vec<u8>> {
        Ok(rmp_serde::to_vec_named(self)?)
    }

    /// Parses a WebSocket binary message.
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > MAX_BODY_BYTES + 1024 {
            return Err(ProtoError::TooLarge);
        }
        Ok(rmp_serde::from_slice(bytes)?)
    }

    /// Decodes the body as `M` (the caller has already matched on `t`).
    pub fn body<M: Message>(&self) -> Result<M> {
        if self.t != M::TYPE {
            return Err(ProtoError::Unexpected(self.t.clone()));
        }
        if self.z {
            let mut decoder = zstd::stream::read::Decoder::new(&self.b[..])?;
            let mut out = Vec::new();
            let limit = MAX_BODY_BYTES as u64;
            let read = std::io::Read::read_to_end(
                &mut std::io::Read::take(&mut decoder, limit + 1),
                &mut out,
            )?;
            if read as u64 > limit {
                return Err(ProtoError::TooLarge);
            }
            Ok(rmp_serde::from_slice(&out)?)
        } else {
            Ok(rmp_serde::from_slice(&self.b)?)
        }
    }

    pub fn is<M: Message>(&self) -> bool {
        self.t == M::TYPE
    }
}

/// Convenience: encode a typed message straight to WebSocket bytes.
pub fn encode<M: Message>(message: &M) -> Result<Vec<u8>> {
    Frame::new(message, None)?.encode()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::messages::{Heartbeat, InventorySection};

    #[test]
    fn small_frames_roundtrip_uncompressed() {
        let hb = Heartbeat {
            uptime_s: 42,
            cpu_pct: 12.5,
            mem_pct: 40.0,
            disk_pct: 71.0,
            logged_in_user: Some("alice".into()),
        };
        let bytes = encode(&hb).expect("encode");
        let frame = Frame::decode(&bytes).expect("decode");
        assert_eq!(frame.t, "heartbeat");
        assert!(!frame.z);
        let back: Heartbeat = frame.body().expect("body");
        assert_eq!(back.uptime_s, 42);
        assert_eq!(back.logged_in_user.as_deref(), Some("alice"));
    }

    #[test]
    fn large_frames_are_compressed() {
        let items: Vec<serde_json::Value> = (0..2000)
            .map(|i| serde_json::json!({ "name": format!("Package {i}"), "version": "1.2.3" }))
            .collect();
        let section = InventorySection {
            section: "software".into(),
            hash: "abc".into(),
            data: serde_json::json!({ "items": items }),
        };
        let frame = Frame::new(&section, None).expect("frame");
        assert!(frame.z);
        let back: InventorySection = Frame::decode(&frame.encode().expect("encode"))
            .expect("decode")
            .body()
            .expect("body");
        assert_eq!(back.data["items"].as_array().expect("array").len(), 2000);
    }

    #[test]
    fn unknown_fields_and_types_are_tolerated() {
        // A newer peer adds a field: older decoders must ignore it.
        #[derive(Serialize)]
        struct FutureHeartbeat {
            uptime_s: u64,
            cpu_pct: f32,
            mem_pct: f32,
            disk_pct: f32,
            logged_in_user: Option<String>,
            gpu_pct: f32,
        }
        let body = rmp_serde::to_vec_named(&FutureHeartbeat {
            uptime_s: 1,
            cpu_pct: 1.0,
            mem_pct: 1.0,
            disk_pct: 1.0,
            logged_in_user: None,
            gpu_pct: 3.0,
        })
        .expect("encode");
        let frame = Frame {
            t: "heartbeat".into(),
            id: None,
            z: false,
            b: body,
        };
        let hb: Heartbeat = frame.body().expect("tolerates unknown field");
        assert_eq!(hb.uptime_s, 1);
        // Asking for the wrong type is an error, not a panic.
        assert!(frame.body::<InventorySection>().is_err());
    }
}
