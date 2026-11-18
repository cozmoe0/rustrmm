//! End-user "Request support" (`POST /agent/v1/support-request`, `docs/api-tickets.md`).
//!
//! The request is plain JSON over HTTPS, authenticated by the device key: the agent signs
//! `"rustrmm/v1/support" ‖ body` with Ed25519 and sends the signature (base64url, no padding)
//! in `X-RustRMM-Signature` next to `X-RustRMM-Device`. The body carries a timestamp (unix
//! seconds, accepted within five minutes) and a random nonce (each accepted once).

use serde::{Deserialize, Serialize};

/// Route on the agent listener.
pub const PATH: &str = "/agent/v1/support-request";
/// Domain separation prefix of the signed bytes.
pub const SIGNING_CONTEXT: &[u8] = b"rustrmm/v1/support";
/// Header with the device id.
pub const DEVICE_HEADER: &str = "x-rustrmm-device";
/// Header with the signature.
pub const SIGNATURE_HEADER: &str = "x-rustrmm-signature";
/// Accepted clock difference between the agent and the server.
pub const MAX_SKEW_SECS: i64 = 300;
/// Largest accepted request body (the screenshot is the bulk of it).
pub const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;

/// The signed request body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SupportRequest {
    /// Account of the signed-in user (`CORP\alex`, `alex`).
    pub user: String,
    /// Display name, when known.
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub email: Option<String>,
    pub subject: String,
    #[serde(default)]
    pub description: String,
    /// JPEG screenshot, standard base64.
    #[serde(default)]
    pub screenshot_jpeg_b64: Option<String>,
    /// Unix seconds.
    pub timestamp: i64,
    pub nonce: String,
}

/// The server's answer (201).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SupportResponse {
    pub ticket_id: String,
    pub number: i64,
}

/// The bytes covered by the signature.
pub fn signing_bytes(body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(SIGNING_CONTEXT.len() + body.len());
    out.extend_from_slice(SIGNING_CONTEXT);
    out.extend_from_slice(body);
    out
}

/// A fresh random nonce (base64url, 22 characters).
pub fn new_nonce() -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(rustrmm_crypto::random::bytes::<16>())
}

/// Encodes a signature for the header.
pub fn encode_signature(signature: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(signature)
}

/// Decodes a signature header (base64url or standard base64, padding optional).
pub fn decode_signature(text: &str) -> Option<Vec<u8>> {
    use base64::Engine as _;
    use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD};
    let text = text.trim();
    [URL_SAFE_NO_PAD, URL_SAFE, STANDARD, STANDARD_NO_PAD]
        .iter()
        .find_map(|engine| engine.decode(text).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signatures_cover_the_context_and_body() {
        let key = rustrmm_crypto::sign::SigningKey::generate();
        let body = br#"{"subject":"Printer"}"#;
        let signature = key.sign(&signing_bytes(body));
        let header = encode_signature(&signature);
        let decoded = decode_signature(&header).expect("decodes");
        key.public_key()
            .verify(&signing_bytes(body), &decoded)
            .expect("valid");
        // The bare body (no context) does not verify.
        assert!(key.public_key().verify(body, &decoded).is_err());
        assert_eq!(new_nonce().len(), 22);
        assert!(decode_signature("!!!").is_none());
    }
}
