//! Test harness usable without elevation:
//! - `AnimationWindow`: a small topmost window repainted every vsync, so the
//!   screen changes continuously and DXGI frame rates are meaningful.
//! - `run_switch_sequence`: creates a private desktop with a full-screen
//!   window, `SwitchDesktop`s the console to it and back. The capture loop
//!   sees exactly what a UAC prompt or Win+L does to it (ACCESS_LOST, new
//!   input desktop, re-attach), minus the Winlogon ACL that needs SYSTEM.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use anyhow::{Context, bail};
use windows::Win32::Foundation::{COLORREF, GENERIC_ALL, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Dwm::DwmFlush;
use windows::Win32::Graphics::Gdi::{
    BeginPaint, CLEARTYPE_QUALITY, CLIP_DEFAULT_PRECIS, CreateFontW, CreateSolidBrush,
    DEFAULT_CHARSET, DT_BOTTOM, DT_CENTER, DT_SINGLELINE, DT_TOP, DeleteObject, DrawTextW,
    EndPaint, FW_BOLD, FillRect, InvalidateRect, OUT_DEFAULT_PRECIS, PAINTSTRUCT, SelectObject,
    SetBkMode, SetTextColor, TRANSPARENT, UpdateWindow,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::StationsAndDesktops::{
    CreateDesktopW, DESKTOP_CONTROL_FLAGS, HDESK, SetThreadDesktop, SwitchDesktop,
};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetClientRect,
    GetSystemMetrics, GetWindowTextW, IDC_ARROW, LoadCursorW, MSG, PM_REMOVE, PeekMessageW,
    PostThreadMessageW, RegisterClassW, SM_CXSCREEN, SM_CYSCREEN, SW_SHOWNOACTIVATE, ShowWindow,
    TranslateMessage, WM_ERASEBKGND, WM_PAINT, WM_QUIT, WNDCLASSW, WS_EX_NOACTIVATE,
    WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP, WS_VISIBLE,
};
use windows::core::{PCWSTR, w};

use crate::desktop::Desktop;

static FRAME: AtomicU64 = AtomicU64::new(0);
const CLASS_NAME: PCWSTR = w!("RustRMMSpikeWindow");
const TEST_DESKTOP: &str = "RustRMMSpikeTest";

struct SendDesktop(HDESK);
// SAFETY: desktop handles are process-wide.
unsafe impl Send for SendDesktop {}

/// A window running its own message loop on a dedicated thread.
pub struct AnimationWindow {
    thread_id: u32,
    join: Option<JoinHandle<()>>,
}

impl AnimationWindow {
    pub fn spawn() -> anyhow::Result<Self> {
        spawn_window(
            None,
            "RustRMM spike animation".into(),
            RECT {
                left: 40,
                top: 40,
                right: 460,
                bottom: 200,
            },
        )
    }
}

impl Drop for AnimationWindow {
    fn drop(&mut self) {
        unsafe {
            let _ = PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
        }
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

fn spawn_window(
    desktop: Option<HDESK>,
    title: String,
    rect: RECT,
) -> anyhow::Result<AnimationWindow> {
    let desktop = desktop.map(SendDesktop);
    let (tx, rx) = mpsc::channel::<Result<u32, String>>();
    let join = std::thread::Builder::new()
        .name("window".into())
        .spawn(move || window_thread(desktop, title, rect, tx))?;
    match rx.recv() {
        Ok(Ok(thread_id)) => Ok(AnimationWindow {
            thread_id,
            join: Some(join),
        }),
        Ok(Err(e)) => {
            let _ = join.join();
            bail!("window thread: {e}")
        }
        Err(_) => {
            let _ = join.join();
            bail!("window thread exited before reporting")
        }
    }
}

fn window_thread(
    desktop: Option<SendDesktop>,
    title: String,
    rect: RECT,
    ready: mpsc::Sender<Result<u32, String>>,
) {
    unsafe {
        // A fresh thread owns no windows yet, so SetThreadDesktop succeeds.
        if let Some(desktop) = desktop
            && let Err(e) = SetThreadDesktop(desktop.0)
        {
            let _ = ready.send(Err(format!("SetThreadDesktop: {e}")));
            return;
        }
        let instance = match GetModuleHandleW(None) {
            Ok(h) => h,
            Err(e) => {
                let _ = ready.send(Err(format!("GetModuleHandleW: {e}")));
                return;
            }
        };
        let class = WNDCLASSW {
            lpfnWndProc: Some(wndproc),
            hInstance: instance.into(),
            lpszClassName: CLASS_NAME,
            hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
            ..Default::default()
        };
        // Returns 0 if another thread registered it already; that is fine.
        RegisterClassW(&class);
        let title_w = crate::util::wide(&title);
        let hwnd = match CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            CLASS_NAME,
            PCWSTR(title_w.as_ptr()),
            WS_POPUP | WS_VISIBLE,
            rect.left,
            rect.top,
            rect.right - rect.left,
            rect.bottom - rect.top,
            None,
            None,
            Some(instance.into()),
            None,
        ) {
            Ok(h) => h,
            Err(e) => {
                let _ = ready.send(Err(format!("CreateWindowExW: {e}")));
                return;
            }
        };
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        let _ = ready.send(Ok(GetCurrentThreadId()));

        let mut msg = MSG::default();
        loop {
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                if msg.message == WM_QUIT {
                    let _ = DestroyWindow(hwnd);
                    return;
                }
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            FRAME.fetch_add(1, Ordering::Relaxed);
            let _ = InvalidateRect(Some(hwnd), None, false);
            let _ = UpdateWindow(hwnd);
            // DwmFlush blocks until the next composition pass (once per
            // vsync). Off the input desktop it can return immediately, so
            // fall back to a ~60 Hz sleep.
            let t = Instant::now();
            if DwmFlush().is_err() || t.elapsed() < Duration::from_millis(2) {
                std::thread::sleep(Duration::from_millis(16));
            }
        }
    }
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_ERASEBKGND => LRESULT(1),
        WM_PAINT => {
            unsafe { paint(hwnd) };
            LRESULT(0)
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

unsafe fn paint(hwnd: HWND) {
    unsafe {
        let mut ps = PAINTSTRUCT::default();
        let hdc = BeginPaint(hwnd, &mut ps);
        let mut rc = RECT::default();
        let _ = GetClientRect(hwnd, &mut rc);
        let n = FRAME.load(Ordering::Relaxed);
        // The colour changes on every repaint so every frame really differs.
        let phase = (n % 256) as u32;
        let brush = CreateSolidBrush(COLORREF(phase | ((255 - phase) << 8) | (0x60 << 16)));
        FillRect(hdc, &rc, brush);
        let _ = DeleteObject(brush.into());

        SetBkMode(hdc, TRANSPARENT);
        SetTextColor(hdc, COLORREF(0x00FF_FFFF));
        // Fit ~50 characters across the window.
        let font = CreateFontW(
            ((rc.bottom - rc.top) / 6)
                .min((rc.right - rc.left) / 28)
                .max(16),
            0,
            0,
            0,
            FW_BOLD.0 as i32,
            0,
            0,
            0,
            DEFAULT_CHARSET,
            OUT_DEFAULT_PRECIS,
            CLIP_DEFAULT_PRECIS,
            CLEARTYPE_QUALITY,
            0,
            w!("Segoe UI"),
        );
        let previous = SelectObject(hdc, font.into());
        let mut title = [0u16; 256];
        let len = GetWindowTextW(hwnd, &mut title).max(0) as usize;
        let mut upper = rc;
        upper.bottom = rc.top + (rc.bottom - rc.top) / 2;
        DrawTextW(
            hdc,
            &mut title[..len],
            &mut upper,
            DT_CENTER | DT_BOTTOM | DT_SINGLELINE,
        );
        let mut line: Vec<u16> = format!("frame {n}   {}", crate::util::timestamp())
            .encode_utf16()
            .collect();
        let mut lower = rc;
        lower.top = upper.bottom;
        DrawTextW(
            hdc,
            &mut line,
            &mut lower,
            DT_CENTER | DT_TOP | DT_SINGLELINE,
        );
        SelectObject(hdc, previous);
        let _ = DeleteObject(font.into());
        let _ = EndPaint(hwnd, &ps);
    }
}

/// Switches the console to a private desktop for `hold`, then back.
/// The switch back runs from a drop guard so an early error cannot leave the
/// user stranded on the test desktop.
pub fn run_switch_sequence(warmup: Duration, hold: Duration) -> anyhow::Result<()> {
    std::thread::sleep(warmup);
    let original = Desktop::open_input().context("OpenInputDesktop for the original desktop")?;
    log!("switch-test: original input desktop '{}'", original.name);

    let name = crate::util::wide(TEST_DESKTOP);
    let handle = unsafe {
        CreateDesktopW(
            PCWSTR(name.as_ptr()),
            PCWSTR::null(),
            None,
            DESKTOP_CONTROL_FLAGS(0),
            GENERIC_ALL.0,
            None,
        )
    }
    .context("CreateDesktopW")?;
    let test = Desktop::from_raw(handle, TEST_DESKTOP);
    let (width, height) = unsafe { (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)) };
    let window = spawn_window(
        Some(test.handle()),
        format!("RustRMM spike - synthetic desktop '{TEST_DESKTOP}'"),
        RECT {
            left: 0,
            top: 0,
            right: width,
            bottom: height,
        },
    )?;
    std::thread::sleep(Duration::from_millis(500));

    {
        let _switch_back = SwitchBack(&original);
        unsafe { SwitchDesktop(test.handle()) }.context("SwitchDesktop to the test desktop")?;
        log!(
            "switch-test: SwitchDesktop -> '{TEST_DESKTOP}' ok; holding {:.1} s",
            hold.as_secs_f64()
        );
        std::thread::sleep(hold);
    }

    drop(window);
    drop(test);
    log!("switch-test: done");
    Ok(())
}

struct SwitchBack<'a>(&'a Desktop);

impl Drop for SwitchBack<'_> {
    fn drop(&mut self) {
        for attempt in 1..=40 {
            match unsafe { SwitchDesktop(self.0.handle()) } {
                Ok(()) => {
                    log!("switch-test: switched back to '{}'", self.0.name);
                    return;
                }
                Err(e) => {
                    if attempt == 1 || attempt == 40 {
                        log!(
                            "switch-test: SwitchDesktop back to '{}' failed (attempt {attempt}): {e}",
                            self.0.name
                        );
                    }
                    std::thread::sleep(Duration::from_millis(250));
                }
            }
        }
    }
}
