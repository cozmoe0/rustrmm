//! Settings → Code signing: is the imported agent bundle signed, and by whom?
//!
//! `GET /api/v1/settings/signing-status` inspects the files of the newest imported release (or
//! the distribution directory when nothing was imported yet), in pure Rust:
//!
//! * **Windows exe (PE):** the security directory's `WIN_CERTIFICATE` holds a PKCS#7
//!   `SignedData`; the signer certificate gives subject, issuer and SHA-1 thumbprint, the
//!   unsigned attributes show whether an RFC 3161 (or legacy) timestamp is present, and the
//!   Authenticode digest in `SpcIndirectDataContent` is compared with a fresh hash of the file.
//! * **MSI:** the `\u{5}DigitalSignature` stream of the compound file holds the same PKCS#7
//!   structure (its digest is not recomputed).
//! * **macOS (Mach-O):** the `LC_CODE_SIGNATURE` super blob's CMS slot gives the Developer ID
//!   signer; a signature without CMS is ad hoc. Notarization cannot be checked offline.
//! * **Linux (ELF):** a detached `<file>.minisig` next to the binary (key id and trusted
//!   comment; the signature itself is not verified without the public key).
//!
//! Certificate chains are not validated: this is an inventory of what was shipped, not a trust
//! decision (Windows and macOS make that on the endpoint).

use std::io::Read as _;
use std::path::{Path, PathBuf};

use axum::Json;
use axum::extract::State;
use chrono::{DateTime, Utc};
use rustrmm_proto::commands::{ReleaseManifest, version_cmp};
use serde::Serialize;
use sha1::Sha1;
use sha2::{Digest, Sha256};
use utoipa::ToSchema;

use crate::auth::AuthCtx;
use crate::error::{ApiError, ApiResult};
use crate::rbac::perm;
use crate::state::AppState;

// ------------------------------------------------------------------ response

#[derive(Debug, Serialize, ToSchema)]
pub struct SigningStatus {
    /// `release` (newest imported release), `distribution` (agent distribution directory, no
    /// release imported yet) or `none`.
    pub source: String,
    pub version: Option<String>,
    pub imported_at: Option<DateTime<Utc>>,
    pub platforms: Vec<PlatformStatus>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct PlatformStatus {
    /// e.g. `windows-x86_64`, `linux-aarch64`, `macos-universal`.
    pub platform: String,
    /// `signed` (every file) | `partially_signed` | `unsigned` | `invalid` (a signature does not
    /// match its file) | `unknown`.
    pub status: String,
    pub files: Vec<FileStatus>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct FileStatus {
    pub file: String,
    /// `pe` | `msi` | `macho` | `elf` | `other`
    pub format: String,
    /// `signed` | `unsigned` | `invalid` | `unknown`
    pub status: String,
    /// `authenticode` | `apple` | `adhoc` | `minisign`, when a signature was found.
    pub method: Option<String>,
    pub signer: Option<SignerInfo>,
    /// Authenticode: a countersignature or RFC 3161 timestamp is present.
    pub timestamped: Option<bool>,
    /// PE only: the Authenticode digest matches the file's contents.
    pub digest_valid: Option<bool>,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct SignerInfo {
    /// Certificate subject (`CN=…, O=…`), or `minisign key <ID>`.
    pub subject: String,
    pub issuer: Option<String>,
    /// Certificate serial number (hex).
    pub serial: Option<String>,
    /// SHA-1 of the signer certificate (upper-case hex), as Windows shows it.
    pub thumbprint_sha1: Option<String>,
    pub not_before: Option<DateTime<Utc>>,
    pub not_after: Option<DateTime<Utc>>,
}

impl FileStatus {
    fn new(file: &str, format: &str, status: &str) -> Self {
        Self {
            file: file.to_string(),
            format: format.to_string(),
            status: status.to_string(),
            method: None,
            signer: None,
            timestamped: None,
            digest_valid: None,
            detail: None,
        }
    }

    fn detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }
}

// ------------------------------------------------------------------ DER

#[derive(Debug, Clone, Copy)]
struct Tlv<'a> {
    tag: u8,
    value: &'a [u8],
    raw: &'a [u8],
}

/// One DER element (definite lengths only; BER indefinite lengths are reported as unknown).
fn tlv(input: &[u8]) -> Option<(Tlv<'_>, &[u8])> {
    let (&tag, rest) = input.split_first()?;
    if tag & 0x1f == 0x1f {
        return None;
    }
    let (&first, rest) = rest.split_first()?;
    let (len, rest) = if first < 0x80 {
        (usize::from(first), rest)
    } else {
        let n = usize::from(first & 0x7f);
        if n == 0 || n > 4 || rest.len() < n {
            return None;
        }
        let len = rest[..n]
            .iter()
            .fold(0usize, |acc, b| (acc << 8) | usize::from(*b));
        (len, &rest[n..])
    };
    if rest.len() < len {
        return None;
    }
    let header = input.len() - rest.len();
    Some((
        Tlv {
            tag,
            value: &rest[..len],
            raw: &input[..header + len],
        },
        &rest[len..],
    ))
}

/// The elements of a constructed value.
fn children(value: &[u8]) -> impl Iterator<Item = Tlv<'_>> {
    let mut rest = value;
    std::iter::from_fn(move || {
        let (item, next) = tlv(rest)?;
        rest = next;
        Some(item)
    })
}

mod oid {
    pub const SIGNED_DATA: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02];
    pub const SPC_INDIRECT_DATA: &[u8] =
        &[0x2b, 0x06, 0x01, 0x04, 0x01, 0x82, 0x37, 0x02, 0x01, 0x04];
    pub const SHA1: &[u8] = &[0x2b, 0x0e, 0x03, 0x02, 0x1a];
    pub const SHA256: &[u8] = &[0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01];
    pub const COUNTER_SIGNATURE: &[u8] = &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x06];
    pub const MS_RFC3161_TIMESTAMP: &[u8] =
        &[0x2b, 0x06, 0x01, 0x04, 0x01, 0x82, 0x37, 0x03, 0x03, 0x01];
    pub const TIMESTAMP_TOKEN: &[u8] = &[
        0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x10, 0x02, 0x0e,
    ];
}

/// What a PKCS#7 / CMS `SignedData` says about its signer.
#[derive(Debug, Default)]
struct Pkcs7 {
    signer: Option<SignerInfo>,
    timestamped: bool,
    /// Authenticode `SpcIndirectDataContent` digest: (algorithm OID, digest).
    spc_digest: Option<(Vec<u8>, Vec<u8>)>,
}

fn parse_pkcs7(der: &[u8]) -> Option<Pkcs7> {
    let (info, _) = tlv(der)?;
    if info.tag != 0x30 {
        return None;
    }
    let mut parts = children(info.value);
    let content_type = parts.next()?;
    if content_type.tag != 0x06 || content_type.value != oid::SIGNED_DATA {
        return None;
    }
    let wrapper = parts.next()?;
    if wrapper.tag != 0xa0 {
        return None;
    }
    let (signed_data, _) = tlv(wrapper.value)?;
    let mut fields = children(signed_data.value);
    let _version = fields.next()?;
    let _digest_algorithms = fields.next()?;
    let encap = fields.next()?;
    let mut out = Pkcs7::default();
    // Authenticode: the signed content is SpcIndirectDataContent with the file digest.
    let mut encap_fields = children(encap.value);
    if let (Some(kind), Some(content)) = (encap_fields.next(), encap_fields.next())
        && kind.value == oid::SPC_INDIRECT_DATA
        && content.tag == 0xa0
    {
        out.spc_digest = (|| {
            let (spc, _) = tlv(content.value)?;
            let mut spc_fields = children(spc.value);
            let _data = spc_fields.next()?;
            let digest_info = spc_fields.next()?;
            let mut di = children(digest_info.value);
            let algorithm = di.next()?;
            let digest = di.next()?;
            let alg_oid = children(algorithm.value).next()?;
            Some((alg_oid.value.to_vec(), digest.value.to_vec()))
        })();
    }
    let mut certificates: Vec<&[u8]> = Vec::new();
    let mut signer_infos = None;
    for field in fields {
        match field.tag {
            0xa0 => certificates.extend(children(field.value).map(|c| c.raw)),
            0x31 => signer_infos = Some(field),
            _ => {}
        }
    }
    let signer_info = children(signer_infos?.value).next()?;
    let mut si = children(signer_info.value);
    let _version = si.next()?;
    let sid = si.next()?;
    let (issuer_raw, serial) = if sid.tag == 0x30 {
        let mut s = children(sid.value);
        (Some(s.next()?.raw), Some(s.next()?.value))
    } else {
        (None, None)
    };
    for attr_block in si.filter(|f| f.tag == 0xa1) {
        for attribute in children(attr_block.value) {
            if let Some(kind) = children(attribute.value).next()
                && [
                    oid::COUNTER_SIGNATURE,
                    oid::MS_RFC3161_TIMESTAMP,
                    oid::TIMESTAMP_TOKEN,
                ]
                .contains(&kind.value)
            {
                out.timestamped = true;
            }
        }
    }
    let parsed: Vec<(&[u8], x509_parser::certificate::X509Certificate<'_>)> = certificates
        .iter()
        .filter_map(|raw| {
            x509_parser::parse_x509_certificate(raw)
                .ok()
                .map(|(_, c)| (*raw, c))
        })
        .collect();
    let signer = parsed.iter().find(|(_, c)| {
        issuer_raw.is_some_and(|i| c.tbs_certificate.issuer.as_raw() == i)
            && serial.is_some_and(|s| strip_zeros(c.tbs_certificate.raw_serial()) == strip_zeros(s))
    });
    out.signer = signer.map(|(raw, cert)| SignerInfo {
        subject: cert.subject().to_string(),
        issuer: Some(cert.issuer().to_string()),
        serial: Some(hex::encode(strip_zeros(cert.tbs_certificate.raw_serial()))),
        thumbprint_sha1: Some(hex::encode_upper(Sha1::digest(raw))),
        not_before: DateTime::from_timestamp(cert.validity().not_before.timestamp(), 0),
        not_after: DateTime::from_timestamp(cert.validity().not_after.timestamp(), 0),
    });
    Some(out)
}

fn strip_zeros(b: &[u8]) -> &[u8] {
    let start = b
        .iter()
        .position(|x| *x != 0)
        .unwrap_or(b.len().saturating_sub(1));
    &b[start..]
}

fn signed_status(file: &str, format: &str, pkcs7: Pkcs7) -> FileStatus {
    let mut status = FileStatus::new(file, format, "signed");
    status.method = Some("authenticode".into());
    status.timestamped = Some(pkcs7.timestamped);
    if pkcs7.signer.is_none() {
        status.detail = Some("Signed, but the signer certificate is not embedded".into());
    }
    status.signer = pkcs7.signer;
    status
}

// ------------------------------------------------------------------ PE

fn u16le(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(b.get(at..at + 2)?.try_into().ok()?))
}

fn u32le(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

fn u32be(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

struct PeLayout {
    checksum: usize,
    security_entry: usize,
    cert_offset: usize,
    cert_size: usize,
}

fn pe_layout(b: &[u8]) -> Option<PeLayout> {
    let pe = u32le(b, 0x3c)? as usize;
    if b.get(pe..pe + 4)? != b"PE\0\0" {
        return None;
    }
    let optional = pe + 24;
    let (rva_count_at, dirs) = match u16le(b, optional)? {
        0x10b => (optional + 92, optional + 96),
        0x20b => (optional + 108, optional + 112),
        _ => return None,
    };
    if u32le(b, rva_count_at)? < 5 {
        return None;
    }
    let security_entry = dirs + 4 * 8;
    Some(PeLayout {
        checksum: optional + 64,
        security_entry,
        cert_offset: u32le(b, security_entry)? as usize,
        cert_size: u32le(b, security_entry + 4)? as usize,
    })
}

/// Authenticode image hash: everything except the checksum, the security directory entry and
/// the attribute certificate table.
fn authenticode_digest<D: Digest>(b: &[u8], layout: &PeLayout) -> Option<Vec<u8>> {
    let end = if layout.cert_size > 0 {
        layout.cert_offset
    } else {
        b.len()
    };
    if layout.checksum + 4 > layout.security_entry || layout.security_entry + 8 > end {
        return None;
    }
    let mut hasher = D::new();
    hasher.update(&b[..layout.checksum]);
    hasher.update(&b[layout.checksum + 4..layout.security_entry]);
    hasher.update(&b[layout.security_entry + 8..end]);
    if layout.cert_size > 0 && layout.cert_offset + layout.cert_size < b.len() {
        hasher.update(&b[layout.cert_offset + layout.cert_size..]);
    }
    Some(hasher.finalize().to_vec())
}

fn inspect_pe(file: &str, b: &[u8]) -> FileStatus {
    let Some(layout) = pe_layout(b) else {
        return FileStatus::new(file, "pe", "unknown").detail("Not a valid PE file");
    };
    if layout.cert_offset == 0 || layout.cert_size == 0 {
        return FileStatus::new(file, "pe", "unsigned");
    }
    let Some(table) = b.get(layout.cert_offset..layout.cert_offset + layout.cert_size) else {
        return FileStatus::new(file, "pe", "invalid")
            .detail("The certificate table points outside the file");
    };
    // WIN_CERTIFICATE { dwLength, wRevision, wCertificateType = 2 (PKCS_SIGNED_DATA), data }
    let length = u32le(table, 0).unwrap_or(0) as usize;
    if u16le(table, 6) != Some(2) || length < 8 || length > table.len() {
        return FileStatus::new(file, "pe", "unknown")
            .detail("Unsupported certificate table entry");
    }
    let Some(pkcs7) = parse_pkcs7(&table[8..length]) else {
        return FileStatus::new(file, "pe", "unknown")
            .detail("The Authenticode signature could not be parsed");
    };
    let digest = pkcs7.spc_digest.clone();
    let mut status = signed_status(file, "pe", pkcs7);
    if let Some((algorithm, expected)) = digest {
        let actual = match algorithm.as_slice() {
            a if a == oid::SHA256 => authenticode_digest::<Sha256>(b, &layout),
            a if a == oid::SHA1 => authenticode_digest::<Sha1>(b, &layout),
            _ => None,
        };
        if let Some(actual) = actual {
            let valid = actual == expected;
            status.digest_valid = Some(valid);
            if !valid {
                status.status = "invalid".into();
                status.detail =
                    Some("The file was modified after it was signed (digest mismatch)".into());
            }
        }
    }
    status
}

// ------------------------------------------------------------------ MSI

fn inspect_msi(file: &str, b: &[u8]) -> FileStatus {
    let Ok(mut compound) = cfb::CompoundFile::open(std::io::Cursor::new(b)) else {
        return FileStatus::new(file, "msi", "unknown").detail("Not a valid MSI file");
    };
    let mut signature = Vec::new();
    match compound.open_stream("/\u{5}DigitalSignature") {
        Ok(mut stream) => {
            if stream
                .by_ref()
                .take(4 * 1024 * 1024)
                .read_to_end(&mut signature)
                .is_err()
            {
                return FileStatus::new(file, "msi", "unknown")
                    .detail("The signature stream could not be read");
            }
        }
        Err(_) => return FileStatus::new(file, "msi", "unsigned"),
    }
    match parse_pkcs7(&signature) {
        Some(pkcs7) => signed_status(file, "msi", pkcs7),
        None => {
            FileStatus::new(file, "msi", "unknown").detail("The MSI signature could not be parsed")
        }
    }
}

// ------------------------------------------------------------------ Mach-O

const LC_CODE_SIGNATURE: u32 = 0x1d;
const CSMAGIC_EMBEDDED_SIGNATURE: u32 = 0xfade_0cc0;
const CSMAGIC_BLOBWRAPPER: u32 = 0xfade_0b01;
const CSSLOT_SIGNATURESLOT: u32 = 0x10000;

/// The code signature super blob of a thin Mach-O (little-endian, 32 or 64 bit).
fn macho_signature(b: &[u8]) -> Option<Option<&[u8]>> {
    let header = match u32le(b, 0)? {
        0xfeed_facf => 32,
        0xfeed_face => 28,
        _ => return None,
    };
    let ncmds = u32le(b, 16)?;
    let mut at = header;
    for _ in 0..ncmds.min(4096) {
        let cmd = u32le(b, at)?;
        let size = u32le(b, at + 4)? as usize;
        if cmd == LC_CODE_SIGNATURE {
            let off = u32le(b, at + 8)? as usize;
            let len = u32le(b, at + 12)? as usize;
            return Some(b.get(off..off.checked_add(len)?));
        }
        if size < 8 {
            return None;
        }
        at += size;
    }
    Some(None)
}

fn inspect_macho(file: &str, b: &[u8]) -> FileStatus {
    // Universal binaries: inspect the first slice (all slices are signed together).
    let slice = if u32be(b, 0) == Some(0xcafe_babe) {
        let offset = u32be(b, 16).unwrap_or(0) as usize;
        let size = u32be(b, 20).unwrap_or(0) as usize;
        match b.get(offset..offset.saturating_add(size)) {
            Some(s) => s,
            None => {
                return FileStatus::new(file, "macho", "unknown")
                    .detail("Malformed universal binary");
            }
        }
    } else {
        b
    };
    let blob = match macho_signature(slice) {
        None => {
            return FileStatus::new(file, "macho", "unknown").detail("Unsupported Mach-O layout");
        }
        Some(None) => return FileStatus::new(file, "macho", "unsigned"),
        Some(Some(blob)) => blob,
    };
    if u32be(blob, 0) != Some(CSMAGIC_EMBEDDED_SIGNATURE) {
        return FileStatus::new(file, "macho", "unknown").detail("Malformed code signature");
    }
    let count = u32be(blob, 8).unwrap_or(0).min(64) as usize;
    let cms = (0..count).find_map(|i| {
        let kind = u32be(blob, 12 + i * 8)?;
        let offset = u32be(blob, 16 + i * 8)? as usize;
        if kind != CSSLOT_SIGNATURESLOT || u32be(blob, offset)? != CSMAGIC_BLOBWRAPPER {
            return None;
        }
        let length = u32be(blob, offset + 4)? as usize;
        blob.get(offset + 8..offset + length.max(8))
    });
    match cms.filter(|c| !c.is_empty()).and_then(parse_pkcs7) {
        Some(pkcs7) => {
            let mut status = FileStatus::new(file, "macho", "signed");
            status.method = Some("apple".into());
            status.timestamped = Some(pkcs7.timestamped);
            status.signer = pkcs7.signer;
            status.detail = Some("Notarization cannot be checked offline".into());
            status
        }
        None => {
            let mut status = FileStatus::new(file, "macho", "unsigned")
                .detail("Ad-hoc signature (no signing identity)");
            status.method = Some("adhoc".into());
            status
        }
    }
}

// ------------------------------------------------------------------ ELF + minisign

fn inspect_elf(file: &str, path: &Path) -> FileStatus {
    let mut sig = path.as_os_str().to_owned();
    sig.push(".minisig");
    let Ok(text) = std::fs::read_to_string(PathBuf::from(sig)) else {
        return FileStatus::new(file, "elf", "unsigned");
    };
    let mut lines = text.lines();
    let _untrusted = lines.next();
    let key_id = lines.next().and_then(|l| {
        use base64::Engine as _;
        let raw = base64::engine::general_purpose::STANDARD
            .decode(l.trim())
            .ok()?;
        let id: [u8; 8] = raw.get(2..10)?.try_into().ok()?;
        Some(format!("{:016X}", u64::from_le_bytes(id)))
    });
    let Some(key_id) = key_id else {
        return FileStatus::new(file, "elf", "unknown").detail("The .minisig file is malformed");
    };
    let trusted = lines
        .next()
        .and_then(|l| l.strip_prefix("trusted comment: "))
        .map(str::to_string);
    let mut status = FileStatus::new(file, "elf", "signed");
    status.method = Some("minisign".into());
    status.signer = Some(SignerInfo {
        subject: format!("minisign key {key_id}"),
        issuer: None,
        serial: None,
        thumbprint_sha1: None,
        not_before: None,
        not_after: None,
    });
    status.detail = Some(match trusted {
        Some(t) => format!("Detached signature; trusted comment: {t}"),
        None => "Detached signature".into(),
    });
    status
}

// ------------------------------------------------------------------ inspection

/// Inspects one artifact on disk.
pub fn inspect(path: &Path) -> FileStatus {
    let file = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) => {
            return FileStatus::new(&file, "other", "unknown")
                .detail(format!("The file could not be read: {e}"));
        }
    };
    inspect_bytes(&file, path, &bytes)
}

fn inspect_bytes(file: &str, path: &Path, b: &[u8]) -> FileStatus {
    match b {
        [b'M', b'Z', ..] => inspect_pe(file, b),
        [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ..] => inspect_msi(file, b),
        [0x7f, b'E', b'L', b'F', ..] => inspect_elf(file, path),
        [0xcf, 0xfa, 0xed, 0xfe, ..]
        | [0xce, 0xfa, 0xed, 0xfe, ..]
        | [0xca, 0xfe, 0xba, 0xbe, ..] => inspect_macho(file, b),
        _ => FileStatus::new(file, "other", "unknown"),
    }
}

fn platform_status(files: &[FileStatus]) -> &'static str {
    let count = |s: &str| files.iter().filter(|f| f.status == s).count();
    if files.is_empty() {
        "unknown"
    } else if count("invalid") > 0 {
        "invalid"
    } else if count("signed") == files.len() {
        "signed"
    } else if count("signed") > 0 {
        "partially_signed"
    } else if count("unsigned") == files.len() {
        "unsigned"
    } else {
        "unknown"
    }
}

fn is_artifact(name: &str) -> bool {
    !(name.ends_with(".minisig") || name.ends_with(".sig") || name == "manifest.json")
}

/// Groups `(platform, path)` pairs into per-platform results.
fn summarize(mut files: Vec<(String, PathBuf)>) -> Vec<PlatformStatus> {
    files.sort();
    let mut out: Vec<PlatformStatus> = Vec::new();
    for (platform, path) in files {
        let status = inspect(&path);
        match out.last_mut() {
            Some(p) if p.platform == platform => p.files.push(status),
            _ => out.push(PlatformStatus {
                platform,
                status: String::new(),
                files: vec![status],
            }),
        }
    }
    for p in &mut out {
        p.status = platform_status(&p.files).to_string();
    }
    out
}

fn walk_bundle(dir: &Path) -> Vec<(String, PathBuf)> {
    let mut files = Vec::new();
    let Ok(platforms) = std::fs::read_dir(dir) else {
        return files;
    };
    for platform in platforms.flatten() {
        if !platform.path().is_dir() {
            continue;
        }
        let name = platform.file_name().to_string_lossy().to_string();
        if let Ok(entries) = std::fs::read_dir(platform.path()) {
            for entry in entries.flatten() {
                let file = entry.file_name().to_string_lossy().to_string();
                if entry.path().is_file() && is_artifact(&file) {
                    files.push((name.clone(), entry.path()));
                }
            }
        }
    }
    files
}

/// Code signing status of the agent bundle
#[utoipa::path(get, path = "/api/v1/settings/signing-status", tag = "Settings",
    summary = "Code signing status of the agent bundle",
    responses((status = 200, body = SigningStatus),
              (status = 401, description = "Sign-in required"),
              (status = 403, description = "Missing permission")))]
pub async fn status(State(state): State<AppState>, ctx: AuthCtx) -> ApiResult<Json<SigningStatus>> {
    ctx.require_global(perm::SETTINGS_MANAGE)?;
    let releases: Vec<(String, DateTime<Utc>, Vec<u8>)> =
        sqlx::query_as("SELECT version, imported_at, manifest FROM agent_releases")
            .fetch_all(&state.db)
            .await?;
    let newest = releases.into_iter().max_by(|a, b| version_cmp(&a.0, &b.0));
    let (source, version, imported_at, files) = match newest {
        Some((version, imported_at, manifest)) => {
            let manifest: ReleaseManifest = serde_json::from_slice(&manifest)
                .map_err(|e| ApiError::internal(format!("stored manifest is invalid: {e}")))?;
            let root = crate::agents::releases::releases_root(&state).join(&version);
            let files = manifest
                .files
                .iter()
                .filter(|f| is_artifact(&f.file))
                .map(|f| (f.platform.clone(), root.join(&f.platform).join(&f.file)))
                .collect();
            ("release", Some(version), Some(imported_at), files)
        }
        None => {
            let files = walk_bundle(&crate::agents::installers::dist_dir(&state));
            let source = if files.is_empty() {
                "none"
            } else {
                "distribution"
            };
            (source, None, None, files)
        }
    };
    let platforms = tokio::task::spawn_blocking(move || summarize(files))
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;
    Ok(Json(SigningStatus {
        source: source.to_string(),
        version,
        imported_at,
        platforms,
    }))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    // Minimal DER writer for building test signatures.
    fn der(tag: u8, content: &[u8]) -> Vec<u8> {
        let mut out = vec![tag];
        let len = content.len();
        if len < 0x80 {
            out.push(len as u8);
        } else {
            let bytes = (len as u32).to_be_bytes();
            let skip = bytes.iter().position(|b| *b != 0).unwrap_or(3);
            out.push(0x80 | (4 - skip) as u8);
            out.extend_from_slice(&bytes[skip..]);
        }
        out.extend_from_slice(content);
        out
    }

    fn cat(parts: &[&[u8]]) -> Vec<u8> {
        parts.concat()
    }

    fn test_cert() -> Vec<u8> {
        let ca = rustrmm_crypto::pki::generate_ca("RustRMM Test Code Signing").expect("ca");
        rustrmm_crypto::pki::cert_der(&ca.cert_pem).expect("der")
    }

    /// A PKCS#7 SignedData with the given certificate, SpcIndirectDataContent digest and an
    /// optional RFC 3161 timestamp attribute. The signature value is a placeholder.
    pub(crate) fn pkcs7(cert_der: &[u8], digest: Option<&[u8]>, timestamped: bool) -> Vec<u8> {
        let (_, cert) = x509_parser::parse_x509_certificate(cert_der).expect("cert");
        let issuer = cert.tbs_certificate.issuer.as_raw();
        let serial = der(0x02, cert.tbs_certificate.raw_serial());
        let sha256_alg = der(0x30, &cat(&[&der(0x06, oid::SHA256), &[0x05, 0x00]]));
        let encap = match digest {
            Some(d) => {
                let spc = der(
                    0x30,
                    &cat(&[
                        &der(
                            0x30,
                            &der(
                                0x06,
                                &[0x2b, 0x06, 0x01, 0x04, 0x01, 0x82, 0x37, 0x02, 0x01, 0x0f],
                            ),
                        ),
                        &der(0x30, &cat(&[&sha256_alg, &der(0x04, d)])),
                    ]),
                );
                der(
                    0x30,
                    &cat(&[&der(0x06, oid::SPC_INDIRECT_DATA), &der(0xa0, &spc)]),
                )
            }
            None => der(
                0x30,
                &der(
                    0x06,
                    &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x01],
                ),
            ),
        };
        let mut signer = cat(&[
            &der(0x02, &[1]),
            &der(0x30, &cat(&[issuer, &serial])),
            &sha256_alg,
            &der(
                0x30,
                &der(
                    0x06,
                    &[0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01],
                ),
            ),
            &der(0x04, &[0xab; 64]),
        ]);
        if timestamped {
            let attribute = der(
                0x30,
                &cat(&[
                    &der(0x06, oid::MS_RFC3161_TIMESTAMP),
                    &der(0x31, &der(0x30, &[])),
                ]),
            );
            signer.extend(der(0xa1, &attribute));
        }
        let signed_data = der(
            0x30,
            &cat(&[
                &der(0x02, &[1]),
                &der(0x31, &sha256_alg),
                &encap,
                &der(0xa0, cert_der),
                &der(0x31, &der(0x30, &signer)),
            ]),
        );
        der(
            0x30,
            &cat(&[&der(0x06, oid::SIGNED_DATA), &der(0xa0, &signed_data)]),
        )
    }

    /// A small PE32+ image with an empty data directory table.
    fn pe_image() -> Vec<u8> {
        let mut b = vec![0u8; 512];
        b[0..2].copy_from_slice(b"MZ");
        b[0x3c..0x40].copy_from_slice(&0x80u32.to_le_bytes());
        b[0x80..0x84].copy_from_slice(b"PE\0\0");
        let optional = 0x80 + 24;
        b[optional..optional + 2].copy_from_slice(&0x20bu16.to_le_bytes());
        b[optional + 108..optional + 112].copy_from_slice(&16u32.to_le_bytes());
        for (i, byte) in b.iter_mut().enumerate().skip(400) {
            *byte = (i % 7) as u8;
        }
        b
    }

    /// Appends an Authenticode signature like signtool/osslsigncode do.
    fn sign_pe(mut b: Vec<u8>, cert: &[u8]) -> Vec<u8> {
        let layout = pe_layout(&b).expect("layout");
        while !b.len().is_multiple_of(8) {
            b.push(0);
        }
        let offset = b.len();
        let digest = authenticode_digest::<Sha256>(
            &b,
            &PeLayout {
                cert_offset: offset,
                cert_size: 0,
                ..layout
            },
        )
        .expect("digest");
        let sig = pkcs7(cert, Some(&digest), true);
        let mut entry = Vec::new();
        let length = (8 + sig.len()) as u32;
        entry.extend_from_slice(&length.to_le_bytes());
        entry.extend_from_slice(&0x0200u16.to_le_bytes());
        entry.extend_from_slice(&2u16.to_le_bytes());
        entry.extend_from_slice(&sig);
        while !entry.len().is_multiple_of(8) {
            entry.push(0);
        }
        let se = layout.security_entry;
        b[se..se + 4].copy_from_slice(&(offset as u32).to_le_bytes());
        b[se + 4..se + 8].copy_from_slice(&(entry.len() as u32).to_le_bytes());
        b.extend_from_slice(&entry);
        b
    }

    #[test]
    fn unsigned_and_signed_pe_files() {
        let cert = test_cert();
        let unsigned = inspect_bytes("a.exe", Path::new("a.exe"), &pe_image());
        assert_eq!(unsigned.status, "unsigned");

        let signed = sign_pe(pe_image(), &cert);
        let status = inspect_bytes("a.exe", Path::new("a.exe"), &signed);
        assert_eq!(status.status, "signed", "{status:?}");
        assert_eq!(status.method.as_deref(), Some("authenticode"));
        assert_eq!(status.digest_valid, Some(true));
        assert_eq!(status.timestamped, Some(true));
        let signer = status.signer.expect("signer");
        assert!(
            signer.subject.contains("RustRMM Test Code Signing"),
            "{}",
            signer.subject
        );
        assert_eq!(
            signer.thumbprint_sha1.as_deref(),
            Some(hex::encode_upper(Sha1::digest(&cert)).as_str())
        );
        assert_eq!(signer.thumbprint_sha1.as_deref().map(str::len), Some(40));

        // Tampering after signing is detected.
        let mut tampered = signed.clone();
        tampered[450] ^= 0xff;
        let status = inspect_bytes("a.exe", Path::new("a.exe"), &tampered);
        assert_eq!(status.status, "invalid");
        assert_eq!(status.digest_valid, Some(false));

        // Garbage in the certificate table is "unknown", never a panic.
        let mut broken = signed;
        let offset = pe_layout(&broken).expect("layout").cert_offset;
        for byte in &mut broken[offset + 8..offset + 24] {
            *byte = 0xee;
        }
        let status = inspect_bytes("a.exe", Path::new("a.exe"), &broken);
        assert_eq!(status.status, "unknown");
    }

    #[test]
    fn msi_signature_stream() {
        let cert = test_cert();
        let make = |signature: Option<Vec<u8>>| -> Vec<u8> {
            let mut compound =
                cfb::CompoundFile::create(std::io::Cursor::new(Vec::new())).expect("cfb");
            {
                let mut stream = compound.create_stream("/Payload").expect("stream");
                std::io::Write::write_all(&mut stream, b"summary").expect("write");
            }
            if let Some(sig) = signature {
                let mut stream = compound
                    .create_stream("/\u{5}DigitalSignature")
                    .expect("stream");
                std::io::Write::write_all(&mut stream, &sig).expect("write");
            }
            compound.flush().expect("flush");
            compound.into_inner().into_inner()
        };
        let unsigned = inspect_bytes("a.msi", Path::new("a.msi"), &make(None));
        assert_eq!(unsigned.status, "unsigned", "{unsigned:?}");
        let signed = inspect_bytes(
            "a.msi",
            Path::new("a.msi"),
            &make(Some(pkcs7(&cert, Some(&[1; 32]), false))),
        );
        assert_eq!(signed.status, "signed", "{signed:?}");
        assert_eq!(signed.timestamped, Some(false));
        assert!(
            signed
                .signer
                .expect("signer")
                .subject
                .contains("RustRMM Test")
        );
    }

    #[test]
    fn macho_and_elf_best_effort() {
        // Thin 64-bit Mach-O without LC_CODE_SIGNATURE.
        let mut macho = vec![0u8; 64];
        macho[0..4].copy_from_slice(&0xfeed_facfu32.to_le_bytes());
        assert_eq!(
            inspect_bytes("agent", Path::new("agent"), &macho).status,
            "unsigned"
        );

        // With a code signature containing a CMS blob.
        let cert = test_cert();
        let cms = pkcs7(&cert, None, true);
        let mut blob = Vec::new();
        blob.extend_from_slice(&CSMAGIC_EMBEDDED_SIGNATURE.to_be_bytes());
        blob.extend_from_slice(&0u32.to_be_bytes());
        blob.extend_from_slice(&1u32.to_be_bytes());
        blob.extend_from_slice(&CSSLOT_SIGNATURESLOT.to_be_bytes());
        blob.extend_from_slice(&20u32.to_be_bytes());
        blob.extend_from_slice(&CSMAGIC_BLOBWRAPPER.to_be_bytes());
        blob.extend_from_slice(&((cms.len() + 8) as u32).to_be_bytes());
        blob.extend_from_slice(&cms);
        let mut signed = vec![0u8; 32];
        signed[0..4].copy_from_slice(&0xfeed_facfu32.to_le_bytes());
        signed[16..20].copy_from_slice(&1u32.to_le_bytes());
        let sig_offset = 32 + 16;
        signed.extend_from_slice(&LC_CODE_SIGNATURE.to_le_bytes());
        signed.extend_from_slice(&16u32.to_le_bytes());
        signed.extend_from_slice(&(sig_offset as u32).to_le_bytes());
        signed.extend_from_slice(&(blob.len() as u32).to_le_bytes());
        signed.extend_from_slice(&blob);
        let status = inspect_bytes("agent", Path::new("agent"), &signed);
        assert_eq!(status.status, "signed", "{status:?}");
        assert_eq!(status.method.as_deref(), Some("apple"));

        // ELF with and without a minisign sidecar.
        let dir = tempfile::tempdir().expect("tempdir");
        let elf = dir.path().join("rustrmm-agent");
        std::fs::write(&elf, b"\x7fELF\x02\x01\x01").expect("write");
        assert_eq!(inspect(&elf).status, "unsigned");
        use base64::Engine as _;
        let mut raw = b"Ed".to_vec();
        raw.extend_from_slice(&0x1122_3344_5566_7788u64.to_le_bytes());
        raw.extend_from_slice(&[0u8; 64]);
        std::fs::write(
            dir.path().join("rustrmm-agent.minisig"),
            format!(
                "untrusted comment: signature from minisign secret key\n{}\ntrusted comment: RustRMM 0.2.0\nAAAA\n",
                base64::engine::general_purpose::STANDARD.encode(raw)
            ),
        )
        .expect("write");
        let status = inspect(&elf);
        assert_eq!(status.status, "signed");
        assert_eq!(
            status.signer.expect("signer").subject,
            "minisign key 1122334455667788"
        );
    }

    #[test]
    fn platform_rollup_and_garbage_input() {
        let f = |s: &str| FileStatus::new("x", "pe", s);
        assert_eq!(platform_status(&[f("signed"), f("signed")]), "signed");
        assert_eq!(
            platform_status(&[f("signed"), f("unsigned")]),
            "partially_signed"
        );
        assert_eq!(platform_status(&[f("unsigned")]), "unsigned");
        assert_eq!(platform_status(&[f("signed"), f("invalid")]), "invalid");
        assert_eq!(platform_status(&[]), "unknown");
        for len in 0..64 {
            let junk: Vec<u8> = (0..len).map(|i| (i * 37 % 256) as u8).collect();
            assert!(parse_pkcs7(&junk).is_none());
            let mut pe = b"MZ".to_vec();
            pe.extend_from_slice(&junk);
            let _ = inspect_bytes("x.exe", Path::new("x.exe"), &pe);
        }
    }
}

#[cfg(test)]
mod sample {
    /// Manual check against a real signed file: `RUSTRMM_SIGNING_SAMPLE=<path> cargo test …`.
    #[test]
    #[ignore = "needs RUSTRMM_SIGNING_SAMPLE"]
    fn inspect_sample() {
        let path = std::env::var("RUSTRMM_SIGNING_SAMPLE").expect("RUSTRMM_SIGNING_SAMPLE");
        let status = super::inspect(std::path::Path::new(&path));
        println!("{}", serde_json::to_string_pretty(&status).expect("json"));
    }
}
