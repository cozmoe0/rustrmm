//! The capture loop shared by `console` and `helper` modes.
//!
//! Per iteration:
//! 1. `OpenInputDesktop`; if its name differs from the thread's desktop, drop
//!    every desktop-bound object and `SetThreadDesktop` to it (if that is
//!    refused, continue on a fresh thread, which has no windows or hooks).
//! 2. Ensure a capturer: DXGI first. `DXGI_ERROR_UNSUPPORTED` -> wait for
//!    `EVENT_SYSTEM_DESKTOPSWITCH` once, then fall back to GDI and retry DXGI
//!    on the next switch event or after 10 s. `E_ACCESSDENIED` & co. are
//!    treated as a transition: wait for a switch event (250 ms poll).
//! 3. `AcquireNextFrame(100 ms)`; `DXGI_ERROR_ACCESS_LOST` -> recreate.
//! 4. Save proof frames (first frame on each desktop, then the latest changed
//!    frame every `save_interval`), log stats every `stats_every`.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use anyhow::anyhow;
use windows::Win32::Foundation::RECT;

use crate::capture::dxgi::{self, DeviceCache, DxgiCapturer};
use crate::capture::gdi::{self, GdiCapturer};
use crate::capture::{CaptureError, Capturer, FrameStatus};
use crate::desktop::{self, Desktop};
use crate::saver::Saver;
use crate::winevent::{self, SwitchSignal};

pub struct LoopOptions {
    /// File-name prefix: `console` or `svc`.
    pub tag: &'static str,
    pub output: Option<usize>,
    pub save_interval: Duration,
    pub max_saved: u32,
    /// None = run until killed (helper).
    pub duration: Option<Duration>,
    pub force_gdi: bool,
    pub gdi_fps: u32,
    pub follow: bool,
    pub stats_every: Duration,
    pub jpeg_quality: u8,
}

impl LoopOptions {
    pub fn console() -> Self {
        Self {
            tag: "console",
            output: None,
            save_interval: Duration::from_secs(2),
            max_saved: 200,
            duration: Some(Duration::from_secs(15)),
            force_gdi: false,
            gdi_fps: 15,
            follow: true,
            stats_every: Duration::from_secs(5),
            jpeg_quality: 80,
        }
    }

    pub fn helper() -> Self {
        Self {
            tag: "svc",
            max_saved: 600,
            duration: None,
            ..Self::console()
        }
    }

    fn describe(&self) -> String {
        format!(
            "tag={} output={} save_interval={:.1}s max_saved={} duration={} force_gdi={} gdi_fps={} follow={} quality={}",
            self.tag,
            self.output.map_or("primary".into(), |o| o.to_string()),
            self.save_interval.as_secs_f64(),
            self.max_saved,
            self.duration.map_or("until killed".into(), |d| format!(
                "{:.0}s",
                d.as_secs_f64()
            )),
            self.force_gdi,
            self.gdi_fps,
            self.follow,
            self.jpeg_quality,
        )
    }
}

#[derive(Clone, Default)]
struct Bucket {
    seconds: f64,
    frames: u64,
    pointer_only: u64,
    timeouts: u64,
    process_ms_sum: f64,
    process_ms_max: f64,
}

impl Bucket {
    fn add(&mut self, other: &Bucket) {
        self.seconds += other.seconds;
        self.frames += other.frames;
        self.pointer_only += other.pointer_only;
        self.timeouts += other.timeouts;
        self.process_ms_sum += other.process_ms_sum;
        self.process_ms_max = self.process_ms_max.max(other.process_ms_max);
    }

    fn describe(&self) -> String {
        let fps = if self.seconds > 0.0 {
            self.frames as f64 / self.seconds
        } else {
            0.0
        };
        let avg = if self.frames > 0 {
            self.process_ms_sum / self.frames as f64
        } else {
            0.0
        };
        format!(
            "{:.1} s: {} new frames ({fps:.1} fps), {} pointer-only, {} timeouts, frame-to-CPU avg {avg:.2} ms max {:.2} ms",
            self.seconds, self.frames, self.pointer_only, self.timeouts, self.process_ms_max
        )
    }
}

/// Stats for the capturer currently in use.
struct Window {
    desktop: String,
    method: &'static str,
    started: Instant,
    bucket: Bucket,
}

#[derive(Default)]
pub struct Summary {
    per_method: BTreeMap<(String, &'static str), Bucket>,
    desktop_switches: u32,
    in_place_switches: u32,
    in_place_switch_failures: u32,
    fresh_threads: u32,
    transient_waits: u32,
    saved: u32,
    dropped: u32,
    switch_events: u64,
    elapsed: f64,
}

impl Summary {
    pub fn log(&self) {
        log!(
            "summary: {:.1} s; desktop switches {} (in-place SetThreadDesktop ok {}, refused {}, fresh capture threads {}); \
             EVENT_SYSTEM_DESKTOPSWITCH notifications {}; transient DXGI waits {}; frames saved {} (dropped {})",
            self.elapsed,
            self.desktop_switches,
            self.in_place_switches,
            self.in_place_switch_failures,
            self.fresh_threads,
            self.switch_events,
            self.transient_waits,
            self.saved,
            self.dropped
        );
        for ((desktop, method), bucket) in &self.per_method {
            log!("summary:   '{desktop}' {method}: {}", bucket.describe());
        }
    }
}

enum Exit {
    Done,
    FreshThread,
}

/// Retry bookkeeping for DXGI while on one desktop.
#[derive(Default)]
struct DxgiRetry {
    unsupported: u32,
    denied: u32,
    retry_at: Option<Instant>,
    switch_count: u64,
    transient_logged: bool,
}

impl DxgiRetry {
    fn arm(&mut self, after: Duration, switch_count: u64) {
        self.retry_at = Some(Instant::now() + after);
        self.switch_count = switch_count;
    }

    fn due(&self, switch_count: u64) -> bool {
        switch_count != self.switch_count || self.retry_at.is_some_and(|t| Instant::now() >= t)
    }
}

struct State {
    opts: LoopOptions,
    saver: Saver,
    signal: SwitchSignal,
    summary: Summary,
    started: Instant,
    /// Desktop the capture thread is attached to.
    current: String,
    /// Owned handle for `current` (None while on the thread's initial desktop).
    owned: Option<Desktop>,
    /// Desktop a fresh capture thread must attach to first.
    pending: Option<Desktop>,
    last_input_error: Option<String>,
    window: Option<Window>,
}

pub fn run(opts: LoopOptions) -> anyhow::Result<Summary> {
    let signal = winevent::start();
    let saver = Saver::start(
        crate::paths::frames_dir(),
        opts.tag,
        opts.jpeg_quality,
        opts.max_saved,
    )?;
    log!("capture: {}", opts.describe());
    let mut state = State {
        opts,
        saver,
        signal,
        summary: Summary::default(),
        started: Instant::now(),
        current: String::new(),
        owned: None,
        pending: None,
        last_input_error: None,
        window: None,
    };
    loop {
        let handle = std::thread::Builder::new()
            .name("capture".into())
            .spawn(move || {
                let mut state = state;
                let exit = capture_thread(&mut state);
                (state, exit)
            })?;
        let (returned, exit) = handle
            .join()
            .map_err(|_| anyhow!("capture thread panicked"))?;
        state = returned;
        match exit {
            Exit::Done => break,
            Exit::FreshThread => state.summary.fresh_threads += 1,
        }
    }
    state.saver.finish();
    state.summary.saved = state.saver.submitted;
    state.summary.dropped = state.saver.dropped;
    state.summary.switch_events = state.signal.count();
    state.summary.elapsed = state.started.elapsed().as_secs_f64();
    Ok(state.summary)
}

fn capture_thread(st: &mut State) -> Exit {
    match st.pending.take() {
        Some(target) => match target.attach_current_thread() {
            Ok(()) => {
                log!("capture: fresh thread attached to '{}'", target.name);
                st.current = target.name.clone();
                st.owned = Some(target);
            }
            Err(e) => {
                log!(
                    "capture: fresh thread could not attach to '{}': {e}",
                    target.name
                );
                st.current = desktop::thread_desktop_name();
                st.owned = None;
            }
        },
        None => {
            st.current = desktop::thread_desktop_name();
            st.owned = None;
        }
    }
    log!(
        "capture: thread {} starts on desktop '{}'",
        crate::util::thread_id(),
        st.current
    );

    let mut capturer: Option<Capturer> = None;
    let mut retry = DxgiRetry::default();
    // One D3D device for the thread's life; only the duplication is
    // recreated per desktop (see DeviceCache).
    let mut devices = DeviceCache::default();
    // Set when a desktop switch is detected; cleared at the first new frame.
    let mut switched_at: Option<Instant> = None;
    // First image on a desktop is saved unconditionally; the first image of
    // a recreated capturer at most once a second; then the latest changed
    // image every save_interval.
    let mut save_now = true;
    let mut save_soon = false;
    let mut dirty = false;
    let mut last_save: Option<Instant> = None;

    loop {
        if st.should_stop() {
            st.close_window();
            return Exit::Done;
        }

        // 1. Follow the input desktop.
        if st.opts.follow {
            match Desktop::open_input() {
                Ok(input) => {
                    if let Some(previous) = st.last_input_error.take() {
                        log!(
                            "capture: input desktop '{}' accessible again (was: {previous})",
                            input.name
                        );
                    }
                    if input.name != st.current {
                        log!(
                            "capture: input desktop changed '{}' -> '{}'",
                            st.current,
                            input.name
                        );
                        st.summary.desktop_switches += 1;
                        // Duplication and screen DCs belong to the old desktop:
                        // release them before SetThreadDesktop.
                        st.close_window();
                        capturer = None;
                        match input.attach_current_thread() {
                            Ok(()) => {
                                st.summary.in_place_switches += 1;
                                st.current = input.name.clone();
                                st.owned = Some(input);
                            }
                            Err(e) => {
                                st.summary.in_place_switch_failures += 1;
                                log!(
                                    "capture: SetThreadDesktop('{}') refused in place: {e}; continuing on a fresh thread",
                                    input.name
                                );
                                st.pending = Some(input);
                                return Exit::FreshThread;
                            }
                        }
                        retry = DxgiRetry::default();
                        switched_at = Some(Instant::now());
                        save_now = true;
                        save_soon = false;
                        dirty = false;
                    }
                }
                Err(e) => {
                    let message = e.message();
                    if st.last_input_error.as_deref() != Some(message.as_str()) {
                        log!(
                            "capture: OpenInputDesktop failed: {e} - input desktop not accessible to this account (secure desktop?)"
                        );
                        st.last_input_error = Some(message);
                    }
                }
            }
        }

        // 2. On the GDI fallback, give DXGI another chance after a desktop
        //    switch notification or when the retry timer fires.
        if matches!(capturer, Some(Capturer::Gdi(_)))
            && !st.opts.force_gdi
            && retry.due(st.signal.count())
        {
            log!("capture: retrying DXGI on '{}'", st.current);
            st.close_window();
            capturer = None;
        }

        // 3. Ensure a capturer.
        if capturer.is_none() {
            match st.create_capturer(&mut retry, &mut devices) {
                Some(created) => {
                    st.open_window(created.method());
                    capturer = Some(created);
                    save_soon = true;
                }
                None => continue, // create_capturer already waited
            }
        }
        let Some(cap) = capturer.as_mut() else {
            continue;
        };

        // 4. Capture.
        let status = match cap.next_frame(100) {
            Ok(status) => status,
            Err(CaptureError::AccessLost) => {
                log!(
                    "capture: {} DXGI_ERROR_ACCESS_LOST on '{}' (desktop switch or mode change); recreating",
                    cap.method(),
                    st.current
                );
                st.close_window();
                capturer = None;
                continue;
            }
            Err(e) => {
                log!(
                    "capture: {} error on '{}': {e}; recreating",
                    cap.method(),
                    st.current
                );
                st.close_window();
                capturer = None;
                devices.invalidate();
                st.signal.wait(Duration::from_millis(200));
                continue;
            }
        };
        st.record(status, cap.last_process_ms());
        if status == FrameStatus::New {
            dirty = true;
            if let Some(at) = switched_at.take() {
                log!(
                    "capture: first new frame on '{}' {:.0} ms after the switch was detected ({})",
                    st.current,
                    at.elapsed().as_secs_f64() * 1000.0,
                    cap.method()
                );
            }
        }

        // 5. Proof frames.
        if let Some(image) = cap.image() {
            let since = last_save.map(|t| t.elapsed());
            let reason = if save_now {
                Some("first frame on this desktop")
            } else if save_soon && since.is_none_or(|d| d >= Duration::from_secs(1)) {
                Some("first frame of a new capturer")
            } else if dirty && since.is_none_or(|d| d >= st.opts.save_interval) {
                Some("periodic")
            } else {
                None
            };
            if let Some(reason) = reason {
                st.saver.submit(&st.current, cap.method(), reason, image);
                save_now = false;
                save_soon = false;
                dirty = false;
                last_save = Some(Instant::now());
            }
        }

        // 6. Stats.
        st.maybe_log_window();
    }
}

impl State {
    fn should_stop(&self) -> bool {
        crate::util::stop_requested()
            || self
                .opts
                .duration
                .is_some_and(|d| self.started.elapsed() >= d)
    }

    fn create_capturer(
        &mut self,
        retry: &mut DxgiRetry,
        devices: &mut DeviceCache,
    ) -> Option<Capturer> {
        if !self.opts.force_gdi {
            match DxgiCapturer::new(self.opts.output, devices) {
                Ok(c) => {
                    log!("capture: DXGI duplication ready on '{}'", self.current);
                    *retry = DxgiRetry::default();
                    return Some(Capturer::Dxgi(c));
                }
                Err(CaptureError::Unsupported) => {
                    retry.unsupported += 1;
                    if retry.unsupported == 1 {
                        log!(
                            "capture: DXGI_ERROR_UNSUPPORTED on '{}'; waiting up to 1 s for EVENT_SYSTEM_DESKTOPSWITCH before retrying",
                            self.current
                        );
                        let got = self.signal.wait(Duration::from_secs(1));
                        log!(
                            "capture: {}",
                            if got {
                                "switch notification received; retrying DXGI"
                            } else {
                                "no switch notification; retrying DXGI once more"
                            }
                        );
                        return None;
                    }
                    log!(
                        "capture: DXGI still unsupported on '{}'; falling back to GDI (DXGI retried on the next switch notification or in 10 s)",
                        self.current
                    );
                    retry.arm(Duration::from_secs(10), self.signal.count());
                }
                Err(
                    e @ (CaptureError::AccessDenied
                    | CaptureError::SessionDisconnected
                    | CaptureError::NotCurrentlyAvailable),
                ) => {
                    // Normally a transition: not yet on the new input desktop,
                    // or the secure desktop is up and we are not LocalSystem.
                    let on_input = self.opts.follow && self.last_input_error.is_none();
                    retry.denied += 1;
                    self.summary.transient_waits += 1;
                    if !retry.transient_logged {
                        log!(
                            "capture: DXGI unavailable on '{}': {e}; waiting for a desktop switch (notification or 250 ms poll)",
                            self.current
                        );
                        retry.transient_logged = true;
                    }
                    // Attached to the input desktop and still refused after ~2 s:
                    // a real refusal, so try GDI.
                    if !(on_input && retry.denied >= 8) {
                        self.signal.wait(Duration::from_millis(250));
                        return None;
                    }
                    log!(
                        "capture: DXGI refused {} times while attached to input desktop '{}'; falling back to GDI",
                        retry.denied,
                        self.current
                    );
                    retry.denied = 0;
                    retry.arm(Duration::from_secs(10), self.signal.count());
                }
                Err(e) => {
                    devices.invalidate();
                    log!(
                        "capture: DXGI setup failed on '{}': {e}; falling back to GDI (retry in 5 s)",
                        self.current
                    );
                    retry.arm(Duration::from_secs(5), self.signal.count());
                }
            }
        }

        let rect = gdi_rect(self.opts.output);
        match GdiCapturer::new(rect, self.opts.gdi_fps) {
            Ok(c) => {
                log!(
                    "capture: GDI capturer on '{}' ({}x{} at {},{}; {})",
                    self.current,
                    rect.right - rect.left,
                    rect.bottom - rect.top,
                    rect.left,
                    rect.top,
                    if self.opts.gdi_fps == 0 {
                        "unpaced".to_string()
                    } else {
                        format!("{} fps cap", self.opts.gdi_fps)
                    }
                );
                Some(Capturer::Gdi(c))
            }
            Err(e) => {
                log!("capture: GDI setup failed on '{}': {e}", self.current);
                self.signal.wait(Duration::from_millis(500));
                None
            }
        }
    }

    fn open_window(&mut self, method: &'static str) {
        self.window = Some(Window {
            desktop: self.current.clone(),
            method,
            started: Instant::now(),
            bucket: Bucket::default(),
        });
    }

    fn record(&mut self, status: FrameStatus, process_ms: f64) {
        let Some(window) = self.window.as_mut() else {
            return;
        };
        let b = &mut window.bucket;
        match status {
            FrameStatus::New => {
                b.frames += 1;
                b.process_ms_sum += process_ms;
                b.process_ms_max = b.process_ms_max.max(process_ms);
            }
            FrameStatus::PointerOnly => b.pointer_only += 1,
            FrameStatus::Timeout => b.timeouts += 1,
        }
    }

    fn maybe_log_window(&mut self) {
        if self
            .window
            .as_ref()
            .is_some_and(|w| w.started.elapsed() >= self.opts.stats_every)
        {
            self.flush_window(true);
        }
    }

    fn close_window(&mut self) {
        self.flush_window(false);
        self.window = None;
    }

    fn flush_window(&mut self, restart: bool) {
        let Some(window) = self.window.as_mut() else {
            return;
        };
        window.bucket.seconds = window.started.elapsed().as_secs_f64();
        if window.bucket.seconds >= 0.05 {
            log!(
                "stats: '{}' {} - {}",
                window.desktop,
                window.method,
                window.bucket.describe()
            );
        }
        self.summary
            .per_method
            .entry((window.desktop.clone(), window.method))
            .or_default()
            .add(&window.bucket);
        if restart {
            window.started = Instant::now();
            window.bucket = Bucket::default();
        }
    }
}

/// Same rectangle DXGI would duplicate, so GDI frames are comparable.
fn gdi_rect(want: Option<usize>) -> RECT {
    dxgi::list_outputs()
        .ok()
        .and_then(|entries| dxgi::pick_output(entries, want))
        .map(|entry| entry.info.rect)
        .unwrap_or_else(gdi::primary_rect)
}
