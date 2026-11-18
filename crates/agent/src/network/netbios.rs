//! NetBIOS node status query (RFC 1002 section 4.2.17, UDP 137): the host's workstation name
//! and, when it reports one, its MAC address.

use std::net::{Ipv4Addr, SocketAddr};
use std::time::Duration;

/// A node status request for the wildcard name `*`.
pub fn request(id: u16) -> Vec<u8> {
    let mut out = Vec::with_capacity(50);
    out.extend_from_slice(&id.to_be_bytes());
    out.extend_from_slice(&[0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    out.push(0x20);
    let mut name = [0u8; 16];
    name[0] = b'*';
    for b in name {
        out.push(b'A' + (b >> 4));
        out.push(b'A' + (b & 0x0F));
    }
    out.push(0x00);
    out.extend_from_slice(&[0x00, 0x21, 0x00, 0x01]);
    out
}

/// The unique workstation (`<00>`) name and the unit id (MAC) from a node status response.
pub fn parse_response(bytes: &[u8], id: u16) -> Option<(String, Option<String>)> {
    if bytes.len() < 12 || bytes[..2] != id.to_be_bytes() || bytes[2] & 0x80 == 0 {
        return None;
    }
    let ancount = u16::from_be_bytes([bytes[6], bytes[7]]);
    if ancount == 0 {
        return None;
    }
    let mut p = 12;
    // The answer's name: a pointer or a full encoded name.
    if bytes.get(p)? & 0xC0 == 0xC0 {
        p += 2;
    } else {
        while *bytes.get(p)? != 0 {
            p += usize::from(bytes[p]) + 1;
        }
        p += 1;
    }
    let rtype = u16::from_be_bytes([*bytes.get(p)?, *bytes.get(p + 1)?]);
    if rtype != 0x21 {
        return None;
    }
    p += 8; // type, class, ttl
    let rdlen = usize::from(u16::from_be_bytes([*bytes.get(p)?, *bytes.get(p + 1)?]));
    p += 2;
    let data = bytes.get(p..p + rdlen)?;
    let count = usize::from(*data.first()?);
    let mut name = None;
    for i in 0..count {
        let entry = data.get(1 + i * 18..1 + (i + 1) * 18)?;
        let suffix = entry[15];
        let group = entry[16] & 0x80 != 0;
        if suffix == 0x00 && !group && name.is_none() {
            let text: String = entry[..15]
                .iter()
                .map(|b| *b as char)
                .collect::<String>()
                .trim_end()
                .to_string();
            if !text.is_empty() && text.chars().all(|c| c.is_ascii_graphic() || c == ' ') {
                name = Some(text);
            }
        }
    }
    let mac = data
        .get(1 + count * 18..1 + count * 18 + 6)
        .map(|m| {
            m.iter()
                .map(|b| format!("{b:02x}"))
                .collect::<Vec<_>>()
                .join(":")
        })
        .filter(|m| m != "00:00:00:00:00:00");
    name.map(|n| (n, mac))
}

/// Asks one host for its NetBIOS name.
pub async fn query(ip: Ipv4Addr, timeout: Duration) -> Option<(String, Option<String>)> {
    let socket = tokio::net::UdpSocket::bind("0.0.0.0:0").await.ok()?;
    socket.connect(SocketAddr::from((ip, 137))).await.ok()?;
    let id = u16::from_be_bytes(rustrmm_crypto::random::bytes::<2>());
    socket.send(&request(id)).await.ok()?;
    let mut buf = [0u8; 1024];
    let n = tokio::time::timeout(timeout, socket.recv(&mut buf))
        .await
        .ok()?
        .ok()?;
    parse_response(&buf[..n], id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_status_round_trip() {
        let req = request(0x1234);
        assert_eq!(req.len(), 50);
        assert_eq!(&req[13..15], b"CK", "'*' encodes as CK");
        // Response: header, pointer name, NBSTAT RR with two names and a MAC.
        let mut resp = vec![0x12, 0x34, 0x84, 0x00, 0, 0, 0, 1, 0, 0, 0, 0];
        resp.extend_from_slice(&req[12..46]);
        resp.extend_from_slice(&[0x00, 0x21, 0x00, 0x01, 0, 0, 0, 0]);
        let mut data = vec![2u8];
        let mut entry = |name: &str, suffix: u8, flags: u8| {
            let mut n = [b' '; 15];
            n[..name.len()].copy_from_slice(name.as_bytes());
            data.extend_from_slice(&n);
            data.push(suffix);
            data.extend_from_slice(&[flags, 0x00]);
        };
        entry("WORKGROUP", 0x00, 0x84);
        entry("WS-ACCT-01", 0x00, 0x04);
        data.extend_from_slice(&[0x00, 0x1b, 0x21, 0x0a, 0x0b, 0x0c]);
        resp.extend_from_slice(&(data.len() as u16).to_be_bytes());
        resp.extend_from_slice(&data);
        assert_eq!(
            parse_response(&resp, 0x1234),
            Some(("WS-ACCT-01".into(), Some("00:1b:21:0a:0b:0c".into())))
        );
        assert_eq!(parse_response(&resp, 0x9999), None, "other transaction");
        assert_eq!(parse_response(&resp[..20], 0x1234), None, "truncated");
    }
}
