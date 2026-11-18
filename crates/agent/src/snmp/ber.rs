//! The subset of BER (X.690) SNMP uses: single-byte tags, definite lengths, INTEGER, OCTET
//! STRING, NULL, OBJECT IDENTIFIER, SEQUENCE and the SNMP application types.

use anyhow::{Result, bail};

pub const INTEGER: u8 = 0x02;
pub const OCTET_STRING: u8 = 0x04;
pub const NULL: u8 = 0x05;
pub const OBJECT_ID: u8 = 0x06;
pub const SEQUENCE: u8 = 0x30;
pub const IP_ADDRESS: u8 = 0x40;
pub const COUNTER32: u8 = 0x41;
pub const GAUGE32: u8 = 0x42;
pub const TIMETICKS: u8 = 0x43;
pub const OPAQUE: u8 = 0x44;
pub const COUNTER64: u8 = 0x46;
pub const NO_SUCH_OBJECT: u8 = 0x80;
pub const NO_SUCH_INSTANCE: u8 = 0x81;
pub const END_OF_MIB_VIEW: u8 = 0x82;
pub const GET_REQUEST: u8 = 0xA0;
pub const GET_NEXT_REQUEST: u8 = 0xA1;
pub const RESPONSE: u8 = 0xA2;
pub const TRAP_V1: u8 = 0xA4;
pub const GET_BULK_REQUEST: u8 = 0xA5;
pub const INFORM_REQUEST: u8 = 0xA6;
pub const TRAP_V2: u8 = 0xA7;
pub const REPORT: u8 = 0xA8;

/// Longest message we build or accept.
pub const MAX_MESSAGE: usize = 65_507;

fn len_bytes(len: usize) -> Vec<u8> {
    if len < 0x80 {
        return vec![len as u8];
    }
    let bytes = (len as u64).to_be_bytes();
    let skip = bytes.iter().take_while(|b| **b == 0).count();
    let mut out = vec![0x80 | (bytes.len() - skip) as u8];
    out.extend_from_slice(&bytes[skip..]);
    out
}

/// Size of the tag and length octets for content of `len` bytes.
pub fn header_len(len: usize) -> usize {
    1 + len_bytes(len).len()
}

/// Tag, length, content.
pub fn tlv(tag: u8, content: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(content.len() + 6);
    out.push(tag);
    out.extend_from_slice(&len_bytes(content.len()));
    out.extend_from_slice(content);
    out
}

/// A constructed value from already-encoded parts.
pub fn seq(tag: u8, parts: &[&[u8]]) -> Vec<u8> {
    let content: Vec<u8> = parts.concat();
    tlv(tag, &content)
}

/// Minimal two's-complement content octets.
fn int_content(v: i64) -> Vec<u8> {
    let bytes = v.to_be_bytes();
    let mut start = 0;
    while start < 7 {
        let (b, next) = (bytes[start], bytes[start + 1]);
        if (b == 0x00 && next & 0x80 == 0) || (b == 0xFF && next & 0x80 != 0) {
            start += 1;
        } else {
            break;
        }
    }
    bytes[start..].to_vec()
}

pub fn integer(v: i64) -> Vec<u8> {
    tlv(INTEGER, &int_content(v))
}

/// An unsigned application value (Counter32, Gauge32, TimeTicks, Counter64).
pub fn unsigned(tag: u8, v: u64) -> Vec<u8> {
    let bytes = v.to_be_bytes();
    let skip = bytes.iter().take_while(|b| **b == 0).count().min(7);
    let mut content = Vec::with_capacity(9);
    if bytes[skip] & 0x80 != 0 {
        content.push(0);
    }
    content.extend_from_slice(&bytes[skip..]);
    tlv(tag, &content)
}

pub fn octets(v: &[u8]) -> Vec<u8> {
    tlv(OCTET_STRING, v)
}

pub fn null() -> Vec<u8> {
    vec![NULL, 0]
}

pub fn decode_int(content: &[u8]) -> Result<i64> {
    if content.is_empty() || content.len() > 8 {
        bail!("INTEGER of {} octets", content.len());
    }
    let mut v: i64 = if content[0] & 0x80 != 0 { -1 } else { 0 };
    for b in content {
        v = (v << 8) | i64::from(*b);
    }
    Ok(v)
}

pub fn decode_uint(content: &[u8]) -> Result<u64> {
    let content = match content {
        [0, rest @ ..] if !rest.is_empty() => rest,
        c => c,
    };
    if content.is_empty() || content.len() > 8 {
        bail!("unsigned value of {} octets", content.len());
    }
    Ok(content.iter().fold(0u64, |v, b| (v << 8) | u64::from(*b)))
}

/// A numeric object identifier.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Oid(pub Vec<u32>);

impl Oid {
    pub fn parse(text: &str) -> Result<Self> {
        let text = text.trim().trim_start_matches('.');
        let arcs: Vec<u32> = text
            .split('.')
            .map(|p| p.parse::<u32>())
            .collect::<Result<_, _>>()
            .map_err(|_| anyhow::anyhow!("invalid OID {text}"))?;
        if arcs.len() < 2 || arcs[0] > 2 || (arcs[0] < 2 && arcs[1] >= 40) || arcs.len() > 128 {
            bail!("invalid OID {text}");
        }
        Ok(Self(arcs))
    }

    pub fn starts_with(&self, prefix: &Oid) -> bool {
        self.0.len() >= prefix.0.len() && self.0[..prefix.0.len()] == prefix.0[..]
    }

    /// The arcs after `prefix`, dotted (the table row index).
    pub fn suffix(&self, prefix: &Oid) -> String {
        self.0[prefix.0.len().min(self.0.len())..]
            .iter()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join(".")
    }

    #[cfg(test)]
    pub fn child(&self, arc: u32) -> Oid {
        let mut arcs = self.0.clone();
        arcs.push(arc);
        Oid(arcs)
    }

    fn content(&self) -> Vec<u8> {
        let mut out = Vec::new();
        let mut push = |mut v: u64| {
            let mut tmp = vec![(v & 0x7F) as u8];
            v >>= 7;
            while v > 0 {
                tmp.push(0x80 | (v & 0x7F) as u8);
                v >>= 7;
            }
            tmp.reverse();
            out.extend_from_slice(&tmp);
        };
        let first = u64::from(self.0[0]) * 40 + u64::from(*self.0.get(1).unwrap_or(&0));
        push(first);
        for arc in self.0.iter().skip(2) {
            push(u64::from(*arc));
        }
        out
    }

    pub fn encode(&self) -> Vec<u8> {
        tlv(OBJECT_ID, &self.content())
    }

    pub fn decode(content: &[u8]) -> Result<Self> {
        if content.is_empty() {
            bail!("empty OID");
        }
        let mut values = Vec::new();
        let mut v: u64 = 0;
        let mut in_arc = false;
        for b in content {
            if !in_arc && *b == 0x80 {
                bail!("OID arc with a leading zero octet");
            }
            v = (v << 7) | u64::from(b & 0x7F);
            if v > u64::from(u32::MAX) * 40 + 39 {
                bail!("OID arc too large");
            }
            in_arc = b & 0x80 != 0;
            if !in_arc {
                values.push(v);
                v = 0;
            }
        }
        if in_arc {
            bail!("truncated OID");
        }
        let first = values[0];
        let (a, b) = if first < 80 {
            (first / 40, first % 40)
        } else {
            (2, first - 80)
        };
        let mut arcs = vec![a as u32, u32::try_from(b)?];
        for v in values.into_iter().skip(1) {
            arcs.push(u32::try_from(v)?);
        }
        if arcs.len() > 128 {
            bail!("OID too long");
        }
        Ok(Self(arcs))
    }
}

impl std::fmt::Display for Oid {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let parts: Vec<String> = self.0.iter().map(u32::to_string).collect();
        f.write_str(&parts.join("."))
    }
}

/// An SNMP value.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Integer(i64),
    OctetString(Vec<u8>),
    Null,
    Oid(Oid),
    IpAddress([u8; 4]),
    Counter32(u32),
    Gauge32(u32),
    TimeTicks(u32),
    Opaque(Vec<u8>),
    Counter64(u64),
    NoSuchObject,
    NoSuchInstance,
    EndOfMibView,
}

impl Value {
    pub fn encode(&self) -> Vec<u8> {
        match self {
            Self::Integer(v) => integer(*v),
            Self::OctetString(v) => octets(v),
            Self::Null => null(),
            Self::Oid(o) => o.encode(),
            Self::IpAddress(a) => tlv(IP_ADDRESS, a),
            Self::Counter32(v) => unsigned(COUNTER32, u64::from(*v)),
            Self::Gauge32(v) => unsigned(GAUGE32, u64::from(*v)),
            Self::TimeTicks(v) => unsigned(TIMETICKS, u64::from(*v)),
            Self::Opaque(v) => tlv(OPAQUE, v),
            Self::Counter64(v) => unsigned(COUNTER64, *v),
            Self::NoSuchObject => vec![NO_SUCH_OBJECT, 0],
            Self::NoSuchInstance => vec![NO_SUCH_INSTANCE, 0],
            Self::EndOfMibView => vec![END_OF_MIB_VIEW, 0],
        }
    }

    pub fn decode(tag: u8, content: &[u8]) -> Result<Self> {
        let u32_of = |c: &[u8]| -> Result<u32> {
            u32::try_from(decode_uint(c)?).map_err(|_| anyhow::anyhow!("32-bit value out of range"))
        };
        Ok(match tag {
            INTEGER => Self::Integer(decode_int(content)?),
            OCTET_STRING => Self::OctetString(content.to_vec()),
            NULL => Self::Null,
            OBJECT_ID => Self::Oid(Oid::decode(content)?),
            IP_ADDRESS => {
                let a: [u8; 4] = content
                    .try_into()
                    .map_err(|_| anyhow::anyhow!("IpAddress of {} octets", content.len()))?;
                Self::IpAddress(a)
            }
            COUNTER32 => Self::Counter32(u32_of(content)?),
            GAUGE32 => Self::Gauge32(u32_of(content)?),
            TIMETICKS => Self::TimeTicks(u32_of(content)?),
            OPAQUE => Self::Opaque(content.to_vec()),
            COUNTER64 => Self::Counter64(decode_uint(content)?),
            NO_SUCH_OBJECT => Self::NoSuchObject,
            NO_SUCH_INSTANCE => Self::NoSuchInstance,
            END_OF_MIB_VIEW => Self::EndOfMibView,
            other => bail!("unsupported value type 0x{other:02x}"),
        })
    }

    /// `noSuchObject`, `noSuchInstance` or `endOfMibView`.
    pub fn is_exception(&self) -> bool {
        matches!(
            self,
            Self::NoSuchObject | Self::NoSuchInstance | Self::EndOfMibView
        )
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Self::Integer(_) => "integer",
            Self::OctetString(_) => "string",
            Self::Null => "null",
            Self::Oid(_) => "oid",
            Self::IpAddress(_) => "ip",
            Self::Counter32(_) => "counter32",
            Self::Gauge32(_) => "gauge32",
            Self::TimeTicks(_) => "timeticks",
            Self::Opaque(_) => "opaque",
            Self::Counter64(_) => "counter64",
            Self::NoSuchObject => "no_such_object",
            Self::NoSuchInstance => "no_such_instance",
            Self::EndOfMibView => "end_of_mib_view",
        }
    }

    /// Text for string-like values (printable UTF-8, otherwise hex).
    pub fn as_text(&self) -> Option<String> {
        match self {
            Self::OctetString(b) | Self::Opaque(b) => Some(printable(b)),
            Self::Oid(o) => Some(o.to_string()),
            Self::IpAddress(a) => Some(std::net::Ipv4Addr::from(*a).to_string()),
            Self::Integer(v) => Some(v.to_string()),
            Self::Counter32(v) | Self::Gauge32(v) | Self::TimeTicks(v) => Some(v.to_string()),
            Self::Counter64(v) => Some(v.to_string()),
            _ => None,
        }
    }

    pub fn to_json(&self) -> serde_json::Value {
        match self {
            Self::Integer(v) => serde_json::json!(v),
            Self::Counter32(v) | Self::Gauge32(v) | Self::TimeTicks(v) => serde_json::json!(v),
            Self::Counter64(v) => serde_json::json!(v),
            Self::Null | Self::NoSuchObject | Self::NoSuchInstance | Self::EndOfMibView => {
                serde_json::Value::Null
            }
            other => serde_json::json!(other.as_text().unwrap_or_default()),
        }
    }
}

/// Printable text when the octets are UTF-8 without control characters (trailing NULs
/// dropped), otherwise colon-separated hex (MAC addresses and other binary values).
pub fn printable(bytes: &[u8]) -> String {
    let trimmed = match bytes.iter().rposition(|b| *b != 0) {
        Some(i) => &bytes[..=i],
        None => &[][..],
    };
    match std::str::from_utf8(trimmed) {
        Ok(s)
            if s.chars()
                .all(|c| !c.is_control() || matches!(c, '\t' | '\r' | '\n')) =>
        {
            s.trim().to_string()
        }
        _ => bytes
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<Vec<_>>()
            .join(":"),
    }
}

/// Reads consecutive TLVs from a buffer.
pub struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    pub fn is_empty(&self) -> bool {
        self.pos >= self.data.len()
    }

    /// The next TLV: (tag, content).
    pub fn read(&mut self) -> Result<(u8, &'a [u8])> {
        let data = self.data;
        let mut p = self.pos;
        let Some(&tag) = data.get(p) else {
            bail!("unexpected end of data");
        };
        if tag & 0x1F == 0x1F {
            bail!("multi-byte tags are not used by SNMP");
        }
        p += 1;
        let Some(&first) = data.get(p) else {
            bail!("missing length");
        };
        p += 1;
        let len = if first < 0x80 {
            usize::from(first)
        } else {
            let n = usize::from(first & 0x7F);
            if n == 0 || n > 4 {
                bail!("unsupported length encoding");
            }
            let Some(bytes) = data.get(p..p + n) else {
                bail!("truncated length");
            };
            p += n;
            bytes.iter().fold(0usize, |v, b| (v << 8) | usize::from(*b))
        };
        let Some(content) = data.get(p..p.saturating_add(len)) else {
            bail!("truncated value ({len} octets declared)");
        };
        self.pos = p + len;
        Ok((tag, content))
    }

    pub fn expect(&mut self, tag: u8) -> Result<&'a [u8]> {
        let (t, content) = self.read()?;
        if t != tag {
            bail!("expected tag 0x{tag:02x}, found 0x{t:02x}");
        }
        Ok(content)
    }

    pub fn integer(&mut self) -> Result<i64> {
        decode_int(self.expect(INTEGER)?)
    }

    pub fn octets(&mut self) -> Result<&'a [u8]> {
        self.expect(OCTET_STRING)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integers_use_minimal_twos_complement() {
        for (v, hex) in [
            (0i64, "020100"),
            (127, "02017f"),
            (128, "02020080"),
            (256, "02020100"),
            (-1, "0201ff"),
            (-128, "020180"),
            (-129, "0202ff7f"),
            (2_147_483_647, "02047fffffff"),
        ] {
            assert_eq!(hex::encode(integer(v)), hex, "{v}");
            let encoded = integer(v);
            let mut r = Reader::new(&encoded);
            assert_eq!(r.integer().expect("decode"), v);
        }
        assert_eq!(hex::encode(unsigned(COUNTER32, 0)), "410100");
        assert_eq!(hex::encode(unsigned(GAUGE32, 0x80)), "42020080");
        assert_eq!(
            hex::encode(unsigned(COUNTER64, u64::MAX)),
            "460900ffffffffffffffff"
        );
        assert_eq!(
            decode_uint(&hex::decode("00ffffffffffffffff").expect("hex")).expect("u64"),
            u64::MAX
        );
        assert!(decode_int(&[]).is_err());
        assert!(decode_uint(&[1, 2, 3, 4, 5, 6, 7, 8, 9]).is_err());
    }

    #[test]
    fn lengths_and_oids() {
        assert_eq!(&tlv(OCTET_STRING, &[0u8; 200])[..3], &[0x04, 0x81, 0xC8]);
        assert_eq!(
            &tlv(OCTET_STRING, &[0u8; 300])[..4],
            &[0x04, 0x82, 0x01, 0x2C]
        );
        assert_eq!(header_len(300), 4);
        let oid = Oid::parse("1.3.6.1.2.1.1.1.0").expect("oid");
        assert_eq!(hex::encode(oid.encode()), "06082b06010201010100");
        // Multi-byte arcs: 1.3.6.1.4.1.311.21.20 (311 = 0x82 0x37).
        let ms = Oid::parse(".1.3.6.1.4.1.311.21.20").expect("oid");
        assert_eq!(hex::encode(ms.encode()), "06092b0601040182371514");
        let encoded = ms.encode();
        let mut r = Reader::new(&encoded);
        assert_eq!(
            Oid::decode(r.expect(OBJECT_ID).expect("tlv")).expect("decode"),
            ms
        );
        // 2.999.3 uses the joint-iso arc rule.
        let joint = Oid::parse("2.999.3").expect("oid");
        assert_eq!(hex::encode(joint.encode()), "0603883703");
        assert_eq!(
            Oid::decode(&hex::decode("883703").expect("hex")).expect("decode"),
            joint
        );
        assert!(Oid::parse("1.40.1").is_err());
        assert!(Oid::parse("x.y").is_err());
        assert!(Oid::decode(&[0x2b, 0x86]).is_err(), "truncated arc");
        let table = Oid::parse("1.3.6.1.2.1.2.2.1.10").expect("oid");
        let cell = Oid::parse("1.3.6.1.2.1.2.2.1.10.3").expect("oid");
        assert!(cell.starts_with(&table));
        assert_eq!(cell.suffix(&table), "3");
        assert_eq!(table.child(7).to_string(), "1.3.6.1.2.1.2.2.1.10.7");
    }

    #[test]
    fn values_round_trip_and_render() {
        for v in [
            Value::Integer(-5),
            Value::OctetString(b"HP LaserJet".to_vec()),
            Value::Null,
            Value::Oid(Oid::parse("1.3.6.1.4.1.11").expect("oid")),
            Value::IpAddress([192, 168, 1, 10]),
            Value::Counter32(u32::MAX),
            Value::Gauge32(42),
            Value::TimeTicks(123_456),
            Value::Counter64(u64::MAX - 1),
            Value::NoSuchInstance,
            Value::EndOfMibView,
        ] {
            let bytes = v.encode();
            let mut r = Reader::new(&bytes);
            let (tag, content) = r.read().expect("tlv");
            assert_eq!(Value::decode(tag, content).expect("decode"), v);
        }
        assert_eq!(printable(b"Black Toner\0\0"), "Black Toner");
        assert_eq!(
            printable(&[0x00, 0x1b, 0xa9, 0x01, 0x02, 0x03]),
            "00:1b:a9:01:02:03"
        );
        assert_eq!(Value::Counter64(7).to_json(), serde_json::json!(7u64));
        assert_eq!(
            Value::IpAddress([10, 0, 0, 1]).to_json(),
            serde_json::json!("10.0.0.1")
        );
        let mut r = Reader::new(&[0x04, 0x05, 0x01]);
        assert!(r.read().is_err(), "truncated content");
        let mut r = Reader::new(&[0x04, 0x80]);
        assert!(r.read().is_err(), "indefinite length");
    }
}
