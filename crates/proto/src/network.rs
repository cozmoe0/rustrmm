//! Network discovery and SNMP monitoring from a site probe agent (see
//! `docs/api-escrow-network.md`, "Network discovery" and "SNMP monitoring").
//!
//! * [`NetworkScan`] (signed command): sweep private IPv4 ranges; the probe streams
//!   [`ScanResults`] in batches.
//! * [`SnmpConfig`] (signed command, because it carries decrypted credentials): the devices the
//!   probe polls and the trap receiver settings. The probe keeps it in memory only.
//! * [`SnmpResults`] / [`SnmpTrap`] (agent → server): samples, unreachable devices and traps.
//! * `Command::SnmpTest` (signed): poll one device once.

use std::net::{IpAddr, Ipv4Addr};

use serde::{Deserialize, Serialize};

use crate::Message;

/// Largest range a scan may cover (a /20).
pub const MAX_RANGE_HOSTS: u32 = 4096;
/// Smallest prefix length accepted for a scan range.
pub const MIN_PREFIX: u8 = 20;
/// Default TCP ports probed by a scan.
pub const DEFAULT_TCP_PORTS: &[u16] = &[22, 80, 443, 445, 3389, 9100, 161];
/// Bounds the agent enforces whatever the server sends.
pub const MAX_CONCURRENCY: u32 = 256;
pub const MAX_TIMEOUT_MS: u32 = 10_000;
/// Poll interval bounds for SNMP devices.
pub const MIN_POLL_SECS: u32 = 30;
pub const MAX_POLL_SECS: u32 = 86_400;

/// Which discovery methods a scan uses.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScanMethods {
    #[serde(default = "yes")]
    pub icmp: bool,
    #[serde(default = "yes")]
    pub arp: bool,
    #[serde(default = "default_ports")]
    pub tcp_ports: Vec<u16>,
    #[serde(default = "yes")]
    pub snmp: bool,
    #[serde(default = "yes")]
    pub mdns: bool,
    #[serde(default = "yes")]
    pub netbios: bool,
}

impl Default for ScanMethods {
    fn default() -> Self {
        Self {
            icmp: true,
            arp: true,
            tcp_ports: default_ports(),
            snmp: true,
            mdns: true,
            netbios: true,
        }
    }
}

fn yes() -> bool {
    true
}

fn default_ports() -> Vec<u16> {
    DEFAULT_TCP_PORTS.to_vec()
}

fn default_concurrency() -> u32 {
    64
}

fn default_timeout_ms() -> u32 {
    800
}

fn default_snmp_port() -> u16 {
    161
}

fn default_trap_port() -> u16 {
    162
}

fn default_poll_secs() -> u32 {
    300
}

/// SNMPv3 user-based security settings.
#[derive(Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct SnmpV3 {
    pub username: String,
    /// `none` | `sha` | `sha256`
    #[serde(default = "none")]
    pub auth: String,
    #[serde(default)]
    pub auth_password: String,
    /// `none` | `aes128`
    #[serde(default = "none")]
    pub privacy: String,
    #[serde(default)]
    pub privacy_password: String,
}

fn none() -> String {
    "none".into()
}

impl std::fmt::Debug for SnmpV3 {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SnmpV3")
            .field("username", &self.username)
            .field("auth", &self.auth)
            .field("privacy", &self.privacy)
            .finish_non_exhaustive()
    }
}

/// An SNMP credential as the probe uses it (decrypted; travels only inside signed commands).
#[derive(Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct SnmpCredential {
    /// `v2c` | `v3`
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub community: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub v3: Option<SnmpV3>,
}

impl std::fmt::Debug for SnmpCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SnmpCredential")
            .field("version", &self.version)
            .field("v3", &self.v3)
            .finish_non_exhaustive()
    }
}

/// Server → agent (signed): sweep the ranges with the chosen methods.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NetworkScan {
    pub scan_id: String,
    /// The scan run this command belongs to (echoed in every [`ScanResults`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    pub ranges: Vec<String>,
    #[serde(default)]
    pub methods: ScanMethods,
    #[serde(default)]
    pub snmp: Vec<SnmpCredential>,
    #[serde(default = "default_concurrency")]
    pub concurrency: u32,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u32,
    /// Ranges outside private address space are refused unless the server allows them.
    #[serde(default)]
    pub allow_public: bool,
}

/// `sysDescr`, `sysName` and `sysObjectID` of a discovered host.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SnmpSysInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sys_descr: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sys_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sys_object_id: Option<String>,
}

/// One host found by a scan.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ScanHost {
    pub ip: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mac: Option<String>,
    /// OUI vendor (the server fills it from its bundled table when the agent leaves it out).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vendor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hostname: Option<String>,
    #[serde(default)]
    pub open_ports: Vec<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snmp: Option<SnmpSysInfo>,
    /// mDNS service types and instance names the host announced.
    #[serde(default)]
    pub mdns: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub netbios_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rtt_ms: Option<f64>,
}

/// Agent → server: a batch of hosts; the last batch has `done: true`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ScanResults {
    pub scan_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(default)]
    pub hosts: Vec<ScanHost>,
    #[serde(default)]
    pub done: bool,
    /// Set on the final batch when the scan failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Message for ScanResults {
    const TYPE: &'static str = "scan_results";
}

/// One OID the probe reads from a device.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SnmpOid {
    pub key: String,
    /// Numeric dotted OID; for tables the column OID (walked).
    pub oid: String,
    #[serde(default)]
    pub table: bool,
}

/// One device the probe polls (or tests once).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SnmpTarget {
    pub id: String,
    pub ip: String,
    #[serde(default = "default_snmp_port")]
    pub port: u16,
    pub credential: SnmpCredential,
    #[serde(default)]
    pub oids: Vec<SnmpOid>,
    #[serde(default = "default_poll_secs")]
    pub poll_interval_secs: u32,
}

/// Trap receiver settings for the probe's site.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrapReceiver {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_trap_port")]
    pub port: u16,
}

impl Default for TrapReceiver {
    fn default() -> Self {
        Self {
            enabled: false,
            port: default_trap_port(),
        }
    }
}

/// Server → agent (signed): everything the probe polls. Replaces the previous configuration.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SnmpConfig {
    /// Hash of the configuration (see [`SnmpConfig::content_hash`]).
    pub version: String,
    #[serde(default)]
    pub devices: Vec<SnmpTarget>,
    #[serde(default)]
    pub trap_receiver: TrapReceiver,
}

impl Message for SnmpConfig {
    const TYPE: &'static str = "snmp_config";
}

impl SnmpConfig {
    pub fn new(devices: Vec<SnmpTarget>, trap_receiver: TrapReceiver) -> Self {
        let mut config = Self {
            version: String::new(),
            devices,
            trap_receiver,
        };
        config.version = config.content_hash();
        config
    }

    /// Lowercase hex SHA-256 over the devices and trap settings.
    pub fn content_hash(&self) -> String {
        let body =
            rmp_serde::to_vec_named(&(&self.devices, &self.trap_receiver)).unwrap_or_default();
        rustrmm_crypto::random::sha256_hex(&body)
    }
}

/// One polled value. `value` is a number (counters as unsigned integers) or a string.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SnmpValue {
    pub key: String,
    /// Table row index (the OID suffix after the column), for table metrics.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub index: Option<String>,
    pub value: serde_json::Value,
    /// SNMP type: `integer` | `counter32` | `counter64` | `gauge32` | `timeticks` | `string` |
    /// `oid` | `ip` | `opaque`.
    #[serde(rename = "type", default, skip_serializing_if = "String::is_empty")]
    pub kind: String,
}

/// All values read from one device in one poll.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SnmpSample {
    pub device_id: String,
    /// Agent clock, unix milliseconds.
    pub at: i64,
    #[serde(default)]
    pub values: Vec<SnmpValue>,
}

/// Agent → server: poll results.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SnmpResults {
    #[serde(default)]
    pub samples: Vec<SnmpSample>,
    #[serde(default)]
    pub unreachable: Vec<String>,
}

impl Message for SnmpResults {
    const TYPE: &'static str = "snmp_results";
}

/// One trap variable binding.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TrapVarbind {
    pub oid: String,
    #[serde(rename = "type", default)]
    pub kind: String,
    pub value: serde_json::Value,
}

/// Agent → server: a received trap (or inform).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SnmpTrap {
    pub from_ip: String,
    /// Agent clock, unix milliseconds.
    pub at: i64,
    /// `v1` | `v2c`
    pub version: String,
    /// The trap OID (`snmpTrapOID.0`; for SNMPv1 traps the RFC 3584 translation).
    pub oid: String,
    #[serde(default)]
    pub varbinds: Vec<TrapVarbind>,
}

impl Message for SnmpTrap {
    const TYPE: &'static str = "snmp_trap";
}

// ------------------------------------------------------------------ address ranges

/// RFC 1918, CGNAT (100.64.0.0/10) or link-local (169.254.0.0/16).
pub fn is_private_v4(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    ip.is_private() || ip.is_link_local() || (o[0] == 100 && (o[1] & 0xC0) == 64)
}

/// [`is_private_v4`] for IPv4; IPv6 unique-local (fc00::/7) or link-local (fe80::/10).
pub fn is_private(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_private_v4(v4),
        IpAddr::V6(v6) => {
            let seg = v6.segments()[0];
            (seg & 0xFE00) == 0xFC00 || (seg & 0xFFC0) == 0xFE80
        }
    }
}

/// An IPv4 network parsed from `a.b.c.d/nn` or a single address.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Range {
    pub network: Ipv4Addr,
    pub prefix: u8,
}

impl Range {
    pub fn parse(text: &str) -> Result<Self, String> {
        let text = text.trim();
        let (addr, prefix) = match text.split_once('/') {
            Some((a, p)) => (
                a,
                p.parse::<u8>()
                    .map_err(|_| format!("{text}: invalid prefix length"))?,
            ),
            None => (text, 32),
        };
        let ip: Ipv4Addr = addr
            .parse()
            .map_err(|_| format!("{text}: not an IPv4 address or CIDR range"))?;
        if prefix > 32 {
            return Err(format!("{text}: invalid prefix length"));
        }
        let mask = mask(prefix);
        let network = Ipv4Addr::from(u32::from(ip) & mask);
        Ok(Self { network, prefix })
    }

    fn first_last(&self) -> (u32, u32) {
        let start = u32::from(self.network);
        let end = start | !mask(self.prefix);
        (start, end)
    }

    /// Usable host addresses (network and broadcast excluded for /30 and wider).
    pub fn hosts(&self) -> impl Iterator<Item = Ipv4Addr> + use<> {
        let (start, end) = self.first_last();
        let (start, end) = if self.prefix <= 30 {
            (start + 1, end - 1)
        } else {
            (start, end)
        };
        (start..=end).map(Ipv4Addr::from)
    }

    pub fn host_count(&self) -> u32 {
        let (start, end) = self.first_last();
        let total = end - start + 1;
        if self.prefix <= 30 { total - 2 } else { total }
    }

    /// Every address of the range is private (see [`is_private_v4`]).
    pub fn is_private(&self) -> bool {
        let (start, end) = self.first_last();
        is_private_v4(Ipv4Addr::from(start)) && is_private_v4(Ipv4Addr::from(end))
    }
}

fn mask(prefix: u8) -> u32 {
    if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - u32::from(prefix))
    }
}

impl std::fmt::Display for Range {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}/{}", self.network, self.prefix)
    }
}

/// Validates one scan range: IPv4, at most a /20, private unless `allow_public`.
pub fn validate_range(text: &str, allow_public: bool) -> Result<Range, String> {
    let range = Range::parse(text)?;
    if range.prefix < MIN_PREFIX {
        return Err(format!(
            "{text}: ranges may cover at most a /{MIN_PREFIX} ({MAX_RANGE_HOSTS} hosts)"
        ));
    }
    if !allow_public && !range.is_private() {
        return Err(format!(
            "{text}: only private ranges (RFC 1918, CGNAT or link-local) may be scanned"
        ));
    }
    Ok(range)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Frame;

    #[test]
    fn private_range_enforcement() {
        for ok in [
            "10.0.0.0/24",
            "172.16.4.0/22",
            "192.168.1.0/24",
            "100.64.1.0/24",
            "169.254.10.0/24",
            "192.168.1.20",
        ] {
            assert!(validate_range(ok, false).is_ok(), "{ok}");
        }
        for bad in [
            "8.8.8.0/24",
            "172.32.0.0/24",
            "100.128.0.0/24",
            "127.0.0.1/32",
            "192.169.0.0/24",
        ] {
            assert!(validate_range(bad, false).is_err(), "{bad} is not private");
        }
        assert!(validate_range("8.8.8.0/24", true).is_ok());
        assert!(
            validate_range("10.0.0.0/19", false).is_err(),
            "larger than a /20"
        );
        assert!(validate_range("10.0.0.0/20", false).is_ok());
        assert!(validate_range("172.31.255.0/20", false).is_ok());
        // A range straddling the edge of private space is not private.
        assert!(!Range::parse("172.16.0.0/11").expect("parse").is_private());
        assert!(validate_range("not-an-ip", false).is_err());
        assert!(validate_range("10.0.0.0/33", false).is_err());
        assert!(is_private("fd00::1".parse().expect("ip")));
        assert!(is_private("fe80::1".parse().expect("ip")));
        assert!(!is_private("2001:db8::1".parse().expect("ip")));
    }

    #[test]
    fn ranges_expand_to_hosts() {
        let r = Range::parse("192.168.1.77/24").expect("parse");
        assert_eq!(r.network, Ipv4Addr::new(192, 168, 1, 0));
        assert_eq!(r.host_count(), 254);
        let hosts: Vec<_> = r.hosts().collect();
        assert_eq!(hosts.first(), Some(&Ipv4Addr::new(192, 168, 1, 1)));
        assert_eq!(hosts.last(), Some(&Ipv4Addr::new(192, 168, 1, 254)));
        let single = Range::parse("10.1.2.3").expect("parse");
        assert_eq!(
            single.hosts().collect::<Vec<_>>(),
            vec![Ipv4Addr::new(10, 1, 2, 3)]
        );
        assert_eq!(
            Range::parse("10.0.0.0/20").expect("parse").host_count(),
            4094
        );
        assert_eq!(single.to_string(), "10.1.2.3/32");
    }

    #[test]
    fn network_messages_round_trip_and_hide_secrets() {
        let config = SnmpConfig::new(
            vec![SnmpTarget {
                id: "dev-1".into(),
                ip: "192.168.1.50".into(),
                port: 161,
                credential: SnmpCredential {
                    version: "v3".into(),
                    community: None,
                    v3: Some(SnmpV3 {
                        username: "monitor".into(),
                        auth: "sha256".into(),
                        auth_password: "auth-secret-1".into(),
                        privacy: "aes128".into(),
                        privacy_password: "priv-secret-1".into(),
                    }),
                },
                oids: vec![SnmpOid {
                    key: "sysUpTime".into(),
                    oid: "1.3.6.1.2.1.1.3.0".into(),
                    table: false,
                }],
                poll_interval_secs: 60,
            }],
            TrapReceiver {
                enabled: true,
                port: 162,
            },
        );
        assert_eq!(config.version, config.content_hash());
        let back: SnmpConfig = Frame::decode(&crate::encode(&config).expect("encode"))
            .expect("decode")
            .body()
            .expect("body");
        assert_eq!(back, config);
        let debug = format!("{back:?}");
        assert!(!debug.contains("auth-secret-1") && !debug.contains("priv-secret-1"));
        let community = SnmpCredential {
            version: "v2c".into(),
            community: Some("public-secret".into()),
            v3: None,
        };
        assert!(!format!("{community:?}").contains("public-secret"));

        let results = ScanResults {
            scan_id: "s1".into(),
            run_id: Some("r1".into()),
            hosts: vec![ScanHost {
                ip: "192.168.1.10".into(),
                mac: Some("00:11:22:33:44:55".into()),
                open_ports: vec![9100, 80],
                snmp: Some(SnmpSysInfo {
                    sys_descr: Some("HP LaserJet".into()),
                    ..Default::default()
                }),
                rtt_ms: Some(1.5),
                ..Default::default()
            }],
            done: true,
            error: None,
        };
        let back: ScanResults = Frame::decode(&crate::encode(&results).expect("encode"))
            .expect("decode")
            .body()
            .expect("body");
        assert_eq!(back, results);

        let samples = SnmpResults {
            samples: vec![SnmpSample {
                device_id: "dev-1".into(),
                at: 1_700_000_000_000,
                values: vec![
                    SnmpValue {
                        key: "ifHCInOctets".into(),
                        index: Some("3".into()),
                        value: serde_json::json!(u64::MAX - 5),
                        kind: "counter64".into(),
                    },
                    SnmpValue {
                        key: "sysDescr".into(),
                        index: None,
                        value: serde_json::json!("Switch"),
                        kind: "string".into(),
                    },
                ],
            }],
            unreachable: vec!["dev-2".into()],
        };
        let back: SnmpResults = Frame::decode(&crate::encode(&samples).expect("encode"))
            .expect("decode")
            .body()
            .expect("body");
        assert_eq!(back, samples);
        assert_eq!(back.samples[0].values[0].value.as_u64(), Some(u64::MAX - 5));

        let trap = SnmpTrap {
            from_ip: "192.168.1.60".into(),
            at: 1,
            version: "v2c".into(),
            oid: "1.3.6.1.6.3.1.1.5.3".into(),
            varbinds: vec![TrapVarbind {
                oid: "1.3.6.1.2.1.2.2.1.1.2".into(),
                kind: "integer".into(),
                value: serde_json::json!(2),
            }],
        };
        let back: SnmpTrap = Frame::decode(&crate::encode(&trap).expect("encode"))
            .expect("decode")
            .body()
            .expect("body");
        assert_eq!(back, trap);
    }
}
