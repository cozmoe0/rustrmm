//! Agent sockets with the optional Noise IK end-to-end channel (`rustrmm_proto::noise`).

use axum::extract::ws::{Message, WebSocket};
use rustrmm_proto::noise::{DataKind, NoiseError, NoiseResult, NoiseWs, WsAdapter};

/// [`WsAdapter`] for axum's WebSocket.
pub struct Axum;

impl WsAdapter for Axum {
    type Message = Message;
    type Error = axum::Error;

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

    fn error(error: NoiseError) -> axum::Error {
        axum::Error::new(error)
    }
}

/// An agent WebSocket (control connection or tunnel), Noise-wrapped when negotiated. It offers
/// the same `recv`/`send` methods as axum's `WebSocket`.
pub type AgentSocket = NoiseWs<WebSocket, Axum>;
