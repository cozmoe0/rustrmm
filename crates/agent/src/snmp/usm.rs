//! SNMPv3 with the User-based Security Model (RFC 3414): password-to-key and key localisation,
//! HMAC-SHA-96 (RFC 3414) and HMAC-SHA-256-192 (RFC 7860) authentication, AES-128-CFB privacy
//! (RFC 3826), and the v3 message and scoped PDU encodings.

use std::ops::Range;

use aes::Aes128;
use aes::cipher::{Array, BlockCipherEncrypt};
use anyhow::{Result, bail};
use hmac::{Hmac, KeyInit, Mac};
use sha1::Sha1;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use super::ber::{self, Reader};
use super::pdu::{AnyPdu, decode_pdu};

pub const FLAG_AUTH: u8 = 0x01;
pub const FLAG_PRIV: u8 = 0x02;
pub const FLAG_REPORTABLE: u8 = 0x04;
/// msgSecurityModel for USM.
pub const USM: i64 = 3;

/// Authentication protocols.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthProto {
    /// usmHMACSHAAuthProtocol (HMAC-SHA-96).
    Sha1,
    /// usmHMAC192SHA256AuthProtocol.
    Sha256,
}

impl AuthProto {
    /// `none` → `Ok(None)`.
    pub fn parse(name: &str) -> Result<Option<Self>> {
        match name {
            "none" | "" => Ok(None),
            "sha" | "sha1" => Ok(Some(Self::Sha1)),
            "sha256" => Ok(Some(Self::Sha256)),
            other => bail!("unsupported SNMPv3 authentication {other}"),
        }
    }

    /// Length of msgAuthenticationParameters.
    pub fn mac_len(self) -> usize {
        match self {
            Self::Sha1 => 12,
            Self::Sha256 => 24,
        }
    }

    fn hash(self, parts: &[&[u8]]) -> Vec<u8> {
        match self {
            Self::Sha1 => {
                let mut h = Sha1::new();
                for p in parts {
                    h.update(p);
                }
                h.finalize().to_vec()
            }
            Self::Sha256 => {
                let mut h = Sha256::new();
                for p in parts {
                    h.update(p);
                }
                h.finalize().to_vec()
            }
        }
    }

    /// RFC 3414 A.2: hash 1 MiB of the repeated password.
    pub fn password_to_key(self, password: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
        if password.is_empty() {
            bail!("an SNMPv3 password cannot be empty");
        }
        let mut chunk = [0u8; 64];
        let mut index = 0usize;
        let mut fill = |chunk: &mut [u8; 64]| {
            for b in chunk.iter_mut() {
                *b = password[index % password.len()];
                index += 1;
            }
        };
        let key = match self {
            Self::Sha1 => {
                let mut h = Sha1::new();
                for _ in 0..(1_048_576 / 64) {
                    fill(&mut chunk);
                    h.update(chunk);
                }
                h.finalize().to_vec()
            }
            Self::Sha256 => {
                let mut h = Sha256::new();
                for _ in 0..(1_048_576 / 64) {
                    fill(&mut chunk);
                    h.update(chunk);
                }
                h.finalize().to_vec()
            }
        };
        chunk.fill(0);
        Ok(Zeroizing::new(key))
    }

    /// RFC 3414 A.2: Kul = H(Ku || engineID || Ku).
    pub fn localize(self, ku: &[u8], engine_id: &[u8]) -> Zeroizing<Vec<u8>> {
        Zeroizing::new(self.hash(&[ku, engine_id, ku]))
    }

    /// Truncated HMAC over a whole message.
    pub fn mac(self, key: &[u8], message: &[u8]) -> Vec<u8> {
        let full = match self {
            Self::Sha1 => {
                let mut m = <Hmac<Sha1> as KeyInit>::new_from_slice(key)
                    .expect("HMAC takes any key length");
                m.update(message);
                m.finalize().into_bytes().to_vec()
            }
            Self::Sha256 => {
                let mut m = <Hmac<Sha256> as KeyInit>::new_from_slice(key)
                    .expect("HMAC takes any key length");
                m.update(message);
                m.finalize().into_bytes().to_vec()
            }
        };
        full[..self.mac_len()].to_vec()
    }
}

/// AES-128 in CFB-128 mode (RFC 3826); works in place, any length.
pub fn aes_cfb(key: &[u8], iv: [u8; 16], data: &mut [u8], encrypt: bool) -> Result<()> {
    if key.len() < 16 {
        bail!("AES-128 needs a 16-octet key");
    }
    let cipher = Aes128::new_from_slice(&key[..16]).map_err(|_| anyhow::anyhow!("bad AES key"))?;
    let mut feedback = iv;
    for chunk in data.chunks_mut(16) {
        let mut block = Array::from(feedback);
        cipher.encrypt_block(&mut block);
        for (i, byte) in chunk.iter_mut().enumerate() {
            let input = *byte;
            *byte ^= block[i];
            feedback[i] = if encrypt { *byte } else { input };
        }
    }
    Ok(())
}

/// The AES IV: engineBoots ‖ engineTime ‖ salt (RFC 3826 section 3.1.2.1).
pub fn priv_iv(boots: u32, time: u32, salt: &[u8]) -> Result<[u8; 16]> {
    if salt.len() != 8 {
        bail!("msgPrivacyParameters must be 8 octets");
    }
    let mut iv = [0u8; 16];
    iv[..4].copy_from_slice(&boots.to_be_bytes());
    iv[4..8].copy_from_slice(&time.to_be_bytes());
    iv[8..].copy_from_slice(salt);
    Ok(iv)
}

/// UsmSecurityParameters.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct UsmParams {
    pub engine_id: Vec<u8>,
    pub boots: i64,
    pub time: i64,
    pub user: Vec<u8>,
    pub auth: Vec<u8>,
    pub privacy: Vec<u8>,
}

impl UsmParams {
    fn parts(&self) -> [Vec<u8>; 6] {
        [
            ber::octets(&self.engine_id),
            ber::integer(self.boots),
            ber::integer(self.time),
            ber::octets(&self.user),
            ber::octets(&self.auth),
            ber::octets(&self.privacy),
        ]
    }

    pub fn encode(&self) -> Vec<u8> {
        let parts = self.parts();
        let refs: Vec<&[u8]> = parts.iter().map(Vec::as_slice).collect();
        ber::seq(ber::SEQUENCE, &refs)
    }

    /// Offset of the authentication parameters' content inside [`UsmParams::encode`].
    fn auth_offset(&self) -> usize {
        let parts = self.parts();
        let content: usize = parts.iter().map(Vec::len).sum();
        ber::header_len(content)
            + parts[..4].iter().map(Vec::len).sum::<usize>()
            + ber::header_len(self.auth.len())
    }

    pub fn decode(content: &[u8]) -> Result<Self> {
        let mut r = Reader::new(content);
        let mut s = Reader::new(r.expect(ber::SEQUENCE)?);
        Ok(Self {
            engine_id: s.octets()?.to_vec(),
            boots: s.integer()?,
            time: s.integer()?,
            user: s.octets()?.to_vec(),
            auth: s.octets()?.to_vec(),
            privacy: s.octets()?.to_vec(),
        })
    }
}

/// msgGlobalData.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Header {
    pub msg_id: i64,
    pub max_size: i64,
    pub flags: u8,
}

/// Encodes a v3 message around an already-encoded msgData (a ScopedPDU or an encrypted OCTET
/// STRING). Returns the message and, when `usm.auth` is a placeholder, its byte range.
pub fn encode_message(
    header: &Header,
    usm: &UsmParams,
    data: &[u8],
) -> (Vec<u8>, Option<Range<usize>>) {
    let version = ber::integer(3);
    let global = ber::seq(
        ber::SEQUENCE,
        &[
            &ber::integer(header.msg_id),
            &ber::integer(header.max_size),
            &ber::octets(&[header.flags]),
            &ber::integer(USM),
        ],
    );
    let usm_bytes = usm.encode();
    let sec = ber::octets(&usm_bytes);
    let content_len = version.len() + global.len() + sec.len() + data.len();
    let message = ber::seq(ber::SEQUENCE, &[&version, &global, &sec, data]);
    let range = (!usm.auth.is_empty()).then(|| {
        let start = ber::header_len(content_len)
            + version.len()
            + global.len()
            + ber::header_len(usm_bytes.len())
            + usm.auth_offset();
        start..start + usm.auth.len()
    });
    (message, range)
}

/// A decoded v3 message (msgData still encoded or encrypted).
#[derive(Debug, Clone)]
pub struct Message<'a> {
    pub header: Header,
    pub usm: UsmParams,
    /// Where msgAuthenticationParameters sit in the original bytes.
    pub auth_range: Option<Range<usize>>,
    /// `SEQUENCE` (plaintext ScopedPDU) or `OCTET STRING` (encrypted).
    pub data_tag: u8,
    pub data: &'a [u8],
}

pub fn decode_message(bytes: &[u8]) -> Result<Message<'_>> {
    let mut outer = Reader::new(bytes);
    let mut r = Reader::new(outer.expect(ber::SEQUENCE)?);
    if r.integer()? != 3 {
        bail!("not an SNMPv3 message");
    }
    let mut g = Reader::new(r.expect(ber::SEQUENCE)?);
    let msg_id = g.integer()?;
    let max_size = g.integer()?;
    let flags = *g
        .octets()?
        .first()
        .ok_or_else(|| anyhow::anyhow!("empty msgFlags"))?;
    if g.integer()? != USM {
        bail!("unsupported security model");
    }
    let sec = r.octets()?;
    let usm = UsmParams::decode(sec)?;
    // Locate the authentication parameters inside the original buffer.
    let auth_range = if usm.auth.is_empty() {
        None
    } else {
        let mut s = Reader::new(Reader::new(sec).expect(ber::SEQUENCE)?);
        for _ in 0..4 {
            s.read()?;
        }
        let auth = s.octets()?;
        let start = auth.as_ptr() as usize - bytes.as_ptr() as usize;
        Some(start..start + auth.len())
    };
    let (data_tag, data) = r.read()?;
    Ok(Message {
        header: Header {
            msg_id,
            max_size,
            flags,
        },
        usm,
        auth_range,
        data_tag,
        data,
    })
}

/// Checks a received message's HMAC.
pub fn verify(proto: AuthProto, key: &[u8], bytes: &[u8], range: &Range<usize>) -> bool {
    let Some(received) = bytes.get(range.clone()) else {
        return false;
    };
    if received.len() != proto.mac_len() {
        return false;
    }
    let mut copy = bytes.to_vec();
    copy[range.clone()].fill(0);
    let expected = proto.mac(key, &copy);
    rustrmm_crypto::random::ct_eq(&expected, received)
}

pub fn encode_scoped(context_engine: &[u8], context_name: &[u8], pdu: &[u8]) -> Vec<u8> {
    ber::seq(
        ber::SEQUENCE,
        &[
            &ber::octets(context_engine),
            &ber::octets(context_name),
            pdu,
        ],
    )
}

/// A ScopedPDU's content: (contextEngineID, contextName, PDU).
pub fn decode_scoped(content: &[u8]) -> Result<(Vec<u8>, Vec<u8>, AnyPdu)> {
    let mut r = Reader::new(content);
    let engine = r.octets()?.to_vec();
    let name = r.octets()?.to_vec();
    let (tag, pdu) = r.read()?;
    Ok((engine, name, decode_pdu(tag, pdu)?))
}

/// A configured SNMPv3 user with its password-derived (not yet localised) keys.
pub struct User {
    pub name: Vec<u8>,
    pub auth: Option<(AuthProto, Zeroizing<Vec<u8>>)>,
    /// Ku of the privacy password (hashed with the authentication protocol).
    pub privacy: Option<Zeroizing<Vec<u8>>>,
}

/// Keys localised to one authoritative engine.
pub struct LocalKeys {
    pub auth: Option<(AuthProto, Zeroizing<Vec<u8>>)>,
    pub privacy: Option<Zeroizing<Vec<u8>>>,
}

impl User {
    pub fn new(v3: &rustrmm_proto::network::SnmpV3) -> Result<Self> {
        let auth_proto = AuthProto::parse(&v3.auth)?;
        let privacy = match v3.privacy.as_str() {
            "none" | "" => false,
            "aes128" | "aes" => true,
            other => bail!("unsupported SNMPv3 privacy {other}"),
        };
        if privacy && auth_proto.is_none() {
            bail!("SNMPv3 privacy needs authentication");
        }
        let auth = match auth_proto {
            Some(p) => Some((p, p.password_to_key(v3.auth_password.as_bytes())?)),
            None => None,
        };
        let privacy = match (privacy, auth_proto) {
            (true, Some(p)) => Some(p.password_to_key(v3.privacy_password.as_bytes())?),
            _ => None,
        };
        Ok(Self {
            name: v3.username.as_bytes().to_vec(),
            auth,
            privacy,
        })
    }

    pub fn localize(&self, engine_id: &[u8]) -> LocalKeys {
        let auth = self
            .auth
            .as_ref()
            .map(|(p, ku)| (*p, p.localize(ku, engine_id)));
        let privacy = match (&self.auth, &self.privacy) {
            (Some((p, _)), Some(ku)) => {
                let mut key = p.localize(ku, engine_id);
                key.truncate(16);
                Some(key)
            }
            _ => None,
        };
        LocalKeys { auth, privacy }
    }

    pub fn flags(&self) -> u8 {
        let mut flags = 0;
        if self.auth.is_some() {
            flags |= FLAG_AUTH;
        }
        if self.privacy.is_some() {
            flags |= FLAG_PRIV;
        }
        flags
    }
}

/// Builds a complete request (authenticated and encrypted as the keys allow).
#[allow(clippy::too_many_arguments)]
pub fn build_request(
    msg_id: i64,
    user: &User,
    keys: &LocalKeys,
    engine_id: &[u8],
    boots: i64,
    time: i64,
    salt: [u8; 8],
    pdu: &[u8],
) -> Result<Vec<u8>> {
    let scoped = encode_scoped(engine_id, b"", pdu);
    let (data, privacy) = match &keys.privacy {
        Some(key) => {
            let mut encrypted = scoped;
            let iv = priv_iv(boots as u32, time as u32, &salt)?;
            aes_cfb(key, iv, &mut encrypted, true)?;
            (ber::octets(&encrypted), salt.to_vec())
        }
        None => (scoped, Vec::new()),
    };
    let usm = UsmParams {
        engine_id: engine_id.to_vec(),
        boots,
        time,
        user: user.name.clone(),
        auth: keys
            .auth
            .as_ref()
            .map(|(p, _)| vec![0u8; p.mac_len()])
            .unwrap_or_default(),
        privacy,
    };
    let header = Header {
        msg_id,
        max_size: ber::MAX_MESSAGE as i64,
        flags: user.flags() | FLAG_REPORTABLE,
    };
    let (mut message, range) = encode_message(&header, &usm, &data);
    if let (Some((proto, key)), Some(range)) = (&keys.auth, range) {
        let mac = proto.mac(key, &message);
        message[range].copy_from_slice(&mac);
    }
    Ok(message)
}

/// Opens a received message: checks the HMAC when it claims authentication and decrypts an
/// encrypted ScopedPDU. Returns the PDU and whether it was authenticated.
pub fn open<'a>(bytes: &'a [u8], keys: &LocalKeys) -> Result<(Message<'a>, AnyPdu, bool)> {
    let message = decode_message(bytes)?;
    let mut authenticated = false;
    if message.header.flags & FLAG_AUTH != 0 {
        let (Some((proto, key)), Some(range)) = (&keys.auth, &message.auth_range) else {
            bail!("authenticated message without matching keys");
        };
        if !verify(*proto, key, bytes, range) {
            bail!("SNMPv3 authentication failed (wrong digest)");
        }
        authenticated = true;
    }
    let pdu = if message.header.flags & FLAG_PRIV != 0 {
        if !authenticated {
            bail!("encrypted message without authentication");
        }
        let key = keys
            .privacy
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("encrypted message without a privacy key"))?;
        if message.data_tag != ber::OCTET_STRING {
            bail!("encrypted ScopedPDU expected");
        }
        let iv = priv_iv(
            message.usm.boots as u32,
            message.usm.time as u32,
            &message.usm.privacy,
        )?;
        let mut plain = message.data.to_vec();
        aes_cfb(key, iv, &mut plain, false)?;
        let mut r = Reader::new(&plain);
        let content = r.expect(ber::SEQUENCE)?;
        decode_scoped(content)?.2
    } else {
        if message.data_tag != ber::SEQUENCE {
            bail!("plaintext ScopedPDU expected");
        }
        decode_scoped(message.data)?.2
    };
    Ok((message, pdu, authenticated))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::snmp::ber::Oid;
    use crate::snmp::pdu::Pdu;

    #[test]
    fn rfc3414_key_localisation() {
        // RFC 3414 A.3.2 (SHA): password "maplesyrup", engine 00…02.
        let engine = hex::decode("000000000000000000000002").expect("hex");
        let ku = AuthProto::Sha1.password_to_key(b"maplesyrup").expect("ku");
        assert_eq!(
            hex::encode(&*ku),
            "9fb5cc0381497b3793528939ff788d5d79145211"
        );
        let kul = AuthProto::Sha1.localize(&ku, &engine);
        assert_eq!(
            hex::encode(&*kul),
            "6695febc9288e36282235fc7151f128497b38f3f"
        );
        // The same algorithm with SHA-256 (RFC 7860), cross-checked with Python's hashlib.
        let ku = AuthProto::Sha256
            .password_to_key(b"maplesyrup")
            .expect("ku");
        assert_eq!(
            hex::encode(&*ku),
            "ab51014d1e077f6017df2b12bee5f5aa72993177e9bb569c4dff5a4ca0b4afac"
        );
        let kul = AuthProto::Sha256.localize(&ku, &engine);
        assert_eq!(
            hex::encode(&*kul),
            "8982e0e549e866db361a6b625d84cccc11162d453ee8ce3a6445c2d6776f0f8b"
        );
        assert!(AuthProto::Sha1.password_to_key(b"").is_err());
    }

    #[test]
    fn hmac_truncation_and_aes_cfb_vectors() {
        // RFC 2202 test case 1 / RFC 4231 test case 1, truncated to 96 and 192 bits.
        let key = [0x0bu8; 20];
        assert_eq!(
            hex::encode(AuthProto::Sha1.mac(&key, b"Hi There")),
            "b617318655057264e28bc0b6"
        );
        assert_eq!(
            hex::encode(AuthProto::Sha256.mac(&key, b"Hi There")),
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da7"
        );
        // NIST SP 800-38A F.3.13 (CFB128-AES128), the first two blocks.
        let key = hex::decode("2b7e151628aed2a6abf7158809cf4f3c").expect("hex");
        let iv: [u8; 16] = hex::decode("000102030405060708090a0b0c0d0e0f")
            .expect("hex")
            .try_into()
            .expect("16");
        let plain = hex::decode("6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e51")
            .expect("hex");
        let mut data = plain.clone();
        aes_cfb(&key, iv, &mut data, true).expect("encrypt");
        assert_eq!(
            hex::encode(&data),
            "3b3fd92eb72dad20333449f8e83cfb4ac8a64537a0b3a93fcde3cdad9f1ce58b"
        );
        aes_cfb(&key, iv, &mut data, false).expect("decrypt");
        assert_eq!(data, plain);
        // A partial final block works too.
        let mut short = plain[..20].to_vec();
        aes_cfb(&key, iv, &mut short, true).expect("encrypt");
        assert_eq!(
            hex::encode(&short),
            "3b3fd92eb72dad20333449f8e83cfb4ac8a64537"
        );
    }

    fn user(auth: &str, privacy: &str) -> User {
        User::new(&rustrmm_proto::network::SnmpV3 {
            username: "monitor".into(),
            auth: auth.into(),
            auth_password: "authpass123".into(),
            privacy: privacy.into(),
            privacy_password: "privpass123".into(),
        })
        .expect("user")
    }

    #[test]
    fn v3_messages_authenticate_and_encrypt() {
        let engine = hex::decode("80001f8880e9630000d61ff449").expect("hex");
        for (auth, privacy) in [
            ("sha", "aes128"),
            ("sha256", "aes128"),
            ("sha256", "none"),
            ("none", "none"),
        ] {
            let user = user(auth, privacy);
            let keys = user.localize(&engine);
            let pdu = Pdu::request(
                ber::GET_REQUEST,
                77,
                &[Oid::parse("1.3.6.1.2.1.1.5.0").expect("oid")],
            );
            let bytes = build_request(5, &user, &keys, &engine, 3, 1234, [9u8; 8], &pdu.encode())
                .expect("build");
            let (message, back, authenticated) = open(&bytes, &keys).expect("open");
            assert_eq!(message.header.msg_id, 5);
            assert_eq!(message.usm.engine_id, engine);
            assert_eq!(message.usm.boots, 3);
            assert_eq!(message.usm.user, b"monitor");
            assert_eq!(authenticated, auth != "none", "{auth}");
            assert_eq!(back, AnyPdu::Pdu(pdu), "{auth}/{privacy}");
            if privacy != "none" {
                assert!(
                    !bytes
                        .windows(7)
                        .any(|w| w == [0x06, 0x08, 0x2b, 0x06, 0x01, 0x02, 0x01]),
                    "the OID is not visible in an encrypted message"
                );
            }
            if auth != "none" {
                // Any changed octet breaks the digest.
                let mut tampered = bytes.clone();
                let last = tampered.len() - 1;
                tampered[last] ^= 1;
                assert!(open(&tampered, &keys).is_err());
                // Keys for another engine do not verify.
                let other = user.localize(b"other-engine");
                assert!(open(&bytes, &other).is_err());
            }
        }
    }
}
