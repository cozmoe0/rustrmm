//! Remote desktop (Phase 8): the messages carried on a desktop tunnel (`docs/api-desktop.md`).
//!
//! * Binary frames (agent → browser) carry media: screen tiles, frame boundaries, cursor position
//!   and shape, and copy rectangles. The first byte is the message type; every integer is
//!   little-endian. [`Media`] encodes and decodes them.
//! * Text frames carry JSON [`DesktopControl`] messages in both directions.
//!
//! The server forwards both unchanged, except that it drops browser input while a session is
//! view-only ([`DesktopControl::is_input`]).

use serde::{Deserialize, Serialize};

/// Binary message types (first byte).
pub mod kind {
    pub const TILE: u8 = 0x01;
    pub const FRAME_END: u8 = 0x02;
    pub const CURSOR_POSITION: u8 = 0x03;
    pub const CURSOR_SHAPE: u8 = 0x04;
    pub const COPY_RECT: u8 = 0x05;
}

/// Tile payload encodings.
pub mod encoding {
    /// A baseline JPEG of exactly the tile's size.
    pub const JPEG: u8 = 1;
    /// Uncompressed BGRA, `w * h * 4` bytes, rows top-down (small tiles only).
    pub const RAW_BGRA: u8 = 2;
    /// The whole tile is one colour; the payload is 4 bytes of BGRA.
    pub const SOLID: u8 = 3;
}

/// Size of a tile message before its payload.
pub const TILE_HEADER_LEN: usize = 14;
/// Largest cursor image the agent sends (pixels per side).
pub const MAX_CURSOR_SIDE: u16 = 256;

/// One binary media message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Media {
    /// `0x01`: a screen region of frame `frame_seq`.
    Tile {
        frame_seq: u32,
        x: u16,
        y: u16,
        w: u16,
        h: u16,
        encoding: u8,
        payload: Vec<u8>,
    },
    /// `0x02`: every tile of `frame_seq` was sent; the viewer presents the frame and acks it.
    FrameEnd { frame_seq: u32, tiles: u16 },
    /// `0x03`: pointer position in pixels of the active monitor.
    CursorPosition { x: i16, y: i16, visible: bool },
    /// `0x04`: pointer image, RGBA (`w * h * 4` bytes), sent when the shape changes.
    CursorShape {
        hot_x: u16,
        hot_y: u16,
        w: u16,
        h: u16,
        rgba: Vec<u8>,
    },
    /// `0x05`: copy a rectangle of the previous image (DXGI move rect); applied before the
    /// frame's tiles.
    CopyRect {
        frame_seq: u32,
        src_x: u16,
        src_y: u16,
        w: u16,
        h: u16,
        dst_x: u16,
        dst_y: u16,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum MediaError {
    #[error("empty message")]
    Empty,
    #[error("unknown message type 0x{0:02x}")]
    UnknownType(u8),
    #[error("message type 0x{kind:02x} is truncated ({len} bytes)")]
    Truncated { kind: u8, len: usize },
    #[error("payload size does not match the header")]
    BadPayload,
}

/// Builds a tile message without copying the payload twice (the agent's hot path).
pub fn tile_message(
    frame_seq: u32,
    x: u16,
    y: u16,
    w: u16,
    h: u16,
    encoding: u8,
    payload: &[u8],
) -> Vec<u8> {
    let mut out = Vec::with_capacity(TILE_HEADER_LEN + payload.len());
    out.push(kind::TILE);
    out.extend_from_slice(&frame_seq.to_le_bytes());
    for v in [x, y, w, h] {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out.push(encoding);
    out.extend_from_slice(payload);
    out
}

impl Media {
    pub fn encode(&self) -> Vec<u8> {
        match self {
            Self::Tile {
                frame_seq,
                x,
                y,
                w,
                h,
                encoding,
                payload,
            } => tile_message(*frame_seq, *x, *y, *w, *h, *encoding, payload),
            Self::FrameEnd { frame_seq, tiles } => {
                let mut out = Vec::with_capacity(7);
                out.push(kind::FRAME_END);
                out.extend_from_slice(&frame_seq.to_le_bytes());
                out.extend_from_slice(&tiles.to_le_bytes());
                out
            }
            Self::CursorPosition { x, y, visible } => {
                let mut out = Vec::with_capacity(6);
                out.push(kind::CURSOR_POSITION);
                out.extend_from_slice(&x.to_le_bytes());
                out.extend_from_slice(&y.to_le_bytes());
                out.push(u8::from(*visible));
                out
            }
            Self::CursorShape {
                hot_x,
                hot_y,
                w,
                h,
                rgba,
            } => {
                let mut out = Vec::with_capacity(9 + rgba.len());
                out.push(kind::CURSOR_SHAPE);
                for v in [hot_x, hot_y, w, h] {
                    out.extend_from_slice(&v.to_le_bytes());
                }
                out.extend_from_slice(rgba);
                out
            }
            Self::CopyRect {
                frame_seq,
                src_x,
                src_y,
                w,
                h,
                dst_x,
                dst_y,
            } => {
                let mut out = Vec::with_capacity(17);
                out.push(kind::COPY_RECT);
                out.extend_from_slice(&frame_seq.to_le_bytes());
                for v in [src_x, src_y, w, h, dst_x, dst_y] {
                    out.extend_from_slice(&v.to_le_bytes());
                }
                out
            }
        }
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, MediaError> {
        let (&kind, rest) = bytes.split_first().ok_or(MediaError::Empty)?;
        let need = |n: usize| -> Result<(), MediaError> {
            if rest.len() < n {
                Err(MediaError::Truncated {
                    kind,
                    len: bytes.len(),
                })
            } else {
                Ok(())
            }
        };
        let u16_at = |i: usize| u16::from_le_bytes([rest[i], rest[i + 1]]);
        let u32_at =
            |i: usize| u32::from_le_bytes([rest[i], rest[i + 1], rest[i + 2], rest[i + 3]]);
        match kind {
            kind::TILE => {
                need(TILE_HEADER_LEN - 1)?;
                let (w, h, encoding) = (u16_at(8), u16_at(10), rest[12]);
                let payload = rest[13..].to_vec();
                let expected = match encoding {
                    encoding::RAW_BGRA => Some(usize::from(w) * usize::from(h) * 4),
                    encoding::SOLID => Some(4),
                    _ => None,
                };
                if expected.is_some_and(|n| n != payload.len()) {
                    return Err(MediaError::BadPayload);
                }
                Ok(Self::Tile {
                    frame_seq: u32_at(0),
                    x: u16_at(4),
                    y: u16_at(6),
                    w,
                    h,
                    encoding,
                    payload,
                })
            }
            kind::FRAME_END => {
                need(6)?;
                Ok(Self::FrameEnd {
                    frame_seq: u32_at(0),
                    tiles: u16_at(4),
                })
            }
            kind::CURSOR_POSITION => {
                need(5)?;
                Ok(Self::CursorPosition {
                    x: u16_at(0) as i16,
                    y: u16_at(2) as i16,
                    visible: rest[4] != 0,
                })
            }
            kind::CURSOR_SHAPE => {
                need(8)?;
                let (w, h) = (u16_at(4), u16_at(6));
                let rgba = rest[8..].to_vec();
                if rgba.len() != usize::from(w) * usize::from(h) * 4 {
                    return Err(MediaError::BadPayload);
                }
                Ok(Self::CursorShape {
                    hot_x: u16_at(0),
                    hot_y: u16_at(2),
                    w,
                    h,
                    rgba,
                })
            }
            kind::COPY_RECT => {
                need(16)?;
                Ok(Self::CopyRect {
                    frame_seq: u32_at(0),
                    src_x: u16_at(4),
                    src_y: u16_at(6),
                    w: u16_at(8),
                    h: u16_at(10),
                    dst_x: u16_at(12),
                    dst_y: u16_at(14),
                })
            }
            other => Err(MediaError::UnknownType(other)),
        }
    }
}

/// Requested picture quality. Fixed levels map to JPEG qualities; `auto` adapts quality and frame
/// rate to the connection.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Quality {
    #[default]
    Auto,
    Low,
    Medium,
    High,
}

impl Quality {
    pub const LOW_JPEG: u8 = 45;
    pub const MEDIUM_JPEG: u8 = 65;
    pub const HIGH_JPEG: u8 = 82;

    /// JPEG quality of a fixed level; `None` for `auto`.
    pub fn jpeg_quality(self) -> Option<u8> {
        match self {
            Self::Auto => None,
            Self::Low => Some(Self::LOW_JPEG),
            Self::Medium => Some(Self::MEDIUM_JPEG),
            Self::High => Some(Self::HIGH_JPEG),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "auto" => Some(Self::Auto),
            "low" => Some(Self::Low),
            "medium" => Some(Self::Medium),
            "high" => Some(Self::High),
            _ => None,
        }
    }
}

/// When the device's user is asked before a session starts (`remote_access.desktop_consent`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConsentMode {
    /// Nobody is asked (the default).
    #[default]
    Never,
    Always,
    /// Ask only when a user is signed in and the session is unlocked.
    WhenUserPresent,
}

impl ConsentMode {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "never" => Some(Self::Never),
            "always" => Some(Self::Always),
            "when_user_present" => Some(Self::WhenUserPresent),
            _ => None,
        }
    }
}

/// Consent state: the browser sees `waiting` then one of the outcomes; the session record keeps
/// the outcome (`not_required` when nobody was asked).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConsentStatus {
    Waiting,
    Granted,
    Denied,
    Timeout,
    NotRequired,
}

impl ConsentStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Waiting => "waiting",
            Self::Granted => "granted",
            Self::Denied => "denied",
            Self::Timeout => "timeout",
            Self::NotRequired => "not_required",
        }
    }

    /// The session may stream.
    pub fn allows(self) -> bool {
        matches!(self, Self::Granted | Self::NotRequired)
    }
}

/// One display of the device. `id` is stable for the life of a session; coordinates are physical
/// pixels on the virtual desktop.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MonitorInfo {
    pub id: u32,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub primary: bool,
    pub scale: f32,
}

/// JSON control messages on a desktop tunnel's text frames (both directions).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DesktopControl {
    // ---- agent → browser
    /// Streaming starts; a full frame follows.
    Ready {
        width: u32,
        height: u32,
        monitors: Vec<MonitorInfo>,
        monitor: u32,
        view_only: bool,
        /// `default` | `winlogon` | `screensaver` (lower-cased input desktop name).
        desktop: String,
    },
    /// The input desktop changed (UAC prompt, lock screen).
    Desktop {
        name: String,
    },
    /// The active monitor's resolution changed; a full frame follows.
    Resize {
        width: u32,
        height: u32,
    },
    /// Text clipboard (agent → browser when the device clipboard changes, browser → agent to set
    /// it). At most [`MAX_CLIPBOARD_BYTES`].
    Clipboard {
        text: String,
    },
    Consent {
        status: ConsentStatus,
    },
    /// Every 2 s.
    Stats {
        fps: f32,
        kbps: u32,
        encode_ms: f32,
        /// `dxgi` | `gdi` | `x11`
        capture: String,
    },
    Exit {
        #[serde(default)]
        code: Option<i64>,
    },
    Error {
        message: String,
    },

    // ---- browser → agent
    /// The viewer presented `frame_seq` (and everything before it).
    Ack {
        frame_seq: u32,
    },
    /// Pointer state in pixels of the active monitor. `buttons` is the DOM `MouseEvent.buttons`
    /// bitmask (1 left, 2 right, 4 middle, 8 back, 16 forward). Wheel values are in notches
    /// (positive y scrolls down, positive x scrolls right; fractions allowed).
    Mouse {
        x: i32,
        y: i32,
        #[serde(default)]
        buttons: u8,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        wheel_x: Option<f32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        wheel_y: Option<f32>,
    },
    /// A key transition. `code` is a DOM `KeyboardEvent.code`; `key` is used only when `code` is
    /// unknown (on-screen keyboards).
    Key {
        code: String,
        #[serde(default)]
        key: String,
        down: bool,
        #[serde(default)]
        location: u8,
    },
    /// Unicode text typed as keystrokes (IME, paste-as-keystrokes); at most [`MAX_TEXT_CHARS`].
    Text {
        text: String,
    },
    /// Ctrl+Alt+Del.
    Cad,
    /// Switch to another monitor.
    Monitor {
        id: u32,
    },
    Quality {
        value: Quality,
    },
    /// Send a full frame.
    Refresh,
    ViewOnly {
        value: bool,
    },
}

/// Clipboard text limit in either direction.
pub const MAX_CLIPBOARD_BYTES: usize = 1024 * 1024;
/// `text` message limit.
pub const MAX_TEXT_CHARS: usize = 4096;
/// The agent keeps at most this many unacknowledged frames in flight.
pub const MAX_FRAMES_IN_FLIGHT: usize = 2;

impl DesktopControl {
    pub fn to_text(&self) -> String {
        serde_json::to_string(self)
            .unwrap_or_else(|_| r#"{"type":"error","message":"encoding"}"#.into())
    }

    /// Browser messages that act on the device; dropped while the session is view-only.
    pub fn is_input(&self) -> bool {
        matches!(
            self,
            Self::Mouse { .. }
                | Self::Key { .. }
                | Self::Text { .. }
                | Self::Cad
                | Self::Clipboard { .. }
        )
    }
}

/// The name the viewer sees for a Windows input desktop (`Default` → `default`, `Screen-saver`
/// → `screensaver`).
pub fn desktop_label(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    match lower.as_str() {
        "screen-saver" => "screensaver".into(),
        _ => lower,
    }
}

/// A one-shot screenshot of the console session's primary monitor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Screenshot {
    /// Downscale to at most this width (the API uses 1280).
    pub max_width: u32,
    #[serde(default)]
    pub consent: ConsentMode,
    #[serde(default = "default_consent_timeout")]
    pub consent_timeout_secs: u32,
    /// Shown in the consent prompt.
    #[serde(default)]
    pub technician: String,
    #[serde(default)]
    pub organization: String,
}

pub fn default_consent_timeout() -> u32 {
    30
}

/// The consent prompt's wording.
pub fn consent_prompt(technician: &str, organization: &str, screenshot: bool) -> String {
    let who = if technician.trim().is_empty() {
        "A technician".to_string()
    } else {
        technician.trim().to_string()
    };
    let from = if organization.trim().is_empty() {
        String::new()
    } else {
        format!(" from {}", organization.trim())
    };
    if screenshot {
        format!("{who}{from} wants to take a screenshot of your screen. Allow?")
    } else {
        format!("{who}{from} wants to view and control your screen. Allow?")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tile_golden_bytes() {
        let tile = Media::Tile {
            frame_seq: 0x0102_0304,
            x: 64,
            y: 128,
            w: 0x0140,
            h: 2,
            encoding: encoding::SOLID,
            payload: vec![0x10, 0x20, 0x30, 0xff],
        };
        let bytes = tile.encode();
        assert_eq!(
            bytes,
            [
                0x01, // type
                0x04, 0x03, 0x02, 0x01, // frame_seq
                0x40, 0x00, // x
                0x80, 0x00, // y
                0x40, 0x01, // w
                0x02, 0x00, // h
                0x03, // encoding
                0x10, 0x20, 0x30, 0xff, // BGRA
            ]
        );
        assert_eq!(Media::decode(&bytes), Ok(tile));
        assert_eq!(
            tile_message(
                0x0102_0304,
                64,
                128,
                0x0140,
                2,
                3,
                &[0x10, 0x20, 0x30, 0xff]
            ),
            bytes
        );
    }

    #[test]
    fn small_messages_golden_bytes() {
        let cases: Vec<(Media, Vec<u8>)> = vec![
            (
                Media::FrameEnd {
                    frame_seq: 7,
                    tiles: 0x0203,
                },
                vec![0x02, 7, 0, 0, 0, 0x03, 0x02],
            ),
            (
                Media::CursorPosition {
                    x: -2,
                    y: 300,
                    visible: true,
                },
                vec![0x03, 0xfe, 0xff, 0x2c, 0x01, 1],
            ),
            (
                Media::CursorShape {
                    hot_x: 1,
                    hot_y: 2,
                    w: 1,
                    h: 1,
                    rgba: vec![9, 8, 7, 6],
                },
                vec![0x04, 1, 0, 2, 0, 1, 0, 1, 0, 9, 8, 7, 6],
            ),
            (
                Media::CopyRect {
                    frame_seq: 0x01,
                    src_x: 0,
                    src_y: 100,
                    w: 800,
                    h: 500,
                    dst_x: 0,
                    dst_y: 60,
                },
                vec![
                    0x05, 1, 0, 0, 0, 0, 0, 100, 0, 0x20, 0x03, 0xf4, 0x01, 0, 0, 60, 0,
                ],
            ),
        ];
        for (message, golden) in cases {
            assert_eq!(message.encode(), golden, "{message:?}");
            assert_eq!(Media::decode(&golden), Ok(message));
        }
    }

    #[test]
    fn decoding_rejects_garbage() {
        assert_eq!(Media::decode(&[]), Err(MediaError::Empty));
        assert_eq!(Media::decode(&[0x7f]), Err(MediaError::UnknownType(0x7f)));
        assert!(matches!(
            Media::decode(&[0x02, 1, 0]),
            Err(MediaError::Truncated { kind: 0x02, .. })
        ));
        // Raw tile whose payload does not match w*h*4.
        let bad = tile_message(1, 0, 0, 2, 2, encoding::RAW_BGRA, &[0; 15]);
        assert_eq!(Media::decode(&bad), Err(MediaError::BadPayload));
        let jpeg = tile_message(1, 0, 0, 64, 64, encoding::JPEG, &[0xff, 0xd8, 0xff, 0xd9]);
        assert!(matches!(
            Media::decode(&jpeg),
            Ok(Media::Tile {
                encoding: encoding::JPEG,
                ..
            })
        ));
    }

    #[test]
    fn control_messages_match_the_contract() {
        let cases = [
            (
                DesktopControl::Ack { frame_seq: 12 },
                r#"{"type":"ack","frame_seq":12}"#,
            ),
            (DesktopControl::Cad, r#"{"type":"cad"}"#),
            (DesktopControl::Refresh, r#"{"type":"refresh"}"#),
            (
                DesktopControl::Quality {
                    value: Quality::High,
                },
                r#"{"type":"quality","value":"high"}"#,
            ),
            (
                DesktopControl::ViewOnly { value: true },
                r#"{"type":"view_only","value":true}"#,
            ),
            (
                DesktopControl::Consent {
                    status: ConsentStatus::Waiting,
                },
                r#"{"type":"consent","status":"waiting"}"#,
            ),
            (
                DesktopControl::Mouse {
                    x: 10,
                    y: 20,
                    buttons: 1,
                    wheel_x: None,
                    wheel_y: Some(-1.0),
                },
                r#"{"type":"mouse","x":10,"y":20,"buttons":1,"wheel_y":-1.0}"#,
            ),
            (
                DesktopControl::Exit { code: None },
                r#"{"type":"exit","code":null}"#,
            ),
        ];
        for (message, text) in cases {
            assert_eq!(message.to_text(), text);
            assert_eq!(
                serde_json::from_str::<DesktopControl>(text).expect("decode"),
                message
            );
        }
        let key: DesktopControl = serde_json::from_str(
            r#"{"type":"key","code":"KeyA","key":"a","down":true,"location":0}"#,
        )
        .expect("key");
        assert!(key.is_input());
        let ready = DesktopControl::Ready {
            width: 2560,
            height: 1440,
            monitors: vec![MonitorInfo {
                id: 0,
                name: "\\\\.\\DISPLAY1".into(),
                x: 0,
                y: 0,
                width: 2560,
                height: 1440,
                primary: true,
                scale: 1.0,
            }],
            monitor: 0,
            view_only: false,
            desktop: "default".into(),
        };
        let value: serde_json::Value = serde_json::from_str(&ready.to_text()).expect("json");
        assert_eq!(value["type"], "ready");
        assert_eq!(value["monitors"][0]["primary"], true);
        assert!(!ready.is_input());
        assert!(DesktopControl::Clipboard { text: "x".into() }.is_input());
        assert!(!DesktopControl::Ack { frame_seq: 1 }.is_input());
    }

    #[test]
    fn quality_levels_and_labels() {
        assert_eq!(Quality::Low.jpeg_quality(), Some(45));
        assert_eq!(Quality::Medium.jpeg_quality(), Some(65));
        assert_eq!(Quality::High.jpeg_quality(), Some(82));
        assert_eq!(Quality::Auto.jpeg_quality(), None);
        assert_eq!(Quality::parse("medium"), Some(Quality::Medium));
        assert_eq!(desktop_label("Winlogon"), "winlogon");
        assert_eq!(desktop_label("Screen-saver"), "screensaver");
        assert!(
            consent_prompt("Ada", "Northwind IT", false).starts_with("Ada from Northwind IT wants")
        );
    }
}
