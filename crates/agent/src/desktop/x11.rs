//! Linux X11 remote desktop. The agent runs as root and is its own helper: it finds the active
//! graphical session with `loginctl`, takes `DISPLAY`/`XAUTHORITY` from a process of that session
//! and connects with x11rb (pure Rust).
//!
//! * Capture: MIT-SHM `GetImage` into a server-created segment (`CreateSegment` passes an fd we
//!   map), falling back to core `GetImage`. The engine finds dirty 64×64 tiles by comparison.
//! * Input: XTEST `FakeInput`; keys map through the keysym table to the server's keycodes, and
//!   characters without a key are typed through a spare keycode.
//! * Cursor: XFIXES `GetCursorImage` (shape changes tracked by serial).
//! * Clipboard: `CLIPBOARD` selection, UTF-8 text only, best effort.
//! * Wayland sessions and machines without a graphical session are refused.

use std::collections::HashMap;
use std::io::Read;
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use base64::Engine as _;
use futures::{SinkExt, StreamExt};
use rustrmm_proto::desktop::{
    ConsentMode, ConsentStatus, DesktopControl, MAX_CLIPBOARD_BYTES, MonitorInfo, Screenshot,
    consent_prompt,
};
use serde_json::{Value, json};
use tokio::sync::mpsc::{UnboundedSender, unbounded_channel};
use tokio_tungstenite::tungstenite::Message as WsMessage;
use x11rb::connection::Connection;
use x11rb::protocol::Event;
use x11rb::protocol::randr::ConnectionExt as _;
use x11rb::protocol::shm::ConnectionExt as _;
use x11rb::protocol::xfixes::ConnectionExt as _;
use x11rb::protocol::xproto::{self, ConnectionExt as _};
use x11rb::protocol::xtest::ConnectionExt as _;
use x11rb::rust_connection::{DefaultStream, RustConnection};
use x11rb::wrapper::ConnectionExt as _;

use super::cursor::Shape;
use super::engine::{
    Captured, CursorPoll, EngineConfig, FrameSource, InputSink, Out, Session, Shared,
};
use super::{Params, Sink, Stream, control, encode, keymap};

// ------------------------------------------------------------------ discovery

/// The graphical session to show.
#[derive(Debug, Clone)]
pub struct Display {
    pub name: String,
    pub xauthority: Option<PathBuf>,
    pub user: Option<String>,
    pub uid: Option<u32>,
    pub locked: bool,
    pub greeter: bool,
}

fn loginctl(args: &[&str]) -> Option<String> {
    let tool = ["/usr/bin/loginctl", "/bin/loginctl"]
        .into_iter()
        .find(|p| Path::new(p).exists())?;
    crate::util::run(tool, args, Duration::from_secs(5))
}

fn session_props(id: &str) -> HashMap<String, String> {
    loginctl(&[
        "show-session",
        id,
        "-p",
        "Type",
        "-p",
        "Active",
        "-p",
        "Leader",
        "-p",
        "Name",
        "-p",
        "User",
        "-p",
        "Display",
        "-p",
        "Class",
        "-p",
        "LockedHint",
        "-p",
        "State",
        "-p",
        "Remote",
    ])
    .unwrap_or_default()
    .lines()
    .filter_map(|l| l.split_once('='))
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect()
}

fn session_ids() -> Vec<String> {
    loginctl(&["list-sessions", "--no-legend"])
        .unwrap_or_default()
        .lines()
        .filter_map(|l| l.split_whitespace().next().map(str::to_string))
        .collect()
}

fn environ(pid: u32) -> HashMap<String, String> {
    let mut raw = Vec::new();
    if std::fs::File::open(format!("/proc/{pid}/environ"))
        .and_then(|mut f| f.read_to_end(&mut raw))
        .is_err()
    {
        return HashMap::new();
    }
    raw.split(|&b| b == 0)
        .filter_map(|e| std::str::from_utf8(e).ok())
        .filter_map(|e| e.split_once('='))
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

fn proc_uid(pid: u32) -> Option<u32> {
    std::fs::read_to_string(format!("/proc/{pid}/status"))
        .ok()?
        .lines()
        .find(|l| l.starts_with("Uid:"))?
        .split_whitespace()
        .nth(1)?
        .parse()
        .ok()
}

/// DISPLAY and XAUTHORITY of the session: its leader's environment, else any process of the
/// session's user that has a DISPLAY.
fn display_env(
    leader: Option<u32>,
    uid: Option<u32>,
    display_hint: &str,
) -> Option<(String, Option<String>)> {
    if let Some(pid) = leader {
        let env = environ(pid);
        if let Some(d) = env.get("DISPLAY") {
            return Some((d.clone(), env.get("XAUTHORITY").cloned()));
        }
    }
    let uid = uid?;
    let mut best: Option<(String, Option<String>)> = None;
    for entry in std::fs::read_dir("/proc").ok()?.flatten() {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|s| s.parse::<u32>().ok())
        else {
            continue;
        };
        if proc_uid(pid) != Some(uid) {
            continue;
        }
        let env = environ(pid);
        if let Some(d) = env.get("DISPLAY") {
            let found = (d.clone(), env.get("XAUTHORITY").cloned());
            if display_hint.is_empty() || d == display_hint {
                return Some(found);
            }
            best.get_or_insert(found);
        }
    }
    best
}

/// Finds the active X11 session; the error text is what the viewer shows.
pub fn discover() -> Result<Display, String> {
    let mut wayland = false;
    let mut candidates = Vec::new();
    for id in session_ids() {
        let p = session_props(&id);
        let get = |k: &str| p.get(k).map(String::as_str).unwrap_or("");
        if get("Active") != "yes" {
            continue;
        }
        match get("Type") {
            "x11" => candidates.push(p.clone()),
            "wayland" => wayland = true,
            _ => {}
        }
    }
    // Signed-in users before greeters.
    candidates.sort_by_key(|p| p.get("Class").map(String::as_str) != Some("user"));
    if let Some(p) = candidates.first() {
        let get = |k: &str| p.get(k).map(String::as_str).unwrap_or("");
        let uid = get("User").parse().ok();
        let leader = get("Leader").parse().ok();
        let hint = get("Display");
        if let Some((name, xauth)) = display_env(leader, uid, hint)
            .or_else(|| (!hint.is_empty()).then(|| (hint.to_string(), None)))
        {
            let user = Some(get("Name").to_string()).filter(|n| !n.is_empty());
            let xauthority = xauth
                .map(PathBuf::from)
                .or_else(|| guess_xauthority(uid, user.as_deref()));
            return Ok(Display {
                name,
                xauthority,
                user,
                uid,
                locked: get("LockedHint") == "yes",
                greeter: get("Class") == "greeter",
            });
        }
    }
    if wayland {
        return Err("Wayland sessions are not supported yet".into());
    }
    // No logind session (containers, development): this process's own display, if any.
    if let Ok(name) = std::env::var("DISPLAY")
        && !name.is_empty()
    {
        return Ok(Display {
            name,
            xauthority: std::env::var_os("XAUTHORITY")
                .map(PathBuf::from)
                .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".Xauthority"))),
            user: None,
            uid: None,
            locked: false,
            greeter: false,
        });
    }
    Err("No graphical session".into())
}

fn guess_xauthority(uid: Option<u32>, user: Option<&str>) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(uid) = uid {
        candidates.push(PathBuf::from(format!("/run/user/{uid}/gdm/Xauthority")));
    }
    if let Some(user) = user {
        candidates.push(PathBuf::from(format!("/home/{user}/.Xauthority")));
    }
    candidates.into_iter().find(|p| p.exists())
}

// ------------------------------------------------------------------ connection

/// Parses `:N[.S]` (local displays only).
fn parse_display(name: &str) -> Result<(u32, usize)> {
    let rest = name
        .strip_prefix("unix")
        .unwrap_or(name)
        .strip_prefix(':')
        .ok_or_else(|| anyhow!("only local displays are supported ({name})"))?;
    let (number, screen) = rest.split_once('.').unwrap_or((rest, "0"));
    Ok((number.parse()?, screen.parse().unwrap_or(0)))
}

/// `MIT-MAGIC-COOKIE-1` for display `number` from an Xauthority file.
fn read_cookie(path: &Path, number: u32) -> Option<(Vec<u8>, Vec<u8>)> {
    let data = std::fs::read(path).ok()?;
    let mut i = 0usize;
    let take = |data: &[u8], i: &mut usize| -> Option<Vec<u8>> {
        let len = u16::from_be_bytes([*data.get(*i)?, *data.get(*i + 1)?]) as usize;
        let v = data.get(*i + 2..*i + 2 + len)?.to_vec();
        *i += 2 + len;
        Some(v)
    };
    let wanted = number.to_string();
    let mut fallback = None;
    while i + 2 <= data.len() {
        let family = u16::from_be_bytes([data[i], data[i + 1]]);
        i += 2;
        let _address = take(&data, &mut i)?;
        let num = take(&data, &mut i)?;
        let name = take(&data, &mut i)?;
        let cookie = take(&data, &mut i)?;
        if name != b"MIT-MAGIC-COOKIE-1" {
            continue;
        }
        // 256 = FamilyLocal, 65535 = FamilyWild.
        if num == wanted.as_bytes() && (family == 256 || family == 65535) {
            return Some((name, cookie));
        }
        if num.is_empty() || num == wanted.as_bytes() {
            fallback.get_or_insert((name, cookie));
        }
    }
    fallback
}

/// Connects to the session's X server with its cookie (no environment changes).
pub fn connect(display: &Display) -> Result<(RustConnection, usize)> {
    let (number, screen) = parse_display(&display.name)?;
    let path = format!("/tmp/.X11-unix/X{number}");
    let stream = match std::os::unix::net::UnixStream::connect(&path) {
        Ok(s) => s,
        Err(_) => {
            use std::os::linux::net::SocketAddrExt;
            let addr = std::os::unix::net::SocketAddr::from_abstract_name(path.as_bytes())?;
            std::os::unix::net::UnixStream::connect_addr(&addr)
                .with_context(|| format!("cannot reach X display {}", display.name))?
        }
    };
    let (stream, _) = DefaultStream::from_unix_stream(stream)?;
    let (name, cookie) = display
        .xauthority
        .as_deref()
        .and_then(|p| read_cookie(p, number))
        .unwrap_or_default();
    let conn = RustConnection::connect_to_stream_with_auth_info(stream, screen, name, cookie)
        .with_context(|| format!("X server {} refused the connection", display.name))?;
    // XWayland means the session is really Wayland (its root window shows nothing).
    if conn
        .query_extension(b"XWAYLAND")
        .ok()
        .and_then(|c| c.reply().ok())
        .is_some_and(|r| r.present)
    {
        bail!("Wayland sessions are not supported yet");
    }
    Ok((conn, screen))
}

// ------------------------------------------------------------------ capture

struct ShmSegment {
    seg: u32,
    ptr: *mut u8,
    size: usize,
}

impl Drop for ShmSegment {
    fn drop(&mut self) {
        // SAFETY: the mapping was created by `mmap` with this size and is unmapped once.
        unsafe {
            libc::munmap(self.ptr.cast(), self.size);
        }
    }
}

pub struct X11Source {
    conn: RustConnection,
    root: u32,
    monitors: Vec<MonitorInfo>,
    active: u32,
    shm: Option<ShmSegment>,
    buf: Vec<u8>,
    size: (u32, u32),
    has_image: bool,
    last_capture: Instant,
    cursor_serial: u32,
    xfixes: bool,
}

// SAFETY: the raw mapping pointer is only used by the thread that owns the source.
unsafe impl Send for X11Source {}

/// One capture per this interval at most (X11 has no change notification here; 30 fps max).
const X11_INTERVAL: Duration = Duration::from_millis(33);

impl X11Source {
    pub fn open(display: &Display) -> Result<Self> {
        let (conn, screen) = connect(display)?;
        let root = conn
            .setup()
            .roots
            .get(screen)
            .context("no such X screen")?
            .root;
        let xfixes = conn
            .xfixes_query_version(4, 0)
            .ok()
            .and_then(|c| c.reply().ok())
            .is_some();
        let mut source = Self {
            conn,
            root,
            monitors: Vec::new(),
            active: 0,
            shm: None,
            buf: Vec::new(),
            size: (0, 0),
            has_image: false,
            last_capture: Instant::now() - Duration::from_secs(1),
            cursor_serial: 0,
            xfixes,
        };
        source.monitors = source.list_monitors(screen);
        Ok(source)
    }

    fn list_monitors(&self, screen: usize) -> Vec<MonitorInfo> {
        let mut list: Vec<MonitorInfo> = self
            .conn
            .randr_get_monitors(self.root, true)
            .ok()
            .and_then(|c| c.reply().ok())
            .map(|r| {
                r.monitors
                    .iter()
                    .map(|m| MonitorInfo {
                        id: 0,
                        name: self
                            .conn
                            .get_atom_name(m.name)
                            .ok()
                            .and_then(|c| c.reply().ok())
                            .map(|a| String::from_utf8_lossy(&a.name).to_string())
                            .unwrap_or_default(),
                        x: i32::from(m.x),
                        y: i32::from(m.y),
                        width: u32::from(m.width),
                        height: u32::from(m.height),
                        primary: m.primary,
                        scale: 1.0,
                    })
                    .filter(|m| m.width > 0 && m.height > 0)
                    .collect()
            })
            .unwrap_or_default();
        if list.is_empty() {
            let s = &self.conn.setup().roots[screen];
            list.push(MonitorInfo {
                id: 0,
                name: "screen".into(),
                x: 0,
                y: 0,
                width: u32::from(s.width_in_pixels),
                height: u32::from(s.height_in_pixels),
                primary: true,
                scale: 1.0,
            });
        }
        list.sort_by_key(|m| (!m.primary, m.x, m.y));
        for (i, m) in list.iter_mut().enumerate() {
            m.id = i as u32;
        }
        list
    }

    fn monitor(&self) -> &MonitorInfo {
        self.monitors
            .iter()
            .find(|m| m.id == self.active)
            .unwrap_or(&self.monitors[0])
    }

    fn ensure_shm(&mut self, bytes: usize) {
        if self.shm.as_ref().is_some_and(|s| s.size >= bytes) {
            return;
        }
        if let Some(old) = self.shm.take() {
            let _ = self.conn.shm_detach(old.seg);
        }
        let Ok(seg) = self.conn.generate_id() else {
            return;
        };
        let Ok(cookie) = self.conn.shm_create_segment(seg, bytes as u32, false) else {
            return;
        };
        let Ok(reply) = cookie.reply() else { return };
        let fd = reply.shm_fd;
        // SAFETY: mapping a server-created shared memory fd of `bytes` bytes read-only; the
        // mapping outlives the fd and is unmapped in Drop.
        let ptr = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                bytes,
                libc::PROT_READ,
                libc::MAP_SHARED,
                fd.as_raw_fd(),
                0,
            )
        };
        if ptr == libc::MAP_FAILED {
            let _ = self.conn.shm_detach(seg);
            return;
        }
        self.shm = Some(ShmSegment {
            seg,
            ptr: ptr.cast(),
            size: bytes,
        });
    }

    fn grab(&mut self) -> Result<()> {
        let m = self.monitor().clone();
        let (w, h) = (m.width as u16, m.height as u16);
        let bytes = usize::from(w) * usize::from(h) * 4;
        self.ensure_shm(bytes);
        let mut done = false;
        if let Some(shm) = &self.shm {
            let reply = self
                .conn
                .shm_get_image(self.root, m.x as i16, m.y as i16, w, h, !0, 2, shm.seg, 0)
                .ok()
                .and_then(|c| c.reply().ok());
            if reply.is_some() {
                self.buf.resize(bytes, 0);
                // SAFETY: the server wrote `bytes` bytes of ZPixmap data into the segment, which
                // is mapped with at least that size.
                unsafe { std::ptr::copy_nonoverlapping(shm.ptr, self.buf.as_mut_ptr(), bytes) };
                done = true;
            }
        }
        if !done {
            self.shm = None;
            let reply = self
                .conn
                .get_image(
                    xproto::ImageFormat::Z_PIXMAP,
                    self.root,
                    m.x as i16,
                    m.y as i16,
                    w,
                    h,
                    !0,
                )?
                .reply()
                .context("GetImage failed")?;
            if reply.data.len() < bytes {
                bail!("unsupported X visual (depth {})", reply.depth);
            }
            self.buf.clear();
            self.buf.extend_from_slice(&reply.data[..bytes]);
        }
        // 24-bit visuals leave the pad byte at zero; the viewer needs opaque pixels.
        for px in self.buf.as_chunks_mut::<4>().0 {
            px[3] = 255;
        }
        self.size = (m.width, m.height);
        self.has_image = true;
        Ok(())
    }
}

impl FrameSource for X11Source {
    fn method(&self) -> &'static str {
        "x11"
    }

    fn monitors(&self) -> Vec<MonitorInfo> {
        self.monitors.clone()
    }

    fn active_monitor(&self) -> u32 {
        self.monitor().id
    }

    fn select_monitor(&mut self, id: u32) -> Result<()> {
        if !self.monitors.iter().any(|m| m.id == id) {
            bail!("no monitor with id {id}");
        }
        self.active = id;
        Ok(())
    }

    fn capture(&mut self, timeout: Duration) -> Result<Captured> {
        let since = self.last_capture.elapsed();
        if since < X11_INTERVAL {
            std::thread::sleep((X11_INTERVAL - since).min(timeout));
            if self.last_capture.elapsed() < X11_INTERVAL {
                return Ok(Captured::Idle);
            }
        }
        self.last_capture = Instant::now();
        self.grab()?;
        // The engine compares tiles; an unchanged screen produces no tiles.
        Ok(Captured::Frame {
            dirty: None,
            moves: Vec::new(),
        })
    }

    fn image(&self) -> Option<(&[u8], u32, u32)> {
        self.has_image
            .then_some((&self.buf[..], self.size.0, self.size.1))
    }

    fn cursor(&mut self) -> Option<CursorPoll> {
        if !self.xfixes {
            return None;
        }
        let reply = self.conn.xfixes_get_cursor_image().ok()?.reply().ok()?;
        let m = self.monitor();
        let (mx, my) = (m.x, m.y);
        let shape = (reply.cursor_serial != self.cursor_serial).then(|| {
            self.cursor_serial = reply.cursor_serial;
            Shape {
                hot_x: reply.xhot,
                hot_y: reply.yhot,
                width: reply.width,
                height: reply.height,
                rgba: argb_to_rgba(&reply.cursor_image),
            }
        });
        Some(CursorPoll {
            x: i32::from(reply.x) - mx,
            y: i32::from(reply.y) - my,
            visible: true,
            shape,
        })
    }

    fn desktop(&self) -> String {
        "default".into()
    }
}

/// XFIXES cursor pixels are premultiplied ARGB; the viewer wants straight RGBA.
fn argb_to_rgba(pixels: &[u32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(pixels.len() * 4);
    for &p in pixels {
        let a = (p >> 24) as u8;
        let un = |c: u32| -> u8 {
            let c = (c & 0xff) as u16;
            if a == 0 {
                0
            } else {
                ((c * 255 + u16::from(a) / 2) / u16::from(a)).min(255) as u8
            }
        };
        out.extend_from_slice(&[un(p >> 16), un(p >> 8), un(p), a]);
    }
    out
}

// ------------------------------------------------------------------ input

const KEY_PRESS: u8 = 2;
const KEY_RELEASE: u8 = 3;
const BUTTON_PRESS: u8 = 4;
const BUTTON_RELEASE: u8 = 5;
const MOTION: u8 = 6;
const SHIFT_L: u32 = 0xffe1;

pub struct X11Input {
    conn: RustConnection,
    root: u32,
    min_keycode: u8,
    per_keycode: u8,
    keysyms: Vec<u32>,
    spare: Vec<u8>,
    next_spare: usize,
    buttons: u8,
    held: Vec<u8>,
    clipboard: Option<std::sync::mpsc::Sender<String>>,
}

impl X11Input {
    pub fn open(
        display: &Display,
        clipboard: Option<std::sync::mpsc::Sender<String>>,
    ) -> Result<Self> {
        let (conn, screen) = connect(display)?;
        let root = conn
            .setup()
            .roots
            .get(screen)
            .context("no such X screen")?
            .root;
        let (min, max) = (conn.setup().min_keycode, conn.setup().max_keycode);
        let mapping = conn.get_keyboard_mapping(min, max - min + 1)?.reply()?;
        let per = mapping.keysyms_per_keycode;
        let spare = (0..=(max - min))
            .filter(|i| {
                let start = usize::from(*i) * usize::from(per);
                mapping.keysyms[start..start + usize::from(per)]
                    .iter()
                    .all(|&k| k == 0)
            })
            .map(|i| min + i)
            .rev()
            .take(8)
            .collect();
        Ok(Self {
            conn,
            root,
            min_keycode: min,
            per_keycode: per,
            keysyms: mapping.keysyms,
            spare,
            next_spare: 0,
            buttons: 0,
            held: Vec::new(),
            clipboard,
        })
    }

    /// Keycode and shift level producing `keysym`.
    fn lookup(&self, keysym: u32) -> Option<(u8, bool)> {
        let per = usize::from(self.per_keycode.max(1));
        for (i, chunk) in self.keysyms.chunks(per).enumerate() {
            if chunk.first() == Some(&keysym) {
                return Some((self.min_keycode + i as u8, false));
            }
        }
        for (i, chunk) in self.keysyms.chunks(per).enumerate() {
            if chunk.get(1) == Some(&keysym) {
                return Some((self.min_keycode + i as u8, true));
            }
        }
        None
    }

    /// Maps `keysym` onto a spare keycode (round-robin).
    fn map_spare(&mut self, keysym: u32) -> Option<u8> {
        if self.spare.is_empty() {
            return None;
        }
        let code = self.spare[self.next_spare % self.spare.len()];
        self.next_spare += 1;
        let per = self.per_keycode.max(1);
        let syms = vec![keysym; usize::from(per)];
        self.conn
            .change_keyboard_mapping(1, code, per, &syms)
            .ok()?;
        let start = usize::from(code - self.min_keycode) * usize::from(per);
        self.keysyms[start..start + usize::from(per)].copy_from_slice(&syms);
        let _ = self.conn.sync();
        Some(code)
    }

    fn fake(&self, kind: u8, detail: u8, x: i16, y: i16) {
        let _ = self
            .conn
            .xtest_fake_input(kind, detail, 0, self.root, x, y, 0);
    }

    fn tap(&mut self, keysym: u32) {
        let (code, shifted) = match self.lookup(keysym) {
            Some(found) => found,
            None => match self.map_spare(keysym) {
                Some(code) => (code, false),
                None => return,
            },
        };
        let shift = if shifted {
            self.lookup(SHIFT_L).map(|(c, _)| c)
        } else {
            None
        };
        if let Some(s) = shift {
            self.fake(KEY_PRESS, s, 0, 0);
        }
        self.fake(KEY_PRESS, code, 0, 0);
        self.fake(KEY_RELEASE, code, 0, 0);
        if let Some(s) = shift {
            self.fake(KEY_RELEASE, s, 0, 0);
        }
        let _ = self.conn.flush();
    }
}

impl InputSink for X11Input {
    fn mouse(&mut self, monitor: &MonitorInfo, x: i32, y: i32, buttons: u8, wheel: (f32, f32)) {
        let px = monitor.x + x.clamp(0, monitor.width.saturating_sub(1) as i32);
        let py = monitor.y + y.clamp(0, monitor.height.saturating_sub(1) as i32);
        self.fake(MOTION, 0, px as i16, py as i16);
        // DOM bit → X button: left 1, right 3, middle 2, back 8, forward 9.
        for (bit, button) in [(1u8, 1u8), (2, 3), (4, 2), (8, 8), (16, 9)] {
            let was = self.buttons & bit != 0;
            let is = buttons & bit != 0;
            if was != is {
                self.fake(if is { BUTTON_PRESS } else { BUTTON_RELEASE }, button, 0, 0);
            }
        }
        self.buttons = buttons;
        let scroll = |amount: f32, negative: u8, positive: u8| {
            let clicks = amount.round() as i32;
            let button = if clicks < 0 { negative } else { positive };
            for _ in 0..clicks.unsigned_abs().min(20) {
                self.fake(BUTTON_PRESS, button, 0, 0);
                self.fake(BUTTON_RELEASE, button, 0, 0);
            }
        };
        // Wheel buttons: 4 up, 5 down, 6 left, 7 right.
        scroll(wheel.1, 4, 5);
        scroll(wheel.0, 6, 7);
        let _ = self.conn.flush();
    }

    fn key(&mut self, code: &str, key: &str, down: bool) {
        if let Some(ks) = keymap::keysym(code)
            && let Some((keycode, _)) = self.lookup(ks)
        {
            self.fake(if down { KEY_PRESS } else { KEY_RELEASE }, keycode, 0, 0);
            if down {
                self.held.push(keycode);
            } else {
                self.held.retain(|&k| k != keycode);
            }
            let _ = self.conn.flush();
            return;
        }
        let mut chars = key.chars();
        if down
            && let (Some(c), None) = (chars.next(), chars.next())
            && !c.is_control()
        {
            self.tap(keymap::char_keysym(c));
        }
    }

    fn text(&mut self, text: &str) {
        for c in text.chars() {
            self.tap(keymap::char_keysym(c));
        }
    }

    fn set_clipboard(&mut self, text: &str) {
        if let Some(tx) = &self.clipboard {
            let _ = tx.send(text.to_string());
        }
    }

    fn cad(&mut self) -> Result<()> {
        let codes: Vec<u8> = [0xffe3u32, 0xffe9, 0xffff]
            .iter()
            .filter_map(|&ks| self.lookup(ks).map(|(c, _)| c))
            .collect();
        if codes.len() != 3 {
            bail!("Ctrl+Alt+Del keys are not mapped on this display");
        }
        for &c in &codes {
            self.fake(KEY_PRESS, c, 0, 0);
        }
        for &c in codes.iter().rev() {
            self.fake(KEY_RELEASE, c, 0, 0);
        }
        let _ = self.conn.flush();
        Ok(())
    }

    fn release_all(&mut self) {
        for code in std::mem::take(&mut self.held) {
            self.fake(KEY_RELEASE, code, 0, 0);
        }
        for (bit, button) in [(1u8, 1u8), (2, 3), (4, 2), (8, 8), (16, 9)] {
            if self.buttons & bit != 0 {
                self.fake(BUTTON_RELEASE, button, 0, 0);
            }
        }
        self.buttons = 0;
        let _ = self.conn.flush();
    }
}

// ------------------------------------------------------------------ clipboard

fn atom(conn: &RustConnection, name: &str) -> Result<u32> {
    Ok(conn.intern_atom(false, name.as_bytes())?.reply()?.atom)
}

/// Clipboard thread: polls `CLIPBOARD` for changes and serves it when the technician sets it.
fn clipboard_thread(
    display: Display,
    out: UnboundedSender<Out>,
    shared: Arc<Shared>,
    set_rx: std::sync::mpsc::Receiver<String>,
) -> Result<()> {
    let (conn, screen) = connect(&display)?;
    let root = conn.setup().roots[screen].root;
    let window = conn.generate_id()?;
    conn.create_window(
        0,
        window,
        root,
        0,
        0,
        1,
        1,
        0,
        xproto::WindowClass::INPUT_ONLY,
        0,
        &xproto::CreateWindowAux::new(),
    )?;
    let clipboard = atom(&conn, "CLIPBOARD")?;
    let utf8 = atom(&conn, "UTF8_STRING")?;
    let targets = atom(&conn, "TARGETS")?;
    let property = atom(&conn, "RUSTRMM_CLIPBOARD")?;
    conn.flush()?;
    let mut owned: Option<String> = None;
    let mut last_seen: Option<String> = None;
    let mut next_poll = Instant::now();
    let mut waiting = false;
    while !shared.stopped() {
        while let Ok(text) = set_rx.try_recv() {
            conn.set_selection_owner(window, clipboard, x11rb::CURRENT_TIME)?;
            conn.flush()?;
            last_seen = Some(text.clone());
            owned = Some(text);
        }
        if owned.is_none() && !waiting && Instant::now() >= next_poll {
            conn.convert_selection(window, clipboard, utf8, property, x11rb::CURRENT_TIME)?;
            conn.flush()?;
            waiting = true;
            next_poll = Instant::now() + Duration::from_secs(1);
        }
        match conn.poll_for_event()? {
            Some(Event::SelectionNotify(e)) => {
                waiting = false;
                if e.property != x11rb::NONE
                    && let Ok(reply) = conn
                        .get_property(
                            true,
                            window,
                            property,
                            xproto::AtomEnum::ANY,
                            0,
                            (MAX_CLIPBOARD_BYTES / 4) as u32,
                        )?
                        .reply()
                {
                    let text = String::from_utf8_lossy(&reply.value).to_string();
                    if last_seen.as_deref() != Some(text.as_str()) {
                        let first = last_seen.is_none();
                        last_seen = Some(text.clone());
                        // The clipboard at session start is not sent; only changes are.
                        if !first && !shared.is_view_only() && !text.is_empty() {
                            let _ = out.send(Out::control(&DesktopControl::Clipboard { text }));
                        }
                    }
                }
            }
            Some(Event::SelectionRequest(e)) => {
                let target_property = if e.property == x11rb::NONE {
                    e.target
                } else {
                    e.property
                };
                let mut reply_property = x11rb::NONE;
                if let Some(text) = &owned {
                    if e.target == targets {
                        let list: Vec<u8> = [targets, utf8, u32::from(xproto::AtomEnum::STRING)]
                            .iter()
                            .flat_map(|a| a.to_ne_bytes())
                            .collect();
                        conn.change_property(
                            xproto::PropMode::REPLACE,
                            e.requestor,
                            target_property,
                            xproto::AtomEnum::ATOM,
                            32,
                            3,
                            &list,
                        )?;
                        reply_property = target_property;
                    } else if e.target == utf8 || e.target == u32::from(xproto::AtomEnum::STRING) {
                        conn.change_property(
                            xproto::PropMode::REPLACE,
                            e.requestor,
                            target_property,
                            e.target,
                            8,
                            text.len() as u32,
                            text.as_bytes(),
                        )?;
                        reply_property = target_property;
                    }
                }
                let notify = xproto::SelectionNotifyEvent {
                    response_type: xproto::SELECTION_NOTIFY_EVENT,
                    sequence: 0,
                    time: e.time,
                    requestor: e.requestor,
                    selection: e.selection,
                    target: e.target,
                    property: reply_property,
                };
                conn.send_event(false, e.requestor, xproto::EventMask::NO_EVENT, notify)?;
                conn.flush()?;
            }
            Some(Event::SelectionClear(_)) => owned = None,
            Some(_) => {}
            None => std::thread::sleep(Duration::from_millis(50)),
        }
        if waiting && Instant::now() > next_poll {
            // No owner answered (empty clipboard).
            waiting = false;
        }
    }
    Ok(())
}

// ------------------------------------------------------------------ consent

fn consent_needed(mode: ConsentMode, display: &Display) -> bool {
    let signed_in = display.user.is_some() && !display.greeter;
    match mode {
        ConsentMode::Never => false,
        ConsentMode::Always => signed_in,
        ConsentMode::WhenUserPresent => signed_in && !display.locked,
    }
}

/// Asks the session's user with `zenity --question` (run as that user). Fails closed.
fn ask_consent(display: &Display, prompt: &str, timeout_secs: u32) -> ConsentStatus {
    let Some(zenity) = ["/usr/bin/zenity", "/bin/zenity"]
        .into_iter()
        .find(|p| Path::new(p).exists())
    else {
        tracing::warn!("consent required but zenity is not installed; denying");
        return ConsentStatus::Denied;
    };
    let mut args: Vec<String> = Vec::new();
    // SAFETY: getuid has no preconditions.
    let me = unsafe { libc::getuid() };
    let mut program = zenity.to_string();
    if Some(me) != display.uid
        && let Some(user) = &display.user
    {
        program = "/usr/sbin/runuser".into();
        args.extend(["-u".into(), user.clone(), "--".into(), zenity.into()]);
    }
    args.extend([
        "--question".into(),
        "--title=Remote support request".into(),
        format!("--text={prompt}"),
        format!("--timeout={}", timeout_secs.max(1)),
    ]);
    let mut cmd = std::process::Command::new(program);
    cmd.args(&args)
        .env_clear()
        .env("DISPLAY", &display.name)
        .env("PATH", "/usr/bin:/bin")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    if let Some(x) = &display.xauthority {
        cmd.env("XAUTHORITY", x);
    }
    match cmd.status().map(|s| s.code()) {
        Ok(Some(0)) => ConsentStatus::Granted,
        Ok(Some(5)) => ConsentStatus::Timeout,
        Ok(Some(1)) => ConsentStatus::Denied,
        other => {
            tracing::warn!(?other, "consent prompt failed; denying");
            ConsentStatus::Denied
        }
    }
}

// ------------------------------------------------------------------ entry points

pub async fn serve(sink: &mut Sink, stream: &mut Stream, params: Params) -> Result<()> {
    let display = tokio::task::spawn_blocking(discover)
        .await?
        .map_err(|e| anyhow!(e))?;
    if consent_needed(params.consent, &display) {
        control(
            sink,
            &DesktopControl::Consent {
                status: ConsentStatus::Waiting,
            },
        )
        .await?;
        let (d, prompt) = (
            display.clone(),
            consent_prompt(&params.technician, &params.organization, false),
        );
        let timeout = params.consent_timeout_secs;
        let status = tokio::task::spawn_blocking(move || ask_consent(&d, &prompt, timeout)).await?;
        control(sink, &DesktopControl::Consent { status }).await?;
        if !status.allows() {
            control(sink, &DesktopControl::Exit { code: None }).await?;
            return Ok(());
        }
    }
    // Fail early with a clear message when the display is unreachable.
    let probe = display.clone();
    tokio::task::spawn_blocking(move || connect(&probe).map(|_| ())).await??;

    let (out_tx, out_rx) = unbounded_channel::<Out>();
    let shared = Shared::new(params.view_only);
    let (set_tx, set_rx) = std::sync::mpsc::channel::<String>();
    {
        let (d, out, shared) = (display.clone(), out_tx.clone(), shared.clone());
        std::thread::Builder::new()
            .name("desktop-clipboard".into())
            .spawn(move || {
                if let Err(e) = clipboard_thread(d, out, shared, set_rx) {
                    tracing::debug!(error = %format!("{e:#}"), "clipboard sync stopped");
                }
            })?;
    }
    let (source_display, input_display) = (display.clone(), display);
    let session = Session::start(
        EngineConfig {
            monitor: params.monitor,
            quality: params.quality,
            threads: encode::default_threads(),
        },
        shared,
        out_tx,
        move || Ok(Box::new(X11Source::open(&source_display)?) as Box<dyn FrameSource>),
        move || Ok(Box::new(X11Input::open(&input_display, Some(set_tx))?) as Box<dyn InputSink>),
    );
    relay(sink, stream, session, out_rx).await
}

/// Relays an in-process [`Session`] between the tunnel and its threads.
async fn relay(
    sink: &mut Sink,
    stream: &mut Stream,
    session: Session,
    mut out_rx: tokio::sync::mpsc::UnboundedReceiver<Out>,
) -> Result<()> {
    let result: Result<()> = async {
        loop {
            tokio::select! {
                message = out_rx.recv() => match message {
                    Some(Out::Binary(b)) => sink.send(WsMessage::Binary(b.into())).await?,
                    Some(Out::Text(t)) => {
                        let exit = matches!(serde_json::from_str(&t), Ok(DesktopControl::Exit { .. }));
                        sink.send(WsMessage::Text(t.into())).await?;
                        if exit {
                            return Ok(());
                        }
                    }
                    None => return Ok(()),
                },
                incoming = stream.next() => match incoming {
                    Some(Ok(WsMessage::Text(text))) => {
                        if let Ok(message) = serde_json::from_str::<DesktopControl>(&text) {
                            session.handle(message);
                        }
                    }
                    Some(Ok(WsMessage::Close(_))) | None | Some(Err(_)) => return Ok(()),
                    Some(Ok(_)) => {}
                },
            }
        }
    }
    .await;
    tokio::task::spawn_blocking(move || session.stop())
        .await
        .ok();
    result
}

pub async fn screenshot(request: Screenshot) -> Result<Value> {
    let display = tokio::task::spawn_blocking(discover)
        .await?
        .map_err(|e| anyhow!(e))?;
    let mut consent = ConsentStatus::NotRequired;
    if consent_needed(request.consent, &display) {
        let (d, prompt) = (
            display.clone(),
            consent_prompt(&request.technician, &request.organization, true),
        );
        let timeout = request.consent_timeout_secs;
        consent = tokio::task::spawn_blocking(move || ask_consent(&d, &prompt, timeout)).await?;
        match consent {
            ConsentStatus::Denied => bail!("The user denied the screenshot"),
            ConsentStatus::Timeout => bail!("The user did not answer the consent prompt"),
            _ => {}
        }
    }
    let max_width = request.max_width.max(160);
    let (w, h, jpeg) = tokio::task::spawn_blocking(move || -> Result<(u32, u32, Vec<u8>)> {
        let mut source = X11Source::open(&display)?;
        source.grab()?;
        let (frame, w, h) = source.image().context("no image")?;
        let (pixels, sw, sh) = encode::downscale(frame, w, h, max_width);
        let jpeg = encode::jpeg(&pixels, sw, sh, 75).context("JPEG encoding failed")?;
        Ok((sw, sh, jpeg))
    })
    .await??;
    Ok(json!({
        "jpeg": base64::engine::general_purpose::STANDARD.encode(jpeg),
        "width": w,
        "height": h,
        "consent": consent.as_str(),
    }))
}

/// A JPEG of the display, captured by the signed-in user for `rustrmm-agent support`.
pub fn own_screenshot(max_width: u32) -> Result<Vec<u8>> {
    let display = discover().map_err(|e| anyhow!(e))?;
    let mut source = X11Source::open(&display)?;
    source.grab()?;
    let (frame, w, h) = source.image().context("no image")?;
    let (pixels, sw, sh) = encode::downscale(frame, w, h, max_width.max(160));
    encode::jpeg(&pixels, sw, sh, 75).context("JPEG encoding failed")
}

/// `GET /devices/{id}/desktop/sessions` on Linux: graphical logind sessions.
pub fn list_sessions() -> Result<Value> {
    let mut items = Vec::new();
    for id in session_ids() {
        let p = session_props(&id);
        let get = |k: &str| p.get(k).map(String::as_str).unwrap_or("");
        let kind = get("Type");
        if kind != "x11" && kind != "wayland" {
            continue;
        }
        let state = if get("Class") == "greeter" {
            "login_screen"
        } else if get("LockedHint") == "yes" {
            "locked"
        } else if get("Active") == "yes" {
            "active"
        } else {
            "disconnected"
        };
        items.push(json!({
            "session_id": id.parse::<u32>().ok(),
            "kind": if get("Remote") == "yes" { "rdp" } else { "console" },
            "user": Some(get("Name")).filter(|n| !n.is_empty() && get("Class") != "greeter"),
            "state": state,
            "monitors": Value::Null,
            "type": kind,
        }));
    }
    Ok(json!({ "items": items }))
}

/// Selftest: one frame of this machine's X display, or `None` (skip) without one.
pub fn selftest() -> Result<super::SelftestOutcome> {
    let display = match discover() {
        Ok(d) => d,
        Err(reason) => return Ok(super::SelftestOutcome::Skip(reason)),
    };
    let started = Instant::now();
    let mut source = match X11Source::open(&display) {
        Ok(s) => s,
        Err(e) => {
            return Ok(super::SelftestOutcome::Skip(format!(
                "display {}: {e:#}",
                display.name
            )));
        }
    };
    source.grab()?;
    let capture_ms = started.elapsed().as_millis();
    let (frame, w, h) = source.image().context("no image")?;
    let encode_started = Instant::now();
    let all = super::tiles::all_tiles(w, h);
    let regions = super::tiles::plan(frame, w, h, &all);
    let encoded = encode::encode_regions(frame, w, &regions, 65, encode::default_threads());
    let bytes: usize = encoded
        .iter()
        .map(|e| e.payload.len() + rustrmm_proto::desktop::TILE_HEADER_LEN)
        .sum();
    Ok(super::SelftestOutcome::Pass(format!(
        "{w}x{h} via x11 ({}), {} tiles -> {} messages, {} KiB, capture {capture_ms} ms, encode {} ms",
        display.name,
        all.len(),
        encoded.len(),
        bytes / 1024,
        encode_started.elapsed().as_millis()
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn displays_and_cookies_parse() {
        assert_eq!(parse_display(":0").expect("display"), (0, 0));
        assert_eq!(parse_display(":1.2").expect("display"), (1, 2));
        assert!(parse_display("remote:0").is_err());
        // One FamilyLocal entry for display 0.
        let mut file = Vec::new();
        let field = |v: &[u8], out: &mut Vec<u8>| {
            out.extend_from_slice(&(v.len() as u16).to_be_bytes());
            out.extend_from_slice(v);
        };
        file.extend_from_slice(&256u16.to_be_bytes());
        field(b"host", &mut file);
        field(b"0", &mut file);
        field(b"MIT-MAGIC-COOKIE-1", &mut file);
        field(&[1, 2, 3, 4], &mut file);
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("Xauthority");
        std::fs::write(&path, &file).expect("write");
        let (name, cookie) = read_cookie(&path, 0).expect("cookie");
        assert_eq!(name, b"MIT-MAGIC-COOKIE-1");
        assert_eq!(cookie, vec![1, 2, 3, 4]);
        assert!(read_cookie(&path, 1).is_none());
    }

    #[test]
    fn cursor_pixels_are_unpremultiplied() {
        // Opaque red, half-transparent premultiplied white, fully transparent.
        let rgba = argb_to_rgba(&[0xffff_0000, 0x8080_8080, 0x0000_0000]);
        assert_eq!(&rgba[0..4], &[255, 0, 0, 255]);
        assert_eq!(&rgba[4..8], &[255, 255, 255, 128]);
        assert_eq!(&rgba[8..12], &[0, 0, 0, 0]);
    }

    #[test]
    fn consent_rules() {
        let user = Display {
            name: ":0".into(),
            xauthority: None,
            user: Some("alex".into()),
            uid: Some(1000),
            locked: false,
            greeter: false,
        };
        assert!(!consent_needed(ConsentMode::Never, &user));
        assert!(consent_needed(ConsentMode::Always, &user));
        assert!(consent_needed(ConsentMode::WhenUserPresent, &user));
        let locked = Display {
            locked: true,
            ..user.clone()
        };
        assert!(!consent_needed(ConsentMode::WhenUserPresent, &locked));
        assert!(consent_needed(ConsentMode::Always, &locked));
        let greeter = Display {
            greeter: true,
            user: Some("gdm".into()),
            ..user
        };
        assert!(!consent_needed(ConsentMode::Always, &greeter));
    }
}
