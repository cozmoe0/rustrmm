//! Cryptographic primitives used across RustRMM.
//!
//! * [`master`] — the installation master key and HKDF sub-key derivation.
//! * [`field`] — authenticated encryption for database fields and key files.
//! * [`sign`] — algorithm-agile signing keys (Ed25519 today).
//! * [`keyfile`] — key files wrapped by a master-derived key.
//! * [`pki`] — the internal certificate authority and TLS pins.
//! * [`random`] — CSPRNG helpers, tokens and hashing.

pub mod field;
pub mod keyfile;
pub mod master;
pub mod pki;
pub mod random;
pub mod sign;

/// Errors produced by this crate.
#[derive(Debug, thiserror::Error)]
pub enum CryptoError {
    #[error("invalid key material: {0}")]
    InvalidKey(String),
    #[error("decryption failed (wrong key, corrupted data or mismatched context)")]
    Decrypt,
    #[error("signature verification failed")]
    BadSignature,
    #[error("unsupported format: {0}")]
    Format(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

pub type Result<T, E = CryptoError> = std::result::Result<T, E>;
