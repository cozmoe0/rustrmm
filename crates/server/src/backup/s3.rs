//! S3-compatible backup destination (AWS, Backblaze B2, MinIO, Wasabi, …).

use std::path::Path;
use std::sync::Arc;

use anyhow::{Context, Result};
use object_store::aws::AmazonS3Builder;
use object_store::path::Path as ObjectPath;
use object_store::{ObjectStore, ObjectStoreExt, PutPayload, WriteMultipart};
use tokio::io::AsyncReadExt;

pub struct S3Target {
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub prefix: String,
    pub access_key_id: String,
    pub secret_access_key: String,
}

impl S3Target {
    fn store(&self) -> Result<Arc<dyn ObjectStore>> {
        // object_store builds its own reqwest client, which takes rustls's process-wide provider
        // (aws-lc-rs is deliberately not in the tree; see deny.toml).
        crate::tls::install_default_provider();
        let mut builder = AmazonS3Builder::new()
            .with_region(if self.region.is_empty() {
                "us-east-1"
            } else {
                &self.region
            })
            .with_bucket_name(&self.bucket)
            .with_access_key_id(&self.access_key_id)
            .with_secret_access_key(&self.secret_access_key);
        if !self.endpoint.is_empty() {
            builder = builder
                .with_endpoint(&self.endpoint)
                .with_allow_http(self.endpoint.starts_with("http://"))
                .with_virtual_hosted_style_request(false);
        }
        Ok(Arc::new(builder.build().context("configuring S3 client")?))
    }

    fn object_path(&self, file_name: &str) -> ObjectPath {
        let prefix = self.prefix.trim_matches('/');
        if prefix.is_empty() {
            ObjectPath::from(file_name)
        } else {
            ObjectPath::from(format!("{prefix}/{file_name}"))
        }
    }

    /// Location string shown in the UI.
    pub fn location(&self, file_name: &str) -> String {
        format!("s3://{}/{}", self.bucket, self.object_path(file_name))
    }

    /// Streams a local file to the bucket using multipart upload.
    pub async fn upload(&self, local: &Path, file_name: &str) -> Result<String> {
        let store = self.store()?;
        let path = self.object_path(file_name);
        let upload = store
            .put_multipart(&path)
            .await
            .context("starting multipart upload")?;
        let mut writer = WriteMultipart::new_with_chunk_size(upload, 8 * 1024 * 1024);
        let mut file = tokio::fs::File::open(local).await?;
        let mut buf = vec![0u8; 4 * 1024 * 1024];
        loop {
            let n = file.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            writer
                .wait_for_capacity(4)
                .await
                .context("uploading part")?;
            writer.write(&buf[..n]);
        }
        writer
            .finish()
            .await
            .context("completing multipart upload")?;
        Ok(self.location(file_name))
    }

    pub async fn delete(&self, file_name: &str) -> Result<()> {
        let store = self.store()?;
        store
            .delete(&self.object_path(file_name))
            .await
            .context("deleting object")?;
        Ok(())
    }

    /// Writes and deletes a small probe object.
    pub async fn test(&self) -> Result<()> {
        let store = self.store()?;
        let path = self.object_path(&format!(".rustrmm-probe-{}", rustrmm_common::new_id()));
        store
            .put(
                &path,
                PutPayload::from_static(b"rustrmm connectivity probe"),
            )
            .await
            .context("writing probe object")?;
        store.delete(&path).await.context("deleting probe object")?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rustls_pki_types::pem::PemObject;
    use rustls_pki_types::{CertificateDer, PrivateKeyDer};
    use tokio::io::AsyncWriteExt;

    fn target(endpoint: String) -> S3Target {
        S3Target {
            endpoint,
            region: "us-east-1".into(),
            bucket: "backups".into(),
            prefix: "rmm".into(),
            access_key_id: "AKIAEXAMPLE".into(),
            secret_access_key: "secret".into(),
        }
    }

    /// SigV4 signing works with the ring provider (no aws-lc-rs in the tree): a fake S3 endpoint
    /// receives a signed PUT and DELETE.
    #[tokio::test]
    async fn requests_are_signed_without_aws_lc_rs() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    return;
                };
                let tx = tx.clone();
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut chunk = [0u8; 4096];
                    loop {
                        let Ok(n) = sock.read(&mut chunk).await else {
                            return;
                        };
                        if n == 0 {
                            return;
                        }
                        buf.extend_from_slice(&chunk[..n]);
                        let text = String::from_utf8_lossy(&buf).to_string();
                        if let Some(head_end) = text.find("\r\n\r\n") {
                            let head = text[..head_end].to_string();
                            let length = head
                                .lines()
                                .find_map(|l| {
                                    l.to_ascii_lowercase()
                                        .strip_prefix("content-length:")
                                        .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                                })
                                .unwrap_or(0);
                            if buf.len() >= head_end + 4 + length {
                                // Deletes are DeleteObjects calls (POST ?delete) answered in XML.
                                let key = text
                                    .split("<Key>")
                                    .nth(1)
                                    .and_then(|k| k.split("</Key>").next())
                                    .unwrap_or_default()
                                    .to_string();
                                let body = if head.starts_with("POST") {
                                    format!(
                                        "<?xml version=\"1.0\" encoding=\"UTF-8\"?><DeleteResult><Deleted><Key>{key}</Key></Deleted></DeleteResult>"
                                    )
                                } else {
                                    String::new()
                                };
                                let body = body.as_bytes();
                                let _ = tx.send(head);
                                buf.clear();
                                let response = format!(
                                    "HTTP/1.1 200 OK\r\nETag: \"abc\"\r\nContent-Length: {}\r\n\r\n",
                                    body.len()
                                );
                                let _ = sock.write_all(response.as_bytes()).await;
                                let _ = sock.write_all(body).await;
                            }
                        }
                    }
                });
            }
        });
        target(format!("http://{addr}"))
            .test()
            .await
            .expect("probe against the fake S3 endpoint");
        let mut methods = Vec::new();
        while let Ok(head) = rx.try_recv() {
            assert!(
                head.to_ascii_lowercase()
                    .contains("authorization: aws4-hmac-sha256"),
                "SigV4 signed: {head}"
            );
            methods.push(head.split(' ').next().unwrap_or_default().to_string());
        }
        assert_eq!(
            methods,
            ["PUT", "POST"],
            "probe written, then deleted (DeleteObjects)"
        );
    }

    /// HTTPS endpoints go through rustls (ring provider): an untrusted certificate fails the
    /// handshake on certificate verification, not for lack of TLS support.
    #[tokio::test]
    async fn https_endpoints_use_rustls_with_ring() {
        let ca = rustrmm_crypto::pki::generate_ca("S3 test CA").expect("ca");
        let key = rustrmm_crypto::pki::generate_leaf_key().expect("key");
        let leaf = rustrmm_crypto::pki::issue_server_cert(&ca, &key, &["127.0.0.1".into()], 1)
            .expect("leaf");
        let chain = vec![CertificateDer::from_pem_slice(leaf.cert_pem.as_bytes()).expect("cert")];
        let config = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .expect("versions")
        .with_no_client_auth()
        .with_single_cert(
            chain,
            PrivateKeyDer::from_pem_slice(key.as_bytes()).expect("key"),
        )
        .expect("config");
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        tokio::spawn(async move {
            while let Ok((sock, _)) = listener.accept().await {
                let _ = acceptor.accept(sock).await;
            }
        });
        let error = target(format!("https://{addr}"))
            .test()
            .await
            .expect_err("untrusted certificate");
        let text = format!("{error:#}").to_ascii_lowercase();
        assert!(
            text.contains("certificate"),
            "TLS ran and rejected the certificate: {text}"
        );
    }
}
