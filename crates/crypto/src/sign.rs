//! Algorithm-agile signing keys.
//!
//! Ed25519 is the only algorithm today; the [`KeyAlgorithm`] tag travels with every public key
//! and signature so P-256 (TPM / Secure Enclave backed) keys can be added without a format break.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::Signer as _;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::{CryptoError, Result};

/// Supported signature algorithms.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyAlgorithm {
    Ed25519,
}

impl KeyAlgorithm {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ed25519 => "ed25519",
        }
    }

    pub fn parse(s: &str) -> Result<Self> {
        match s {
            "ed25519" => Ok(Self::Ed25519),
            other => Err(CryptoError::Format(format!(
                "unsupported key algorithm '{other}'"
            ))),
        }
    }
}

/// A private signing key.
pub struct SigningKey {
    inner: ed25519_dalek::SigningKey,
}

impl SigningKey {
    /// Generates a new random key.
    pub fn generate() -> Self {
        let seed = Zeroizing::new(crate::random::bytes::<32>());
        Self {
            inner: ed25519_dalek::SigningKey::from_bytes(&seed),
        }
    }

    /// Restores a key from its secret bytes.
    pub fn from_secret_bytes(algorithm: KeyAlgorithm, secret: &[u8]) -> Result<Self> {
        match algorithm {
            KeyAlgorithm::Ed25519 => {
                let seed: [u8; 32] = secret.try_into().map_err(|_| {
                    CryptoError::InvalidKey("ed25519 secret must be 32 bytes".into())
                })?;
                let seed = Zeroizing::new(seed);
                Ok(Self {
                    inner: ed25519_dalek::SigningKey::from_bytes(&seed),
                })
            }
        }
    }

    pub fn algorithm(&self) -> KeyAlgorithm {
        KeyAlgorithm::Ed25519
    }

    /// Secret bytes for persistence (wrap them before writing to disk).
    pub fn secret_bytes(&self) -> Zeroizing<Vec<u8>> {
        Zeroizing::new(self.inner.to_bytes().to_vec())
    }

    pub fn public_key(&self) -> PublicKey {
        PublicKey {
            algorithm: KeyAlgorithm::Ed25519,
            bytes: self.inner.verifying_key().to_bytes().to_vec(),
        }
    }

    /// Signs `message`, returning raw signature bytes.
    pub fn sign(&self, message: &[u8]) -> Vec<u8> {
        self.inner.sign(message).to_bytes().to_vec()
    }
}

impl std::fmt::Debug for SigningKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "SigningKey({}, public={})",
            self.algorithm().as_str(),
            self.public_key()
        )
    }
}

/// A public verification key. Text form: `ed25519:<base64url>`.
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct PublicKey {
    pub algorithm: KeyAlgorithm,
    pub bytes: Vec<u8>,
}

impl PublicKey {
    /// Verifies `signature` over `message` (strict verification for Ed25519).
    pub fn verify(&self, message: &[u8], signature: &[u8]) -> Result<()> {
        match self.algorithm {
            KeyAlgorithm::Ed25519 => {
                let key_bytes: [u8; 32] = self.bytes.as_slice().try_into().map_err(|_| {
                    CryptoError::InvalidKey("ed25519 public key must be 32 bytes".into())
                })?;
                let key = ed25519_dalek::VerifyingKey::from_bytes(&key_bytes)
                    .map_err(|e| CryptoError::InvalidKey(e.to_string()))?;
                let sig_bytes: [u8; 64] = signature
                    .try_into()
                    .map_err(|_| CryptoError::BadSignature)?;
                let sig = ed25519_dalek::Signature::from_bytes(&sig_bytes);
                key.verify_strict(message, &sig)
                    .map_err(|_| CryptoError::BadSignature)?;
                Ok(())
            }
        }
    }

    /// Parses the `alg:base64url` text form.
    pub fn parse(text: &str) -> Result<Self> {
        let (alg, data) = text.split_once(':').ok_or_else(|| {
            CryptoError::Format("public key must look like 'ed25519:<base64url>'".into())
        })?;
        let algorithm = KeyAlgorithm::parse(alg)?;
        let bytes = URL_SAFE_NO_PAD
            .decode(data)
            .map_err(|e| CryptoError::Format(format!("invalid public key encoding: {e}")))?;
        let key = Self { algorithm, bytes };
        // Validate that the key material decodes.
        match algorithm {
            KeyAlgorithm::Ed25519 => {
                let arr: [u8; 32] = key.bytes.as_slice().try_into().map_err(|_| {
                    CryptoError::InvalidKey("ed25519 public key must be 32 bytes".into())
                })?;
                ed25519_dalek::VerifyingKey::from_bytes(&arr)
                    .map_err(|e| CryptoError::InvalidKey(e.to_string()))?;
            }
        }
        Ok(key)
    }

    /// Short fingerprint for display: first 16 hex chars of SHA-256 over the text form.
    pub fn fingerprint(&self) -> String {
        crate::random::sha256_hex(self.to_string().as_bytes())[..16].to_string()
    }
}

impl std::fmt::Display for PublicKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}:{}",
            self.algorithm.as_str(),
            URL_SAFE_NO_PAD.encode(&self.bytes)
        )
    }
}

impl std::fmt::Debug for PublicKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "PublicKey({self})")
    }
}

impl Serialize for PublicKey {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

impl<'de> Deserialize<'de> for PublicKey {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        Self::parse(&text).map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sign_verify_roundtrip() {
        let key = SigningKey::generate();
        let sig = key.sign(b"hello");
        key.public_key()
            .verify(b"hello", &sig)
            .expect("valid signature");
        assert!(key.public_key().verify(b"hello!", &sig).is_err());
    }

    #[test]
    fn restore_from_secret() {
        let key = SigningKey::generate();
        let restored = SigningKey::from_secret_bytes(KeyAlgorithm::Ed25519, &key.secret_bytes())
            .expect("restore");
        assert_eq!(key.public_key(), restored.public_key());
    }

    #[test]
    fn text_form_roundtrip() {
        let public = SigningKey::generate().public_key();
        let text = public.to_string();
        assert!(text.starts_with("ed25519:"));
        assert_eq!(PublicKey::parse(&text).expect("parse"), public);
        assert!(PublicKey::parse("rsa:abcd").is_err());
        assert_eq!(public.fingerprint().len(), 16);
    }
}
