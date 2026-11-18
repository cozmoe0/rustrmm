//! Private key files on disk.
//!
//! Secret key material is stored *wrapped*: encrypted with a [`FieldCipher`] whose key is
//! derived from the master key, with the key name as associated data. Files are created with
//! owner-only permissions on Unix; on Windows they inherit the (restricted) data directory ACL.

use std::fs;
use std::io::Write;
use std::path::Path;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use zeroize::Zeroizing;

use crate::field::FieldCipher;
use crate::{CryptoError, Result};

const HEADER: &str = "RUSTRMM-WRAPPED-KEY v1";

/// Writes bytes to `path` atomically (temp file + rename) with owner-only permissions on Unix.
pub fn write_private(path: &Path, contents: &[u8]) -> Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let tmp = path.with_extension("tmp");
    {
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&tmp)?;
        file.write_all(contents)?;
        file.sync_all()?;
    }
    fs::rename(&tmp, path)?;
    Ok(())
}

/// Encrypts `secret` under `cipher` and writes it to `path`. `name` binds the file to its role.
pub fn write_wrapped(path: &Path, cipher: &FieldCipher, name: &str, secret: &[u8]) -> Result<()> {
    let blob = cipher.encrypt(secret, aad(name).as_bytes());
    let contents = format!("{HEADER}\nname: {name}\n{}\n", STANDARD.encode(blob));
    write_private(path, contents.as_bytes())
}

/// Reads and decrypts a wrapped key file written by [`write_wrapped`].
pub fn read_wrapped(path: &Path, cipher: &FieldCipher, name: &str) -> Result<Zeroizing<Vec<u8>>> {
    let text = fs::read_to_string(path)?;
    let mut lines = text.lines();
    if lines.next() != Some(HEADER) {
        return Err(CryptoError::Format(format!(
            "{} is not a wrapped key file",
            path.display()
        )));
    }
    let stored_name = lines
        .next()
        .and_then(|l| l.strip_prefix("name: "))
        .ok_or_else(|| CryptoError::Format("missing key name".into()))?;
    if stored_name != name {
        return Err(CryptoError::Format(format!(
            "key file {} holds '{stored_name}', expected '{name}'",
            path.display()
        )));
    }
    let body = lines
        .next()
        .ok_or_else(|| CryptoError::Format("missing key body".into()))?;
    let blob = STANDARD
        .decode(body.trim())
        .map_err(|e| CryptoError::Format(format!("invalid base64: {e}")))?;
    cipher.decrypt(&blob, aad(name).as_bytes())
}

fn aad(name: &str) -> String {
    format!("rustrmm/keyfile/{name}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wrapped_roundtrip_and_name_binding() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("identity.key");
        let cipher = FieldCipher::new(&[1u8; 32]);
        write_wrapped(&path, &cipher, "identity", b"secret-bytes").expect("write");
        assert_eq!(
            read_wrapped(&path, &cipher, "identity")
                .expect("read")
                .as_slice(),
            b"secret-bytes"
        );
        assert!(read_wrapped(&path, &cipher, "command").is_err());
        assert!(read_wrapped(&path, &FieldCipher::new(&[2u8; 32]), "identity").is_err());
    }
}
