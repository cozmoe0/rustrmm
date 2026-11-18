//! TLS client configuration.
//!
//! * After enrollment in internal-CA mode the stored CA certificate is the **only** trusted root.
//! * During enrollment the deploy key carries the CA's SPKI pin; [`PinnedCaVerifier`] finds that CA
//!   in the presented chain and then performs normal WebPKI validation (including host name) with
//!   it as the sole trust anchor. No trust-on-first-use.
//! * Without a pin (public / AD CS certificates) the operating system trust store is used.
//!
//! Independently of TLS, every connection authenticates the server's identity key.

use std::sync::Arc;

use anyhow::{Context, Result};
use rustls::client::WebPkiServerVerifier;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::CryptoProvider;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{
    ClientConfig, DigitallySignedStruct, Error as TlsError, RootCertStore, SignatureScheme,
};
use rustls_pki_types::pem::PemObject;

fn provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

/// Config for normal operation.
pub fn client_config(ca_cert_pem: Option<&str>) -> Result<Arc<ClientConfig>> {
    let provider = provider();
    let builder = ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()?;
    let mut config = match ca_cert_pem {
        Some(pem) => {
            let mut roots = RootCertStore::empty();
            for cert in CertificateDer::pem_slice_iter(pem.as_bytes()) {
                roots
                    .add(cert.context("invalid CA certificate")?)
                    .context("unusable CA certificate")?;
            }
            builder.with_root_certificates(roots).with_no_client_auth()
        }
        None => builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(rustls_platform_verifier::Verifier::new(
                provider,
            )?))
            .with_no_client_auth(),
    };
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(Arc::new(config))
}

/// Config for the first contact, trusting only the CA matching `pin` (or the OS store).
pub fn enrollment_config(pin: Option<&str>) -> Result<Arc<ClientConfig>> {
    let Some(pin) = pin else {
        return client_config(None);
    };
    let provider = provider();
    let mut config = ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(PinnedCaVerifier {
            pin: pin.to_string(),
            provider,
        }))
        .with_no_client_auth();
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(Arc::new(config))
}

#[derive(Debug)]
struct PinnedCaVerifier {
    pin: String,
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for PinnedCaVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, TlsError> {
        for candidate in intermediates {
            let matches =
                rustrmm_crypto::pki::spki_pin_der(candidate.as_ref()).is_ok_and(|p| p == self.pin);
            if !matches {
                continue;
            }
            let mut roots = RootCertStore::empty();
            roots
                .add(candidate.clone().into_owned())
                .map_err(|e| TlsError::General(format!("pinned CA unusable: {e}")))?;
            let inner =
                WebPkiServerVerifier::builder_with_provider(Arc::new(roots), self.provider.clone())
                    .build()
                    .map_err(|e| TlsError::General(e.to_string()))?;
            return inner.verify_server_cert(end_entity, &[], server_name, ocsp_response, now);
        }
        Err(TlsError::General(
            "server certificate is not issued by the RustRMM CA in the deploy key".into(),
        ))
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// HTTP client using a given TLS config.
pub fn http_client(config: Arc<ClientConfig>) -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .use_preconfigured_tls((*config).clone())
        .timeout(std::time::Duration::from_secs(60))
        .connect_timeout(std::time::Duration::from_secs(15))
        .user_agent(format!("rustrmm-agent/{}", crate::AGENT_VERSION))
        .build()
        .context("building HTTP client")
}
