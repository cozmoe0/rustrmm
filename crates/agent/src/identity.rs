//! The device key: generated on the endpoint at enrollment and never sent anywhere.
//!
//! Windows stores it DPAPI-protected (machine scope) inside the SYSTEM/Administrators-only data
//! directory; Unix stores it as a root-only `0600` file. The agent's Noise static key (end-to-end
//! channel) is stored next to it the same way; agents enrolled before the channel existed create
//! it on their first start after the upgrade.

use anyhow::{Context, Result};
use rustrmm_crypto::sign::{KeyAlgorithm, SigningKey};
use rustrmm_proto::noise::StaticKeypair;
use zeroize::Zeroizing;

use crate::paths::Paths;

pub fn create(paths: &Paths) -> Result<SigningKey> {
    let key = SigningKey::generate();
    let protected = protect(&key.secret_bytes())?;
    crate::config::write_private(&paths.key_file(), &protected)?;
    Ok(key)
}

/// Creates the agent's Noise static key (at enrollment).
pub fn create_noise(paths: &Paths) -> Result<StaticKeypair> {
    let key = StaticKeypair::generate();
    let protected = protect(key.secret_bytes())?;
    crate::config::write_private(&paths.noise_key_file(), &protected)?;
    Ok(key)
}

/// Loads the agent's Noise static key, creating it when an upgraded agent has none yet.
pub fn load_or_create_noise(paths: &Paths) -> Result<StaticKeypair> {
    let file = paths.noise_key_file();
    if !file.exists() {
        tracing::info!("creating the end-to-end channel key");
        return create_noise(paths);
    }
    let blob = std::fs::read(&file).with_context(|| format!("reading {}", file.display()))?;
    match unprotect(&blob).map(|secret| StaticKeypair::from_secret(&secret)) {
        Ok(Ok(key)) => Ok(key),
        // A new key is registered on the next connection (vouched for by the device key).
        _ => {
            tracing::warn!("the end-to-end channel key is unreadable; creating a new one");
            create_noise(paths)
        }
    }
}

/// The server Noise key pinned after the first end-to-end handshake.
pub fn noise_pin(paths: &Paths) -> Result<Option<[u8; 32]>> {
    match std::fs::read_to_string(paths.noise_pin_file()) {
        Ok(text) => Ok(Some(
            rustrmm_proto::noise::decode_key(text.trim())
                .context("the pinned server Noise key is corrupt")?,
        )),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e).context("reading the pinned server Noise key"),
    }
}

pub fn save_noise_pin(paths: &Paths, key: &[u8; 32]) -> Result<()> {
    crate::config::write_private(
        &paths.noise_pin_file(),
        rustrmm_proto::noise::encode_key(key).as_bytes(),
    )
}

pub fn load(paths: &Paths) -> Result<SigningKey> {
    let blob = std::fs::read(paths.key_file())
        .with_context(|| format!("reading {}", paths.key_file().display()))?;
    let secret = unprotect(&blob)?;
    SigningKey::from_secret_bytes(KeyAlgorithm::Ed25519, &secret).context("device key is corrupt")
}

#[cfg(windows)]
fn protect(secret: &[u8]) -> Result<Vec<u8>> {
    use windows::Win32::Foundation::{HLOCAL, LocalFree};
    use windows::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_LOCAL_MACHINE, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData,
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: secret.len() as u32,
        pbData: secret.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    // SAFETY: input points to `secret` for the duration of the call; output is allocated by the
    // system and freed with LocalFree below.
    unsafe {
        CryptProtectData(
            &input,
            windows::core::w!("RustRMM device key"),
            None,
            None,
            None,
            CRYPTPROTECT_LOCAL_MACHINE | CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .context("DPAPI protect failed")?;
        let data = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(output.pbData as *mut core::ffi::c_void)));
        Ok(data)
    }
}

#[cfg(windows)]
fn unprotect(blob: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    use windows::Win32::Foundation::{HLOCAL, LocalFree};
    use windows::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptUnprotectData,
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: blob.len() as u32,
        pbData: blob.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    // SAFETY: as in `protect`.
    unsafe {
        CryptUnprotectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .context("DPAPI unprotect failed")?;
        let data = Zeroizing::new(
            std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec(),
        );
        std::ptr::write_bytes(output.pbData, 0, output.cbData as usize);
        let _ = LocalFree(Some(HLOCAL(output.pbData as *mut core::ffi::c_void)));
        Ok(data)
    }
}

#[cfg(not(windows))]
fn protect(secret: &[u8]) -> Result<Vec<u8>> {
    Ok(secret.to_vec())
}

#[cfg(not(windows))]
fn unprotect(blob: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    Ok(Zeroizing::new(blob.to_vec()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_roundtrip() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = Paths::resolve(Some(dir.path().to_path_buf()));
        let key = create(&paths).expect("create");
        let loaded = load(&paths).expect("load");
        assert_eq!(key.public_key(), loaded.public_key());
    }

    #[test]
    fn noise_key_and_pin_roundtrip() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = Paths::resolve(Some(dir.path().to_path_buf()));
        let created = load_or_create_noise(&paths).expect("create on upgrade");
        let loaded = load_or_create_noise(&paths).expect("load");
        assert_eq!(created.public_key(), loaded.public_key());
        assert!(noise_pin(&paths).expect("no pin").is_none());
        save_noise_pin(&paths, &created.public_key()).expect("pin");
        assert_eq!(noise_pin(&paths).expect("pin"), Some(created.public_key()));
    }
}
