//! Authenticated encryption for database fields and small secrets.
//!
//! XChaCha20-Poly1305 with a random 192-bit nonce per message. The caller supplies associated
//! data (AAD) that binds the ciphertext to its location — e.g. `"users/totp_secret/<user-id>"` —
//! so a ciphertext copied into another row or column fails to decrypt.
//!
//! Wire format: `[version=1][nonce: 24 bytes][ciphertext + tag]`.

use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{KeyInit, XChaCha20Poly1305, XNonce};
use zeroize::Zeroizing;

use crate::{CryptoError, Result};

const VERSION: u8 = 1;
const NONCE_LEN: usize = 24;

/// Symmetric field cipher bound to one 256-bit key.
#[derive(Clone)]
pub struct FieldCipher {
    cipher: XChaCha20Poly1305,
}

impl FieldCipher {
    /// Creates a cipher from a 32-byte key (normally derived from the master key).
    pub fn new(key: &[u8; 32]) -> Self {
        let cipher =
            XChaCha20Poly1305::new_from_slice(key).expect("XChaCha20-Poly1305 keys are 32 bytes");
        Self { cipher }
    }

    /// Encrypts `plaintext`, binding it to `aad`.
    pub fn encrypt(&self, plaintext: &[u8], aad: &[u8]) -> Vec<u8> {
        let nonce_bytes = crate::random::bytes::<NONCE_LEN>();
        let nonce = XNonce::from(nonce_bytes);
        let ciphertext = self
            .cipher
            .encrypt(
                &nonce,
                Payload {
                    msg: plaintext,
                    aad,
                },
            )
            .expect("encryption with a valid key cannot fail");
        let mut out = Vec::with_capacity(1 + NONCE_LEN + ciphertext.len());
        out.push(VERSION);
        out.extend_from_slice(&nonce_bytes);
        out.extend_from_slice(&ciphertext);
        out
    }

    /// Decrypts a blob produced by [`FieldCipher::encrypt`] with the same `aad`.
    pub fn decrypt(&self, blob: &[u8], aad: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
        if blob.len() < 1 + NONCE_LEN + 16 {
            return Err(CryptoError::Decrypt);
        }
        if blob[0] != VERSION {
            return Err(CryptoError::Format(format!(
                "unknown field-cipher version {}",
                blob[0]
            )));
        }
        let mut nonce_bytes = [0u8; NONCE_LEN];
        nonce_bytes.copy_from_slice(&blob[1..1 + NONCE_LEN]);
        let nonce = XNonce::from(nonce_bytes);
        let plaintext = self
            .cipher
            .decrypt(
                &nonce,
                Payload {
                    msg: &blob[1 + NONCE_LEN..],
                    aad,
                },
            )
            .map_err(|_| CryptoError::Decrypt)?;
        Ok(Zeroizing::new(plaintext))
    }

    /// Convenience: encrypt a UTF-8 string.
    pub fn encrypt_str(&self, plaintext: &str, aad: &str) -> Vec<u8> {
        self.encrypt(plaintext.as_bytes(), aad.as_bytes())
    }

    /// Convenience: decrypt into a UTF-8 string.
    pub fn decrypt_string(&self, blob: &[u8], aad: &str) -> Result<Zeroizing<String>> {
        let bytes = self.decrypt(blob, aad.as_bytes())?;
        let text = String::from_utf8(bytes.to_vec()).map_err(|_| CryptoError::Decrypt)?;
        Ok(Zeroizing::new(text))
    }
}

impl std::fmt::Debug for FieldCipher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("FieldCipher(<redacted>)")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cipher() -> FieldCipher {
        FieldCipher::new(&[7u8; 32])
    }

    #[test]
    fn roundtrip() {
        let c = cipher();
        let blob = c.encrypt(b"top secret", b"users/totp/1");
        assert_eq!(
            c.decrypt(&blob, b"users/totp/1")
                .expect("decrypts")
                .as_slice(),
            b"top secret"
        );
    }

    #[test]
    fn nonces_are_unique() {
        let c = cipher();
        assert_ne!(c.encrypt(b"x", b"a"), c.encrypt(b"x", b"a"));
    }

    #[test]
    fn wrong_aad_or_key_fails() {
        let c = cipher();
        let blob = c.encrypt(b"top secret", b"users/totp/1");
        assert!(c.decrypt(&blob, b"users/totp/2").is_err());
        assert!(
            FieldCipher::new(&[8u8; 32])
                .decrypt(&blob, b"users/totp/1")
                .is_err()
        );
    }

    #[test]
    fn tampering_is_detected() {
        let c = cipher();
        let mut blob = c.encrypt(b"top secret", b"aad");
        let last = blob.len() - 1;
        blob[last] ^= 0x01;
        assert!(c.decrypt(&blob, b"aad").is_err());
        assert!(c.decrypt(&blob[..10], b"aad").is_err());
    }
}
