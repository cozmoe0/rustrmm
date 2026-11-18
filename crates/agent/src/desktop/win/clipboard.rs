//! Text clipboard sync: a message-only window on its own thread (never the capture thread) that
//! listens for `WM_CLIPBOARDUPDATE` and sets clipboard text on request. The clipboard belongs to
//! the window station, so this keeps working while the secure desktop is the input desktop.

use std::sync::{Arc, Mutex, OnceLock};

use rustrmm_proto::desktop::{DesktopControl, MAX_CLIPBOARD_BYTES};
use tokio::sync::mpsc::UnboundedSender;
use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::DataExchange::{
    AddClipboardFormatListener, CloseClipboard, EmptyClipboard, GetClipboardData, OpenClipboard,
    RemoveClipboardFormatListener, SetClipboardData,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Memory::{GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalUnlock};
use windows::Win32::System::Ole::CF_UNICODETEXT;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW, HWND_MESSAGE,
    MSG, PostMessageW, PostQuitMessage, RegisterClassW, WINDOW_EX_STYLE, WINDOW_STYLE, WM_APP,
    WM_CLIPBOARDUPDATE, WM_CLOSE, WM_DESTROY, WNDCLASSW,
};
use windows::core::w;

use crate::desktop::engine::{Out, Shared};

const WM_SET_TEXT: u32 = WM_APP + 1;

struct State {
    out: UnboundedSender<Out>,
    shared: Arc<Shared>,
    /// Text we set ourselves (its change notification is not echoed back).
    last_set: Option<String>,
    last_seen: Option<String>,
    pending: Option<String>,
}

static STATE: OnceLock<Mutex<Option<State>>> = OnceLock::new();

fn state() -> &'static Mutex<Option<State>> {
    STATE.get_or_init(|| Mutex::new(None))
}

/// Handle to the clipboard thread's window.
#[derive(Clone)]
pub struct Handle {
    hwnd: isize,
}

impl Handle {
    /// Sets the device clipboard (asynchronously, on the clipboard thread).
    pub fn set(&self, text: &str) {
        if let Ok(mut guard) = state().lock()
            && let Some(s) = guard.as_mut()
        {
            s.pending = Some(text.to_string());
        }
        // SAFETY: posting to a window owned by the clipboard thread; harmless if it is gone.
        unsafe {
            let _ = PostMessageW(
                Some(HWND(self.hwnd as *mut _)),
                WM_SET_TEXT,
                WPARAM(0),
                LPARAM(0),
            );
        }
    }

    pub fn stop(&self) {
        // SAFETY: as above.
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

/// Starts the watcher thread; `None` when the window could not be created.
pub fn start(out: UnboundedSender<Out>, shared: Arc<Shared>) -> Option<Handle> {
    if let Ok(mut guard) = state().lock() {
        *guard = Some(State {
            out,
            shared,
            last_set: None,
            last_seen: None,
            pending: None,
        });
    }
    let (tx, rx) = std::sync::mpsc::channel::<Option<isize>>();
    std::thread::Builder::new()
        .name("desktop-clipboard".into())
        .spawn(move || {
            // SAFETY: window class registration and creation with static strings; the window is
            // destroyed on WM_CLOSE and the loop ends with WM_QUIT.
            unsafe {
                let instance = GetModuleHandleW(None).unwrap_or_default();
                let class = WNDCLASSW {
                    lpfnWndProc: Some(wndproc),
                    hInstance: instance.into(),
                    lpszClassName: w!("RustRMMDesktopClipboard"),
                    ..Default::default()
                };
                RegisterClassW(&class);
                let hwnd = match CreateWindowExW(
                    WINDOW_EX_STYLE(0),
                    w!("RustRMMDesktopClipboard"),
                    w!(""),
                    WINDOW_STYLE(0),
                    0,
                    0,
                    0,
                    0,
                    Some(HWND_MESSAGE),
                    None,
                    Some(instance.into()),
                    None,
                ) {
                    Ok(h) => h,
                    Err(e) => {
                        tracing::warn!(error = %e, "clipboard window unavailable");
                        let _ = tx.send(None);
                        return;
                    }
                };
                if let Err(e) = AddClipboardFormatListener(hwnd) {
                    tracing::warn!(error = %e, "clipboard listener unavailable");
                }
                let _ = tx.send(Some(hwnd.0 as isize));
                let mut msg = MSG::default();
                while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                    DispatchMessageW(&msg);
                }
            }
        })
        .ok()?;
    rx.recv().ok().flatten().map(|hwnd| Handle { hwnd })
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_CLIPBOARDUPDATE => {
            if let Some(text) = read_text(hwnd)
                && let Ok(mut guard) = state().lock()
                && let Some(s) = guard.as_mut()
            {
                let ours = s.last_set.as_deref() == Some(text.as_str());
                let repeat = s.last_seen.as_deref() == Some(text.as_str());
                s.last_seen = Some(text.clone());
                if !ours && !repeat && !s.shared.is_view_only() && text.len() <= MAX_CLIPBOARD_BYTES
                {
                    let _ = s
                        .out
                        .send(Out::control(&DesktopControl::Clipboard { text }));
                }
            }
            LRESULT(0)
        }
        WM_SET_TEXT => {
            let pending = state()
                .lock()
                .ok()
                .and_then(|mut g| g.as_mut().and_then(|s| s.pending.take()));
            if let Some(text) = pending
                && write_text(hwnd, &text)
                && let Ok(mut guard) = state().lock()
                && let Some(s) = guard.as_mut()
            {
                s.last_set = Some(text);
            }
            LRESULT(0)
        }
        WM_CLOSE => {
            // SAFETY: our own window, on its thread.
            unsafe {
                let _ = RemoveClipboardFormatListener(hwnd);
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

/// Opens the clipboard, retrying briefly while another process holds it.
fn open(hwnd: HWND) -> bool {
    for _ in 0..10 {
        // SAFETY: plain call with our window as the owner.
        if unsafe { OpenClipboard(Some(hwnd)) }.is_ok() {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    false
}

fn read_text(hwnd: HWND) -> Option<String> {
    if !open(hwnd) {
        return None;
    }
    // SAFETY: the clipboard is open; the handle is locked only while copying and never freed
    // (the clipboard owns it).
    let text = unsafe {
        GetClipboardData(CF_UNICODETEXT.0 as u32)
            .ok()
            .and_then(|h| {
                let global = HGLOBAL(h.0);
                let ptr = GlobalLock(global) as *const u16;
                if ptr.is_null() {
                    return None;
                }
                let mut len = 0usize;
                while *ptr.add(len) != 0 && len < MAX_CLIPBOARD_BYTES {
                    len += 1;
                }
                let text = String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len));
                let _ = GlobalUnlock(global);
                Some(text)
            })
    };
    // SAFETY: opened above.
    unsafe {
        let _ = CloseClipboard();
    }
    text
}

fn write_text(hwnd: HWND, text: &str) -> bool {
    let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    if !open(hwnd) {
        return false;
    }
    // SAFETY: the allocation is filled while locked and handed to the clipboard, which owns it
    // after SetClipboardData succeeds; on failure it is freed here.
    let ok = unsafe {
        let _ = EmptyClipboard();
        match GlobalAlloc(GMEM_MOVEABLE, wide.len() * 2) {
            Ok(global) => {
                let ptr = GlobalLock(global) as *mut u16;
                if ptr.is_null() {
                    let _ = GlobalFree(Some(global));
                    false
                } else {
                    std::ptr::copy_nonoverlapping(wide.as_ptr(), ptr, wide.len());
                    let _ = GlobalUnlock(global);
                    match SetClipboardData(CF_UNICODETEXT.0 as u32, Some(HANDLE(global.0))) {
                        Ok(_) => true,
                        Err(_) => {
                            let _ = GlobalFree(Some(global));
                            false
                        }
                    }
                }
            }
            Err(_) => false,
        }
    };
    // SAFETY: opened above.
    unsafe {
        let _ = CloseClipboard();
    }
    ok
}
