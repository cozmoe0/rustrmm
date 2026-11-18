//! "Remote session in progress" banner: a small topmost, click-through, layered window at the
//! top centre of the primary monitor, on its own UI thread, excluded from capture with
//! `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` so the technician never sees it.

use std::sync::OnceLock;

use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, CLEARTYPE_QUALITY, CLIP_DEFAULT_PRECIS, CreateFontW, CreateSolidBrush,
    DEFAULT_CHARSET, DT_CALCRECT, DT_CENTER, DT_SINGLELINE, DT_VCENTER, DeleteObject, DrawTextW,
    EndPaint, FW_SEMIBOLD, FillRect, GetDC, HFONT, OUT_DEFAULT_PRECIS, PAINTSTRUCT, ReleaseDC,
    SelectObject, SetBkMode, SetTextColor, TRANSPARENT,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::HiDpi::GetDpiForSystem;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW,
    GetSystemMetrics, HWND_TOPMOST, LWA_ALPHA, MSG, PostMessageW, PostQuitMessage, RegisterClassW,
    SM_CXSCREEN, SW_SHOWNOACTIVATE, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    SetLayeredWindowAttributes, SetTimer, SetWindowDisplayAffinity, SetWindowPos, ShowWindow,
    WDA_EXCLUDEFROMCAPTURE, WM_CLOSE, WM_DESTROY, WM_PAINT, WM_TIMER, WNDCLASSW, WS_EX_LAYERED,
    WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_POPUP,
};
use windows::core::w;

/// Text and font, shared with the window procedure (one banner per helper process).
struct Content {
    text: Vec<u16>,
    font_height: i32,
}

static CONTENT: OnceLock<Content> = OnceLock::new();

pub struct Banner {
    hwnd: isize,
}

impl Banner {
    pub fn stop(&self) {
        // SAFETY: posting to the banner thread's window; harmless if it is gone.
        unsafe {
            let _ = PostMessageW(
                Some(HWND(self.hwnd as *mut _)),
                WM_CLOSE,
                WPARAM(0),
                LPARAM(0),
            );
        }
    }
}

fn font(height: i32) -> HFONT {
    // SAFETY: plain font creation; the caller deletes it.
    unsafe {
        CreateFontW(
            -height,
            0,
            0,
            0,
            FW_SEMIBOLD.0 as i32,
            0,
            0,
            0,
            DEFAULT_CHARSET,
            OUT_DEFAULT_PRECIS,
            CLIP_DEFAULT_PRECIS,
            CLEARTYPE_QUALITY,
            0,
            w!("Segoe UI"),
        )
    }
}

/// Shows the banner; returns once the window exists (or failed).
pub fn start(technician: &str) -> Option<Banner> {
    let who = if technician.trim().is_empty() {
        "IT support".to_string()
    } else {
        technician.trim().to_string()
    };
    let text = format!("Remote session in progress \u{2014} {who}");
    // SAFETY: plain query (the process is per-monitor DPI aware).
    let dpi = unsafe { GetDpiForSystem() }.max(96) as i32;
    let font_height = 15 * dpi / 96;
    let _ = CONTENT.set(Content {
        text: text.encode_utf16().collect(),
        font_height,
    });
    let (tx, rx) = std::sync::mpsc::channel::<Option<isize>>();
    std::thread::Builder::new()
        .name("desktop-banner".into())
        .spawn(move || {
            let content = CONTENT.get();
            let Some(content) = content else {
                let _ = tx.send(None);
                return;
            };
            // SAFETY: window creation and a message loop on this dedicated thread; GDI objects
            // are released before the thread ends.
            unsafe {
                // Measure the text.
                let dc = GetDC(None);
                let f = font(content.font_height);
                let old = SelectObject(dc, f.into());
                let mut measure = RECT::default();
                let mut text = content.text.clone();
                DrawTextW(dc, &mut text, &mut measure, DT_CALCRECT | DT_SINGLELINE);
                SelectObject(dc, old);
                let _ = DeleteObject(f.into());
                ReleaseDC(None, dc);
                let pad = content.font_height;
                let width = (measure.right - measure.left) + 2 * pad;
                let height = (measure.bottom - measure.top) + pad;
                let screen = GetSystemMetrics(SM_CXSCREEN);

                let instance = GetModuleHandleW(None).unwrap_or_default();
                let class = WNDCLASSW {
                    lpfnWndProc: Some(wndproc),
                    hInstance: instance.into(),
                    lpszClassName: w!("RustRMMDesktopBanner"),
                    ..Default::default()
                };
                RegisterClassW(&class);
                let hwnd = match CreateWindowExW(
                    WS_EX_LAYERED
                        | WS_EX_TRANSPARENT
                        | WS_EX_TOPMOST
                        | WS_EX_TOOLWINDOW
                        | WS_EX_NOACTIVATE,
                    w!("RustRMMDesktopBanner"),
                    w!("RustRMM remote session"),
                    WS_POPUP,
                    (screen - width) / 2,
                    0,
                    width,
                    height,
                    None,
                    None,
                    Some(instance.into()),
                    None,
                ) {
                    Ok(h) => h,
                    Err(e) => {
                        tracing::warn!(error = %e, "banner window unavailable");
                        let _ = tx.send(None);
                        return;
                    }
                };
                let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), 225, LWA_ALPHA);
                if let Err(e) = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE) {
                    tracing::warn!(error = %e, "banner cannot be excluded from capture");
                }
                let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
                // Re-assert topmost every few seconds (full-screen apps push it down).
                SetTimer(Some(hwnd), 1, 3000, None);
                let _ = tx.send(Some(hwnd.0 as isize));
                let mut msg = MSG::default();
                while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                    DispatchMessageW(&msg);
                }
            }
        })
        .ok()?;
    rx.recv().ok().flatten().map(|hwnd| Banner { hwnd })
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_PAINT => {
            let Some(content) = CONTENT.get() else {
                return LRESULT(0);
            };
            let mut ps = PAINTSTRUCT::default();
            // SAFETY: paint cycle on our own window; GDI objects are deleted after use.
            unsafe {
                let dc = BeginPaint(hwnd, &mut ps);
                let brush = CreateSolidBrush(COLORREF(0x0020_3fb0)); // BGR: a deep orange-red
                FillRect(dc, &ps.rcPaint, brush);
                let _ = DeleteObject(brush.into());
                let f = font(content.font_height);
                let old = SelectObject(dc, f.into());
                SetBkMode(dc, TRANSPARENT);
                SetTextColor(dc, COLORREF(0x00ff_ffff));
                let mut rect = RECT::default();
                let _ = windows::Win32::UI::WindowsAndMessaging::GetClientRect(hwnd, &mut rect);
                let mut text = content.text.clone();
                DrawTextW(
                    dc,
                    &mut text,
                    &mut rect,
                    DT_CENTER | DT_VCENTER | DT_SINGLELINE,
                );
                SelectObject(dc, old);
                let _ = DeleteObject(f.into());
                let _ = EndPaint(hwnd, &ps);
            }
            LRESULT(0)
        }
        WM_TIMER => {
            // SAFETY: our own window.
            unsafe {
                let _ = SetWindowPos(
                    hwnd,
                    Some(HWND_TOPMOST),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );
            }
            LRESULT(0)
        }
        WM_CLOSE => {
            // SAFETY: our own window, on its thread.
            unsafe {
                let _ = DestroyWindow(hwnd);
            }
            LRESULT(0)
        }
        WM_DESTROY => {
            // SAFETY: ends this thread's message loop.
            unsafe { PostQuitMessage(0) };
            LRESULT(0)
        }
        // SAFETY: default handling for everything else.
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}
