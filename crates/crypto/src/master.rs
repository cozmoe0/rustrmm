//! The installation master key.
//!
//! A single 256-bit secret supplied by the operator (Docker secret / key file). Every other
//! secret-protecting key is derived from it with HKDF-SHA256 and a purpose label, so the master
//! key itself is never used directly for encryption.

use std::fs;
use std::path::Path;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use hkdf::Hkdf;
use sha2::Sha256;
use zeroize::Zeroizing;

use crate::{CryptoError, Result};

const HKDF_SALT: &[u8] = b"rustrmm/master-key/v1";

/// The 32-byte master key. Zeroed on drop.
pub struct MasterKey(Zeroizing<[u8; 32]>);

impl MasterKey {
    /// Generates a fresh random master key.
    pub fn generate() -> Self {
        Self(Zeroizing::new(crate::random::bytes::<32>()))
    }

    /// Parses a base64 (standard alphabet) encoded key; surrounding whitespace is ignored.
    pub fn from_base64(encoded: &str) -> Result<Self> {
        let raw = Zeroizing::new(STANDARD.decode(encoded.trim()).map_err(|e| {
            CryptoError::InvalidKey(format!("master key is not valid base64: {e}"))
        })?);
        let bytes: [u8; 32] = raw.as_slice().try_into().map_err(|_| {
            CryptoError::InvalidKey(format!("master key must be 32 bytes, got {}", raw.len()))
        })?;
        Ok(Self(Zeroizing::new(bytes)))
    }

    /// Base64 (standard alphabet) representation, for the recovery kit and key files.
    pub fn to_base64(&self) -> Zeroizing<String> {
        Zeroizing::new(STANDARD.encode(self.0.as_slice()))
    }

    /// Loads the key from a text file containing base64.
    pub fn load(path: &Path) -> Result<Self> {
        let text = Zeroizing::new(fs::read_to_string(path)?);
        Self::from_base64(&text)
    }

    /// Loads the key, creating a new one (owner-only permissions) if the file does not exist.
    /// Returns `(key, created)`.
    pub fn load_or_create(path: &Path) -> Result<(Self, bool)> {
        if path.exists() {
            return Ok((Self::load(path)?, false));
        }
        let key = Self::generate();
        key.write_to(path)?;
        Ok((key, true))
    }

    /// Writes the key as base64 text with owner-only permissions where supported.
    pub fn write_to(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut contents = self.to_base64();
        contents.push('\n');
        crate::keyfile::write_private(path, contents.as_bytes())
    }

    /// Derives a 32-byte sub-key for `purpose` (e.g. `"db-field-encryption"`).
    pub fn derive(&self, purpose: &str) -> Zeroizing<[u8; 32]> {
        let hk = Hkdf::<Sha256>::new(Some(HKDF_SALT), self.0.as_slice());
        let mut out = Zeroizing::new([0u8; 32]);
        hk.expand(purpose.as_bytes(), out.as_mut_slice())
            .expect("32 bytes is a valid HKDF-SHA256 output length");
        out
    }
}

impl std::fmt::Debug for MasterKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("MasterKey(<redacted>)")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_roundtrip_and_derivation_is_stable() {
        let key = MasterKey::generate();
        let encoded = key.to_base64();
        let again = MasterKey::from_base64(&encoded).expect("valid key");
        assert_eq!(*key.derive("a"), *again.derive("a"));
        assert_ne!(*key.derive("a"), *key.derive("b"));
    }

    #[test]
    fn rejects_wrong_length() {
        assert!(MasterKey::from_base64("AAAA").is_err());
        assert!(MasterKey::from_base64("not base64!!").is_err());
    }

    #[test]
    fn load_or_create_persists() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("keys").join("master.key");
        let (a, created) = MasterKey::load_or_create(&path).expect("create");
        assert!(created);
        let (b, created) = MasterKey::load_or_create(&path).expect("load");
        assert!(!created);
        assert_eq!(*a.derive("x"), *b.derive("x"));
    }
}
