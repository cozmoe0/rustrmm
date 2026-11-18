//! An async SNMP manager over UDP: v1/v2c communities and SNMPv3 (engine discovery, time
//! window resynchronisation, authentication and privacy), with Get, GetNext/GetBulk walks and
//! retries.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use rustrmm_proto::network::SnmpCredential;
use tokio::net::UdpSocket;

use super::ber::{self, Oid, Value};
use super::pdu::{AnyPdu, Pdu, decode_community, encode_community};
use super::usm::{self, LocalKeys, User};

const USM_STATS: [u32; 10] = [1, 3, 6, 1, 6, 3, 15, 1, 1, 0];
const MAX_REPETITIONS: i32 = 25;

/// How to secure requests.
pub enum Security {
    Community { version: i64, community: Vec<u8> },
    V3 { user: Arc<User> },
}

impl Security {
    /// From a protocol credential (derives SNMPv3 keys: about a millisecond of hashing).
    pub fn from_credential(credential: &SnmpCredential) -> Result<Self> {
        match credential.version.as_str() {
            "v3" => {
                let v3 = credential
                    .v3
                    .as_ref()
                    .context("SNMPv3 credential without v3 settings")?;
                Ok(Self::V3 {
                    user: Arc::new(User::new(v3)?),
                })
            }
            "v1" => Ok(Self::Community {
                version: 0,
                community: credential
                    .community
                    .clone()
                    .unwrap_or_default()
                    .into_bytes(),
            }),
            _ => Ok(Self::Community {
                version: 1,
                community: credential
                    .community
                    .clone()
                    .unwrap_or_else(|| "public".into())
                    .into_bytes(),
            }),
        }
    }

    pub fn clone_ref(&self) -> Self {
        match self {
            Self::Community { version, community } => Self::Community {
                version: *version,
                community: community.clone(),
            },
            Self::V3 { user } => Self::V3 { user: user.clone() },
        }
    }
}

struct Engine {
    id: Vec<u8>,
    boots: i64,
    time: i64,
    at: Instant,
    keys: LocalKeys,
}

impl Engine {
    fn time_now(&self) -> i64 {
        self.time + self.at.elapsed().as_secs() as i64
    }
}

pub struct Client {
    socket: UdpSocket,
    security: Security,
    engine: Option<Engine>,
    timeout: Duration,
    retries: u32,
    next_id: i32,
}

fn usm_report_reason(pdu: &Pdu) -> Option<&'static str> {
    let (oid, _) = pdu.varbinds.first()?;
    let prefix = Oid(USM_STATS[..9].to_vec());
    if !oid.starts_with(&prefix) {
        return Some("the agent reported an error");
    }
    Some(match oid.0.get(9) {
        Some(1) => "unsupported security level",
        Some(2) => "not in time window",
        Some(3) => "unknown user name",
        Some(4) => "unknown engine id",
        Some(5) => "wrong digest (authentication failed)",
        Some(6) => "decryption error",
        _ => "the agent reported an error",
    })
}

impl Client {
    pub async fn new(
        target: SocketAddr,
        security: Security,
        timeout: Duration,
        retries: u32,
    ) -> Result<Self> {
        let bind: SocketAddr = if target.is_ipv4() {
            "0.0.0.0:0".parse()?
        } else {
            "[::]:0".parse()?
        };
        let socket = UdpSocket::bind(bind).await?;
        socket.connect(target).await?;
        Ok(Self {
            socket,
            security,
            engine: None,
            timeout,
            retries,
            next_id: (u32::from_be_bytes(rustrmm_crypto::random::bytes::<4>()) >> 2) as i32,
        })
    }

    fn id(&mut self) -> i32 {
        self.next_id = self.next_id.wrapping_add(1) & 0x3FFF_FFFF;
        self.next_id
    }

    /// Sends and waits for a datagram `accept` likes, retrying on timeouts.
    async fn exchange(&self, request: &[u8], accept: impl Fn(&[u8]) -> bool) -> Result<Vec<u8>> {
        let mut buf = vec![0u8; ber::MAX_MESSAGE];
        for _ in 0..=self.retries {
            self.socket.send(request).await?;
            let deadline = tokio::time::Instant::now() + self.timeout;
            loop {
                match tokio::time::timeout_at(deadline, self.socket.recv(&mut buf)).await {
                    Ok(Ok(n)) => {
                        if accept(&buf[..n]) {
                            return Ok(buf[..n].to_vec());
                        }
                    }
                    // ICMP port unreachable surfaces as an error on a connected socket.
                    Ok(Err(e)) if e.kind() == std::io::ErrorKind::ConnectionRefused => {
                        bail!("no SNMP agent (port unreachable)")
                    }
                    Ok(Err(e)) if e.kind() == std::io::ErrorKind::ConnectionReset => {
                        bail!("no SNMP agent (port unreachable)")
                    }
                    Ok(Err(e)) => return Err(e.into()),
                    Err(_) => break,
                }
            }
        }
        bail!("no response")
    }

    async fn discover(&mut self) -> Result<()> {
        let msg_id = i64::from(self.id());
        let pdu = Pdu::request(ber::GET_REQUEST, self.id(), &[]);
        let scoped = usm::encode_scoped(b"", b"", &pdu.encode());
        let header = usm::Header {
            msg_id,
            max_size: ber::MAX_MESSAGE as i64,
            flags: usm::FLAG_REPORTABLE,
        };
        let (request, _) = usm::encode_message(&header, &usm::UsmParams::default(), &scoped);
        let reply = self
            .exchange(&request, |b| {
                usm::decode_message(b).is_ok_and(|m| m.header.msg_id == msg_id)
            })
            .await?;
        let message = usm::decode_message(&reply)?;
        if message.usm.engine_id.is_empty() {
            bail!("SNMPv3 engine discovery returned no engine id");
        }
        let Security::V3 { user } = &self.security else {
            bail!("not an SNMPv3 client");
        };
        self.engine = Some(Engine {
            keys: user.localize(&message.usm.engine_id),
            id: message.usm.engine_id,
            boots: message.usm.boots,
            time: message.usm.time,
            at: Instant::now(),
        });
        Ok(())
    }

    async fn request_v3(&mut self, pdu: &mut Pdu) -> Result<Pdu> {
        let mut resynced = false;
        loop {
            if self.engine.is_none() {
                self.discover().await?;
            }
            let Security::V3 { user } = &self.security else {
                bail!("not an SNMPv3 client");
            };
            let user = user.clone();
            pdu.request_id = self.id();
            let msg_id = i64::from(self.id());
            let engine = self.engine.as_ref().context("engine")?;
            let request = usm::build_request(
                msg_id,
                &user,
                &engine.keys,
                &engine.id,
                engine.boots,
                engine.time_now(),
                rustrmm_crypto::random::bytes::<8>(),
                &pdu.encode(),
            )?;
            let reply = self
                .exchange(&request, |b| {
                    usm::decode_message(b).is_ok_and(|m| m.header.msg_id == msg_id)
                })
                .await?;
            let engine = self.engine.as_ref().context("engine")?;
            let opened = usm::open(&reply, &engine.keys);
            let (message, any, authenticated) = match opened {
                Ok(o) => o,
                Err(e) => return Err(e),
            };
            let AnyPdu::Pdu(response) = any else {
                bail!("unexpected PDU in response");
            };
            if response.tag == ber::REPORT {
                let reason = usm_report_reason(&response).unwrap_or("report");
                if !resynced && (reason == "not in time window" || reason == "unknown engine id") {
                    resynced = true;
                    if reason == "unknown engine id" {
                        self.engine = None;
                    } else if let Some(engine) = self.engine.as_mut() {
                        engine.boots = message.usm.boots;
                        engine.time = message.usm.time;
                        engine.at = Instant::now();
                    }
                    continue;
                }
                bail!("SNMPv3: {reason}");
            }
            if user.auth.is_some() && !authenticated {
                bail!("SNMPv3 response was not authenticated");
            }
            if response.request_id != pdu.request_id {
                bail!("mismatched SNMP response");
            }
            return Ok(response);
        }
    }

    /// Sends one request PDU and returns the response PDU.
    pub async fn request(&mut self, mut pdu: Pdu) -> Result<Pdu> {
        match &self.security {
            Security::V3 { .. } => self.request_v3(&mut pdu).await,
            Security::Community { version, community } => {
                let (version, community) = (*version, community.clone());
                pdu.request_id = self.id();
                let id = pdu.request_id;
                let request = encode_community(version, &community, &pdu.encode());
                let reply = self
                    .exchange(&request, |b| {
                        matches!(decode_community(b), Ok(m) if matches!(&m.pdu, AnyPdu::Pdu(p) if p.request_id == id))
                    })
                    .await?;
                match decode_community(&reply)?.pdu {
                    AnyPdu::Pdu(p) if p.tag == ber::RESPONSE => Ok(p),
                    _ => bail!("unexpected SNMP response"),
                }
            }
        }
    }

    fn is_v1(&self) -> bool {
        matches!(self.security, Security::Community { version: 0, .. })
    }

    /// Get of a few OIDs; exceptions (`noSuchObject`, …) are left out.
    pub async fn get(&mut self, oids: &[Oid]) -> Result<Vec<(Oid, Value)>> {
        if oids.is_empty() {
            return Ok(Vec::new());
        }
        let response = self
            .request(Pdu::request(ber::GET_REQUEST, 0, oids))
            .await?;
        if response.error_status != 0 {
            // v1 answers noSuchName (2) for the whole request: retry one by one.
            if oids.len() > 1 {
                let mut out = Vec::new();
                for oid in oids {
                    if let Ok(mut one) = Box::pin(self.get(std::slice::from_ref(oid))).await {
                        out.append(&mut one);
                    }
                }
                return Ok(out);
            }
            return Ok(Vec::new());
        }
        Ok(response
            .varbinds
            .into_iter()
            .filter(|(_, v)| !v.is_exception() && *v != Value::Null)
            .collect())
    }

    /// Every row under `root` (GetBulk, or GetNext for v1), at most `max_rows`.
    pub async fn walk(&mut self, root: &Oid, max_rows: usize) -> Result<Vec<(Oid, Value)>> {
        let mut out = Vec::new();
        let mut current = root.clone();
        while out.len() < max_rows {
            let pdu = if self.is_v1() {
                Pdu::request(ber::GET_NEXT_REQUEST, 0, std::slice::from_ref(&current))
            } else {
                Pdu::bulk(0, 0, MAX_REPETITIONS, std::slice::from_ref(&current))
            };
            let response = self.request(pdu).await?;
            if response.error_status != 0 || response.varbinds.is_empty() {
                break;
            }
            let mut advanced = false;
            for (oid, value) in response.varbinds {
                if !oid.starts_with(root) || matches!(value, Value::EndOfMibView) || oid <= current
                {
                    return Ok(out);
                }
                current = oid.clone();
                advanced = true;
                if !value.is_exception() {
                    out.push((oid, value));
                }
                if out.len() >= max_rows {
                    break;
                }
            }
            if !advanced {
                break;
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A tiny v2c agent on loopback: answers Get and GetBulk from a fixed table.
    async fn fake_agent() -> SocketAddr {
        let socket = UdpSocket::bind("127.0.0.1:0").await.expect("bind");
        let addr = socket.local_addr().expect("addr");
        tokio::spawn(async move {
            let table: Vec<(Oid, Value)> = vec![
                (
                    Oid::parse("1.3.6.1.2.1.1.1.0").expect("oid"),
                    Value::OctetString(b"Test switch".to_vec()),
                ),
                (
                    Oid::parse("1.3.6.1.2.1.1.3.0").expect("oid"),
                    Value::TimeTicks(12_345),
                ),
                (
                    Oid::parse("1.3.6.1.2.1.2.2.1.2.1").expect("oid"),
                    Value::OctetString(b"eth0".to_vec()),
                ),
                (
                    Oid::parse("1.3.6.1.2.1.2.2.1.2.2").expect("oid"),
                    Value::OctetString(b"eth1".to_vec()),
                ),
                (
                    Oid::parse("1.3.6.1.2.1.2.2.1.3.1").expect("oid"),
                    Value::Integer(6),
                ),
            ];
            let mut buf = vec![0u8; 65_535];
            loop {
                let Ok((n, from)) = socket.recv_from(&mut buf).await else {
                    return;
                };
                let Ok(msg) = decode_community(&buf[..n]) else {
                    continue;
                };
                if msg.community != b"public" {
                    continue;
                }
                let AnyPdu::Pdu(req) = msg.pdu else { continue };
                let varbinds = match req.tag {
                    ber::GET_REQUEST => req
                        .varbinds
                        .iter()
                        .map(|(oid, _)| {
                            let v = table.iter().find(|(o, _)| o == oid).map(|(_, v)| v.clone());
                            (oid.clone(), v.unwrap_or(Value::NoSuchObject))
                        })
                        .collect(),
                    ber::GET_BULK_REQUEST => {
                        let start = &req.varbinds[0].0;
                        let mut rows: Vec<(Oid, Value)> = table
                            .iter()
                            .filter(|(o, _)| o > start)
                            .take(req.error_index as usize)
                            .cloned()
                            .collect();
                        if rows.is_empty() {
                            rows.push((start.clone(), Value::EndOfMibView));
                        }
                        rows
                    }
                    _ => continue,
                };
                let resp = Pdu {
                    tag: ber::RESPONSE,
                    request_id: req.request_id,
                    error_status: 0,
                    error_index: 0,
                    varbinds,
                };
                let bytes = encode_community(1, b"public", &resp.encode());
                let _ = socket.send_to(&bytes, from).await;
            }
        });
        addr
    }

    #[tokio::test]
    async fn get_and_walk_against_a_local_agent() {
        let addr = fake_agent().await;
        let security = Security::from_credential(&SnmpCredential {
            version: "v2c".into(),
            community: Some("public".into()),
            v3: None,
        })
        .expect("security");
        let mut client = Client::new(addr, security, Duration::from_millis(500), 1)
            .await
            .expect("client");
        let got = client
            .get(&[
                Oid::parse("1.3.6.1.2.1.1.1.0").expect("oid"),
                Oid::parse("1.3.6.1.2.1.1.99.0").expect("oid"),
            ])
            .await
            .expect("get");
        assert_eq!(got.len(), 1, "noSuchObject is left out");
        assert_eq!(got[0].1.as_text().as_deref(), Some("Test switch"));
        let column = Oid::parse("1.3.6.1.2.1.2.2.1.2").expect("oid");
        let rows = client.walk(&column, 100).await.expect("walk");
        let names: Vec<(String, String)> = rows
            .iter()
            .map(|(o, v)| (o.suffix(&column), v.as_text().unwrap_or_default()))
            .collect();
        assert_eq!(
            names,
            vec![("1".into(), "eth0".into()), ("2".into(), "eth1".into())]
        );
        // A wrong community gets no answer.
        let wrong = Security::from_credential(&SnmpCredential {
            version: "v2c".into(),
            community: Some("private".into()),
            v3: None,
        })
        .expect("security");
        let mut client = Client::new(addr, wrong, Duration::from_millis(150), 0)
            .await
            .expect("client");
        assert!(
            client
                .get(&[Oid::parse("1.3.6.1.2.1.1.1.0").expect("oid")])
                .await
                .is_err()
        );
    }
}
