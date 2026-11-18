//! The server key ring.
//!
//! * `identity` — signs agent handshake challenges; agents pin its public key.
//! * `command`  — signs every server→agent command envelope.
//! * `release`  — signs agent update manifests.
//! * `escrow`   — age X25519 identity; agents encrypt escrowed secrets to its recipient.
//! * `noise`    — X25519 static key of the Noise IK channel; offered to agents signed by `identity`
//!   and pinned by them after first use.
//!
//! Private keys are stored wrapped by a master-derived key in `<data>/keys/` and never in the
//! database, so a SQL-level compromise cannot forge commands or decrypt escrow.

use std::path::Path;
use std::str::FromStr;

use age::secrecy::ExposeSecret;
use anyhow::{Context, Result};
use rustrmm_crypto::field::FieldCipher;
use rustrmm_crypto::keyfile;
use rustrmm_crypto::master::MasterKey;
use rustrmm_crypto::sign::{KeyAlgorithm, PublicKey, SigningKey};
use zeroize::Zeroizing;

pub struct KeyRing {
    pub identity: SigningKey,
    pub command: SigningKey,
    pub release: SigningKey,
    pub escrow: age::x25519::Identity,
    /// Static key of the agent channel's Noise IK handshake.
    pub noise: rustrmm_proto::noise::StaticKeypair,
    /// HMAC key for peppered hashes (recovery codes, API token lookups).
    pub pepper: Zeroizing<[u8; 32]>,
}

impl KeyRing {
    /// Loads every key from `dir`, generating any that do not exist yet.
    pub fn load_or_create(dir: &Path, master: &MasterKey) -> Result<Self> {
        std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
        let wrap = FieldCipher::new(&master.derive("keyfile-wrap"));
        Ok(Self {
            identity: signing_key(dir, &wrap, "identity")?,
            command: signing_key(dir, &wrap, "command")?,
            release: signing_key(dir, &wrap, "release")?,
            escrow: escrow_identity(dir, &wrap)?,
            noise: noise_key(dir, &wrap)?,
            pepper: master.derive("pepper"),
        })
    }

    pub fn identity_public(&self) -> PublicKey {
        self.identity.public_key()
    }

    pub fn escrow_recipient(&self) -> String {
        self.escrow.to_public().to_string()
    }
}

fn signing_key(dir: &Path, wrap: &FieldCipher, name: &str) -> Result<SigningKey> {
    let path = dir.join(format!("{name}.key"));
    if path.exists() {
        let secret = keyfile::read_wrapped(&path, wrap, name)
            .with_context(|| format!("reading {name} key"))?;
        return SigningKey::from_secret_bytes(KeyAlgorithm::Ed25519, &secret)
            .context("decoding signing key");
    }
    let key = SigningKey::generate();
    keyfile::write_wrapped(&path, wrap, name, &key.secret_bytes())
        .with_context(|| format!("writing {name} key"))?;
    tracing::info!(key = name, public = %key.public_key(), "generated server signing key");
    Ok(key)
}

fn noise_key(dir: &Path, wrap: &FieldCipher) -> Result<rustrmm_proto::noise::StaticKeypair> {
    use rustrmm_proto::noise::{StaticKeypair, encode_key};
    let path = dir.join("noise.key");
    if path.exists() {
        let secret = keyfile::read_wrapped(&path, wrap, "noise").context("reading noise key")?;
        return StaticKeypair::from_secret(&secret).context("decoding noise key");
    }
    let key = StaticKeypair::generate();
    keyfile::write_wrapped(&path, wrap, "noise", key.secret_bytes())
        .context("writing noise key")?;
    tracing::info!(public = %encode_key(&key.public_key()), "generated Noise channel key");
    Ok(key)
}

fn escrow_identity(dir: &Path, wrap: &FieldCipher) -> Result<age::x25519::Identity> {
    let path = dir.join("escrow.key");
    if path.exists() {
        let secret = keyfile::read_wrapped(&path, wrap, "escrow").context("reading escrow key")?;
        let text = std::str::from_utf8(&secret).context("escrow key is not UTF-8")?;
        return age::x25519::Identity::from_str(text)
            .map_err(|e| anyhow::anyhow!("invalid escrow identity: {e}"));
    }
    let identity = age::x25519::Identity::generate();
    let secret = identity.to_string();
    keyfile::write_wrapped(&path, wrap, "escrow", secret.expose_secret().as_bytes())
        .context("writing escrow key")?;
    tracing::info!(recipient = %identity.to_public(), "generated escrow key");
    Ok(identity)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_persist_across_loads() {
        let dir = tempfile::tempdir().expect("tempdir");
        let master = MasterKey::generate();
        let first = KeyRing::load_or_create(dir.path(), &master).expect("create");
        let second = KeyRing::load_or_create(dir.path(), &master).expect("load");
        assert_eq!(first.identity_public(), second.identity_public());
        assert_eq!(first.command.public_key(), second.command.public_key());
        assert_eq!(first.escrow_recipient(), second.escrow_recipient());
        assert_eq!(first.noise.public_key(), second.noise.public_key());
        assert_ne!(first.identity_public(), first.command.public_key());
    }

    #[test]
    fn wrong_master_key_cannot_load() {
        let dir = tempfile::tempdir().expect("tempdir");
        KeyRing::load_or_create(dir.path(), &MasterKey::generate()).expect("create");
        assert!(KeyRing::load_or_create(dir.path(), &MasterKey::generate()).is_err());
    }
}
