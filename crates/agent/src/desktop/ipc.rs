//! Framing between the agent and its desktop helper process (Windows named pipe).
//!
//! Each frame is `u8 kind, u32 length (LE), payload`. Media and control payloads are exactly the
//! tunnel's binary and text messages, so the service relays them without re-encoding.

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// Helper → agent: a binary desktop message (`docs/api-desktop.md`).
pub const MEDIA: u8 = 1;
/// Either direction: a JSON `DesktopControl` message.
pub const CONTROL: u8 = 2;
/// Agent → helper: the [`HelperConfig`] (first frame).
pub const CONFIG: u8 = 3;
/// Helper → agent: a screenshot (`u32 width, u32 height, JPEG`).
pub const SCREENSHOT: u8 = 4;
/// Helper → agent: a log line (the helper has no log file of its own).
pub const LOG: u8 = 5;

/// Largest frame accepted (a full-screen raw cursor or clipboard is far below this).
pub const MAX_FRAME: usize = 32 * 1024 * 1024;

/// What the helper should do.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HelperConfig {
    /// `stream` or `screenshot`.
    pub mode: String,
    #[serde(default)]
    pub monitor: Option<u32>,
    #[serde(default)]
    pub view_only: bool,
    #[serde(default)]
    pub quality: rustrmm_proto::desktop::Quality,
    #[serde(default)]
    pub banner: bool,
    #[serde(default)]
    pub technician: String,
    /// Screenshot mode: downscale to at most this width.
    #[serde(default)]
    pub max_width: u32,
}

pub async fn write<W: AsyncWrite + Unpin>(
    w: &mut W,
    kind: u8,
    payload: &[u8],
) -> std::io::Result<()> {
    let mut header = [0u8; 5];
    header[0] = kind;
    header[1..].copy_from_slice(&(payload.len() as u32).to_le_bytes());
    w.write_all(&header).await?;
    w.write_all(payload).await?;
    w.flush().await
}

/// Reads one frame; `None` at a clean end of stream.
pub async fn read<R: AsyncRead + Unpin>(r: &mut R) -> std::io::Result<Option<(u8, Vec<u8>)>> {
    let mut header = [0u8; 5];
    match r.read_exact(&mut header).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_le_bytes([header[1], header[2], header[3], header[4]]) as usize;
    if len > MAX_FRAME {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("helper frame of {len} bytes exceeds the limit"),
        ));
    }
    let mut payload = vec![0u8; len];
    r.read_exact(&mut payload).await?;
    Ok(Some((header[0], payload)))
}

/// Screenshot payload: `u32 width, u32 height, JPEG bytes`.
pub fn screenshot_payload(width: u32, height: u32, jpeg: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 + jpeg.len());
    out.extend_from_slice(&width.to_le_bytes());
    out.extend_from_slice(&height.to_le_bytes());
    out.extend_from_slice(jpeg);
    out
}

pub fn parse_screenshot(payload: &[u8]) -> Option<(u32, u32, &[u8])> {
    if payload.len() < 8 {
        return None;
    }
    let w = u32::from_le_bytes(payload[0..4].try_into().ok()?);
    let h = u32::from_le_bytes(payload[4..8].try_into().ok()?);
    Some((w, h, &payload[8..]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn frames_round_trip_and_limits_hold() {
        let mut wire = Vec::new();
        write(&mut wire, CONTROL, br#"{"type":"refresh"}"#)
            .await
            .expect("write");
        write(&mut wire, MEDIA, &[2, 1, 0, 0, 0, 0, 0])
            .await
            .expect("write");
        assert_eq!(&wire[..5], &[CONTROL, 18, 0, 0, 0]);
        let mut reader = &wire[..];
        let (kind, payload) = read(&mut reader).await.expect("read").expect("frame");
        assert_eq!(kind, CONTROL);
        assert_eq!(payload, br#"{"type":"refresh"}"#);
        let (kind, payload) = read(&mut reader).await.expect("read").expect("frame");
        assert_eq!((kind, payload.len()), (MEDIA, 7));
        assert!(read(&mut reader).await.expect("eof").is_none());

        let oversized = [MEDIA, 0xff, 0xff, 0xff, 0x7f];
        assert!(read(&mut &oversized[..]).await.is_err());
        // A truncated payload is an error, not a clean end.
        let truncated = [MEDIA, 4, 0, 0, 0, 1];
        assert!(read(&mut &truncated[..]).await.is_err());
    }

    #[test]
    fn screenshot_payload_round_trips() {
        let payload = screenshot_payload(1280, 720, &[0xff, 0xd8]);
        assert_eq!(
            parse_screenshot(&payload),
            Some((1280, 720, &[0xff, 0xd8][..]))
        );
        assert_eq!(parse_screenshot(&[1, 2]), None);
        let config = HelperConfig {
            mode: "stream".into(),
            monitor: Some(1),
            view_only: true,
            quality: rustrmm_proto::desktop::Quality::Low,
            banner: true,
            technician: "Ada".into(),
            max_width: 0,
        };
        let text = serde_json::to_string(&config).expect("json");
        assert_eq!(
            serde_json::from_str::<HelperConfig>(&text).expect("back"),
            config
        );
    }
}
