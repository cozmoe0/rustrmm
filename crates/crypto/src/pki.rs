//! Internal certificate authority for the `internal` TLS mode.
//!
//! The CA (P-256, 10 years) signs a server leaf certificate (P-256, 1 year by default) whose key
//! stays stable across renewals so SPKI pins handed to agents keep working.

use std::net::IpAddr;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use chrono::{DateTime, Datelike, Duration, Utc};
use rcgen::{
    BasicConstraints, CertificateParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose, IsCa,
    Issuer, KeyPair, KeyUsagePurpose, PKCS_ECDSA_P256_SHA256, SanType,
};
use sha2::{Digest, Sha256};
use x509_parser::extensions::GeneralName;
use zeroize::Zeroizing;

use crate::{CryptoError, Result};

/// PEM-encoded CA certificate and private key.
pub struct CaMaterial {
    pub cert_pem: String,
    pub key_pem: Zeroizing<String>,
}

/// PEM-encoded leaf certificate and private key.
pub struct LeafMaterial {
    pub cert_pem: String,
    pub key_pem: Zeroizing<String>,
}

/// Facts about a certificate that callers care about.
#[derive(Debug, Clone)]
pub struct CertInfo {
    pub not_after: DateTime<Utc>,
    pub sans: Vec<String>,
    /// base64(SHA-256(SubjectPublicKeyInfo DER)) — the format used by `curl --pinnedpubkey`.
    pub spki_sha256: String,
}

fn rc_err(e: rcgen::Error) -> CryptoError {
    CryptoError::Format(format!("certificate generation failed: {e}"))
}

fn set_validity(params: &mut CertificateParams, from: DateTime<Utc>, to: DateTime<Utc>) {
    params.not_before = rcgen::date_time_ymd(from.year(), from.month() as u8, from.day() as u8);
    params.not_after = rcgen::date_time_ymd(to.year(), to.month() as u8, to.day() as u8);
}

/// Generates a new self-signed CA.
pub fn generate_ca(common_name: &str) -> Result<CaMaterial> {
    let key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).map_err(rc_err)?;
    let mut params = CertificateParams::new(Vec::<String>::new()).map_err(rc_err)?;
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, common_name);
    dn.push(DnType::OrganizationName, "RustRMM");
    params.distinguished_name = dn;
    params.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
    params.key_usages = vec![
        KeyUsagePurpose::KeyCertSign,
        KeyUsagePurpose::CrlSign,
        KeyUsagePurpose::DigitalSignature,
    ];
    let now = Utc::now();
    set_validity(
        &mut params,
        now - Duration::days(1),
        now + Duration::days(3650),
    );
    let cert = params.self_signed(&key).map_err(rc_err)?;
    Ok(CaMaterial {
        cert_pem: cert.pem(),
        key_pem: Zeroizing::new(key.serialize_pem()),
    })
}

/// Generates a new P-256 private key (PEM) for a leaf certificate.
pub fn generate_leaf_key() -> Result<Zeroizing<String>> {
    let key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).map_err(rc_err)?;
    Ok(Zeroizing::new(key.serialize_pem()))
}

/// Issues a server certificate for `sans` (DNS names and/or IP addresses), signed by `ca`,
/// using the existing leaf key `leaf_key_pem` so the public key (and pins) stay stable.
pub fn issue_server_cert(
    ca: &CaMaterial,
    leaf_key_pem: &str,
    sans: &[String],
    days: i64,
) -> Result<LeafMaterial> {
    if sans.is_empty() {
        return Err(CryptoError::Format(
            "a server certificate needs at least one subject alternative name".into(),
        ));
    }
    let ca_key = KeyPair::from_pem(&ca.key_pem).map_err(rc_err)?;
    let issuer = Issuer::from_ca_cert_pem(&ca.cert_pem, ca_key).map_err(rc_err)?;
    let leaf_key = KeyPair::from_pem(leaf_key_pem).map_err(rc_err)?;

    let mut params = CertificateParams::new(Vec::<String>::new()).map_err(rc_err)?;
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, sans[0].as_str());
    dn.push(DnType::OrganizationName, "RustRMM");
    params.distinguished_name = dn;
    params.subject_alt_names = sans
        .iter()
        .map(|san| match san.parse::<IpAddr>() {
            Ok(ip) => Ok(SanType::IpAddress(ip)),
            Err(_) => san
                .as_str()
                .try_into()
                .map(SanType::DnsName)
                .map_err(|e| CryptoError::Format(format!("invalid DNS name '{san}': {e}"))),
        })
        .collect::<Result<Vec<_>>>()?;
    params.is_ca = IsCa::ExplicitNoCa;
    params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    params.use_authority_key_identifier_extension = true;
    let now = Utc::now();
    set_validity(
        &mut params,
        now - Duration::days(1),
        now + Duration::days(days.max(2)),
    );
    let cert = params.signed_by(&leaf_key, &issuer).map_err(rc_err)?;
    Ok(LeafMaterial {
        cert_pem: cert.pem(),
        key_pem: Zeroizing::new(leaf_key_pem.to_string()),
    })
}

/// Parses the first certificate in a PEM bundle.
pub fn inspect_cert(cert_pem: &str) -> Result<CertInfo> {
    let (_, pem) = x509_parser::pem::parse_x509_pem(cert_pem.as_bytes())
        .map_err(|e| CryptoError::Format(format!("invalid certificate PEM: {e}")))?;
    let cert = pem
        .parse_x509()
        .map_err(|e| CryptoError::Format(format!("invalid certificate: {e}")))?;
    let not_after = DateTime::<Utc>::from_timestamp(cert.validity().not_after.timestamp(), 0)
        .ok_or_else(|| CryptoError::Format("certificate expiry out of range".into()))?;
    let mut sans = Vec::new();
    if let Ok(Some(ext)) = cert.subject_alternative_name() {
        for name in &ext.value.general_names {
            match name {
                GeneralName::DNSName(dns) => sans.push((*dns).to_string()),
                GeneralName::IPAddress(bytes) => {
                    if let Ok(v4) = <[u8; 4]>::try_from(*bytes) {
                        sans.push(IpAddr::from(v4).to_string());
                    } else if let Ok(v6) = <[u8; 16]>::try_from(*bytes) {
                        sans.push(IpAddr::from(v6).to_string());
                    }
                }
                _ => {}
            }
        }
    }
    let spki_sha256 = STANDARD.encode(Sha256::digest(cert.public_key().raw));
    Ok(CertInfo {
        not_after,
        sans,
        spki_sha256,
    })
}

/// base64(SHA-256(SubjectPublicKeyInfo)) of a DER certificate.
pub fn spki_pin_der(der: &[u8]) -> Result<String> {
    let (_, cert) = x509_parser::parse_x509_certificate(der)
        .map_err(|e| CryptoError::Format(format!("invalid certificate: {e}")))?;
    Ok(STANDARD.encode(Sha256::digest(cert.public_key().raw)))
}

/// Converts a PEM certificate into DER bytes (first certificate only).
pub fn cert_der(cert_pem: &str) -> Result<Vec<u8>> {
    let (_, pem) = x509_parser::pem::parse_x509_pem(cert_pem.as_bytes())
        .map_err(|e| CryptoError::Format(format!("invalid certificate PEM: {e}")))?;
    Ok(pem.contents)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ca_issues_leaf_with_stable_key() {
        let ca = generate_ca("RustRMM Test CA").expect("ca");
        let key = generate_leaf_key().expect("leaf key");
        let sans = vec!["rmm.example.test".to_string(), "127.0.0.1".to_string()];
        let first = issue_server_cert(&ca, &key, &sans, 365).expect("leaf");
        let second = issue_server_cert(&ca, &key, &sans, 365).expect("renewed leaf");

        let a = inspect_cert(&first.cert_pem).expect("inspect");
        let b = inspect_cert(&second.cert_pem).expect("inspect");
        assert_eq!(a.spki_sha256, b.spki_sha256, "renewal keeps the public key");
        assert!(a.sans.contains(&"rmm.example.test".to_string()));
        assert!(a.sans.contains(&"127.0.0.1".to_string()));
        assert!(a.not_after > Utc::now() + Duration::days(300));
    }

    #[test]
    fn rejects_empty_sans() {
        let ca = generate_ca("RustRMM Test CA").expect("ca");
        let key = generate_leaf_key().expect("leaf key");
        assert!(issue_server_cert(&ca, &key, &[], 30).is_err());
    }
}
