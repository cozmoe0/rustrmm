//! Decoding received traps (SNMPv1 Trap-PDU, SNMPv2c Trapv2 and InformRequest) into the
//! protocol's `SnmpTrap`. Informs are acknowledged with a Response.

use std::net::IpAddr;

use anyhow::{Result, bail};
use rustrmm_proto::network::{SnmpTrap, TrapVarbind};

use super::ber::{self, Oid, Value};
use super::pdu::{AnyPdu, Pdu, decode_community, encode_community, peek_version};

const SYS_UPTIME_0: [u32; 9] = [1, 3, 6, 1, 2, 1, 1, 3, 0];
const SNMP_TRAP_OID_0: [u32; 11] = [1, 3, 6, 1, 6, 3, 1, 1, 4, 1, 0];

fn varbind(oid: &Oid, value: &Value) -> TrapVarbind {
    TrapVarbind {
        oid: oid.to_string(),
        kind: value.kind().to_string(),
        value: value.to_json(),
    }
}

/// A decoded trap and, for an inform, the acknowledgement to send back.
pub struct Decoded {
    pub trap: SnmpTrap,
    pub reply: Option<Vec<u8>>,
}

pub fn decode(bytes: &[u8], from: IpAddr, at_ms: i64) -> Result<Decoded> {
    if peek_version(bytes)? == 3 {
        bail!("SNMPv3 traps are not supported");
    }
    let message = decode_community(bytes)?;
    match message.pdu {
        AnyPdu::TrapV1(t) => Ok(Decoded {
            trap: SnmpTrap {
                from_ip: from.to_string(),
                at: at_ms,
                version: "v1".into(),
                oid: t.trap_oid().to_string(),
                varbinds: t.varbinds.iter().map(|(o, v)| varbind(o, v)).collect(),
            },
            reply: None,
        }),
        AnyPdu::Pdu(p) if matches!(p.tag, ber::TRAP_V2 | ber::INFORM_REQUEST) => {
            let trap_oid = p
                .varbinds
                .iter()
                .find(|(o, _)| o.0 == SNMP_TRAP_OID_0)
                .and_then(|(_, v)| match v {
                    Value::Oid(o) => Some(o.to_string()),
                    _ => None,
                })
                .ok_or_else(|| anyhow::anyhow!("trap without snmpTrapOID.0"))?;
            let varbinds = p
                .varbinds
                .iter()
                .filter(|(o, _)| o.0 != SYS_UPTIME_0 && o.0 != SNMP_TRAP_OID_0)
                .map(|(o, v)| varbind(o, v))
                .collect();
            let reply = (p.tag == ber::INFORM_REQUEST).then(|| {
                let response = Pdu {
                    tag: ber::RESPONSE,
                    request_id: p.request_id,
                    error_status: 0,
                    error_index: 0,
                    varbinds: p.varbinds.clone(),
                };
                encode_community(message.version, &message.community, &response.encode())
            });
            Ok(Decoded {
                trap: SnmpTrap {
                    from_ip: from.to_string(),
                    at: at_ms,
                    version: if message.version == 0 { "v1" } else { "v2c" }.into(),
                    oid: trap_oid,
                    varbinds,
                },
                reply,
            })
        }
        _ => bail!("not a trap"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::snmp::pdu::TrapV1;

    fn from() -> IpAddr {
        "192.168.1.60".parse().expect("ip")
    }

    #[test]
    fn decodes_v2c_traps_and_acknowledges_informs() {
        // A linkDown trap, built independently of our encoder (hex from a Python BER writer).
        let bytes = hex::decode(concat!(
            "305602010104067075626c6963a74902040bcd4f0a020100020100303b300f0608",
            "2b06010201010300430300d4313017060a2b06010603010104010006092b060106",
            "0301010503300f060a2b060102010202010102020102"
        ))
        .expect("hex");
        // The same trap from our encoder must be identical.
        let ours = encode_community(
            1,
            b"public",
            &Pdu {
                tag: ber::TRAP_V2,
                request_id: 0x0bcd4f0a,
                error_status: 0,
                error_index: 0,
                varbinds: vec![
                    (Oid(SYS_UPTIME_0.to_vec()), Value::TimeTicks(54321)),
                    (
                        Oid(SNMP_TRAP_OID_0.to_vec()),
                        Value::Oid(Oid::parse("1.3.6.1.6.3.1.1.5.3").expect("oid")),
                    ),
                    (
                        Oid::parse("1.3.6.1.2.1.2.2.1.1.2").expect("oid"),
                        Value::Integer(2),
                    ),
                ],
            }
            .encode(),
        );
        assert_eq!(hex::encode(&ours), hex::encode(&bytes));
        let decoded = decode(&bytes, from(), 1_700_000_000_000).expect("decode");
        assert_eq!(decoded.trap.version, "v2c");
        assert_eq!(decoded.trap.oid, "1.3.6.1.6.3.1.1.5.3");
        assert_eq!(decoded.trap.from_ip, "192.168.1.60");
        assert_eq!(
            decoded.trap.varbinds.len(),
            1,
            "sysUpTime and snmpTrapOID are not repeated"
        );
        assert_eq!(decoded.trap.varbinds[0].oid, "1.3.6.1.2.1.2.2.1.1.2");
        assert_eq!(decoded.trap.varbinds[0].value, serde_json::json!(2));
        assert!(decoded.reply.is_none());

        // The same notification as an inform gets a Response with the same request id.
        let mut inform = bytes.clone();
        let pos = inform
            .iter()
            .position(|b| *b == ber::TRAP_V2)
            .expect("pdu tag");
        inform[pos] = ber::INFORM_REQUEST;
        let decoded = decode(&inform, from(), 1).expect("decode");
        let reply = decoded.reply.expect("acknowledgement");
        match decode_community(&reply).expect("reply").pdu {
            AnyPdu::Pdu(p) => {
                assert_eq!(p.tag, ber::RESPONSE);
                assert_eq!(p.request_id, 0x0bcd4f0a);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn decodes_v1_traps_with_rfc3584_oids() {
        let trap = TrapV1 {
            enterprise: Oid::parse("1.3.6.1.4.1.318").expect("oid"),
            agent_addr: [192, 168, 1, 60],
            generic: 6,
            specific: 7,
            timestamp: 99,
            varbinds: vec![(
                Oid::parse("1.3.6.1.4.1.318.2.3.3.0").expect("oid"),
                Value::OctetString(b"On battery".to_vec()),
            )],
        };
        let bytes = encode_community(0, b"public", &trap.encode());
        let decoded = decode(&bytes, from(), 1).expect("decode");
        assert_eq!(decoded.trap.version, "v1");
        assert_eq!(decoded.trap.oid, "1.3.6.1.4.1.318.0.7");
        assert_eq!(
            decoded.trap.varbinds[0].value,
            serde_json::json!("On battery")
        );
        assert!(decode(b"\x30\x03\x02\x01\x03", from(), 1).is_err());
        assert!(decode(b"garbage", from(), 1).is_err());
    }
}
