//! SNMP PDUs and the community (v1/v2c) message wrapper.

use anyhow::{Result, bail};

use super::ber::{self, Oid, Reader, Value};

/// Get, GetNext, GetBulk (error fields carry non-repeaters / max-repetitions), Response,
/// Inform, SNMPv2-Trap and Report.
#[derive(Debug, Clone, PartialEq)]
pub struct Pdu {
    pub tag: u8,
    pub request_id: i32,
    pub error_status: i32,
    pub error_index: i32,
    pub varbinds: Vec<(Oid, Value)>,
}

impl Pdu {
    pub fn request(tag: u8, request_id: i32, oids: &[Oid]) -> Self {
        Self {
            tag,
            request_id,
            error_status: 0,
            error_index: 0,
            varbinds: oids.iter().map(|o| (o.clone(), Value::Null)).collect(),
        }
    }

    pub fn bulk(request_id: i32, non_repeaters: i32, max_repetitions: i32, oids: &[Oid]) -> Self {
        Self {
            tag: ber::GET_BULK_REQUEST,
            request_id,
            error_status: non_repeaters,
            error_index: max_repetitions,
            varbinds: oids.iter().map(|o| (o.clone(), Value::Null)).collect(),
        }
    }

    pub fn encode(&self) -> Vec<u8> {
        let binds: Vec<Vec<u8>> = self
            .varbinds
            .iter()
            .map(|(oid, value)| ber::seq(ber::SEQUENCE, &[&oid.encode(), &value.encode()]))
            .collect();
        let refs: Vec<&[u8]> = binds.iter().map(Vec::as_slice).collect();
        let list = ber::seq(ber::SEQUENCE, &refs);
        ber::seq(
            self.tag,
            &[
                &ber::integer(i64::from(self.request_id)),
                &ber::integer(i64::from(self.error_status)),
                &ber::integer(i64::from(self.error_index)),
                &list,
            ],
        )
    }

    pub fn decode(tag: u8, content: &[u8]) -> Result<Self> {
        let mut r = Reader::new(content);
        let request_id = i32::try_from(r.integer()?)?;
        let error_status = i32::try_from(r.integer()?)?;
        let error_index = i32::try_from(r.integer()?)?;
        let varbinds = decode_varbinds(r.expect(ber::SEQUENCE)?)?;
        Ok(Self {
            tag,
            request_id,
            error_status,
            error_index,
            varbinds,
        })
    }
}

pub fn decode_varbinds(content: &[u8]) -> Result<Vec<(Oid, Value)>> {
    let mut list = Reader::new(content);
    let mut out = Vec::new();
    while !list.is_empty() {
        let mut vb = Reader::new(list.expect(ber::SEQUENCE)?);
        let oid = Oid::decode(vb.expect(ber::OBJECT_ID)?)?;
        let (tag, value) = vb.read()?;
        out.push((oid, Value::decode(tag, value)?));
        if out.len() > 10_000 {
            bail!("too many variable bindings");
        }
    }
    Ok(out)
}

/// An SNMPv1 Trap-PDU.
#[derive(Debug, Clone, PartialEq)]
pub struct TrapV1 {
    pub enterprise: Oid,
    pub agent_addr: [u8; 4],
    pub generic: i64,
    pub specific: i64,
    pub timestamp: u32,
    pub varbinds: Vec<(Oid, Value)>,
}

impl TrapV1 {
    pub fn decode(content: &[u8]) -> Result<Self> {
        let mut r = Reader::new(content);
        let enterprise = Oid::decode(r.expect(ber::OBJECT_ID)?)?;
        let addr = r.expect(ber::IP_ADDRESS)?;
        let agent_addr: [u8; 4] = addr
            .try_into()
            .map_err(|_| anyhow::anyhow!("agent-addr of {} octets", addr.len()))?;
        let generic = r.integer()?;
        let specific = r.integer()?;
        let timestamp = u32::try_from(ber::decode_uint(r.expect(ber::TIMETICKS)?)?)?;
        let varbinds = decode_varbinds(r.expect(ber::SEQUENCE)?)?;
        Ok(Self {
            enterprise,
            agent_addr,
            generic,
            specific,
            timestamp,
            varbinds,
        })
    }

    #[cfg(test)]
    pub fn encode(&self) -> Vec<u8> {
        let binds: Vec<Vec<u8>> = self
            .varbinds
            .iter()
            .map(|(oid, value)| ber::seq(ber::SEQUENCE, &[&oid.encode(), &value.encode()]))
            .collect();
        let refs: Vec<&[u8]> = binds.iter().map(Vec::as_slice).collect();
        ber::seq(
            ber::TRAP_V1,
            &[
                &self.enterprise.encode(),
                &ber::tlv(ber::IP_ADDRESS, &self.agent_addr),
                &ber::integer(self.generic),
                &ber::integer(self.specific),
                &ber::unsigned(ber::TIMETICKS, u64::from(self.timestamp)),
                &ber::seq(ber::SEQUENCE, &refs),
            ],
        )
    }

    /// The RFC 3584 (section 3.1) translation to an SNMPv2 trap OID.
    pub fn trap_oid(&self) -> Oid {
        if (0..=5).contains(&self.generic) {
            Oid(vec![1, 3, 6, 1, 6, 3, 1, 1, 5, self.generic as u32 + 1])
        } else {
            let mut arcs = self.enterprise.0.clone();
            arcs.push(0);
            arcs.push(u32::try_from(self.specific).unwrap_or(0));
            Oid(arcs)
        }
    }
}

/// A PDU of either shape.
#[derive(Debug, Clone, PartialEq)]
pub enum AnyPdu {
    Pdu(Pdu),
    TrapV1(TrapV1),
}

pub fn decode_pdu(tag: u8, content: &[u8]) -> Result<AnyPdu> {
    match tag {
        ber::TRAP_V1 => Ok(AnyPdu::TrapV1(TrapV1::decode(content)?)),
        ber::GET_REQUEST
        | ber::GET_NEXT_REQUEST
        | ber::RESPONSE
        | ber::GET_BULK_REQUEST
        | ber::INFORM_REQUEST
        | ber::TRAP_V2
        | ber::REPORT
        | 0xA3 => Ok(AnyPdu::Pdu(Pdu::decode(tag, content)?)),
        other => bail!("unknown PDU type 0x{other:02x}"),
    }
}

/// `version` 0 = v1, 1 = v2c.
pub fn encode_community(version: i64, community: &[u8], pdu: &[u8]) -> Vec<u8> {
    ber::seq(
        ber::SEQUENCE,
        &[&ber::integer(version), &ber::octets(community), pdu],
    )
}

/// A decoded v1/v2c message.
#[derive(Debug, Clone, PartialEq)]
pub struct CommunityMessage {
    pub version: i64,
    pub community: Vec<u8>,
    pub pdu: AnyPdu,
}

/// The message version without decoding further (0 v1, 1 v2c, 3 v3).
pub fn peek_version(bytes: &[u8]) -> Result<i64> {
    let mut outer = Reader::new(bytes);
    let mut r = Reader::new(outer.expect(ber::SEQUENCE)?);
    r.integer()
}

pub fn decode_community(bytes: &[u8]) -> Result<CommunityMessage> {
    let mut outer = Reader::new(bytes);
    let mut r = Reader::new(outer.expect(ber::SEQUENCE)?);
    let version = r.integer()?;
    if !matches!(version, 0 | 1) {
        bail!("not a community message (version {version})");
    }
    let community = r.octets()?.to_vec();
    let (tag, content) = r.read()?;
    Ok(CommunityMessage {
        version,
        community,
        pdu: decode_pdu(tag, content)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn get_request_matches_the_wire_format() {
        let pdu = Pdu::request(
            ber::GET_REQUEST,
            1,
            &[Oid::parse("1.3.6.1.2.1.1.1.0").expect("oid")],
        );
        let msg = encode_community(1, b"public", &pdu.encode());
        assert_eq!(
            hex::encode(&msg),
            "302602010104067075626c6963a019020101020100020100300e300c06082b060102010101000500"
        );
        let back = decode_community(&msg).expect("decode");
        assert_eq!(back.version, 1);
        assert_eq!(back.community, b"public");
        assert_eq!(back.pdu, AnyPdu::Pdu(pdu));
        assert_eq!(peek_version(&msg).expect("version"), 1);
    }

    #[test]
    fn bulk_and_v1_traps() {
        let bulk = Pdu::bulk(9, 0, 20, &[Oid::parse("1.3.6.1.2.1.2.2.1.2").expect("oid")]);
        let encoded = bulk.encode();
        let mut r = Reader::new(&encoded);
        let (tag, content) = r.read().expect("tlv");
        assert_eq!(tag, ber::GET_BULK_REQUEST);
        let back = Pdu::decode(tag, content).expect("decode");
        assert_eq!(back.error_index, 20, "max-repetitions");
        let trap = TrapV1 {
            enterprise: Oid::parse("1.3.6.1.4.1.318").expect("oid"),
            agent_addr: [192, 168, 1, 20],
            generic: 6,
            specific: 5,
            timestamp: 1000,
            varbinds: vec![],
        };
        assert_eq!(trap.trap_oid().to_string(), "1.3.6.1.4.1.318.0.5");
        let link_down = TrapV1 {
            generic: 2,
            ..trap.clone()
        };
        assert_eq!(link_down.trap_oid().to_string(), "1.3.6.1.6.3.1.1.5.3");
        let encoded = trap.encode();
        let mut r = Reader::new(&encoded);
        let (tag, content) = r.read().expect("tlv");
        assert_eq!(
            decode_pdu(tag, content).expect("decode"),
            AnyPdu::TrapV1(trap)
        );
    }
}
