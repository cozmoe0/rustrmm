//! TLS setup for the console and agent listeners.
//!
//! `internal` mode runs a private CA under `<data>/pki`, issues a server certificate covering
//! every configured host name, and renews it automatically (stable key, so pins never change).
//! `custom` mode loads operator PEM files. `proxy` mode serves plain HTTP.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use arc_swap::ArcSwap;
use chrono::Utc;
use rustls::server::{ClientHello, ResolvesServerCert};
use rustls::sign::CertifiedKey;
use rustls_pki_types::pem::PemObject;
use rustls_pki_types::{CertificateDer, PrivateKeyDer};
use rustrmm_crypto::field::FieldCipher;
use rustrmm_crypto::keyfile;
use rustrmm_crypto::master::MasterKey;
use rustrmm_crypto::pki::{self, CaMaterial};
use zeroize::Zeroizing;

use crate::config::{ServeArgs, TlsMode};

/// Certificate resolver whose certificate can be swapped at runtime (renewal / reload).
#[derive(Debug)]
pub struct CertResolver {
    current: ArcSwap<CertifiedKey>,
}

impl CertResolver {
    fn new(key: CertifiedKey) -> Self {
        Self {
            current: ArcSwap::from_pointee(key),
        }
    }

    fn replace(&self, key: CertifiedKey) {
        self.current.store(Arc::new(key));
    }
}

impl ResolvesServerCert for CertResolver {
    fn resolve(&self, _client_hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        Some(self.current.load_full())
    }
}

/// Result of TLS preparation.
pub struct TlsSetup {
    pub mode: TlsMode,
    pub server_config: Option<Arc<rustls::ServerConfig>>,
    pub resolver: Option<Arc<CertResolver>>,
    /// PEM of the internal CA (internal mode) — offered for download and pinned by agents.
    pub ca_cert_pem: Option<String>,
    /// base64(SHA-256(SPKI)) of the internal CA.
    pub ca_spki_pin: Option<String>,
    /// base64(SHA-256(SPKI)) of the serving leaf (for `curl --pinnedpubkey`).
    pub leaf_spki_pin: Option<String>,
}

const CA_CERT: &str = "ca.crt";
const CA_KEY: &str = "ca.key";
const LEAF_CERT: &str = "server.crt";
const LEAF_KEY: &str = "server.key";
const LEAF_DAYS: i64 = 397;
const RENEW_WITHIN_DAYS: i64 = 30;

/// Installs ring as rustls's process-wide crypto provider (idempotent). Clients that build their
/// own TLS configuration (object_store's reqwest client for S3 backups) rely on it.
pub fn install_default_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

pub fn prepare(args: &ServeArgs, master: &MasterKey) -> Result<TlsSetup> {
    install_default_provider();
    match args.tls_mode {
        TlsMode::Proxy => Ok(TlsSetup {
            mode: TlsMode::Proxy,
            server_config: None,
            resolver: None,
            ca_cert_pem: None,
            ca_spki_pin: None,
            leaf_spki_pin: None,
        }),
        TlsMode::Custom => {
            let cert = args
                .tls_cert
                .as_ref()
                .context("RUSTRMM_TLS_CERT is required in custom TLS mode")?;
            let key = args
                .tls_key
                .as_ref()
                .context("RUSTRMM_TLS_KEY is required in custom TLS mode")?;
            let certified = load_custom(cert, key)?;
            let leaf_pem = std::fs::read_to_string(cert)?;
            let leaf_spki_pin = pki::inspect_cert(&leaf_pem).ok().map(|i| i.spki_sha256);
            let resolver = Arc::new(CertResolver::new(certified));
            Ok(TlsSetup {
                mode: TlsMode::Custom,
                server_config: Some(server_config(resolver.clone())?),
                resolver: Some(resolver),
                ca_cert_pem: None,
                ca_spki_pin: None,
                leaf_spki_pin,
            })
        }
        TlsMode::Internal => {
            let pki_dir = args.pki_dir();
            let wrap = FieldCipher::new(&master.derive("keyfile-wrap"));
            let ca = load_or_create_ca(&pki_dir, &wrap)?;
            let sans = required_sans(args);
            let (certified, leaf_pin) = ensure_leaf(&pki_dir, &wrap, &ca, &sans)?;
            let ca_pin = pki::inspect_cert(&ca.cert_pem)?.spki_sha256;
            let resolver = Arc::new(CertResolver::new(certified));
            Ok(TlsSetup {
                mode: TlsMode::Internal,
                server_config: Some(server_config(resolver.clone())?),
                resolver: Some(resolver),
                ca_cert_pem: Some(ca.cert_pem.clone()),
                ca_spki_pin: Some(ca_pin),
                leaf_spki_pin: Some(leaf_pin),
            })
        }
    }
}

/// Background task: re-checks the internal leaf daily and renews it before expiry.
pub fn spawn_renewal(args: ServeArgs, master_key: Arc<MasterKey>, resolver: Arc<CertResolver>) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(12 * 3600));
        interval.tick().await;
        loop {
            interval.tick().await;
            let args = args.clone();
            let master_key = master_key.clone();
            let result = tokio::task::spawn_blocking(move || -> Result<CertifiedKey> {
                let wrap = FieldCipher::new(&master_key.derive("keyfile-wrap"));
                let ca = load_or_create_ca(&args.pki_dir(), &wrap)?;
                let (certified, _) =
                    ensure_leaf(&args.pki_dir(), &wrap, &ca, &required_sans(&args))?;
                Ok(certified)
            })
            .await;
            match result {
                Ok(Ok(certified)) => resolver.replace(certified),
                Ok(Err(e)) => {
                    tracing::error!(error = %format!("{e:#}"), "certificate renewal check failed")
                }
                Err(e) => tracing::error!(error = %e, "certificate renewal task panicked"),
            }
        }
    });
}

fn server_config(resolver: Arc<CertResolver>) -> Result<Arc<rustls::ServerConfig>> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut config = rustls::ServerConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
        .context("configuring TLS protocol versions")?
        .with_no_client_auth()
        .with_cert_resolver(resolver);
    config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    Ok(Arc::new(config))
}

fn required_sans(args: &ServeArgs) -> Vec<String> {
    let mut sans = BTreeSet::new();
    for url in [
        Some(args.console_url.clone()),
        Some(args.effective_agent_url()),
    ]
    .into_iter()
    .flatten()
    {
        if let Some(host) = url.host_str() {
            sans.insert(
                host.trim_start_matches('[')
                    .trim_end_matches(']')
                    .to_string(),
            );
        }
    }
    for name in ["localhost", "127.0.0.1", "::1"] {
        sans.insert(name.to_string());
    }
    for var in ["COMPUTERNAME", "HOSTNAME"] {
        if let Ok(host) = std::env::var(var) {
            let host = host.trim().to_ascii_lowercase();
            if !host.is_empty() {
                sans.insert(host);
            }
        }
    }
    for extra in &args.extra_sans {
        let extra = extra.trim();
        if !extra.is_empty() {
            sans.insert(extra.to_string());
        }
    }
    // Put the console host first so it becomes the certificate CN.
    let mut ordered: Vec<String> = Vec::new();
    if let Some(host) = args.console_url.host_str() {
        ordered.push(
            host.trim_start_matches('[')
                .trim_end_matches(']')
                .to_string(),
        );
    }
    for san in sans {
        if !ordered.contains(&san) {
            ordered.push(san);
        }
    }
    ordered
}

fn load_or_create_ca(dir: &Path, wrap: &FieldCipher) -> Result<CaMaterial> {
    std::fs::create_dir_all(dir)?;
    let cert_path = dir.join(CA_CERT);
    let key_path = dir.join(CA_KEY);
    if cert_path.exists() && key_path.exists() {
        let cert_pem = std::fs::read_to_string(&cert_path)?;
        let key = keyfile::read_wrapped(&key_path, wrap, "pki-ca")?;
        let key_pem =
            Zeroizing::new(String::from_utf8(key.to_vec()).context("CA key is not UTF-8")?);
        return Ok(CaMaterial { cert_pem, key_pem });
    }
    let ca = pki::generate_ca("RustRMM Internal CA")?;
    keyfile::write_wrapped(&key_path, wrap, "pki-ca", ca.key_pem.as_bytes())?;
    std::fs::write(&cert_path, &ca.cert_pem)?;
    tracing::info!(path = %cert_path.display(), "generated internal certificate authority");
    Ok(ca)
}

fn ensure_leaf(
    dir: &Path,
    wrap: &FieldCipher,
    ca: &CaMaterial,
    sans: &[String],
) -> Result<(CertifiedKey, String)> {
    let cert_path = dir.join(LEAF_CERT);
    let key_path = dir.join(LEAF_KEY);
    let key_pem = if key_path.exists() {
        let key = keyfile::read_wrapped(&key_path, wrap, "pki-server")?;
        Zeroizing::new(String::from_utf8(key.to_vec()).context("server key is not UTF-8")?)
    } else {
        let key = pki::generate_leaf_key()?;
        keyfile::write_wrapped(&key_path, wrap, "pki-server", key.as_bytes())?;
        key
    };

    let needs_issue = match std::fs::read_to_string(&cert_path) {
        Ok(pem) => match pki::inspect_cert(&pem) {
            Ok(info) => {
                let expiring =
                    info.not_after - Utc::now() < chrono::Duration::days(RENEW_WITHIN_DAYS);
                let missing = sans
                    .iter()
                    .any(|s| !info.sans.iter().any(|have| have.eq_ignore_ascii_case(s)));
                expiring || missing
            }
            Err(_) => true,
        },
        Err(_) => true,
    };
    if needs_issue {
        let leaf = pki::issue_server_cert(ca, &key_pem, sans, LEAF_DAYS)?;
        std::fs::write(&cert_path, &leaf.cert_pem)?;
        tracing::info!(sans = ?sans, "issued internal server certificate");
    }
    let leaf_pem = std::fs::read_to_string(&cert_path)?;
    let pin = pki::inspect_cert(&leaf_pem)?.spki_sha256;
    let chain = vec![
        CertificateDer::from(pki::cert_der(&leaf_pem)?),
        CertificateDer::from(pki::cert_der(&ca.cert_pem)?),
    ];
    Ok((certified_key(chain, key_pem.as_bytes())?, pin))
}

fn load_custom(cert: &PathBuf, key: &PathBuf) -> Result<CertifiedKey> {
    let chain = CertificateDer::pem_file_iter(cert)
        .with_context(|| format!("reading {}", cert.display()))?
        .collect::<Result<Vec<_>, _>>()
        .with_context(|| format!("parsing certificates in {}", cert.display()))?;
    if chain.is_empty() {
        bail!("{} contains no certificates", cert.display());
    }
    let key_pem =
        Zeroizing::new(std::fs::read(key).with_context(|| format!("reading {}", key.display()))?);
    certified_key(chain, &key_pem)
}

fn certified_key(chain: Vec<CertificateDer<'static>>, key_pem: &[u8]) -> Result<CertifiedKey> {
    let key_der = PrivateKeyDer::from_pem_slice(key_pem).context("parsing private key PEM")?;
    let signing_key = rustls::crypto::ring::sign::any_supported_type(&key_der)
        .context("unsupported private key type")?;
    Ok(CertifiedKey::new(chain, signing_key))
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    fn args(dir: &Path) -> ServeArgs {
        crate::config::Cli::parse_from([
            "rustrmm-server",
            "--data-dir",
            dir.to_str().expect("utf8 path"),
            "--console-url",
            "https://rmm.example.test:8443",
        ])
        .serve
    }

    #[test]
    fn internal_mode_generates_and_reuses_pki() {
        let dir = tempfile::tempdir().expect("tempdir");
        let master = MasterKey::generate();
        let first = prepare(&args(dir.path()), &master).expect("prepare");
        assert!(first.server_config.is_some());
        let second = prepare(&args(dir.path()), &master).expect("prepare again");
        assert_eq!(first.ca_spki_pin, second.ca_spki_pin);
        assert_eq!(first.leaf_spki_pin, second.leaf_spki_pin);
        let info = pki::inspect_cert(
            &std::fs::read_to_string(dir.path().join("pki").join(LEAF_CERT)).expect("leaf"),
        )
        .expect("inspect");
        assert!(info.sans.contains(&"rmm.example.test".to_string()));
        assert!(info.sans.contains(&"localhost".to_string()));
    }
}
