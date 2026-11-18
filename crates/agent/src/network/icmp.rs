//! ICMP echo sweep. Uses a raw socket when the agent is privileged (SYSTEM/root) and, on Linux
//! and macOS, an unprivileged ICMP datagram socket otherwise; callers fall back to TCP probes
//! when neither is available. Sends are paced (`pps`), replies are collected on a second thread.

use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use socket2::{Domain, Protocol, Socket, Type};

/// Which kind of socket the sweep used.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Raw,
    #[cfg_attr(windows, allow(dead_code))]
    Datagram,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Raw => "raw",
            Self::Datagram => "datagram",
        }
    }
}

fn checksum(data: &[u8]) -> u16 {
    let mut sum: u32 = 0;
    for chunk in data.chunks(2) {
        let word = if chunk.len() == 2 {
            u16::from_be_bytes([chunk[0], chunk[1]])
        } else {
            u16::from_be_bytes([chunk[0], 0])
        };
        sum += u32::from(word);
    }
    while sum >> 16 != 0 {
        sum = (sum & 0xFFFF) + (sum >> 16);
    }
    !(sum as u16)
}

/// An echo request.
pub fn echo_request(id: u16, seq: u16) -> Vec<u8> {
    let mut packet = vec![8, 0, 0, 0];
    packet.extend_from_slice(&id.to_be_bytes());
    packet.extend_from_slice(&seq.to_be_bytes());
    packet.extend_from_slice(b"rustrmm-scan0000");
    let sum = checksum(&packet);
    packet[2..4].copy_from_slice(&sum.to_be_bytes());
    packet
}

/// (identifier, sequence) of an echo reply, with or without a leading IPv4 header.
pub fn parse_reply(buf: &[u8]) -> Option<(u16, u16)> {
    let icmp = if buf.first().is_some_and(|b| b >> 4 == 4) && buf.len() >= 20 {
        let ihl = usize::from(buf[0] & 0x0F) * 4;
        buf.get(ihl..)?
    } else {
        buf
    };
    if icmp.len() < 8 || icmp[0] != 0 || icmp[1] != 0 {
        return None;
    }
    Some((
        u16::from_be_bytes([icmp[4], icmp[5]]),
        u16::from_be_bytes([icmp[6], icmp[7]]),
    ))
}

fn open() -> std::io::Result<(UdpSocket, Mode)> {
    let raw = Socket::new(Domain::IPV4, Type::RAW, Some(Protocol::ICMPV4));
    let (socket, mode) = match raw {
        Ok(s) => (s, Mode::Raw),
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        Err(_) => (
            Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::ICMPV4))?,
            Mode::Datagram,
        ),
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        Err(e) => return Err(e),
    };
    socket.bind(&SocketAddr::from(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, 0)).into())?;
    socket.set_read_timeout(Some(Duration::from_millis(100)))?;
    Ok((socket.into(), mode))
}

/// Whether an ICMP socket can be opened at all.
pub fn available() -> Option<Mode> {
    open().ok().map(|(_, m)| m)
}

/// Pings every target once; returns the round-trip time (ms) of each host that answered.
pub fn sweep(
    targets: &[Ipv4Addr],
    timeout: Duration,
    pps: u32,
) -> std::io::Result<(Mode, HashMap<Ipv4Addr, f64>)> {
    let (socket, mode) = open()?;
    let receiver = socket.try_clone()?;
    let id = u16::from_be_bytes(rustrmm_crypto::random::bytes::<2>());
    let sent: Arc<Mutex<HashMap<Ipv4Addr, Instant>>> = Arc::new(Mutex::new(HashMap::new()));
    let replies: Arc<Mutex<HashMap<Ipv4Addr, f64>>> = Arc::new(Mutex::new(HashMap::new()));
    let stop = Arc::new(AtomicBool::new(false));
    let collector = {
        let (sent, replies, stop) = (sent.clone(), replies.clone(), stop.clone());
        std::thread::spawn(move || {
            let mut buf = [0u8; 1500];
            while !stop.load(Ordering::Relaxed) {
                let Ok((n, from)) = receiver.recv_from(&mut buf) else {
                    continue;
                };
                let SocketAddr::V4(from) = from else { continue };
                let Some((reply_id, _)) = parse_reply(&buf[..n]) else {
                    continue;
                };
                // Datagram sockets rewrite the identifier; raw sockets see everyone's replies.
                if mode == Mode::Raw && reply_id != id {
                    continue;
                }
                let at = sent.lock().ok().and_then(|s| s.get(from.ip()).copied());
                if let (Some(at), Ok(mut r)) = (at, replies.lock()) {
                    r.entry(*from.ip())
                        .or_insert_with(|| at.elapsed().as_secs_f64() * 1000.0);
                }
            }
        })
    };
    let gap = Duration::from_secs_f64(1.0 / f64::from(pps.max(1)));
    let mut errors = 0usize;
    for (i, ip) in targets.iter().enumerate() {
        let packet = echo_request(id, (i & 0xFFFF) as u16);
        if let Ok(mut s) = sent.lock() {
            s.insert(*ip, Instant::now());
        }
        if socket.send_to(&packet, SocketAddrV4::new(*ip, 0)).is_err() {
            errors += 1;
        }
        std::thread::sleep(gap);
    }
    std::thread::sleep(timeout);
    stop.store(true, Ordering::Relaxed);
    let _ = collector.join();
    if errors == targets.len() && !targets.is_empty() {
        return Err(std::io::Error::other("every ICMP send failed"));
    }
    let replies = replies.lock().map(|r| r.clone()).unwrap_or_default();
    Ok((mode, replies))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn echo_packets_and_replies() {
        let packet = echo_request(0xBEEF, 7);
        assert_eq!(packet[0], 8);
        assert_eq!(
            checksum(&packet),
            0,
            "a packet with its checksum sums to zero"
        );
        // A reply as a raw socket delivers it (20-byte IPv4 header first).
        let mut reply = vec![
            0x45, 0, 0, 44, 0, 0, 0, 0, 64, 1, 0, 0, 127, 0, 0, 1, 127, 0, 0, 1,
        ];
        let mut icmp = packet.clone();
        icmp[0] = 0;
        reply.extend_from_slice(&icmp);
        assert_eq!(parse_reply(&reply), Some((0xBEEF, 7)));
        assert_eq!(
            parse_reply(&icmp),
            Some((0xBEEF, 7)),
            "datagram sockets omit the header"
        );
        assert_eq!(parse_reply(&packet), None, "an echo request is not a reply");
    }
}
