//! Noise IK end-to-end channel inside the agent WebSocket (`docs/api-platform.md`).
//!
//! TLS protects the agent connection hop by hop; a TLS-terminating reverse proxy (`tls_mode =
//! proxy`) or a corporate TLS-inspection box can still read it. When both peers advertise the
//! [`CAPABILITY`], every frame after the identity handshake is additionally wrapped in a
//! `Noise_IK_25519_ChaChaPoly_BLAKE2s` channel that ends inside the agent and the server.
//!
//! Negotiation (control connection):
//!
//! 1. Agent → `Hello { capabilities: [.., "noise"] }`.
//! 2. Server → `Challenge { .., noise: Some(NoiseOffer) }`. The offer carries the server's static
//!    X25519 key, signed by the server identity key over both nonces and the device id
//!    ([`offer`]). The agent verifies it against the identity key it pinned at enrollment and
//!    then pins the Noise key itself after the first successful handshake ([`accept_offer`]).
//! 3. Agent → `Proof`, then [`NoiseInit`]: the first IK message plus a device-key signature over
//!    the agent's static key ([`start_control`]).
//! 4. Server → [`NoiseAccept`] (the second IK message, [`accept_control`]); from here on both
//!    sides wrap frames with a [`NoiseCodec`], starting with `Welcome`.
//!
//! Tunnel sockets run their own IK handshake with the same static keys (prologue bound to the
//! tunnel id); the server checks that the agent's static key is the one of the live control
//! connection.
//!
//! Wire format: one WebSocket binary message carries one logical message, split into Noise
//! transport messages of at most 65 535 bytes (every chunk is full-size except the last, so no
//! length prefixes are needed). The first plaintext byte is a header: the data kind (binary or
//! text) and a rekey flag. Each side rekeys its sending key (Noise `REKEY`) after 1 GiB or one
//! hour, setting the flag on the last message under the old key so the receiver follows.

use std::marker::PhantomData;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::task::{Context, Poll, ready};
use std::time::{Duration, Instant};

use futures::{Sink, Stream};
use rustrmm_crypto::sign::{PublicKey, SigningKey};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::Message;

/// Capability name in `Hello.capabilities`.
pub const CAPABILITY: &str = "noise";
/// Noise protocol name.
pub const PATTERN: &str = "Noise_IK_25519_ChaChaPoly_BLAKE2s";
/// Largest Noise message (spec limit).
pub const MAX_NOISE_MESSAGE: usize = 65_535;
/// AEAD tag added to every transport message.
pub const TAG_LEN: usize = 16;
/// Plaintext bytes per transport message.
pub const MAX_CHUNK_PLAINTEXT: usize = MAX_NOISE_MESSAGE - TAG_LEN;
/// Each side rekeys its sending direction after this many plaintext bytes…
pub const REKEY_BYTES: u64 = 1 << 30;
/// …or after this long, whichever comes first.
pub const REKEY_INTERVAL: Duration = Duration::from_secs(3600);

const SERVER_KEY_CONTEXT: &[u8] = b"rustrmm/v1/noise/server-static";
const AGENT_KEY_CONTEXT: &[u8] = b"rustrmm/v1/noise/agent-static";
const CONTROL_PROLOGUE: &[u8] = b"rustrmm/v1/noise/control";
const TUNNEL_PROLOGUE: &[u8] = b"rustrmm/v1/noise/tunnel";

const KIND_MASK: u8 = 0x0f;
const FLAG_REKEY: u8 = 0x80;

/// Wire size of a logical message with `plaintext` payload bytes (header and tags included).
pub const fn sealed_len(plaintext: usize) -> usize {
    let p = plaintext + 1;
    p + p.div_ceil(MAX_CHUNK_PLAINTEXT) * TAG_LEN
}

static REKEY_BYTES_OVERRIDE: AtomicU64 = AtomicU64::new(0);

/// Lowers the rekey threshold for every codec created afterwards in this process.
///
/// Test-only: integration tests use it to exercise rekeying without sending a gigabyte.
#[doc(hidden)]
pub fn set_rekey_bytes_for_tests(bytes: u64) {
    REKEY_BYTES_OVERRIDE.store(bytes, Ordering::Relaxed);
}

fn rekey_bytes() -> u64 {
    match REKEY_BYTES_OVERRIDE.load(Ordering::Relaxed) {
        0 => REKEY_BYTES,
        n => n,
    }
}

#[derive(Debug, thiserror::Error)]
pub enum NoiseError {
    #[error("noise: {0}")]
    Snow(#[from] snow::Error),
    #[error("the server's Noise key is not signed by its identity key")]
    BadOfferSignature,
    #[error(
        "the server's Noise key differs from the key pinned by this agent; refusing to connect"
    )]
    PinMismatch,
    #[error(
        "the server did not offer the Noise channel although this agent pinned a key (possible downgrade)"
    )]
    Downgrade,
    #[error("the agent's Noise key is not signed by its device key")]
    BadAgentSignature,
    #[error("invalid Noise key")]
    BadKey,
    #[error("malformed Noise message: {0}")]
    Malformed(&'static str),
    #[error("unencrypted data frame on an encrypted channel")]
    Plaintext,
}

pub type NoiseResult<T> = std::result::Result<T, NoiseError>;

fn params() -> snow::params::NoiseParams {
    PATTERN.parse().expect("valid Noise pattern")
}

/// A static X25519 key pair (server key ring, agent identity).
#[derive(Clone)]
pub struct StaticKeypair {
    secret: Zeroizing<[u8; 32]>,
    public: [u8; 32],
}

impl std::fmt::Debug for StaticKeypair {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StaticKeypair")
            .field("public", &encode_key(&self.public))
            .finish_non_exhaustive()
    }
}

impl StaticKeypair {
    pub fn generate() -> Self {
        Self::from_secret(&rustrmm_crypto::random::bytes::<32>()).expect("32 bytes")
    }

    pub fn from_secret(secret: &[u8]) -> NoiseResult<Self> {
        let secret: [u8; 32] = secret.try_into().map_err(|_| NoiseError::BadKey)?;
        let public = curve25519_dalek::MontgomeryPoint::mul_base_clamped(secret).to_bytes();
        Ok(Self {
            secret: Zeroizing::new(secret),
            public,
        })
    }

    pub fn secret_bytes(&self) -> &[u8; 32] {
        &self.secret
    }

    pub fn public_key(&self) -> [u8; 32] {
        self.public
    }
}

/// `x25519:<base64>` text form of a public key (storage, logs, API).
pub fn encode_key(public: &[u8; 32]) -> String {
    use base64::Engine as _;
    format!(
        "x25519:{}",
        base64::engine::general_purpose::STANDARD.encode(public)
    )
}

pub fn decode_key(text: &str) -> NoiseResult<[u8; 32]> {
    use base64::Engine as _;
    let body = text.strip_prefix("x25519:").ok_or(NoiseError::BadKey)?;
    base64::engine::general_purpose::STANDARD
        .decode(body)
        .ok()
        .and_then(|b| <[u8; 32]>::try_from(b).ok())
        .ok_or(NoiseError::BadKey)
}

fn key32(bytes: &[u8]) -> NoiseResult<[u8; 32]> {
    bytes.try_into().map_err(|_| NoiseError::BadKey)
}

fn statement(
    context: &[u8],
    public: &[u8],
    agent_nonce: &[u8],
    server_nonce: &[u8],
    device_id: &str,
) -> Vec<u8> {
    let mut m = Vec::with_capacity(context.len() + 112 + device_id.len());
    m.extend_from_slice(context);
    for part in [public, agent_nonce, server_nonce, device_id.as_bytes()] {
        m.extend_from_slice(&(part.len() as u32).to_be_bytes());
        m.extend_from_slice(part);
    }
    m
}

/// Prologue of the control connection's handshake: binds it to this connection's nonces.
pub fn control_prologue(agent_nonce: &[u8], server_nonce: &[u8], device_id: &str) -> Vec<u8> {
    statement(CONTROL_PROLOGUE, &[], agent_nonce, server_nonce, device_id)
}

/// Prologue of a tunnel socket's handshake: binds it to the tunnel id.
pub fn tunnel_prologue(tunnel_id: &str) -> Vec<u8> {
    statement(TUNNEL_PROLOGUE, &[], &[], &[], tunnel_id)
}

/// The server's static key, signed by its identity key (`Challenge.noise`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoiseOffer {
    #[serde(with = "serde_bytes")]
    pub public_key: Vec<u8>,
    #[serde(with = "serde_bytes")]
    pub signature: Vec<u8>,
}

/// Agent → server after `Proof`: the first IK message and a device-key signature over the
/// agent's static key (which the IK message carries encrypted).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoiseInit {
    #[serde(with = "serde_bytes")]
    pub signature: Vec<u8>,
    #[serde(with = "serde_bytes")]
    pub payload: Vec<u8>,
}

impl Message for NoiseInit {
    const TYPE: &'static str = "noise_init";
}

/// Server → agent: the second IK message. Everything after it is wrapped.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoiseAccept {
    #[serde(with = "serde_bytes")]
    pub payload: Vec<u8>,
}

impl Message for NoiseAccept {
    const TYPE: &'static str = "noise_accept";
}

/// Server: signs its static key for this connection.
pub fn offer(
    identity: &SigningKey,
    local: &StaticKeypair,
    agent_nonce: &[u8],
    server_nonce: &[u8],
    device_id: &str,
) -> NoiseOffer {
    let public = local.public_key();
    NoiseOffer {
        public_key: public.to_vec(),
        signature: identity.sign(&statement(
            SERVER_KEY_CONTEXT,
            &public,
            agent_nonce,
            server_nonce,
            device_id,
        )),
    }
}

/// Agent: checks the server's offer against the pinned identity key and the pinned Noise key.
///
/// Returns the server key to use, or `None` when the server does not offer the channel (legacy
/// server, only accepted while nothing is pinned).
pub fn accept_offer(
    identity: &PublicKey,
    offer: Option<&NoiseOffer>,
    pinned: Option<&[u8; 32]>,
    agent_nonce: &[u8],
    server_nonce: &[u8],
    device_id: &str,
) -> NoiseResult<Option<[u8; 32]>> {
    let Some(offer) = offer else {
        return match pinned {
            Some(_) => Err(NoiseError::Downgrade),
            None => Ok(None),
        };
    };
    let key = key32(&offer.public_key)?;
    identity
        .verify(
            &statement(
                SERVER_KEY_CONTEXT,
                &key,
                agent_nonce,
                server_nonce,
                device_id,
            ),
            &offer.signature,
        )
        .map_err(|_| NoiseError::BadOfferSignature)?;
    if let Some(pin) = pinned
        && !rustrmm_crypto::random::ct_eq(pin, &key)
    {
        return Err(NoiseError::PinMismatch);
    }
    Ok(Some(key))
}

/// Agent: starts the control connection's handshake.
pub fn start_control(
    local: &StaticKeypair,
    device_key: &SigningKey,
    server_key: &[u8; 32],
    agent_nonce: &[u8],
    server_nonce: &[u8],
    device_id: &str,
) -> NoiseResult<(Initiator, NoiseInit)> {
    let prologue = control_prologue(agent_nonce, server_nonce, device_id);
    let (initiator, payload) = Initiator::start(local, server_key, &prologue)?;
    let signature = device_key.sign(&statement(
        AGENT_KEY_CONTEXT,
        &local.public_key(),
        agent_nonce,
        server_nonce,
        device_id,
    ));
    Ok((initiator, NoiseInit { signature, payload }))
}

/// Server: answers the control connection's handshake after the device proved its key.
pub fn accept_control(
    local: &StaticKeypair,
    device_key: &PublicKey,
    init: &NoiseInit,
    agent_nonce: &[u8],
    server_nonce: &[u8],
    device_id: &str,
) -> NoiseResult<Accepted> {
    let prologue = control_prologue(agent_nonce, server_nonce, device_id);
    let accepted = respond(local, &prologue, &init.payload)?;
    device_key
        .verify(
            &statement(
                AGENT_KEY_CONTEXT,
                &accepted.remote_static,
                agent_nonce,
                server_nonce,
                device_id,
            ),
            &init.signature,
        )
        .map_err(|_| NoiseError::BadAgentSignature)?;
    Ok(accepted)
}

/// Initiator side of an IK handshake (agent).
pub struct Initiator {
    state: snow::HandshakeState,
}

impl Initiator {
    /// Builds the first handshake message.
    pub fn start(
        local: &StaticKeypair,
        remote: &[u8; 32],
        prologue: &[u8],
    ) -> NoiseResult<(Self, Vec<u8>)> {
        let mut state = snow::Builder::new(params())
            .local_private_key(&local.secret[..])?
            .remote_public_key(remote)?
            .prologue(prologue)?
            .build_initiator()?;
        let mut buf = vec![0u8; 256];
        let n = state.write_message(&[], &mut buf)?;
        buf.truncate(n);
        Ok((Self { state }, buf))
    }

    /// Reads the responder's reply and switches to transport mode.
    pub fn finish(mut self, reply: &[u8]) -> NoiseResult<NoiseCodec> {
        if reply.len() > MAX_NOISE_MESSAGE {
            return Err(NoiseError::Malformed("handshake message too large"));
        }
        let mut payload = vec![0u8; MAX_NOISE_MESSAGE];
        self.state.read_message(reply, &mut payload)?;
        Ok(NoiseCodec::new(self.state.into_transport_mode()?))
    }
}

/// Result of answering an IK handshake (server).
pub struct Accepted {
    /// The initiator's static key, authenticated by the handshake.
    pub remote_static: [u8; 32],
    /// Second handshake message to send back.
    pub reply: Vec<u8>,
    pub codec: NoiseCodec,
}

/// Responder side of an IK handshake (server).
pub fn respond(local: &StaticKeypair, prologue: &[u8], first: &[u8]) -> NoiseResult<Accepted> {
    if first.len() > MAX_NOISE_MESSAGE {
        return Err(NoiseError::Malformed("handshake message too large"));
    }
    let mut state = snow::Builder::new(params())
        .local_private_key(&local.secret[..])?
        .prologue(prologue)?
        .build_responder()?;
    let mut payload = vec![0u8; MAX_NOISE_MESSAGE];
    state.read_message(first, &mut payload)?;
    let remote_static = key32(
        state
            .get_remote_static()
            .ok_or(NoiseError::Malformed("no initiator static key"))?,
    )?;
    let mut reply = vec![0u8; 256];
    let n = state.write_message(&[], &mut reply)?;
    reply.truncate(n);
    Ok(Accepted {
        remote_static,
        reply,
        codec: NoiseCodec::new(state.into_transport_mode()?),
    })
}

/// Kind of a wrapped WebSocket data message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DataKind {
    Binary = 0,
    Text = 1,
}

/// Rekey and traffic counters of one channel (shared, for diagnostics and tests).
#[derive(Debug, Default)]
pub struct NoiseStats {
    pub sent_rekeys: AtomicU64,
    pub received_rekeys: AtomicU64,
    pub sent_messages: AtomicU64,
    pub received_messages: AtomicU64,
}

/// Seals and opens logical messages with an established Noise transport.
pub struct NoiseCodec {
    transport: snow::TransportState,
    rekey_bytes: u64,
    rekey_interval: Duration,
    sent_since_rekey: u64,
    rekeyed_at: Instant,
    stats: Arc<NoiseStats>,
    scratch: Vec<u8>,
}

impl NoiseCodec {
    fn new(transport: snow::TransportState) -> Self {
        Self {
            transport,
            rekey_bytes: rekey_bytes(),
            rekey_interval: REKEY_INTERVAL,
            sent_since_rekey: 0,
            rekeyed_at: Instant::now(),
            stats: Arc::default(),
            scratch: vec![0u8; MAX_NOISE_MESSAGE],
        }
    }

    /// Overrides the rekey policy of this codec.
    pub fn with_rekey_policy(mut self, bytes: u64, interval: Duration) -> Self {
        self.rekey_bytes = bytes.max(1);
        self.rekey_interval = interval;
        self
    }

    pub fn stats(&self) -> Arc<NoiseStats> {
        self.stats.clone()
    }

    /// Encrypts one logical message into the bytes of one WebSocket binary message.
    pub fn seal(&mut self, kind: DataKind, payload: &[u8]) -> NoiseResult<Vec<u8>> {
        let total = payload.len() as u64 + 1;
        let rekey = self.sent_since_rekey.saturating_add(total) >= self.rekey_bytes
            || self.rekeyed_at.elapsed() >= self.rekey_interval;
        let mut plain = Vec::with_capacity(payload.len() + 1);
        plain.push(kind as u8 | if rekey { FLAG_REKEY } else { 0 });
        plain.extend_from_slice(payload);
        let mut out = Vec::with_capacity(sealed_len(payload.len()));
        for chunk in plain.chunks(MAX_CHUNK_PLAINTEXT) {
            let n = self.transport.write_message(chunk, &mut self.scratch)?;
            out.extend_from_slice(&self.scratch[..n]);
        }
        self.stats.sent_messages.fetch_add(1, Ordering::Relaxed);
        if rekey {
            self.transport.rekey_outgoing();
            self.sent_since_rekey = 0;
            self.rekeyed_at = Instant::now();
            self.stats.sent_rekeys.fetch_add(1, Ordering::Relaxed);
        } else {
            self.sent_since_rekey += total;
        }
        Ok(out)
    }

    /// Decrypts the bytes of one WebSocket binary message.
    pub fn open(&mut self, wire: &[u8]) -> NoiseResult<(DataKind, Vec<u8>)> {
        if wire.len() <= TAG_LEN {
            return Err(NoiseError::Malformed("message too short"));
        }
        let mut plain = Vec::with_capacity(wire.len());
        for chunk in wire.chunks(MAX_NOISE_MESSAGE) {
            if chunk.len() <= TAG_LEN {
                return Err(NoiseError::Malformed("truncated chunk"));
            }
            let n = self.transport.read_message(chunk, &mut self.scratch)?;
            plain.extend_from_slice(&self.scratch[..n]);
        }
        let header = *plain.first().ok_or(NoiseError::Malformed("empty"))?;
        if header & !(KIND_MASK | FLAG_REKEY) != 0 {
            return Err(NoiseError::Malformed("unknown header flags"));
        }
        let kind = match header & KIND_MASK {
            0 => DataKind::Binary,
            1 => DataKind::Text,
            _ => return Err(NoiseError::Malformed("unknown data kind")),
        };
        self.stats.received_messages.fetch_add(1, Ordering::Relaxed);
        if header & FLAG_REKEY != 0 {
            self.transport.rekey_incoming();
            self.stats.received_rekeys.fetch_add(1, Ordering::Relaxed);
        }
        plain.remove(0);
        Ok((kind, plain))
    }
}

/// Maps a WebSocket library's message type onto [`NoiseWs`].
pub trait WsAdapter {
    type Message;
    type Error;
    /// The payload of a data message, or the message itself for control frames (ping, pong,
    /// close), which pass through unencrypted.
    fn into_data(message: Self::Message) -> Result<(DataKind, Vec<u8>), Self::Message>;
    /// Rebuilds a data message (text must be valid UTF-8).
    fn from_data(kind: DataKind, payload: Vec<u8>) -> NoiseResult<Self::Message>;
    fn binary(bytes: Vec<u8>) -> Self::Message;
    fn error(error: NoiseError) -> Self::Error;
}

/// A WebSocket that transparently wraps data messages when a [`NoiseCodec`] is set and passes
/// everything through unchanged otherwise (peers without the capability).
pub struct NoiseWs<S, A: WsAdapter> {
    inner: S,
    codec: Option<NoiseCodec>,
    stats: Option<Arc<NoiseStats>>,
    _adapter: PhantomData<fn() -> A>,
}

impl<S, A: WsAdapter> NoiseWs<S, A> {
    pub fn new(inner: S, codec: Option<NoiseCodec>) -> Self {
        let stats = codec.as_ref().map(NoiseCodec::stats);
        Self {
            inner,
            codec,
            stats,
            _adapter: PhantomData,
        }
    }

    /// True when data messages are Noise-encrypted.
    pub fn is_encrypted(&self) -> bool {
        self.codec.is_some()
    }

    pub fn stats(&self) -> Option<Arc<NoiseStats>> {
        self.stats.clone()
    }

    /// The underlying socket (drops the codec).
    pub fn into_inner(self) -> S {
        self.inner
    }
}

impl<S, A> NoiseWs<S, A>
where
    A: WsAdapter,
    S: Stream<Item = Result<A::Message, A::Error>> + Sink<A::Message, Error = A::Error> + Unpin,
{
    /// Next message (cancel-safe), like `axum::extract::ws::WebSocket::recv`.
    pub async fn recv(&mut self) -> Option<Result<A::Message, A::Error>> {
        futures::StreamExt::next(self).await
    }

    /// Sends one message, like `axum::extract::ws::WebSocket::send`.
    pub async fn send(&mut self, message: A::Message) -> Result<(), A::Error> {
        futures::SinkExt::send(self, message).await
    }
}

impl<S, A> Stream for NoiseWs<S, A>
where
    A: WsAdapter,
    S: Stream<Item = Result<A::Message, A::Error>> + Unpin,
{
    type Item = Result<A::Message, A::Error>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        let item = ready!(Pin::new(&mut this.inner).poll_next(cx));
        let Some(codec) = this.codec.as_mut() else {
            return Poll::Ready(item);
        };
        Poll::Ready(match item {
            Some(Ok(message)) => Some(match A::into_data(message) {
                Ok((DataKind::Binary, wire)) => codec
                    .open(&wire)
                    .and_then(|(kind, payload)| A::from_data(kind, payload))
                    .map_err(A::error),
                Ok((DataKind::Text, _)) => Err(A::error(NoiseError::Plaintext)),
                Err(control) => Ok(control),
            }),
            other => other,
        })
    }
}

impl<S, A> Sink<A::Message> for NoiseWs<S, A>
where
    A: WsAdapter,
    S: Sink<A::Message, Error = A::Error> + Unpin,
{
    type Error = A::Error;

    fn poll_ready(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Pin::new(&mut self.get_mut().inner).poll_ready(cx)
    }

    fn start_send(self: Pin<&mut Self>, item: A::Message) -> Result<(), Self::Error> {
        let this = self.get_mut();
        let item = match this.codec.as_mut() {
            None => item,
            Some(codec) => match A::into_data(item) {
                Ok((kind, payload)) => A::binary(codec.seal(kind, &payload).map_err(A::error)?),
                Err(control) => control,
            },
        };
        Pin::new(&mut this.inner).start_send(item)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }

    fn poll_close(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Pin::new(&mut self.get_mut().inner).poll_close(cx)
    }
}

/// [`WsAdapter`] for `tokio-tungstenite` (agent, simulator, tests).
#[cfg(feature = "tungstenite")]
pub mod tungstenite {
    use tokio_tungstenite::tungstenite::{Error, Message};

    use super::{DataKind, NoiseError, NoiseResult, WsAdapter};

    pub struct Tungstenite;

    impl WsAdapter for Tungstenite {
        type Message = Message;
        type Error = Error;

        fn into_data(message: Message) -> Result<(DataKind, Vec<u8>), Message> {
            match message {
                Message::Binary(b) => Ok((DataKind::Binary, b.into())),
                Message::Text(t) => Ok((DataKind::Text, t.as_bytes().to_vec())),
                other => Err(other),
            }
        }

        fn from_data(kind: DataKind, payload: Vec<u8>) -> NoiseResult<Message> {
            Ok(match kind {
                DataKind::Binary => Message::Binary(payload.into()),
                DataKind::Text => Message::Text(
                    String::from_utf8(payload)
                        .map_err(|_| NoiseError::Malformed("text frame is not UTF-8"))?
                        .into(),
                ),
            })
        }

        fn binary(bytes: Vec<u8>) -> Message {
            Message::Binary(bytes.into())
        }

        fn error(error: NoiseError) -> Error {
            Error::Io(std::io::Error::new(std::io::ErrorKind::InvalidData, error))
        }
    }

    /// A tungstenite WebSocket with optional Noise wrapping.
    pub type NoiseSocket<S> = super::NoiseWs<S, Tungstenite>;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair(prologue: &[u8]) -> (NoiseCodec, NoiseCodec, [u8; 32]) {
        let server = StaticKeypair::generate();
        let agent = StaticKeypair::generate();
        let (initiator, first) =
            Initiator::start(&agent, &server.public_key(), prologue).expect("start");
        let accepted = respond(&server, prologue, &first).expect("respond");
        assert_eq!(accepted.remote_static, agent.public_key());
        let agent_codec = initiator.finish(&accepted.reply).expect("finish");
        (agent_codec, accepted.codec, agent.public_key())
    }

    #[test]
    fn keypair_public_key_matches_snow() {
        let kp = snow::Builder::new(params())
            .generate_keypair()
            .expect("keypair");
        let ours = StaticKeypair::from_secret(&kp.private).expect("secret");
        assert_eq!(ours.public_key().to_vec(), kp.public);
        assert_eq!(
            decode_key(&encode_key(&ours.public_key())).expect("decode"),
            ours.public_key()
        );
        assert!(decode_key("x25519:AAAA").is_err());
    }

    #[test]
    fn round_trips_small_large_and_text_messages() {
        let (mut a, mut s, _) = pair(b"p");
        for len in [
            0usize,
            1,
            100,
            MAX_CHUNK_PLAINTEXT - 1,
            MAX_CHUNK_PLAINTEXT,
            300_000,
        ] {
            let payload: Vec<u8> = (0..len).map(|i| (i % 251) as u8).collect();
            let wire = a.seal(DataKind::Binary, &payload).expect("seal");
            assert_eq!(wire.len(), sealed_len(len), "len {len}");
            let (kind, back) = s.open(&wire).expect("open");
            assert_eq!(kind, DataKind::Binary);
            assert_eq!(back, payload);
        }
        let wire = s
            .seal(DataKind::Text, b"{\"type\":\"ready\"}")
            .expect("seal");
        let (kind, back) = a.open(&wire).expect("open");
        assert_eq!(
            (kind, back.as_slice()),
            (DataKind::Text, &b"{\"type\":\"ready\"}"[..])
        );
    }

    #[test]
    fn tampering_reordering_and_wrong_prologue_fail() {
        let (mut a, mut s, _) = pair(b"p");
        let first = a.seal(DataKind::Binary, b"one").expect("seal");
        let second = a.seal(DataKind::Binary, b"two").expect("seal");
        assert!(s.open(&second).is_err(), "out of order");
        let (mut a, mut s, _) = pair(b"p");
        let mut wire = a.seal(DataKind::Binary, b"one").expect("seal");
        wire[3] ^= 1;
        assert!(s.open(&wire).is_err(), "tampered");
        assert!(s.open(&first[..10]).is_err(), "truncated");

        let server = StaticKeypair::generate();
        let agent = StaticKeypair::generate();
        let (_, msg) = Initiator::start(&agent, &server.public_key(), b"a").expect("start");
        assert!(respond(&server, b"b", &msg).is_err(), "prologue mismatch");
        let other = StaticKeypair::generate();
        assert!(respond(&other, b"a", &msg).is_err(), "wrong server key");
    }

    #[test]
    fn rekeys_by_volume_and_time_in_both_directions() {
        let (a, s, _) = pair(b"p");
        let mut a = a.with_rekey_policy(1000, REKEY_INTERVAL);
        let mut s = s.with_rekey_policy(u64::MAX, Duration::ZERO);
        for i in 0..50u32 {
            let payload = vec![i as u8; 300];
            let (_, back) = s
                .open(&a.seal(DataKind::Binary, &payload).expect("seal"))
                .expect("open");
            assert_eq!(back, payload);
            let (_, back) = a
                .open(&s.seal(DataKind::Binary, &payload).expect("seal"))
                .expect("open");
            assert_eq!(back, payload);
        }
        let (a_stats, s_stats) = (a.stats(), s.stats());
        let sent = a_stats.sent_rekeys.load(Ordering::Relaxed);
        assert!(sent >= 10, "volume rekeys: {sent}");
        assert_eq!(sent, s_stats.received_rekeys.load(Ordering::Relaxed));
        assert_eq!(
            s_stats.sent_rekeys.load(Ordering::Relaxed),
            50,
            "time rekeys every message"
        );
        assert_eq!(a_stats.received_rekeys.load(Ordering::Relaxed), 50);
    }

    #[test]
    fn offer_and_agent_key_signatures_bind_the_connection() {
        let identity = SigningKey::generate();
        let device = SigningKey::generate();
        let server = StaticKeypair::generate();
        let agent = StaticKeypair::generate();
        let (an, sn) = ([1u8; 32], [2u8; 32]);
        let offer = offer(&identity, &server, &an, &sn, "dev-1");

        let key = accept_offer(
            &identity.public_key(),
            Some(&offer),
            None,
            &an,
            &sn,
            "dev-1",
        )
        .expect("valid")
        .expect("offered");
        assert_eq!(key, server.public_key());
        assert!(matches!(
            accept_offer(
                &identity.public_key(),
                Some(&offer),
                None,
                &an,
                &sn,
                "dev-2"
            ),
            Err(NoiseError::BadOfferSignature)
        ));
        assert!(matches!(
            accept_offer(
                &SigningKey::generate().public_key(),
                Some(&offer),
                None,
                &an,
                &sn,
                "dev-1"
            ),
            Err(NoiseError::BadOfferSignature)
        ));
        let other_pin = StaticKeypair::generate().public_key();
        assert!(matches!(
            accept_offer(
                &identity.public_key(),
                Some(&offer),
                Some(&other_pin),
                &an,
                &sn,
                "dev-1"
            ),
            Err(NoiseError::PinMismatch)
        ));
        assert!(matches!(
            accept_offer(&identity.public_key(), None, Some(&key), &an, &sn, "dev-1"),
            Err(NoiseError::Downgrade)
        ));
        assert!(
            accept_offer(&identity.public_key(), None, None, &an, &sn, "dev-1")
                .expect("legacy")
                .is_none()
        );

        let (initiator, init) =
            start_control(&agent, &device, &key, &an, &sn, "dev-1").expect("start");
        assert!(matches!(
            accept_control(
                &server,
                &SigningKey::generate().public_key(),
                &init,
                &an,
                &sn,
                "dev-1"
            ),
            Err(NoiseError::BadAgentSignature)
        ));
        let (_, init2) = start_control(&agent, &device, &key, &an, &sn, "dev-1").expect("start");
        let accepted =
            accept_control(&server, &device.public_key(), &init2, &an, &sn, "dev-1").expect("ok");
        assert_eq!(accepted.remote_static, agent.public_key());
        // The first initiator's handshake is unrelated to the accepted one.
        assert!(initiator.finish(&accepted.reply).is_err());
    }
}
