//! Secrets escrow (see `docs/api-escrow-network.md`, "Escrow cryptography").
//!
//! * [`EscrowItem`] (agent → server) carries one secret encrypted on the device with `age` to the
//!   server's escrow recipient (`AgentConfig.escrow_recipient`), so plaintext never crosses the
//!   wire and never reaches the database.
//! * [`RotateLocalAdmin`] (signed command) sets a fresh random password on the managed local
//!   administrator account; the agent escrows it at once as a `laps` item. The command result
//!   never contains the password.
//! * `Command::EscrowRefresh` (signed command) asks the agent to collect BitLocker recovery keys
//!   (and FileVault/LUKS status) again.

use serde::{Deserialize, Serialize};

use crate::Message;

/// Escrow item kinds.
pub mod kinds {
    pub const BITLOCKER: &str = "bitlocker";
    pub const LAPS: &str = "laps";
    pub const FILEVAULT: &str = "filevault";
    pub const LUKS: &str = "luks";
    pub const ALL: &[&str] = &[BITLOCKER, LAPS, FILEVAULT, LUKS];
}

/// Largest accepted `ciphertext_age` (a recovery key or password is far smaller).
pub const MAX_CIPHERTEXT_BYTES: usize = 16 * 1024;

/// Agent → server: one escrowed secret, encrypted to the escrow recipient.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct EscrowItem {
    /// `bitlocker` | `laps` | `filevault` | `luks`
    pub kind: String,
    /// BitLocker key protector id, local account name, …
    pub identifier: String,
    #[serde(default)]
    pub label: String,
    /// A binary `age` file encrypted to the server's X25519 escrow recipient.
    #[serde(with = "serde_bytes")]
    pub ciphertext_age: Vec<u8>,
    /// Agent clock, unix milliseconds.
    pub captured_at: i64,
    /// `volume`, `mount_point`, `key_protector_id`, `account`, … — never secrets.
    #[serde(default)]
    pub metadata: serde_json::Value,
    /// [`source_hash`] of the plaintext, so the server can de-duplicate without decrypting.
    #[serde(default)]
    pub source_hash: String,
}

impl std::fmt::Debug for EscrowItem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EscrowItem")
            .field("kind", &self.kind)
            .field("identifier", &self.identifier)
            .field("label", &self.label)
            .field("ciphertext_age", &self.ciphertext_age.len())
            .field("captured_at", &self.captured_at)
            .field("metadata", &self.metadata)
            .finish()
    }
}

impl Message for EscrowItem {
    const TYPE: &'static str = "escrow_item";
}

/// Lowercase hex SHA-256 over a domain-separated encoding of the secret and where it belongs.
/// The secrets escrowed here (48-digit recovery keys, 14+ character random passwords) are far
/// too large to guess from their hash.
pub fn source_hash(kind: &str, identifier: &str, plaintext: &[u8]) -> String {
    let mut m = Vec::with_capacity(32 + kind.len() + identifier.len() + plaintext.len());
    m.extend_from_slice(b"rustrmm/v1/escrow\0");
    m.extend_from_slice(kind.as_bytes());
    m.push(0);
    m.extend_from_slice(identifier.as_bytes());
    m.push(0);
    m.extend_from_slice(plaintext);
    rustrmm_crypto::random::sha256_hex(&m)
}

/// Password character sets for [`RotateLocalAdmin::complexity`].
pub const COMPLEXITIES: &[&str] = &["full", "alphanumeric"];
/// Bounds the agent enforces on generated password lengths.
pub const MIN_PASSWORD_LENGTH: u32 = 14;
pub const MAX_PASSWORD_LENGTH: u32 = 64;

/// Server → agent (signed): rotate the managed local administrator password.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RotateLocalAdmin {
    pub account: String,
    #[serde(default = "yes")]
    pub create_if_missing: bool,
    #[serde(default = "default_length")]
    pub length: u32,
    /// `full` (upper, lower, digits, symbols) | `alphanumeric`
    #[serde(default = "default_complexity")]
    pub complexity: String,
    #[serde(default)]
    pub disable_other_admins: bool,
}

fn yes() -> bool {
    true
}

fn default_length() -> u32 {
    20
}

fn default_complexity() -> String {
    "full".into()
}

impl Default for RotateLocalAdmin {
    fn default() -> Self {
        Self {
            account: "rmm-admin".into(),
            create_if_missing: true,
            length: default_length(),
            complexity: default_complexity(),
            disable_other_admins: false,
        }
    }
}

/// Whether a local account name is acceptable on every platform (letters, digits, `-`, `_`,
/// `.`; 1–20 characters; not starting with `-` or `.`).
pub fn valid_account_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 20
        && !name.starts_with(['-', '.'])
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Frame;

    #[test]
    fn escrow_item_round_trips_without_leaking_in_debug() {
        let item = EscrowItem {
            kind: kinds::BITLOCKER.into(),
            identifier: "{2F1C0000-0000-0000-0000-000000000001}".into(),
            label: "C: recovery key".into(),
            ciphertext_age: b"age-encryption.org/v1\nsecret-ish".to_vec(),
            captured_at: 1_700_000_000_000,
            metadata: serde_json::json!({ "volume": "C:" }),
            source_hash: source_hash("bitlocker", "{2F1C}", b"111111-222222"),
        };
        let bytes = crate::encode(&item).expect("encode");
        let back: EscrowItem = Frame::decode(&bytes).expect("decode").body().expect("body");
        assert_eq!(back, item);
        assert!(!format!("{back:?}").contains("secret-ish"));
        assert_eq!(back.source_hash.len(), 64);
        assert_ne!(
            source_hash("bitlocker", "a", b"bc"),
            source_hash("bitlocker", "ab", b"c"),
            "fields are separated"
        );
    }

    #[test]
    fn rotate_defaults_and_names() {
        let parsed: RotateLocalAdmin =
            serde_json::from_value(serde_json::json!({ "account": "rmm-admin" })).expect("parse");
        assert_eq!(parsed, RotateLocalAdmin::default());
        assert!(valid_account_name("rmm-admin"));
        assert!(!valid_account_name("bad name"));
        assert!(!valid_account_name("-x"));
        assert!(!valid_account_name("a_very_long_account_name_x"));
    }
}
