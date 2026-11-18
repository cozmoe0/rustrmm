//! Secrets escrow: BitLocker recovery passwords (Windows) and the managed local administrator
//! password (LAPS-style rotation), each encrypted with `age` to the server's escrow recipient
//! (`AgentConfig.escrow_recipient`) before it leaves the collecting function. FileVault and LUKS
//! are reported, not escrowed (attended flows; see the inventory's `encryption`).
//!
//! The agent remembers a SHA-256 of every secret it sent (`escrow.json`, hashes only) so
//! automatic collection never sends the same key twice; an explicit `escrow_refresh` re-sends
//! everything (the server de-duplicates).

pub mod bitlocker;
pub mod laps;

use std::collections::BTreeMap;
use std::sync::LazyLock;

use anyhow::{Context, Result};
use rustrmm_proto::commands::CommandResult;
use rustrmm_proto::escrow::{EscrowItem, RotateLocalAdmin, kinds, source_hash};
use serde::{Deserialize, Serialize};
use serde_json::json;
use zeroize::Zeroizing;

use crate::paths::Paths;

/// Collection and rotation never run concurrently.
static LOCK: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));

/// Encrypts a secret to an age X25519 recipient (`age1…`).
pub fn encrypt(recipient: &str, plaintext: &[u8]) -> Result<Vec<u8>> {
    let recipient: age::x25519::Recipient = recipient
        .trim()
        .parse()
        .map_err(|e| anyhow::anyhow!("invalid escrow recipient: {e}"))?;
    age::encrypt(&recipient, plaintext).map_err(|e| anyhow::anyhow!("encryption failed: {e}"))
}

/// Builds an escrow item; the plaintext is only borrowed for the encryption and the hash.
pub fn item(
    recipient: &str,
    kind: &str,
    identifier: &str,
    label: &str,
    secret: &str,
    metadata: serde_json::Value,
) -> Result<EscrowItem> {
    Ok(EscrowItem {
        kind: kind.into(),
        identifier: identifier.into(),
        label: label.into(),
        ciphertext_age: encrypt(recipient, secret.as_bytes())?,
        captured_at: chrono::Utc::now().timestamp_millis(),
        metadata,
        source_hash: source_hash(kind, identifier, secret.as_bytes()),
    })
}

/// Hashes of what was sent, by `kind:identifier` (never secrets).
#[derive(Debug, Default, Serialize, Deserialize)]
struct Sent {
    #[serde(default)]
    items: BTreeMap<String, String>,
}

fn sent_file(paths: &Paths) -> std::path::PathBuf {
    paths.data_dir.join("escrow.json")
}

impl Sent {
    fn load(paths: &Paths) -> Self {
        std::fs::read(sent_file(paths))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    fn save(&self, paths: &Paths) {
        if let Ok(bytes) = serde_json::to_vec_pretty(self)
            && let Err(e) = crate::config::write_private(&sent_file(paths), &bytes)
        {
            tracing::warn!(error = %format!("{e:#}"), "could not record escrowed hashes");
        }
    }
}

/// What a collection did.
#[derive(Debug, Default, Clone, Serialize)]
pub struct Collected {
    pub sent: usize,
    pub unchanged: usize,
    pub bitlocker_volumes: usize,
    pub errors: Vec<String>,
    pub notes: Vec<String>,
}

/// Collects BitLocker recovery passwords and queues new ones for the server. With `force`,
/// everything is sent again.
pub async fn collect(paths: &Paths, recipient: &str, force: bool) -> Result<Collected> {
    let _guard = LOCK.lock().await;
    if recipient.trim().is_empty() {
        anyhow::bail!("this agent has no escrow recipient (re-enroll it)");
    }
    let mut out = Collected::default();
    #[cfg(windows)]
    {
        let (volumes, protectors, errors) =
            tokio::task::spawn_blocking(bitlocker::collect).await??;
        out.bitlocker_volumes = volumes.len();
        out.errors = errors;
        let mut sent = Sent::load(paths);
        for p in protectors {
            let key = format!("{}:{}", kinds::BITLOCKER, p.protector_id);
            let hash = source_hash(kinds::BITLOCKER, &p.protector_id, p.password.as_bytes());
            if !force && sent.items.get(&key) == Some(&hash) {
                out.unchanged += 1;
                continue;
            }
            let label = match &p.drive {
                Some(d) => format!("{d} recovery key"),
                None => "Recovery key".to_string(),
            };
            let item = item(
                recipient,
                kinds::BITLOCKER,
                &p.protector_id,
                &label,
                &p.password,
                json!({ "volume": p.drive.clone().unwrap_or_else(|| p.volume.clone()), "mount_point": p.drive,
                        "key_protector_id": p.protector_id }),
            )?;
            crate::outbox::push(&item);
            sent.items.insert(key, hash);
            out.sent += 1;
        }
        sent.save(paths);
    }
    #[cfg(target_os = "macos")]
    {
        let _ = (paths, force);
        let status = crate::util::run_any(
            "/usr/bin/fdesetup",
            &["status"],
            std::time::Duration::from_secs(20),
        )
        .unwrap_or_default();
        out.notes.push(format!(
            "FileVault: {}; a personal recovery key is escrowed only through the attended `fdesetup changerecovery -personal` flow",
            status.lines().next().unwrap_or("unknown").trim()
        ));
    }
    #[cfg(target_os = "linux")]
    {
        let _ = (paths, force);
        out.notes.push(
            "LUKS devices are reported in the security inventory; keys are not escrowed".into(),
        );
    }
    Ok(out)
}

/// Collection at start-up and after a BitLocker change seen by inventory (de-duplicated).
pub fn spawn_collect(paths: Paths, recipient: String) {
    if !cfg!(windows) || recipient.is_empty() {
        return;
    }
    tokio::spawn(async move {
        match collect(&paths, &recipient, false).await {
            Ok(c) if c.sent > 0 => {
                tracing::info!(sent = c.sent, "BitLocker recovery keys escrowed")
            }
            Ok(_) => {}
            Err(e) => tracing::debug!(error = %format!("{e:#}"), "BitLocker collection skipped"),
        }
    });
}

/// `Command::EscrowRefresh`.
pub fn spawn_refresh(cmd_id: String, paths: Paths, recipient: String) {
    tokio::spawn(async move {
        let result = match collect(&paths, &recipient, true).await {
            Ok(c) => CommandResult {
                cmd_id,
                status: "succeeded".into(),
                message: format!("{} item(s) sent", c.sent),
                data: serde_json::to_value(&c).unwrap_or_default(),
            },
            Err(e) => CommandResult {
                cmd_id,
                status: "failed".into(),
                message: format!("{e:#}"),
                data: serde_json::Value::Null,
            },
        };
        crate::outbox::result(result);
    });
}

/// Rotates the managed account's password and escrows the new one. The password exists only
/// inside this function (in zeroizing memory) and in the age ciphertext.
pub async fn rotate(
    paths: &Paths,
    recipient: &str,
    request: &RotateLocalAdmin,
) -> Result<serde_json::Value> {
    let _guard = LOCK.lock().await;
    if recipient.trim().is_empty() {
        anyhow::bail!("this agent has no escrow recipient (re-enroll it)");
    }
    if request.disable_other_admins {
        anyhow::bail!("disable_other_admins is not supported by this agent");
    }
    let password: Zeroizing<String> = laps::generate(request.length, &request.complexity);
    // Encrypt first: never change a password that could not be escrowed.
    let item = item(
        recipient,
        kinds::LAPS,
        &request.account,
        &format!("Local administrator ({})", request.account),
        &password,
        json!({ "account": request.account }),
    )?;
    let account = request.clone();
    let secret = password.clone();
    let outcome = tokio::task::spawn_blocking(move || laps::set_password(&account, &secret))
        .await
        .context("rotation task failed")??;
    crate::outbox::push(&item);
    let mut sent = Sent::load(paths);
    sent.items.insert(
        format!("{}:{}", kinds::LAPS, request.account),
        item.source_hash.clone(),
    );
    sent.save(paths);
    tracing::info!(account = %request.account, created = outcome.created, "local administrator password rotated");
    Ok(json!({
        "account": request.account, "created": outcome.created, "group": outcome.group,
        "length": password.len(), "rotated_at": chrono::Utc::now().to_rfc3339(),
    }))
}

/// `Command::RotateLocalAdmin`.
pub fn spawn_rotate(cmd_id: String, paths: Paths, recipient: String, request: RotateLocalAdmin) {
    tokio::spawn(async move {
        let result = match rotate(&paths, &recipient, &request).await {
            Ok(data) => CommandResult {
                cmd_id,
                status: "succeeded".into(),
                message: format!("password of {} rotated", request.account),
                data,
            },
            Err(e) => CommandResult {
                cmd_id,
                status: "failed".into(),
                message: format!("{e:#}"),
                data: serde_json::Value::Null,
            },
        };
        crate::outbox::result(result);
    });
}

/// Self-test: encrypt a sample secret to a freshly generated recipient and decrypt it again;
/// generate a LAPS password; parse a sample BitLocker result. No real secret is read.
pub fn selftest() -> Result<String> {
    let identity = age::x25519::Identity::generate();
    let recipient = identity.to_public().to_string();
    let sample = laps::generate(24, "full");
    let item = item(
        &recipient,
        kinds::LAPS,
        "selftest",
        "Self-test",
        &sample,
        json!({ "account": "selftest" }),
    )?;
    anyhow::ensure!(
        !item
            .ciphertext_age
            .windows(sample.len())
            .any(|w| w == sample.as_bytes()),
        "plaintext visible in the ciphertext"
    );
    let plain = Zeroizing::new(
        age::decrypt(&identity, &item.ciphertext_age)
            .map_err(|e| anyhow::anyhow!("decrypt: {e}"))?,
    );
    anyhow::ensure!(
        plain.as_slice() == sample.as_bytes(),
        "age round trip mismatch"
    );
    anyhow::ensure!(
        item.source_hash == source_hash(kinds::LAPS, "selftest", sample.as_bytes()),
        "hash mismatch"
    );
    let parsed = bitlocker::parse_numerical_password(&json!({
        "ReturnValue": 0, "NumericalPassword": "123453-234564-345675-456786-567897-679008-790119-801130",
    }))?;
    anyhow::ensure!(
        bitlocker::valid_recovery_password(&parsed),
        "recovery password parsing"
    );
    #[cfg(windows)]
    let bitlocker = match std::thread::spawn(bitlocker_metadata).join() {
        Ok(Ok(n)) => format!("; BitLocker WMI reachable ({n} volume(s), metadata only)"),
        Ok(Err(e)) => format!("; BitLocker WMI not readable here ({e:#})"),
        Err(_) => "; BitLocker WMI query panicked".to_string(),
    };
    #[cfg(not(windows))]
    let bitlocker = String::new();
    Ok(format!(
        "age X25519 round trip ({} octets), LAPS password {} chars{bitlocker}",
        item.ciphertext_age.len(),
        sample.len()
    ))
}

/// Counts encryptable volumes without reading any recovery password.
#[cfg(windows)]
fn bitlocker_metadata() -> Result<usize> {
    use std::collections::HashMap;
    let con =
        wmi::WMIConnection::with_namespace_path(r"ROOT\CIMV2\Security\MicrosoftVolumeEncryption")?;
    let rows: Vec<HashMap<String, wmi::Variant>> =
        con.raw_query("SELECT DeviceID, ProtectionStatus FROM Win32_EncryptableVolume")?;
    Ok(rows.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn items_are_encrypted_to_the_recipient() {
        let identity = age::x25519::Identity::generate();
        let item = item(
            &identity.to_public().to_string(),
            kinds::BITLOCKER,
            "{2F1C}",
            "C: recovery key",
            "123453-234564-345675-456786-567897-679008-790119-801130",
            json!({ "volume": "C:" }),
        )
        .expect("item");
        assert!(item.ciphertext_age.starts_with(b"age-encryption.org/v1\n"));
        let plain = age::decrypt(&identity, &item.ciphertext_age).expect("decrypt");
        assert_eq!(
            plain,
            b"123453-234564-345675-456786-567897-679008-790119-801130"
        );
        assert!(encrypt("not-a-recipient", b"x").is_err());
        assert!(selftest().is_ok());
    }

    #[test]
    fn sent_hashes_persist_without_secrets() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = Paths::resolve(Some(dir.path().to_path_buf()));
        let mut sent = Sent::load(&paths);
        let hash = source_hash(kinds::BITLOCKER, "{id}", b"secret-recovery-password");
        sent.items.insert("bitlocker:{id}".into(), hash.clone());
        sent.save(&paths);
        let text = std::fs::read_to_string(sent_file(&paths)).expect("file");
        assert!(!text.contains("secret-recovery-password"));
        assert_eq!(Sent::load(&paths).items.get("bitlocker:{id}"), Some(&hash));
    }
}
