//! mDNS / DNS-SD (RFC 6762/6763) discovery: a one-shot multicast browse of service types and
//! per-host reverse lookups sent from an ephemeral port, so responders answer us directly.

use std::collections::{BTreeSet, HashMap};
use std::net::{Ipv4Addr, SocketAddr};
use std::time::Duration;

use anyhow::{Result, bail};

pub const TYPE_A: u16 = 1;
pub const TYPE_PTR: u16 = 12;
pub const TYPE_SRV: u16 = 33;
const MDNS: SocketAddr = SocketAddr::V4(std::net::SocketAddrV4::new(
    Ipv4Addr::new(224, 0, 0, 251),
    5353,
));
pub const SERVICES: &str = "_services._dns-sd._udp.local";

fn encode_name(name: &str, out: &mut Vec<u8>) {
    for label in name
        .trim_end_matches('.')
        .split('.')
        .filter(|l| !l.is_empty())
    {
        let bytes = &label.as_bytes()[..label.len().min(63)];
        out.push(bytes.len() as u8);
        out.extend_from_slice(bytes);
    }
    out.push(0);
}

/// A single-question query.
pub fn query(id: u16, name: &str, qtype: u16) -> Vec<u8> {
    let mut out = Vec::with_capacity(64);
    out.extend_from_slice(&id.to_be_bytes());
    out.extend_from_slice(&[0, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
    encode_name(name, &mut out);
    out.extend_from_slice(&qtype.to_be_bytes());
    out.extend_from_slice(&1u16.to_be_bytes());
    out
}

/// `d.c.b.a.in-addr.arpa`.
pub fn reverse_name(ip: Ipv4Addr) -> String {
    let o = ip.octets();
    format!("{}.{}.{}.{}.in-addr.arpa", o[3], o[2], o[1], o[0])
}

/// Reads a (possibly compressed) name at `pos`; returns the name and the position after it.
fn read_name(msg: &[u8], mut pos: usize) -> Result<(String, usize)> {
    let mut labels = Vec::new();
    let mut end = None;
    let mut jumps = 0;
    loop {
        let Some(&len) = msg.get(pos) else {
            bail!("truncated name");
        };
        match len {
            0 => {
                pos += 1;
                break;
            }
            l if l & 0xC0 == 0xC0 => {
                let Some(&low) = msg.get(pos + 1) else {
                    bail!("truncated pointer");
                };
                if end.is_none() {
                    end = Some(pos + 2);
                }
                jumps += 1;
                if jumps > 16 {
                    bail!("compression loop");
                }
                pos = (usize::from(l & 0x3F) << 8) | usize::from(low);
            }
            l => {
                let l = usize::from(l);
                let Some(label) = msg.get(pos + 1..pos + 1 + l) else {
                    bail!("truncated label");
                };
                labels.push(String::from_utf8_lossy(label).to_string());
                pos += 1 + l;
            }
        }
    }
    Ok((labels.join("."), end.unwrap_or(pos)))
}

/// One resource record we care about.
#[derive(Debug, Clone, PartialEq)]
pub enum Record {
    Ptr { name: String, target: String },
    A { name: String, addr: Ipv4Addr },
    Srv { name: String, target: String },
}

/// Answer, authority and additional records of a response.
pub fn parse(msg: &[u8]) -> Result<Vec<Record>> {
    if msg.len() < 12 || msg[2] & 0x80 == 0 {
        bail!("not a DNS response");
    }
    let count = |i: usize| usize::from(u16::from_be_bytes([msg[i], msg[i + 1]]));
    let (qd, records) = (count(4), count(6) + count(8) + count(10));
    let mut pos = 12;
    for _ in 0..qd {
        let (_, p) = read_name(msg, pos)?;
        pos = p + 4;
    }
    let mut out = Vec::new();
    for _ in 0..records.min(200) {
        let (name, p) = read_name(msg, pos)?;
        let Some(header) = msg.get(p..p + 10) else {
            bail!("truncated record");
        };
        let rtype = u16::from_be_bytes([header[0], header[1]]);
        let rdlen = usize::from(u16::from_be_bytes([header[8], header[9]]));
        let start = p + 10;
        if msg.len() < start + rdlen {
            bail!("truncated record data");
        }
        match rtype {
            TYPE_PTR => out.push(Record::Ptr {
                name,
                target: read_name(msg, start)?.0,
            }),
            TYPE_A if rdlen == 4 => out.push(Record::A {
                name,
                addr: Ipv4Addr::new(msg[start], msg[start + 1], msg[start + 2], msg[start + 3]),
            }),
            TYPE_SRV if rdlen > 6 => out.push(Record::Srv {
                name,
                target: read_name(msg, start + 6)?.0,
            }),
            _ => {}
        }
        pos = start + rdlen;
    }
    Ok(out)
}

/// The host name a device announces for its address (unicast query to its port 5353).
pub async fn reverse_lookup(ip: Ipv4Addr, timeout: Duration) -> Option<String> {
    let socket = tokio::net::UdpSocket::bind("0.0.0.0:0").await.ok()?;
    let id = u16::from_be_bytes(rustrmm_crypto::random::bytes::<2>());
    socket
        .send_to(
            &query(id, &reverse_name(ip), TYPE_PTR),
            SocketAddr::from((ip, 5353)),
        )
        .await
        .ok()?;
    let mut buf = vec![0u8; 9000];
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let (n, from) = tokio::time::timeout_at(deadline, socket.recv_from(&mut buf))
            .await
            .ok()?
            .ok()?;
        if from.ip() != std::net::IpAddr::V4(ip) {
            continue;
        }
        let records = parse(&buf[..n]).ok()?;
        return records.into_iter().find_map(|r| match r {
            Record::Ptr { target, .. } => Some(target),
            _ => None,
        });
    }
}

/// Service types (and instance names) each responder announces to a one-shot browse.
pub async fn browse(window: Duration) -> HashMap<Ipv4Addr, BTreeSet<String>> {
    let mut found: HashMap<Ipv4Addr, BTreeSet<String>> = HashMap::new();
    let Ok(socket) = tokio::net::UdpSocket::bind("0.0.0.0:0").await else {
        return found;
    };
    let id = u16::from_be_bytes(rustrmm_crypto::random::bytes::<2>());
    if socket
        .send_to(&query(id, SERVICES, TYPE_PTR), MDNS)
        .await
        .is_err()
    {
        return found;
    }
    let mut buf = vec![0u8; 9000];
    let deadline = tokio::time::Instant::now() + window;
    while let Ok(Ok((n, from))) =
        tokio::time::timeout_at(deadline, socket.recv_from(&mut buf)).await
    {
        let std::net::IpAddr::V4(ip) = from.ip() else {
            continue;
        };
        let Ok(records) = parse(&buf[..n]) else {
            continue;
        };
        let entry = found.entry(ip).or_default();
        for record in records {
            if let Record::Ptr { target, .. } = record
                && entry.len() < 50
            {
                entry.insert(target.chars().take(255).collect());
            }
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queries_and_compressed_answers() {
        let q = query(0x4242, SERVICES, TYPE_PTR);
        assert_eq!(&q[..2], &[0x42, 0x42]);
        assert_eq!(q[12], 9, "_services");
        assert_eq!(
            reverse_name("192.168.1.20".parse().expect("ip")),
            "20.1.168.192.in-addr.arpa"
        );
        // Response: one question, two PTR answers (the second compressed against the first).
        let mut msg = vec![0x42, 0x42, 0x84, 0x00, 0, 1, 0, 2, 0, 0, 0, 0];
        msg.extend_from_slice(&q[12..]);
        // Answer 1: name = pointer to the question (offset 12), PTR → _ipp._tcp.local
        msg.extend_from_slice(&[0xC0, 12, 0, 12, 0, 1, 0, 0, 0x11, 0x94]);
        let mut target = Vec::new();
        encode_name("_ipp._tcp.local", &mut target);
        msg.extend_from_slice(&(target.len() as u16).to_be_bytes());
        let ipp_at = msg.len();
        msg.extend_from_slice(&target);
        // Answer 2: PTR → _http + pointer to "._tcp.local" inside the first target.
        msg.extend_from_slice(&[0xC0, 12, 0, 12, 0, 1, 0, 0, 0x11, 0x94]);
        let tail = (ipp_at + 5) as u8; // skips "\x04_ipp"
        let data = [5, b'_', b'h', b't', b't', b'p', 0xC0, tail];
        msg.extend_from_slice(&(data.len() as u16).to_be_bytes());
        msg.extend_from_slice(&data);
        let records = parse(&msg).expect("parse");
        assert_eq!(
            records,
            vec![
                Record::Ptr {
                    name: SERVICES.into(),
                    target: "_ipp._tcp.local".into()
                },
                Record::Ptr {
                    name: SERVICES.into(),
                    target: "_http._tcp.local".into()
                },
            ]
        );
        // A pointer loop is refused, not followed forever.
        let mut bad = vec![0x42, 0x42, 0x84, 0x00, 0, 0, 0, 1, 0, 0, 0, 0];
        bad.extend_from_slice(&[0xC0, 12]);
        assert!(parse(&bad).is_err());
        assert!(parse(&[0u8; 4]).is_err());
    }
}
