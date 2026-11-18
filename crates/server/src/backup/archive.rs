//! Backup archive format: `tar` → `zstd` → `age` (X25519 recipient).
//!
//! Contents: `manifest.json`, `rustrmm.db` (consistent `VACUUM INTO` snapshot), `keys/*` and
//! `pki/*` (still wrapped by the master key, which is deliberately *not* included), and
//! optionally `files/**`. The server only holds the age recipient, so it can write backups but
//! cannot read them; restoring needs the identity from the recovery kit.

use std::fs::File;
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::str::FromStr;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const DB_ENTRY: &str = "rustrmm.db";
pub const MANIFEST_ENTRY: &str = "manifest.json";

#[derive(Debug, Serialize, Deserialize)]
pub struct Manifest {
    pub product: String,
    pub version: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub schema_version: i64,
    pub includes_files: bool,
    pub server_identity: String,
}

/// Writer adapter that hashes and counts everything passing through.
struct HashingWriter<W: Write> {
    inner: W,
    hasher: Sha256,
    bytes: u64,
}

impl<W: Write> Write for HashingWriter<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let n = self.inner.write(buf)?;
        self.hasher.update(&buf[..n]);
        self.bytes += n as u64;
        Ok(n)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

pub struct ArchiveInputs<'a> {
    pub snapshot: &'a Path,
    pub keys_dir: &'a Path,
    pub pki_dir: &'a Path,
    pub files_dir: Option<&'a Path>,
    pub manifest: &'a Manifest,
    pub recipient: &'a str,
}

pub struct ArchiveOutput {
    pub size_bytes: u64,
    pub sha256: String,
}

/// Builds the encrypted archive at `out_path`. Blocking: run in `spawn_blocking`.
pub fn create(inputs: &ArchiveInputs<'_>, out_path: &Path) -> Result<ArchiveOutput> {
    let recipient = age::x25519::Recipient::from_str(inputs.recipient)
        .map_err(|e| anyhow::anyhow!("invalid backup recipient: {e}"))?;
    let file =
        File::create(out_path).with_context(|| format!("creating {}", out_path.display()))?;
    let hashing = HashingWriter {
        inner: BufWriter::new(file),
        hasher: Sha256::new(),
        bytes: 0,
    };
    let encryptor =
        age::Encryptor::with_recipients(std::iter::once(&recipient as &dyn age::Recipient))
            .map_err(|e| anyhow::anyhow!("age setup failed: {e}"))?;
    let age_writer = encryptor
        .wrap_output(hashing)
        .context("starting age stream")?;
    let mut zstd_writer =
        zstd::stream::write::Encoder::new(age_writer, 6).context("starting zstd stream")?;
    {
        let mut tar = tar::Builder::new(&mut zstd_writer);
        tar.mode(tar::HeaderMode::Deterministic);
        let manifest = serde_json::to_vec_pretty(inputs.manifest)?;
        append_bytes(&mut tar, MANIFEST_ENTRY, &manifest)?;
        tar.append_path_with_name(inputs.snapshot, DB_ENTRY)
            .context("adding database snapshot")?;
        if inputs.keys_dir.is_dir() {
            append_dir_files(&mut tar, inputs.keys_dir, "keys", &["master.key"])?;
        }
        if inputs.pki_dir.is_dir() {
            append_dir_files(&mut tar, inputs.pki_dir, "pki", &[])?;
        }
        if let Some(files) = inputs.files_dir
            && files.is_dir()
        {
            tar.append_dir_all("files", files)
                .context("adding blob store")?;
        }
        tar.finish().context("finishing tar")?;
    }
    let age_writer = zstd_writer.finish().context("finishing zstd")?;
    let mut hashing = age_writer.finish().context("finishing age")?;
    hashing.flush()?;
    let sha256 = hex::encode(hashing.hasher.finalize());
    let size_bytes = hashing.bytes;
    let file = hashing
        .inner
        .into_inner()
        .map_err(|e| anyhow::anyhow!("flushing archive: {}", e.error()))?;
    file.sync_all()?;
    Ok(ArchiveOutput { size_bytes, sha256 })
}

fn append_bytes<W: Write>(tar: &mut tar::Builder<W>, name: &str, bytes: &[u8]) -> Result<()> {
    let mut header = tar::Header::new_gnu();
    header.set_size(bytes.len() as u64);
    header.set_mode(0o600);
    header.set_mtime(chrono::Utc::now().timestamp().max(0) as u64);
    header.set_cksum();
    tar.append_data(&mut header, name, bytes)
        .with_context(|| format!("adding {name}"))?;
    Ok(())
}

fn append_dir_files<W: Write>(
    tar: &mut tar::Builder<W>,
    dir: &Path,
    prefix: &str,
    skip: &[&str],
) -> Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if skip.contains(&name.as_str()) || name.ends_with(".tmp") {
            continue;
        }
        tar.append_path_with_name(&path, format!("{prefix}/{name}"))
            .with_context(|| format!("adding {}", path.display()))?;
    }
    Ok(())
}

/// Decrypts and unpacks an archive into `dest` (created if needed). Blocking.
pub fn extract(archive: &Path, identity_text: &str, dest: &Path) -> Result<Manifest> {
    let identity_line = identity_text
        .lines()
        .map(str::trim)
        .find(|l| l.starts_with("AGE-SECRET-KEY-1"))
        .context("identity file does not contain an AGE-SECRET-KEY-1 line")?;
    let identity = age::x25519::Identity::from_str(identity_line)
        .map_err(|e| anyhow::anyhow!("invalid identity: {e}"))?;
    let file = File::open(archive).with_context(|| format!("opening {}", archive.display()))?;
    let decryptor =
        age::Decryptor::new(BufReader::new(file)).context("not an age-encrypted file")?;
    let reader = decryptor
        .decrypt(std::iter::once(&identity as &dyn age::Identity))
        .context("decryption failed — wrong recovery-kit identity?")?;
    let zstd_reader = zstd::stream::read::Decoder::new(reader)?;
    std::fs::create_dir_all(dest)?;
    let mut tar = tar::Archive::new(zstd_reader);
    for entry in tar.entries()? {
        let mut entry = entry?;
        let path: PathBuf = entry.path()?.into_owned();
        if path.is_absolute()
            || path
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            bail!("archive contains an unsafe path: {}", path.display());
        }
        entry.unpack_in(dest)?;
    }
    let mut manifest_text = String::new();
    File::open(dest.join(MANIFEST_ENTRY))
        .context("archive has no manifest")?
        .read_to_string(&mut manifest_text)?;
    let manifest: Manifest = serde_json::from_str(&manifest_text).context("invalid manifest")?;
    if !dest.join(DB_ENTRY).exists() {
        bail!("archive has no database snapshot");
    }
    Ok(manifest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use age::secrecy::ExposeSecret;

    #[test]
    fn roundtrip() {
        let dir = tempfile::tempdir().expect("tempdir");
        let snapshot = dir.path().join("snap.db");
        std::fs::write(&snapshot, b"sqlite-bytes").expect("write");
        let keys = dir.path().join("keys");
        std::fs::create_dir_all(&keys).expect("mkdir");
        std::fs::write(keys.join("identity.key"), b"wrapped").expect("write");
        std::fs::write(keys.join("master.key"), b"must-not-be-included").expect("write");
        let pki = dir.path().join("pki");
        std::fs::create_dir_all(&pki).expect("mkdir");
        std::fs::write(pki.join("ca.crt"), b"cert").expect("write");

        let identity = age::x25519::Identity::generate();
        let recipient = identity.to_public().to_string();
        let manifest = Manifest {
            product: "RustRMM".into(),
            version: "0.1.0".into(),
            created_at: chrono::Utc::now(),
            schema_version: 1,
            includes_files: false,
            server_identity: "ed25519:x".into(),
        };
        let out = dir.path().join("backup.tar.zst.age");
        let result = create(
            &ArchiveInputs {
                snapshot: &snapshot,
                keys_dir: &keys,
                pki_dir: &pki,
                files_dir: None,
                manifest: &manifest,
                recipient: &recipient,
            },
            &out,
        )
        .expect("create");
        assert_eq!(
            result.size_bytes,
            std::fs::metadata(&out).expect("meta").len()
        );
        assert_eq!(result.sha256.len(), 64);

        let dest = dir.path().join("restored");
        let restored = extract(&out, identity.to_string().expose_secret(), &dest).expect("extract");
        assert_eq!(restored.schema_version, 1);
        assert_eq!(
            std::fs::read(dest.join(DB_ENTRY)).expect("db"),
            b"sqlite-bytes"
        );
        assert!(dest.join("keys/identity.key").exists());
        assert!(
            !dest.join("keys/master.key").exists(),
            "master key must never be archived"
        );
        assert!(dest.join("pki/ca.crt").exists());

        let wrong = age::x25519::Identity::generate();
        assert!(
            extract(
                &out,
                wrong.to_string().expose_secret(),
                &dir.path().join("nope")
            )
            .is_err()
        );
    }
}
