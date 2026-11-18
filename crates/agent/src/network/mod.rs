//! Network discovery for site probes: ICMP sweep (TCP fallback when unprivileged), ARP table,
//! TCP connect probes, SNMP system queries, mDNS and NetBIOS names. Every scan is limited to
//! private ranges unless the server allows otherwise, paced (packets and connects per second)
//! and concurrency bounded; results stream back as `scan_results` batches through the outbox.

pub mod arp;
pub mod icmp;
pub mod mdns;
pub mod netbios;

use std::collections::{BTreeMap, BTreeSet};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use anyhow::{Result, bail};
use rustrmm_proto::commands::CommandResult;
use rustrmm_proto::network::{
    MAX_CONCURRENCY, MAX_TIMEOUT_MS, NetworkScan, Range, ScanHost, ScanResults, SnmpSysInfo,
    validate_range,
};
use serde_json::json;
use tokio::sync::{Mutex, Semaphore};

/// ICMP echo requests per second.
const ICMP_PPS: u32 = 400;
/// New TCP connections per second.
const CONNECTS_PER_SEC: u32 = 500;
/// Hosts per `scan_results` message.
const BATCH: usize = 64;
/// Ports used to find live hosts when ICMP is unavailable and the scan probes none.
const LIVENESS_PORTS: &[u16] = &[80, 443, 445, 22, 3389];
/// The most addresses one scan may cover (16 ranges of a /20).
const MAX_TARGETS: usize = 16 * 4096;

/// One scan at a time per agent.
static SCAN_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

/// Spaces out events to at most `per_sec` per second.
struct Pacer {
    gap: Duration,
    next: Mutex<tokio::time::Instant>,
}

impl Pacer {
    fn new(per_sec: u32) -> Self {
        Self {
            gap: Duration::from_secs_f64(1.0 / f64::from(per_sec.max(1))),
            next: Mutex::new(tokio::time::Instant::now()),
        }
    }

    async fn wait(&self) {
        let slot = {
            let mut next = self.next.lock().await;
            let slot = (*next).max(tokio::time::Instant::now());
            *next = slot + self.gap;
            slot
        };
        tokio::time::sleep_until(slot).await;
    }
}

#[derive(Debug, Default, Clone)]
struct Host {
    rtt_ms: Option<f64>,
    mac: Option<String>,
    ports: BTreeSet<u16>,
    snmp: Option<SnmpSysInfo>,
    netbios: Option<String>,
    hostname: Option<String>,
    mdns: BTreeSet<String>,
}

/// What the scan did, for the command result.
#[derive(Debug, Clone)]
pub struct Summary {
    pub hosts: usize,
    pub targets: usize,
    pub duration_ms: u128,
    pub icmp: &'static str,
}

/// IPv4 networks of this machine's interfaces.
fn local_networks() -> Vec<Range> {
    let Ok(networks) = sysinfo::Networks::new_with_refreshed_list() else {
        return Vec::new();
    };
    networks
        .values()
        .flat_map(|n| n.ip_networks().to_vec())
        .filter_map(|ip| match ip.addr {
            IpAddr::V4(v4) if !v4.is_loopback() => {
                Range::parse(&format!("{v4}/{}", ip.prefix)).ok()
            }
            _ => None,
        })
        .collect()
}

fn in_networks(ip: Ipv4Addr, networks: &[Range]) -> bool {
    networks.iter().any(|n| {
        let mask = if n.prefix == 0 {
            0
        } else {
            u32::MAX << (32 - u32::from(n.prefix))
        };
        u32::from(ip) & mask == u32::from(n.network)
    })
}

enum Probe {
    Open,
    Closed,
    Silent,
}

async fn tcp_probe(ip: Ipv4Addr, port: u16, timeout: Duration) -> Probe {
    match tokio::time::timeout(
        timeout,
        tokio::net::TcpStream::connect(SocketAddr::from((ip, port))),
    )
    .await
    {
        Ok(Ok(_)) => Probe::Open,
        // A reset means the host is up but nothing listens there.
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::ConnectionRefused => Probe::Closed,
        _ => Probe::Silent,
    }
}

/// Runs a scan, calling `emit` with each batch (the last one has `done: true`).
pub async fn scan<F>(scan: &NetworkScan, mut emit: F) -> Result<Summary>
where
    F: FnMut(ScanResults),
{
    let started = Instant::now();
    let mut targets: BTreeSet<Ipv4Addr> = BTreeSet::new();
    for text in &scan.ranges {
        let range = validate_range(text, scan.allow_public).map_err(|e| anyhow::anyhow!(e))?;
        targets.extend(range.hosts());
        if targets.len() > MAX_TARGETS {
            bail!("the scan covers more than {MAX_TARGETS} addresses");
        }
    }
    let targets: Vec<Ipv4Addr> = targets.into_iter().collect();
    let methods = &scan.methods;
    let concurrency = scan.concurrency.clamp(1, MAX_CONCURRENCY) as usize;
    let timeout = Duration::from_millis(u64::from(scan.timeout_ms.clamp(100, MAX_TIMEOUT_MS)));
    let local = local_networks();
    let mut hosts: BTreeMap<Ipv4Addr, Host> = BTreeMap::new();

    // 1. ICMP sweep.
    let mut icmp_mode = "off";
    if methods.icmp && !targets.is_empty() {
        let list = targets.clone();
        match tokio::task::spawn_blocking(move || icmp::sweep(&list, timeout, ICMP_PPS)).await? {
            Ok((mode, replies)) => {
                icmp_mode = mode.as_str();
                for (ip, rtt) in replies {
                    hosts.entry(ip).or_default().rtt_ms = Some((rtt * 100.0).round() / 100.0);
                }
            }
            Err(e) => {
                tracing::debug!(error = %e, "ICMP unavailable; using TCP probes for liveness");
                icmp_mode = "tcp-fallback";
            }
        }
    }
    let icmp_worked = matches!(icmp_mode, "raw" | "datagram");

    // 2. ARP entries (the sweep itself filled the cache for directly connected ranges).
    let add_arp = |hosts: &mut BTreeMap<Ipv4Addr, Host>, table: Vec<(Ipv4Addr, String)>| {
        for (ip, mac) in table {
            if targets.binary_search(&ip).is_ok() {
                hosts.entry(ip).or_default().mac.get_or_insert(mac);
            }
        }
    };
    if methods.arp {
        add_arp(
            &mut hosts,
            tokio::task::spawn_blocking(arp::read_table).await?,
        );
    }

    // 3. TCP connect probes: live hosts when ICMP worked (plus every address of routed ranges,
    //    which ARP cannot vouch for), every address otherwise.
    let mut ports: Vec<u16> = methods
        .tcp_ports
        .iter()
        .copied()
        .filter(|p| *p != 0)
        .collect();
    ports.sort_unstable();
    ports.dedup();
    let liveness_only = ports.is_empty() && !icmp_worked && methods.icmp;
    if liveness_only {
        ports = LIVENESS_PORTS.to_vec();
    }
    if !ports.is_empty() {
        let probe_targets: Vec<Ipv4Addr> = if icmp_worked {
            targets
                .iter()
                .copied()
                .filter(|ip| hosts.contains_key(ip) || !in_networks(*ip, &local))
                .collect()
        } else {
            targets.clone()
        };
        let pacer = Arc::new(Pacer::new(CONNECTS_PER_SEC));
        let permits = Arc::new(Semaphore::new(concurrency));
        let mut tasks = tokio::task::JoinSet::new();
        for ip in probe_targets {
            for port in ports.clone() {
                let (pacer, permits) = (pacer.clone(), permits.clone());
                tasks.spawn(async move {
                    let _permit = permits.acquire_owned().await;
                    pacer.wait().await;
                    (ip, port, tcp_probe(ip, port, timeout).await)
                });
            }
        }
        while let Some(done) = tasks.join_next().await {
            let Ok((ip, port, probe)) = done else {
                continue;
            };
            match probe {
                Probe::Open => {
                    let host = hosts.entry(ip).or_default();
                    if !liveness_only {
                        host.ports.insert(port);
                    }
                }
                Probe::Closed => {
                    hosts.entry(ip).or_default();
                }
                Probe::Silent => {}
            }
        }
        if methods.arp {
            add_arp(
                &mut hosts,
                tokio::task::spawn_blocking(arp::read_table).await?,
            );
        }
    }

    // 4. Names and SNMP facts of live hosts.
    let browse = if methods.mdns {
        Some(tokio::spawn(mdns::browse(Duration::from_millis(1500))))
    } else {
        None
    };
    let credentials: Vec<Arc<crate::snmp::client::Security>> = if methods.snmp {
        let creds = scan.snmp.clone();
        tokio::task::spawn_blocking(move || {
            creds
                .iter()
                .filter_map(|c| crate::snmp::client::Security::from_credential(c).ok())
                .map(Arc::new)
                .collect()
        })
        .await?
    } else {
        Vec::new()
    };
    let permits = Arc::new(Semaphore::new(concurrency.min(32)));
    let mut tasks = tokio::task::JoinSet::new();
    for ip in hosts.keys().copied().collect::<Vec<_>>() {
        let (permits, credentials) = (permits.clone(), credentials.clone());
        let (want_netbios, want_mdns) = (methods.netbios, methods.mdns);
        tasks.spawn(async move {
            let _permit = permits.acquire_owned().await;
            let mut snmp = None;
            for security in &credentials {
                if let Ok(system) = crate::snmp::system(
                    SocketAddr::from((ip, 161)),
                    security.clone_ref(),
                    timeout,
                    0,
                )
                .await
                {
                    snmp = Some(system.info);
                    break;
                }
            }
            let netbios = if want_netbios {
                netbios::query(ip, timeout).await
            } else {
                None
            };
            let hostname = if want_mdns {
                mdns::reverse_lookup(ip, timeout).await
            } else {
                None
            };
            (ip, snmp, netbios, hostname)
        });
    }
    while let Some(done) = tasks.join_next().await {
        let Ok((ip, snmp, netbios, hostname)) = done else {
            continue;
        };
        let host = hosts.entry(ip).or_default();
        host.snmp = snmp;
        if let Some((name, mac)) = netbios {
            host.netbios = Some(name);
            if host.mac.is_none() {
                host.mac = mac;
            }
        }
        host.hostname = hostname.map(|h| h.trim_end_matches('.').to_string());
    }
    if let Some(browse) = browse
        && let Ok(found) = browse.await
    {
        for (ip, services) in found {
            if let Some(host) = hosts.get_mut(&ip) {
                host.mdns.extend(services);
            }
        }
    }

    // 5. Report.
    let found: Vec<ScanHost> = hosts
        .into_iter()
        .map(|(ip, h)| ScanHost {
            ip: ip.to_string(),
            mac: h.mac,
            vendor: None,
            hostname: h.hostname,
            open_ports: h.ports.into_iter().collect(),
            snmp: h.snmp,
            mdns: h.mdns.into_iter().collect(),
            netbios_name: h.netbios,
            rtt_ms: h.rtt_ms,
        })
        .collect();
    let total = found.len();
    let mut chunks = found.chunks(BATCH).peekable();
    if chunks.peek().is_none() {
        emit(ScanResults {
            scan_id: scan.scan_id.clone(),
            run_id: scan.run_id.clone(),
            hosts: Vec::new(),
            done: true,
            error: None,
        });
    }
    while let Some(chunk) = chunks.next() {
        emit(ScanResults {
            scan_id: scan.scan_id.clone(),
            run_id: scan.run_id.clone(),
            hosts: chunk.to_vec(),
            done: chunks.peek().is_none(),
            error: None,
        });
    }
    Ok(Summary {
        hosts: total,
        targets: targets.len(),
        duration_ms: started.elapsed().as_millis(),
        icmp: icmp_mode,
    })
}

/// `Command::NetworkScan`: runs in the background; batches and the result go through the
/// outbox so they survive a reconnect.
pub fn spawn_scan(cmd_id: String, request: NetworkScan) {
    tokio::spawn(async move {
        let reply = |status: &str, message: String, data: serde_json::Value| CommandResult {
            cmd_id: cmd_id.clone(),
            status: status.into(),
            message,
            data,
        };
        let Ok(_guard) = SCAN_LOCK.try_lock() else {
            crate::outbox::result(reply(
                "rejected",
                "another network scan is running".into(),
                serde_json::Value::Null,
            ));
            return;
        };
        crate::outbox::result(reply("running", String::new(), serde_json::Value::Null));
        tracing::info!(scan = %request.scan_id, ranges = ?request.ranges, "network scan started");
        match scan(&request, |batch| crate::outbox::push(&batch)).await {
            Ok(summary) => {
                tracing::info!(scan = %request.scan_id, hosts = summary.hosts, ms = summary.duration_ms as u64, "network scan finished");
                crate::outbox::result(reply(
                    "succeeded",
                    format!("{} hosts found", summary.hosts),
                    json!({ "hosts_found": summary.hosts, "targets": summary.targets,
                            "duration_ms": summary.duration_ms as u64, "icmp": summary.icmp }),
                ));
            }
            Err(e) => {
                let message = format!("{e:#}");
                crate::outbox::push(&ScanResults {
                    scan_id: request.scan_id.clone(),
                    run_id: request.run_id.clone(),
                    hosts: Vec::new(),
                    done: true,
                    error: Some(message.clone()),
                });
                crate::outbox::result(reply("failed", message, serde_json::Value::Null));
            }
        }
    });
}

/// Self-test: a TCP scan of 127.0.0.1/32 against a local listener (no other address is touched).
pub async fn selftest() -> Result<String> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    let accept = tokio::spawn(async move {
        loop {
            if listener.accept().await.is_err() {
                return;
            }
        }
    });
    let request = NetworkScan {
        scan_id: "selftest".into(),
        run_id: None,
        ranges: vec!["127.0.0.1/32".into()],
        methods: rustrmm_proto::network::ScanMethods {
            icmp: false,
            arp: false,
            tcp_ports: vec![port],
            snmp: false,
            mdns: false,
            netbios: false,
        },
        snmp: Vec::new(),
        concurrency: 4,
        timeout_ms: 1000,
        // Loopback is not private address space; the self-test opts in explicitly.
        allow_public: true,
    };
    // The private-range rule refuses the same request without the opt-in.
    let refused = scan(
        &NetworkScan {
            allow_public: false,
            ..request.clone()
        },
        |_| {},
    )
    .await;
    anyhow::ensure!(refused.is_err(), "loopback was accepted as a private range");
    let mut batches = Vec::new();
    let summary = scan(&request, |b| batches.push(b)).await?;
    accept.abort();
    let host = batches
        .iter()
        .flat_map(|b| b.hosts.iter())
        .find(|h| h.ip == "127.0.0.1")
        .ok_or_else(|| anyhow::anyhow!("127.0.0.1 was not found"))?;
    anyhow::ensure!(
        host.open_ports == vec![port],
        "expected port {port} open, got {:?}",
        host.open_ports
    );
    anyhow::ensure!(
        batches.last().is_some_and(|b| b.done),
        "last batch not marked done"
    );
    let icmp = icmp::available()
        .map(|m| m.as_str())
        .unwrap_or("unavailable (TCP fallback)");
    let snmp = crate::snmp::selftest().await?;
    Ok(format!(
        "127.0.0.1/32 TCP {port} open ({} ms); ICMP {icmp}; {snmp}",
        summary.duration_ms
    ))
}
