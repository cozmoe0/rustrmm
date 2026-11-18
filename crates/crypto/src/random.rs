//! CSPRNG helpers, opaque tokens and hashing utilities.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, KeyInit, Mac};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

/// Fills a fixed-size array from the operating system CSPRNG.
///
/// # Panics
/// Panics if the OS random source is unavailable — continuing without randomness would be unsafe.
pub fn bytes<const N: usize>() -> [u8; N] {
    let mut buf = [0u8; N];
    getrandom::fill(&mut buf).expect("operating system random number generator unavailable");
    buf
}

/// Fills an arbitrary buffer from the OS CSPRNG.
pub fn fill(buf: &mut [u8]) {
    getrandom::fill(buf).expect("operating system random number generator unavailable");
}

/// A 256-bit random token encoded as unpadded base64url (43 characters).
pub fn token() -> String {
    URL_SAFE_NO_PAD.encode(bytes::<32>())
}

/// SHA-256 of `data`, lowercase hex.
pub fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

/// SHA-256 of `data` as raw bytes.
pub fn sha256(data: &[u8]) -> [u8; 32] {
    let digest = Sha256::digest(data);
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

/// HMAC-SHA256(key, data), lowercase hex. Used for peppered hashes of low-entropy secrets.
pub fn hmac_sha256_hex(key: &[u8], data: &[u8]) -> String {
    let mut mac =
        <Hmac<Sha256> as KeyInit>::new_from_slice(key).expect("HMAC accepts keys of any length");
    mac.update(data);
    hex::encode(mac.finalize().into_bytes())
}

/// Constant-time equality for secrets of possibly different lengths.
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && bool::from(a.ct_eq(b))
}

/// Human-friendly code made of groups of base32 characters (no ambiguous padding),
/// e.g. `groups = 4, group_len = 4` → `K7QD-2MXA-PL4Z-91HC`.
pub fn grouped_code(groups: usize, group_len: usize) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I, O, 0, 1
    let mut out = String::with_capacity(groups * (group_len + 1));
    let mut raw = vec![0u8; groups * group_len];
    fill(&mut raw);
    for (i, b) in raw.iter().enumerate() {
        if i > 0 && i % group_len == 0 {
            out.push('-');
        }
        out.push(ALPHABET[(*b as usize) % ALPHABET.len()] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_random_and_url_safe() {
        let a = token();
        let b = token();
        assert_ne!(a, b);
        assert_eq!(a.len(), 43);
        assert!(
            a.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        );
    }

    #[test]
    fn constant_time_eq_works() {
        assert!(ct_eq(b"abc", b"abc"));
        assert!(!ct_eq(b"abc", b"abd"));
        assert!(!ct_eq(b"abc", b"abcd"));
    }

    #[test]
    fn grouped_codes_have_expected_shape() {
        let code = grouped_code(4, 4);
        assert_eq!(code.len(), 19);
        assert_eq!(code.matches('-').count(), 3);
    }

    #[test]
    fn hmac_is_deterministic() {
        assert_eq!(hmac_sha256_hex(b"k", b"v"), hmac_sha256_hex(b"k", b"v"));
        assert_ne!(hmac_sha256_hex(b"k", b"v"), hmac_sha256_hex(b"k2", b"v"));
    }
}
