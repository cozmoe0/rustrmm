//! `rustrmm-agent desktop-helper`: the process that runs inside the user's session.
//!
//! It never touches the network. It connects to the agent's named pipe, reads its
//! [`HelperConfig`], then either streams (capture, encode, input, clipboard, banner) or takes one
//! screenshot. It exits when the pipe closes or the parent agent process exits.

use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use rustrmm_proto::desktop::DesktopControl;
use tokio::sync::mpsc::{UnboundedSender, unbounded_channel};
use windows::Win32::System::Threading::{
    INFINITE, OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject,
};
use windows::Win32::UI::HiDpi::{
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetProcessDpiAwarenessContext,
};

use super::capture::WinSource;
use super::input::WinInput;
use super::launch::OwnedHandle;
use super::{banner, clipboard, pipe};
use crate::desktop::engine::{
    Captured, EngineConfig, FrameSource, InputSink, Out, Session, Shared,
};
use crate::desktop::ipc::{self, HelperConfig};
use crate::desktop::{SelftestOutcome, encode, tiles};

/// Physical-pixel coordinates for GDI and correct output rectangles on scaled displays; must run
/// before any capture.
pub fn set_dpi_awareness() {
    // SAFETY: process-wide setting with no pointer arguments.
    if let Err(e) =
        unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) }
    {
        tracing::debug!(error = %e, "SetProcessDpiAwarenessContext failed (already set?)");
    }
}

/// The helper must not outlive the agent that started it (job objects cannot span sessions).
fn exit_with_parent(pid: u32) {
    // SAFETY: plain open for SYNCHRONIZE; the handle moves to the watchdog thread.
    let handle = match unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, pid) } {
        Ok(h) => OwnedHandle(h),
        Err(_) => return,
    };
    std::thread::spawn(move || {
        let handle = handle;
        // SAFETY: valid process handle owned by this thread.
        unsafe { WaitForSingleObject(handle.0, INFINITE) };
        std::process::exit(0);
    });
}

/// Sends tracing output to the agent over the pipe.
#[derive(Clone)]
struct PipeLog(UnboundedSender<String>);

impl std::io::Write for PipeLog {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let line = String::from_utf8_lossy(buf).trim_end().to_string();
        if !line.is_empty() {
            let _ = self.0.send(line);
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for PipeLog {
    type Writer = PipeLog;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

pub fn main(session: u32, pipe_name: &str, parent: u32) -> Result<()> {
    set_dpi_awareness();
    exit_with_parent(parent);
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let result = rt.block_on(run(pipe_name, session));
    // Session threads may still hold handles; the process ends here either way.
    std::process::exit(if result.is_ok() { 0 } else { 1 });
}

async fn run(pipe_name: &str, session: u32) -> Result<()> {
    let client = pipe::connect(pipe_name).await?;
    let (mut reader, mut writer) = tokio::io::split(client);
    let (log_tx, mut log_rx) = unbounded_channel::<String>();
    let _ = tracing_subscriber::fmt()
        .with_writer(PipeLog(log_tx))
        .with_ansi(false)
        .without_time()
        .with_target(false)
        .with_max_level(tracing::Level::INFO)
        .try_init();
    let (kind, payload) = ipc::read(&mut reader)
        .await?
        .context("the agent closed the pipe before sending a configuration")?;
    if kind != ipc::CONFIG {
        bail!("expected a configuration frame");
    }
    let config: HelperConfig =
        serde_json::from_slice(&payload).context("bad helper configuration")?;
    tracing::info!(session, mode = %config.mode, desktop = %super::desktop::thread_desktop_name(), "desktop helper started");

    if config.mode == "screenshot" {
        let max_width = config.max_width.max(160);
        let shot = tokio::task::spawn_blocking(move || screenshot(max_width)).await?;
        match shot {
            Ok((w, h, jpeg)) => {
                ipc::write(
                    &mut writer,
                    ipc::SCREENSHOT,
                    &ipc::screenshot_payload(w, h, &jpeg),
                )
                .await?
            }
            Err(e) => {
                let text = Out::error(format!("{e:#}"));
                if let Out::Text(t) = text {
                    ipc::write(&mut writer, ipc::CONTROL, t.as_bytes()).await?;
                }
            }
        }
        while let Ok(line) = log_rx.try_recv() {
            let _ = ipc::write(&mut writer, ipc::LOG, line.as_bytes()).await;
        }
        return Ok(());
    }

    let (out_tx, mut out_rx) = unbounded_channel::<Out>();
    let shared = Shared::new(config.view_only);
    let clip = clipboard::start(out_tx.clone(), shared.clone());
    let shown = if config.banner {
        banner::start(&config.technician)
    } else {
        None
    };
    let input_clip = clip.clone();
    let session_handle = Arc::new(Session::start(
        EngineConfig {
            monitor: config.monitor,
            quality: config.quality,
            threads: encode::default_threads(),
        },
        shared.clone(),
        out_tx,
        || Ok(Box::new(WinSource::new(false)?) as Box<dyn FrameSource>),
        move || Ok(Box::new(WinInput::new(input_clip)) as Box<dyn InputSink>),
    ));
    let writer_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                message = out_rx.recv() => match message {
                    Some(Out::Binary(b)) => if ipc::write(&mut writer, ipc::MEDIA, &b).await.is_err() { break },
                    Some(Out::Text(t)) => if ipc::write(&mut writer, ipc::CONTROL, t.as_bytes()).await.is_err() { break },
                    None => break,
                },
                Some(line) = log_rx.recv() => {
                    if ipc::write(&mut writer, ipc::LOG, line.as_bytes()).await.is_err() { break }
                }
            }
        }
    });
    loop {
        match ipc::read(&mut reader).await {
            Ok(Some((ipc::CONTROL, payload))) => {
                if let Ok(message) = serde_json::from_slice::<DesktopControl>(&payload) {
                    session_handle.handle(message);
                }
            }
            Ok(Some(_)) => {}
            Ok(None) | Err(_) => break,
        }
    }
    tracing::info!("agent closed the pipe; helper exiting");
    shared
        .stop
        .store(true, std::sync::atomic::Ordering::Relaxed);
    if let Some(c) = &clip {
        c.stop();
    }
    if let Some(b) = &shown {
        b.stop();
    }
    writer_task.abort();
    if let Ok(session) = Arc::try_unwrap(session_handle) {
        let _ = tokio::task::spawn_blocking(move || session.stop()).await;
    }
    Ok(())
}

/// One frame of the primary monitor, downscaled to `max_width` and JPEG-encoded.
pub fn screenshot(max_width: u32) -> Result<(u32, u32, Vec<u8>)> {
    let (frame, w, h) = grab_frame(Duration::from_secs(3))?;
    let (pixels, sw, sh) = encode::downscale(&frame, w, h, max_width);
    let jpeg = encode::jpeg(&pixels, sw, sh, 75).context("JPEG encoding failed")?;
    Ok((sw, sh, jpeg))
}

/// Captures the primary monitor in-process: DXGI first, then GDI.
pub fn grab_frame(wait: Duration) -> Result<(Vec<u8>, u32, u32)> {
    for force_gdi in [false, true] {
        let mut source = WinSource::new(force_gdi)?;
        let deadline = Instant::now() + wait;
        while Instant::now() < deadline {
            if let Captured::Frame { .. } = source.capture(Duration::from_millis(100))?
                && let Some((frame, w, h)) = source.image()
            {
                return Ok((frame.to_vec(), w, h));
            }
        }
    }
    bail!("no frame was captured")
}

/// Selftest: captures and encodes one full frame of this session; `None` when there is no
/// interactive display (session 0 or no attached monitor).
pub fn selftest() -> Result<SelftestOutcome> {
    set_dpi_awareness();
    if super::session::own_session() == 0 {
        return Ok(SelftestOutcome::Skip(
            "session 0 has no interactive display".into(),
        ));
    }
    let started = Instant::now();
    let mut source = match WinSource::new(false) {
        Ok(s) => s,
        Err(e) => return Ok(SelftestOutcome::Skip(format!("{e:#}"))),
    };
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut got = false;
    while Instant::now() < deadline {
        if let Captured::Frame { .. } = source.capture(Duration::from_millis(100))? {
            got = true;
            break;
        }
    }
    if !got {
        // Static desktop under DXGI or a refusal: GDI always yields a frame.
        source = WinSource::new(true)?;
        while Instant::now() < deadline + Duration::from_secs(2) {
            if let Captured::Frame { .. } = source.capture(Duration::from_millis(100))? {
                got = true;
                break;
            }
        }
    }
    if !got {
        bail!("no frame was captured");
    }
    let capture_ms = started.elapsed().as_millis();
    let method = source.method();
    let (frame, w, h) = source.image().context("no image")?;
    let encode_started = Instant::now();
    let all = tiles::all_tiles(w, h);
    let regions = tiles::plan(frame, w, h, &all);
    let encoded = encode::encode_regions(frame, w, &regions, 65, encode::default_threads());
    let bytes: usize = encoded
        .iter()
        .map(|e| e.payload.len() + rustrmm_proto::desktop::TILE_HEADER_LEN)
        .sum();
    Ok(SelftestOutcome::Pass(format!(
        "{w}x{h} via {method}, {} tiles -> {} messages, {} KiB, capture {capture_ms} ms, encode {} ms",
        all.len(),
        encoded.len(),
        bytes / 1024,
        encode_started.elapsed().as_millis()
    )))
}
