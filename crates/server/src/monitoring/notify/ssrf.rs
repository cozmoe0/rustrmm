//! The one HTTP client every outbound webhook goes through, guarded against server-side request
//! forgery.
//!
//! * Only `https` URLs, or `http` when the host is allowlisted.
//! * The server resolves the host itself and refuses loopback, private, link-local, CGNAT,
//!   multicast and other non-public addresses (IPv4-mapped and NAT64 IPv6 forms included)
//!   unless the host — or every resolved address — is in the monitoring setting
//!   `webhook_allowlist`.
//! * The connection is pinned to the checked addresses (no second lookup, so DNS rebinding
//!   cannot swap them), redirects are never followed, proxies from the environment are
//!   ignored, and connect and total timeouts apply.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use ipnet::IpNet;
use url::{Host, Url};

pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
pub const TOTAL_TIMEOUT: Duration = Duration::from_secs(15);
/// Response bodies are read only this far (for error messages).
const MAX_BODY: usize = 4096;

/// One allowlist entry.
#[derive(Debug, Clone, PartialEq)]
pub enum AllowEntry {
    Host(String),
    Net(IpNet),
}

impl AllowEntry {
    pub fn parse(entry: &str) -> Option<Self> {
        let entry = entry.trim().trim_end_matches('.').to_ascii_lowercase();
        if entry.is_empty() {
            return None;
        }
        if let Ok(net) = entry.parse::<IpNet>() {
            return Some(Self::Net(net));
        }
        if let Ok(ip) = entry
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<IpAddr>()
        {
            return Some(Self::Net(IpNet::from(ip)));
        }
        let valid = entry.len() <= 253
            && entry.split('.').all(|label| {
                !label.is_empty()
                    && label.len() <= 63
                    && !label.starts_with('-')
                    && label
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            });
        valid.then_some(Self::Host(entry))
    }
}

/// The parsed allowlist.
#[derive(Debug, Clone, Default)]
pub struct Allowlist(Vec<AllowEntry>);

impl Allowlist {
    pub fn new(entries: &[String]) -> Self {
        Self(
            entries
                .iter()
                .filter_map(|e| AllowEntry::parse(e))
                .collect(),
        )
    }

    fn host_allowed(&self, host: &str) -> bool {
        let host = host.trim_end_matches('.').to_ascii_lowercase();
        self.0
            .iter()
            .any(|e| matches!(e, AllowEntry::Host(h) if *h == host))
    }

    fn ip_allowed(&self, ip: IpAddr) -> bool {
        let ip = canonical(ip);
        self.0
            .iter()
            .any(|e| matches!(e, AllowEntry::Net(net) if net.contains(&ip)))
    }
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum GuardError {
    #[error("only http(s) URLs are allowed")]
    Scheme,
    #[error("plain http is only allowed for allowlisted hosts; use https")]
    PlainHttp,
    #[error("the URL has no host")]
    NoHost,
    #[error("URLs with credentials are not allowed")]
    Credentials,
    #[error(
        "{0} resolves to a non-public address ({1}); add it to the webhook allowlist to allow it"
    )]
    Blocked(String, IpAddr),
    #[error("{0} did not resolve to any address")]
    Unresolved(String),
}

/// IPv4-mapped (`::ffff:a.b.c.d`), IPv4-compatible (`::a.b.c.d`) and NAT64 (`64:ff9b::/96`)
/// addresses are judged by the IPv4 address they carry.
pub fn canonical(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return IpAddr::V4(v4);
            }
            let seg = v6.segments();
            if seg[0] == 0x64 && seg[1] == 0xff9b && seg[2..6] == [0, 0, 0, 0] {
                let o = v6.octets();
                return IpAddr::V4(Ipv4Addr::new(o[12], o[13], o[14], o[15]));
            }
            if seg[..6] == [0, 0, 0, 0, 0, 0] && !(seg[6] == 0 && seg[7] <= 1) {
                let o = v6.octets();
                return IpAddr::V4(Ipv4Addr::new(o[12], o[13], o[14], o[15]));
            }
            IpAddr::V6(v6)
        }
        v4 => v4,
    }
}

fn blocked_v4(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_multicast()
        || ip.is_broadcast()
        || ip.is_documentation()
        || o[0] == 0                                    // "this network"
        || (o[0] == 100 && (64..128).contains(&o[1]))    // CGNAT 100.64.0.0/10
        || (o[0] == 192 && o[1] == 0 && o[2] == 0)       // IETF protocol assignments
        || (o[0] == 198 && (18..20).contains(&o[1]))     // benchmarking 198.18.0.0/15
        || o[0] >= 240 // reserved
}

fn blocked_v6(ip: Ipv6Addr) -> bool {
    let seg = ip.segments();
    ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_multicast()
        || (seg[0] & 0xfe00) == 0xfc00          // unique local fc00::/7
        || (seg[0] & 0xffc0) == 0xfe80          // link-local fe80::/10
        || (seg[0] & 0xffc0) == 0xfec0          // site-local (deprecated) fec0::/10
        || (seg[0] == 0x2001 && seg[1] == 0x0db8) // documentation
        || (seg[0] == 0x0100 && seg[1..4] == [0, 0, 0]) // discard-only 100::/64
}

/// Whether an address is off limits for outbound webhooks.
pub fn is_blocked(ip: IpAddr) -> bool {
    match canonical(ip) {
        IpAddr::V4(v4) => blocked_v4(v4),
        IpAddr::V6(v6) => blocked_v6(v6),
    }
}

/// A URL that passed the guard, with the addresses the connection must use.
#[derive(Debug, Clone)]
pub struct Checked {
    pub url: Url,
    /// Set for domain names: the connection is pinned to these addresses.
    pub pinned: Option<(String, Vec<SocketAddr>)>,
}

/// Checks the scheme and host; `addrs` are the resolved addresses of a domain host.
pub fn evaluate(url: &Url, addrs: &[IpAddr], allow: &Allowlist) -> Result<(), GuardError> {
    if !url.username().is_empty() || url.password().is_some() {
        return Err(GuardError::Credentials);
    }
    let host = url.host().ok_or(GuardError::NoHost)?;
    let (name, literal) = match &host {
        Host::Domain(d) => (d.to_string(), None),
        Host::Ipv4(ip) => (ip.to_string(), Some(IpAddr::V4(*ip))),
        Host::Ipv6(ip) => (ip.to_string(), Some(IpAddr::V6(*ip))),
    };
    let candidates: Vec<IpAddr> = match literal {
        Some(ip) => vec![ip],
        None => addrs.to_vec(),
    };
    if candidates.is_empty() {
        return Err(GuardError::Unresolved(name));
    }
    let host_listed = literal.is_none() && allow.host_allowed(&name);
    let every_ip_listed = candidates.iter().all(|ip| allow.ip_allowed(*ip));
    let allowlisted = host_listed || every_ip_listed;
    match url.scheme() {
        "https" => {}
        "http" if allowlisted => {}
        "http" => return Err(GuardError::PlainHttp),
        _ => return Err(GuardError::Scheme),
    }
    if !allowlisted && let Some(ip) = candidates.iter().find(|ip| is_blocked(**ip)) {
        return Err(GuardError::Blocked(name, *ip));
    }
    Ok(())
}

/// Resolves and checks a URL at delivery time.
pub async fn check(url: &str, allow: &Allowlist) -> Result<Checked> {
    let url = Url::parse(url.trim()).context("invalid URL")?;
    if !matches!(url.scheme(), "http" | "https") {
        bail!(GuardError::Scheme);
    }
    let port = url.port_or_known_default().unwrap_or(443);
    let (addrs, pinned) = match url.host() {
        Some(Host::Domain(domain)) => {
            let domain = domain.to_string();
            let resolved: Vec<SocketAddr> = tokio::time::timeout(
                CONNECT_TIMEOUT,
                tokio::net::lookup_host((domain.as_str(), port)),
            )
            .await
            .map_err(|_| anyhow::anyhow!("resolving {domain} timed out"))?
            .with_context(|| format!("resolving {domain}"))?
            .collect();
            let ips: Vec<IpAddr> = resolved.iter().map(SocketAddr::ip).collect();
            (ips, Some((domain, resolved)))
        }
        Some(_) => (Vec::new(), None),
        None => bail!(GuardError::NoHost),
    };
    evaluate(&url, &addrs, allow)?;
    Ok(Checked { url, pinned })
}

/// TLS configuration for outbound webhooks: ring provider and the platform's trust store.
pub(crate) fn tls_client_config() -> Result<rustls::ClientConfig> {
    static CONFIG: OnceLock<Arc<rustls::ClientConfig>> = OnceLock::new();
    if let Some(c) = CONFIG.get() {
        return Ok((**c).clone());
    }
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let verifier = rustls_platform_verifier::Verifier::new(provider.clone())
        .context("loading the platform certificate verifier")?;
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();
    let config = CONFIG.get_or_init(|| Arc::new(config));
    Ok((**config).clone())
}

/// Builds a client bound to the checked addresses.
fn client(checked: &Checked) -> Result<reqwest::Client> {
    let mut builder = reqwest::Client::builder()
        .use_preconfigured_tls(tls_client_config()?)
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(TOTAL_TIMEOUT)
        .user_agent(format!("RustRMM/{}", rustrmm_common::VERSION));
    if let Some((domain, addrs)) = &checked.pinned {
        builder = builder.resolve_to_addrs(domain, addrs);
    }
    builder.build().context("building HTTP client")
}

/// Outcome of one outbound request.
#[derive(Debug, Clone)]
pub struct Response {
    pub status: u16,
    pub body: String,
}

impl Response {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// Sends a POST through the guard. `headers` are added verbatim (validated by the caller).
pub async fn post(
    url: &str,
    allow: &Allowlist,
    headers: &[(String, String)],
    content_type: &str,
    body: Vec<u8>,
) -> Result<Response> {
    let checked = check(url, allow).await?;
    let client = client(&checked)?;
    let mut request = client
        .post(checked.url.clone())
        .header(reqwest::header::CONTENT_TYPE, content_type)
        .body(body);
    for (name, value) in headers {
        request = request.header(name.as_str(), value.as_str());
    }
    let response = request.send().await.map_err(|e| {
        // reqwest errors include the URL, which can hold a webhook token.
        anyhow::anyhow!("request failed: {}", describe(&e))
    })?;
    let status = response.status().as_u16();
    let mut body = Vec::new();
    let mut stream = response;
    while let Ok(Some(chunk)) = stream.chunk().await {
        body.extend_from_slice(&chunk);
        if body.len() >= MAX_BODY {
            body.truncate(MAX_BODY);
            break;
        }
    }
    Ok(Response {
        status,
        body: String::from_utf8_lossy(&body).to_string(),
    })
}

fn describe(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "timed out".into()
    } else if e.is_connect() {
        "could not connect".into()
    } else if e.is_redirect() {
        "redirects are not followed".into()
    } else {
        let mut source: Option<&dyn std::error::Error> = std::error::Error::source(e);
        let mut last = String::from("transport error");
        while let Some(s) = source {
            last = s.to_string();
            source = s.source();
        }
        last
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().expect("ip")
    }

    fn url(s: &str) -> Url {
        Url::parse(s).expect("url")
    }

    #[test]
    fn ipv4_ranges() {
        for blocked in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "100.127.255.254",
            "0.0.0.0",
            "0.1.2.3",
            "224.0.0.1",
            "239.255.255.250",
            "255.255.255.255",
            "192.0.0.8",
            "198.18.0.1",
            "240.0.0.1",
            "192.0.2.10",
        ] {
            assert!(is_blocked(ip(blocked)), "{blocked}");
        }
        for public in [
            "8.8.8.8",
            "1.1.1.1",
            "100.128.0.1",
            "172.32.0.1",
            "52.95.110.1",
            "198.20.0.1",
        ] {
            assert!(!is_blocked(ip(public)), "{public}");
        }
    }

    #[test]
    fn ipv6_ranges_and_embedded_ipv4() {
        for blocked in [
            "::1",
            "::",
            "fc00::1",
            "fd12:3456::1",
            "fe80::1",
            "fec0::1",
            "ff02::1",
            "2001:db8::1",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            "::ffff:169.254.169.254",
            "64:ff9b::a00:1",
            "::10.0.0.1",
            "100::1",
        ] {
            assert!(is_blocked(ip(blocked)), "{blocked}");
        }
        for public in [
            "2606:4700:4700::1111",
            "2001:4860:4860::8888",
            "::ffff:8.8.8.8",
            "64:ff9b::808:808",
        ] {
            assert!(!is_blocked(ip(public)), "{public}");
        }
        assert_eq!(canonical(ip("::ffff:192.168.0.1")), ip("192.168.0.1"));
    }

    #[test]
    fn urls_are_judged_by_scheme_host_and_resolved_addresses() {
        let none = Allowlist::default();
        assert_eq!(
            evaluate(&url("https://127.0.0.1/hook"), &[], &none),
            Err(GuardError::Blocked("127.0.0.1".into(), ip("127.0.0.1")))
        );
        assert!(matches!(
            evaluate(&url("https://[::ffff:10.0.0.1]/"), &[], &none),
            Err(GuardError::Blocked(..))
        ));
        assert_eq!(
            evaluate(
                &url("http://hooks.example.com/"),
                &[ip("93.184.216.34")],
                &none
            ),
            Err(GuardError::PlainHttp)
        );
        assert!(
            evaluate(
                &url("https://hooks.example.com/"),
                &[ip("93.184.216.34")],
                &none
            )
            .is_ok()
        );
        // A public name that resolves to a private address (DNS rebinding, internal names).
        assert!(matches!(
            evaluate(&url("https://evil.example.com/"), &[ip("93.184.216.34"), ip("10.0.0.5")], &none),
            Err(GuardError::Blocked(_, addr)) if addr == ip("10.0.0.5")
        ));
        assert_eq!(
            evaluate(&url("https://x.example.com/"), &[], &none),
            Err(GuardError::Unresolved("x.example.com".into()))
        );
        assert_eq!(
            evaluate(&url("ftp://example.com/"), &[ip("93.184.216.34")], &none),
            Err(GuardError::Scheme)
        );
        assert_eq!(
            evaluate(
                &url("https://user:pw@example.com/"),
                &[ip("93.184.216.34")],
                &none
            ),
            Err(GuardError::Credentials)
        );

        let allow = Allowlist::new(&[
            "127.0.0.1".into(),
            "hooks.internal".into(),
            "10.20.0.0/16".into(),
        ]);
        assert!(evaluate(&url("http://127.0.0.1:9000/hook"), &[], &allow).is_ok());
        assert!(
            evaluate(
                &url("http://hooks.internal/x"),
                &[ip("192.168.5.5")],
                &allow
            )
            .is_ok()
        );
        assert!(evaluate(&url("https://ci.corp/x"), &[ip("10.20.1.1")], &allow).is_ok());
        assert!(matches!(
            evaluate(
                &url("https://ci.corp/x"),
                &[ip("10.20.1.1"), ip("10.30.0.1")],
                &allow
            ),
            Err(GuardError::Blocked(..))
        ));
        assert!(matches!(
            evaluate(&url("https://127.0.0.2/"), &[], &allow),
            Err(GuardError::Blocked(..))
        ));
        assert_eq!(AllowEntry::parse("http://x"), None);
        assert_eq!(
            AllowEntry::parse("[::1]"),
            Some(AllowEntry::Net(IpNet::from(ip("::1"))))
        );
    }

    #[tokio::test]
    async fn names_resolving_to_loopback_are_refused() {
        let err = check("https://localhost:8443/hook", &Allowlist::default())
            .await
            .expect_err("localhost resolves to loopback");
        assert!(
            err.downcast_ref::<GuardError>()
                .is_some_and(|e| matches!(e, GuardError::Blocked(host, _) if host == "localhost")),
            "{err:#}"
        );
        let ok = check(
            "http://localhost:8443/hook",
            &Allowlist::new(&["localhost".into()]),
        )
        .await
        .expect("allowlisted host");
        assert!(ok.pinned.is_some_and(|(_, addrs)| !addrs.is_empty()));
    }
}
