//! The streaming engine shared by every platform.
//!
//! A [`FrameSource`] (DXGI/GDI on Windows, X11 on Linux) captures; the engine thread diffs each
//! new image against the last one sent, encodes the dirty regions in parallel, and emits media
//! and control messages. Flow control: at most [`MAX_FRAMES_IN_FLIGHT`] unacknowledged frames;
//! while the viewer is behind, nothing is captured (DXGI accumulates the changes for us). An
//! [`InputSink`] on its own thread injects keyboard and mouse input, so input never waits behind
//! an encode.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use anyhow::Result;
use rustrmm_proto::desktop::{
    DesktopControl, MAX_CLIPBOARD_BYTES, MAX_CURSOR_SIDE, MAX_FRAMES_IN_FLIGHT, MAX_TEXT_CHARS,
    Media, MonitorInfo, Quality, desktop_label, tile_message,
};
use tokio::sync::mpsc::UnboundedSender;

use super::cursor::{self, Shape};
use super::encode;
use super::quality::{self, Controller};
use super::tiles::{self, MoveRect, Rect};

/// Stats cadence (and the adaptation window).
const STATS_EVERY: Duration = Duration::from_secs(2);
/// Frames still unacknowledged after this long are written off (a stalled or hidden viewer).
const ACK_TIMEOUT: Duration = Duration::from_secs(10);
/// Longest wait inside one capture call, so commands and the cursor stay responsive.
const CAPTURE_SLICE: Duration = Duration::from_millis(30);
/// Pointer polling interval (about 60 Hz; an X11 poll is a round trip carrying the image).
const CURSOR_EVERY: Duration = Duration::from_millis(16);

/// A message for the tunnel.
#[derive(Debug, Clone, PartialEq)]
pub enum Out {
    Binary(Vec<u8>),
    Text(String),
}

impl Out {
    pub fn control(message: &DesktopControl) -> Self {
        Self::Text(message.to_text())
    }

    pub fn error(message: impl Into<String>) -> Self {
        Self::control(&DesktopControl::Error {
            message: message.into(),
        })
    }
}

/// What a capture call produced.
#[derive(Debug, Clone, PartialEq)]
pub enum Captured {
    /// A new image is available. `dirty` narrows the comparison (`None` = compare everything);
    /// `moves` are applied before it.
    Frame {
        dirty: Option<Vec<Rect>>,
        moves: Vec<MoveRect>,
    },
    /// Nothing changed within the timeout.
    Idle,
}

/// Pointer state relative to the active monitor; `shape` only when it changed.
#[derive(Debug, Clone, PartialEq)]
pub struct CursorPoll {
    pub x: i32,
    pub y: i32,
    pub visible: bool,
    pub shape: Option<Shape>,
}

pub trait FrameSource {
    /// `dxgi` | `gdi` | `x11`
    fn method(&self) -> &'static str;
    fn monitors(&self) -> Vec<MonitorInfo>;
    fn active_monitor(&self) -> u32;
    fn select_monitor(&mut self, id: u32) -> Result<()>;
    /// Waits up to `timeout` for a new image of the active monitor.
    fn capture(&mut self, timeout: Duration) -> Result<Captured>;
    /// The latest image: packed top-down BGRA, width, height.
    fn image(&self) -> Option<(&[u8], u32, u32)>;
    fn cursor(&mut self) -> Option<CursorPoll>;
    /// Current input desktop name (`Default`, `Winlogon`, …).
    fn desktop(&self) -> String;
}

/// Keyboard, mouse and clipboard injection.
pub trait InputSink {
    /// `x`/`y` are pixels of the active monitor (`monitor`).
    fn mouse(&mut self, monitor: &MonitorInfo, x: i32, y: i32, buttons: u8, wheel: (f32, f32));
    fn key(&mut self, code: &str, key: &str, down: bool);
    fn text(&mut self, text: &str);
    fn set_clipboard(&mut self, text: &str);
    /// Ctrl+Alt+Del where the platform handles it in-process (Linux); Windows does it in the
    /// service.
    fn cad(&mut self) -> Result<()>;
    /// Releases every key and button still held (session end).
    fn release_all(&mut self);
}

/// State shared by the engine, input and clipboard threads.
#[derive(Default)]
pub struct Shared {
    pub view_only: AtomicBool,
    pub stop: AtomicBool,
    /// The monitor being streamed (input coordinates are relative to it).
    pub monitor: Mutex<Option<MonitorInfo>>,
}

impl Shared {
    pub fn new(view_only: bool) -> Arc<Self> {
        Arc::new(Self {
            view_only: AtomicBool::new(view_only),
            ..Default::default()
        })
    }

    pub fn stopped(&self) -> bool {
        self.stop.load(Ordering::Relaxed)
    }

    pub fn is_view_only(&self) -> bool {
        self.view_only.load(Ordering::Relaxed)
    }
}

#[derive(Debug)]
enum EngineCmd {
    Ack(u32),
    Refresh,
    Quality(Quality),
    Monitor(u32),
}

#[derive(Debug)]
enum InputCmd {
    Mouse {
        x: i32,
        y: i32,
        buttons: u8,
        wheel: (f32, f32),
    },
    Key {
        code: String,
        key: String,
        down: bool,
    },
    Text(String),
    Clipboard(String),
    Cad,
}

#[derive(Debug, Clone, Copy)]
pub struct EngineConfig {
    pub monitor: Option<u32>,
    pub quality: Quality,
    pub threads: usize,
}

/// A running desktop stream: the engine thread, the input thread and the message router.
pub struct Session {
    engine_tx: Sender<EngineCmd>,
    input_tx: Sender<InputCmd>,
    pub shared: Arc<Shared>,
    threads: Vec<JoinHandle<()>>,
}

impl Session {
    /// Starts the threads. `make_source` and `make_input` run on their own threads (Windows binds
    /// both to the input desktop of the thread that uses them).
    pub fn start<S, I>(
        config: EngineConfig,
        shared: Arc<Shared>,
        out: UnboundedSender<Out>,
        make_source: S,
        make_input: I,
    ) -> Self
    where
        S: FnOnce() -> Result<Box<dyn FrameSource>> + Send + 'static,
        I: FnOnce() -> Result<Box<dyn InputSink>> + Send + 'static,
    {
        let (engine_tx, engine_rx) = mpsc::channel();
        let (input_tx, input_rx) = mpsc::channel();
        let mut threads = Vec::new();
        {
            let (shared, out) = (shared.clone(), out.clone());
            if let Ok(h) = std::thread::Builder::new()
                .name("desktop-capture".into())
                .spawn(move || match make_source() {
                    Ok(mut source) => run(source.as_mut(), config, engine_rx, &out, &shared),
                    Err(e) => {
                        tracing::warn!(error = %format!("{e:#}"), "screen capture unavailable");
                        let _ = out.send(Out::error(format!("Screen capture failed: {e:#}")));
                        let _ = out.send(Out::control(&DesktopControl::Exit { code: None }));
                    }
                })
            {
                threads.push(h);
            }
        }
        {
            let (shared, out) = (shared.clone(), out);
            if let Ok(h) = std::thread::Builder::new()
                .name("desktop-input".into())
                .spawn(move || match make_input() {
                    Ok(mut sink) => input_loop(sink.as_mut(), input_rx, &out, &shared),
                    Err(e) => {
                        tracing::warn!(error = %format!("{e:#}"), "input injection unavailable");
                    }
                })
            {
                threads.push(h);
            }
        }
        Self {
            engine_tx,
            input_tx,
            shared,
            threads,
        }
    }

    /// Routes one browser control message.
    pub fn handle(&self, message: DesktopControl) {
        if message.is_input() && self.shared.is_view_only() {
            return;
        }
        let engine = |cmd| {
            let _ = self.engine_tx.send(cmd);
        };
        let input = |cmd| {
            let _ = self.input_tx.send(cmd);
        };
        match message {
            DesktopControl::Ack { frame_seq } => engine(EngineCmd::Ack(frame_seq)),
            DesktopControl::Refresh => engine(EngineCmd::Refresh),
            DesktopControl::Quality { value } => engine(EngineCmd::Quality(value)),
            DesktopControl::Monitor { id } => engine(EngineCmd::Monitor(id)),
            DesktopControl::ViewOnly { value } => {
                self.shared.view_only.store(value, Ordering::Relaxed);
            }
            DesktopControl::Mouse {
                x,
                y,
                buttons,
                wheel_x,
                wheel_y,
            } => input(InputCmd::Mouse {
                x,
                y,
                buttons,
                wheel: (wheel_x.unwrap_or(0.0), wheel_y.unwrap_or(0.0)),
            }),
            DesktopControl::Key {
                code, key, down, ..
            } => input(InputCmd::Key { code, key, down }),
            DesktopControl::Text { text } => {
                if text.chars().count() <= MAX_TEXT_CHARS {
                    input(InputCmd::Text(text));
                }
            }
            DesktopControl::Clipboard { text } => {
                if text.len() <= MAX_CLIPBOARD_BYTES {
                    input(InputCmd::Clipboard(text));
                }
            }
            DesktopControl::Cad => input(InputCmd::Cad),
            _ => {}
        }
    }

    /// Stops and joins every thread.
    pub fn stop(self) {
        self.shared.stop.store(true, Ordering::Relaxed);
        drop(self.engine_tx);
        drop(self.input_tx);
        for t in self.threads {
            let _ = t.join();
        }
    }
}

fn input_loop(
    sink: &mut dyn InputSink,
    commands: Receiver<InputCmd>,
    out: &UnboundedSender<Out>,
    shared: &Shared,
) {
    loop {
        let cmd = match commands.recv_timeout(Duration::from_millis(250)) {
            Ok(cmd) => cmd,
            Err(RecvTimeoutError::Timeout) if !shared.stopped() => continue,
            Err(_) => break,
        };
        // View-only may have been switched on after the message was queued.
        if shared.is_view_only() {
            continue;
        }
        match cmd {
            InputCmd::Mouse {
                x,
                y,
                buttons,
                wheel,
            } => {
                let monitor = shared.monitor.lock().ok().and_then(|m| m.clone());
                if let Some(monitor) = monitor {
                    sink.mouse(&monitor, x, y, buttons, wheel);
                }
            }
            InputCmd::Key { code, key, down } => sink.key(&code, &key, down),
            InputCmd::Text(text) => sink.text(&text),
            InputCmd::Clipboard(text) => sink.set_clipboard(&text),
            InputCmd::Cad => {
                if let Err(e) = sink.cad() {
                    let _ = out.send(Out::error(format!("{e:#}")));
                }
            }
        }
    }
    sink.release_all();
}

/// Per-window statistics.
struct Stats {
    started: Instant,
    frames: u32,
    bytes: u64,
    encode_ms: f64,
    blocked: Duration,
}

impl Stats {
    fn new() -> Self {
        Self {
            started: Instant::now(),
            frames: 0,
            bytes: 0,
            encode_ms: 0.0,
            blocked: Duration::ZERO,
        }
    }
}

/// The engine loop. Returns when `shared.stop` is set, the command channel closes or the
/// tunnel is gone.
fn run(
    source: &mut dyn FrameSource,
    config: EngineConfig,
    commands: Receiver<EngineCmd>,
    out: &UnboundedSender<Out>,
    shared: &Shared,
) {
    let send = |m: Out| out.send(m).is_ok();
    if let Some(id) = config.monitor
        && let Err(e) = source.select_monitor(id)
    {
        tracing::warn!(monitor = id, error = %format!("{e:#}"), "monitor not available; using the primary");
    }
    let mut controller = Controller::new(config.quality);
    let threads = config.threads.max(1);
    let mut prev: Vec<u8> = Vec::new();
    let mut prev_size = (0u32, 0u32);
    let mut seq: u32 = 0;
    let mut in_flight: VecDeque<(u32, Instant)> = VecDeque::new();
    let mut force_full = true;
    let mut ready_sent = false;
    let mut desktop = source.desktop();
    let mut last_cursor: Option<(i32, i32, bool)> = None;
    let mut cursor_polled = Instant::now();
    let mut last_send = Instant::now() - Duration::from_secs(1);
    let mut stats = Stats::new();
    let mut last_error: Option<String> = None;
    let mut publish_monitor = true;
    // Commands received while waiting, handled at the top of the next iteration.
    let mut pending: VecDeque<EngineCmd> = VecDeque::new();

    'outer: loop {
        if shared.stopped() || out.is_closed() {
            break;
        }
        // ---- commands
        loop {
            let next = match pending.pop_front() {
                Some(cmd) => Ok(cmd),
                None => commands.try_recv(),
            };
            match next {
                Ok(cmd) => match cmd {
                    EngineCmd::Ack(n) => {
                        while let Some(&(s, at)) = in_flight.front() {
                            if seq_le(s, n) {
                                controller.on_ack(at.elapsed());
                                in_flight.pop_front();
                            } else {
                                break;
                            }
                        }
                    }
                    EngineCmd::Refresh => force_full = true,
                    EngineCmd::Quality(q) => controller.set_mode(q),
                    EngineCmd::Monitor(id) => match source.select_monitor(id) {
                        Ok(()) => {
                            ready_sent = false;
                            force_full = true;
                            publish_monitor = true;
                            last_cursor = None;
                        }
                        Err(e) => {
                            let _ =
                                send(Out::error(format!("Monitor {id} is not available: {e:#}")));
                        }
                    },
                },
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => break 'outer,
            }
        }
        if publish_monitor {
            let monitors = source.monitors();
            let active = source.active_monitor();
            if let Ok(mut m) = shared.monitor.lock() {
                *m = monitors.iter().find(|m| m.id == active).cloned();
            }
            publish_monitor = false;
        }

        // ---- cursor (polled at about 60 Hz, also while the viewer is behind)
        if ready_sent
            && cursor_polled.elapsed() >= CURSOR_EVERY
            && let Some(c) = {
                cursor_polled = Instant::now();
                source.cursor()
            }
        {
            if let Some(shape) = c.shape {
                let shape = cursor::clamp_size(shape, MAX_CURSOR_SIDE);
                let _ = send(Out::Binary(
                    Media::CursorShape {
                        hot_x: shape.hot_x,
                        hot_y: shape.hot_y,
                        w: shape.width,
                        h: shape.height,
                        rgba: shape.rgba,
                    }
                    .encode(),
                ));
            }
            let pos = (c.x, c.y, c.visible);
            if last_cursor != Some(pos) {
                last_cursor = Some(pos);
                let _ = send(Out::Binary(
                    Media::CursorPosition {
                        x: c.x.clamp(i16::MIN as i32, i16::MAX as i32) as i16,
                        y: c.y.clamp(i16::MIN as i32, i16::MAX as i32) as i16,
                        visible: c.visible,
                    }
                    .encode(),
                ));
            }
        }

        // ---- flow control
        if let Some(&(_, oldest)) = in_flight.front()
            && oldest.elapsed() > ACK_TIMEOUT
        {
            tracing::debug!("viewer stopped acknowledging frames; resuming");
            in_flight.clear();
        }
        if in_flight.len() >= MAX_FRAMES_IN_FLIGHT {
            let started = Instant::now();
            match commands.recv_timeout(Duration::from_millis(10)) {
                Ok(cmd) => pending.push_back(cmd),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
            stats.blocked += started.elapsed();
            maybe_stats(&mut stats, &mut controller, source.method(), out);
            continue;
        }
        // ---- pacing
        let interval = controller.frame_interval();
        let since = last_send.elapsed();
        if since < interval && !force_full {
            let wait = (interval - since).min(Duration::from_millis(10));
            match commands.recv_timeout(wait) {
                Ok(cmd) => pending.push_back(cmd),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
            continue;
        }

        // ---- capture
        let captured = match source.capture(CAPTURE_SLICE) {
            Ok(c) => {
                last_error = None;
                c
            }
            Err(e) => {
                let text = format!("{e:#}");
                if last_error.as_deref() != Some(text.as_str()) {
                    tracing::warn!(error = %text, "capture failed");
                    let _ = send(Out::error(format!("Screen capture failed: {text}")));
                    last_error = Some(text);
                }
                std::thread::sleep(Duration::from_millis(250));
                continue;
            }
        };
        let name = source.desktop();
        if name != desktop {
            desktop = name;
            let _ = send(Out::control(&DesktopControl::Desktop {
                name: desktop_label(&desktop),
            }));
            force_full = true;
        }
        let (dirty, moves) = match captured {
            Captured::Frame { dirty, moves } => (dirty, moves),
            Captured::Idle if force_full => (None, Vec::new()),
            Captured::Idle => {
                maybe_stats(&mut stats, &mut controller, source.method(), out);
                continue;
            }
        };
        let Some((frame, width, height)) = source.image() else {
            continue;
        };
        if width == 0 || height == 0 || frame.len() < (width * height * 4) as usize {
            continue;
        }

        // ---- ready / resize
        if !ready_sent {
            let monitors = source.monitors();
            let active = source.active_monitor();
            if let Ok(mut m) = shared.monitor.lock() {
                *m = monitors.iter().find(|m| m.id == active).cloned();
            }
            if !send(Out::control(&DesktopControl::Ready {
                width,
                height,
                monitors,
                monitor: active,
                view_only: shared.is_view_only(),
                desktop: desktop_label(&desktop),
            })) {
                break;
            }
            ready_sent = true;
            force_full = true;
        } else if (width, height) != prev_size {
            let _ = send(Out::control(&DesktopControl::Resize { width, height }));
            force_full = true;
        }

        // ---- diff
        let full = force_full || (width, height) != prev_size || prev.len() != frame.len();
        let mut copy_messages = Vec::new();
        let tiles_dirty = if full {
            prev.clear();
            prev.extend_from_slice(frame);
            prev_size = (width, height);
            tiles::all_tiles(width, height)
        } else {
            let mut hint = dirty;
            for m in &moves {
                tiles::apply_move(&mut prev, width, height, m);
                copy_messages.push(
                    Media::CopyRect {
                        frame_seq: seq,
                        src_x: m.src_x as u16,
                        src_y: m.src_y as u16,
                        w: m.dst.w as u16,
                        h: m.dst.h as u16,
                        dst_x: m.dst.x as u16,
                        dst_y: m.dst.y as u16,
                    }
                    .encode(),
                );
                if let Some(h) = hint.as_mut() {
                    h.push(m.dst);
                }
            }
            tiles::dirty_tiles(&prev, frame, width, height, hint.as_deref())
        };
        force_full = false;
        if tiles_dirty.is_empty() && copy_messages.is_empty() {
            continue;
        }

        // ---- encode and send
        let started = Instant::now();
        let regions = tiles::plan(frame, width, height, &tiles_dirty);
        let encoded =
            encode::encode_regions(frame, width, &regions, controller.jpeg_quality(), threads);
        let encode_ms = started.elapsed().as_secs_f64() * 1000.0;
        let mut bytes = 0u64;
        for message in copy_messages {
            bytes += message.len() as u64;
            if !send(Out::Binary(message)) {
                break 'outer;
            }
        }
        let tile_count = encoded.len().min(u16::MAX as usize) as u16;
        for e in &encoded {
            let message = tile_message(
                seq,
                e.rect.x as u16,
                e.rect.y as u16,
                e.rect.w as u16,
                e.rect.h as u16,
                e.encoding,
                &e.payload,
            );
            bytes += message.len() as u64;
            if !send(Out::Binary(message)) {
                break 'outer;
            }
        }
        if !send(Out::Binary(
            Media::FrameEnd {
                frame_seq: seq,
                tiles: tile_count,
            }
            .encode(),
        )) {
            break;
        }
        if !full {
            for r in &regions {
                tiles::copy_rect(&mut prev, frame, width, &r.rect);
            }
        }
        in_flight.push_back((seq, Instant::now()));
        seq = seq.wrapping_add(1);
        last_send = Instant::now();
        stats.frames += 1;
        stats.bytes += bytes;
        stats.encode_ms += encode_ms;
        maybe_stats(&mut stats, &mut controller, source.method(), out);
    }
}

/// `a <= b` in wrapping sequence space.
fn seq_le(a: u32, b: u32) -> bool {
    b.wrapping_sub(a) < u32::MAX / 2
}

fn maybe_stats(
    stats: &mut Stats,
    controller: &mut Controller,
    method: &str,
    out: &UnboundedSender<Out>,
) {
    let elapsed = stats.started.elapsed();
    if elapsed < STATS_EVERY {
        return;
    }
    let secs = elapsed.as_secs_f64();
    let encode_ms = if stats.frames > 0 {
        stats.encode_ms / f64::from(stats.frames)
    } else {
        0.0
    };
    controller.on_window(&quality::Window {
        elapsed,
        blocked: stats.blocked,
        encode_ms,
    });
    let _ = out.send(Out::control(&DesktopControl::Stats {
        fps: (f64::from(stats.frames) / secs) as f32,
        kbps: (stats.bytes as f64 * 8.0 / 1000.0 / secs) as u32,
        encode_ms: encode_ms as f32,
        capture: method.to_string(),
    }));
    *stats = Stats::new();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scripted source: a list of frames, each with optional dirty hints.
    struct Script {
        frames: VecDeque<(Vec<u8>, Option<Vec<Rect>>)>,
        current: Vec<u8>,
        width: u32,
        height: u32,
    }

    impl FrameSource for Script {
        fn method(&self) -> &'static str {
            "test"
        }
        fn monitors(&self) -> Vec<MonitorInfo> {
            vec![MonitorInfo {
                id: 0,
                name: "test".into(),
                x: 0,
                y: 0,
                width: self.width,
                height: self.height,
                primary: true,
                scale: 1.0,
            }]
        }
        fn active_monitor(&self) -> u32 {
            0
        }
        fn select_monitor(&mut self, id: u32) -> Result<()> {
            anyhow::ensure!(id == 0, "no such monitor");
            Ok(())
        }
        fn capture(&mut self, _timeout: Duration) -> Result<Captured> {
            match self.frames.pop_front() {
                Some((frame, dirty)) => {
                    self.current = frame;
                    Ok(Captured::Frame {
                        dirty,
                        moves: Vec::new(),
                    })
                }
                None => {
                    std::thread::sleep(Duration::from_millis(5));
                    Ok(Captured::Idle)
                }
            }
        }
        fn image(&self) -> Option<(&[u8], u32, u32)> {
            (!self.current.is_empty()).then_some((&self.current[..], self.width, self.height))
        }
        fn cursor(&mut self) -> Option<CursorPoll> {
            None
        }
        fn desktop(&self) -> String {
            "Default".into()
        }
    }

    struct NoInput;
    impl InputSink for NoInput {
        fn mouse(&mut self, _: &MonitorInfo, _: i32, _: i32, _: u8, _: (f32, f32)) {}
        fn key(&mut self, _: &str, _: &str, _: bool) {}
        fn text(&mut self, _: &str) {}
        fn set_clipboard(&mut self, _: &str) {}
        fn cad(&mut self) -> Result<()> {
            anyhow::bail!("no CAD here")
        }
        fn release_all(&mut self) {}
    }

    fn collect(rx: &mut tokio::sync::mpsc::UnboundedReceiver<Out>, until: Duration) -> Vec<Out> {
        let deadline = Instant::now() + until;
        let mut got = Vec::new();
        while Instant::now() < deadline {
            match rx.try_recv() {
                Ok(m) => got.push(m),
                Err(_) => std::thread::sleep(Duration::from_millis(5)),
            }
        }
        got
    }

    fn frame_ends(messages: &[Out]) -> Vec<u32> {
        messages
            .iter()
            .filter_map(|m| match m {
                Out::Binary(b) => match Media::decode(b) {
                    Ok(Media::FrameEnd { frame_seq, .. }) => Some(frame_seq),
                    _ => None,
                },
                _ => None,
            })
            .collect()
    }

    #[test]
    fn engine_sends_ready_full_frame_then_only_changes_with_flow_control() {
        let (w, h) = (128u32, 64u32);
        let base = vec![10u8; (w * h * 4) as usize];
        let mut changed = base.clone();
        changed[0] = 99; // tile (0, 0)
        let mut changed2 = changed.clone();
        changed2[(64 * 4) as usize] = 7; // tile (1, 0)
        let frames = VecDeque::from(vec![
            (base, None),
            (changed, None),
            (changed2, Some(vec![Rect::new(64, 0, 1, 1)])),
        ]);
        let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel();
        let shared = Shared::new(false);
        let session = Session::start(
            EngineConfig {
                monitor: None,
                quality: Quality::Medium,
                threads: 2,
            },
            shared.clone(),
            out_tx,
            move || {
                Ok(Box::new(Script {
                    frames,
                    current: Vec::new(),
                    width: w,
                    height: h,
                }) as Box<dyn FrameSource>)
            },
            || Ok(Box::new(NoInput) as Box<dyn InputSink>),
        );
        let first = collect(&mut out_rx, Duration::from_millis(400));
        match &first[0] {
            Out::Text(t) => {
                let ready: DesktopControl = serde_json::from_str(t).expect("ready");
                assert!(matches!(
                    ready,
                    DesktopControl::Ready {
                        width: 128,
                        height: 64,
                        ..
                    }
                ));
            }
            other => panic!("expected ready, got {other:?}"),
        }
        // Two frames in flight, no acks: the third must wait.
        assert_eq!(frame_ends(&first), vec![0, 1], "{first:?}");
        // The second frame carries only the changed tile.
        let tiles_of_1: Vec<Media> = first
            .iter()
            .filter_map(|m| match m {
                Out::Binary(b) => Media::decode(b).ok(),
                _ => None,
            })
            .filter(|m| matches!(m, Media::Tile { frame_seq: 1, .. }))
            .collect();
        assert_eq!(tiles_of_1.len(), 1);
        assert!(matches!(
            tiles_of_1[0],
            Media::Tile {
                x: 0,
                y: 0,
                w: 64,
                h: 64,
                ..
            }
        ));

        session.handle(DesktopControl::Ack { frame_seq: 1 });
        let more = collect(&mut out_rx, Duration::from_millis(300));
        assert_eq!(frame_ends(&more), vec![2]);
        // Refresh forces a full frame even though nothing changed.
        session.handle(DesktopControl::Ack { frame_seq: 2 });
        session.handle(DesktopControl::Refresh);
        let refreshed = collect(&mut out_rx, Duration::from_millis(300));
        assert_eq!(frame_ends(&refreshed), vec![3]);
        session.stop();
    }

    #[test]
    fn view_only_drops_input_and_sequence_wraps() {
        let shared = Shared::new(true);
        let (out_tx, _out_rx) = tokio::sync::mpsc::unbounded_channel();
        let session = Session::start(
            EngineConfig {
                monitor: None,
                quality: Quality::Low,
                threads: 1,
            },
            shared.clone(),
            out_tx,
            || anyhow::bail!("no display in this test"),
            || Ok(Box::new(NoInput) as Box<dyn InputSink>),
        );
        session.handle(DesktopControl::Cad); // dropped: would produce an error otherwise
        session.handle(DesktopControl::ViewOnly { value: false });
        assert!(!shared.is_view_only());
        session.stop();
        assert!(seq_le(u32::MAX, 0));
        assert!(seq_le(5, 5));
        assert!(!seq_le(6, 5));
    }
}
