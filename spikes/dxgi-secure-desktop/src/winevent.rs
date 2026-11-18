//! `EVENT_SYSTEM_DESKTOPSWITCH` notifications via `SetWinEventHook`.
//!
//! Two hook threads run so the log shows empirically which hooks see a
//! switch: one stays pinned to the desktop it started on (`Default`), one
//! follows the input desktop (unhook, `SetThreadDesktop`, re-hook). Hooks
//! live on dedicated threads so the capture thread itself never owns a hook,
//! which would make its `SetThreadDesktop` fail.
//!
//! The capture loop does not depend on these events for correctness (it
//! polls `OpenInputDesktop` every iteration); they only cut the wait when
//! DXGI is unavailable.

use std::cell::RefCell;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use windows::Win32::Foundation::{HANDLE, HWND, WAIT_OBJECT_0};
use windows::Win32::System::Threading::{CreateEventW, SetEvent, WaitForSingleObject};
use windows::Win32::UI::Accessibility::{HWINEVENTHOOK, SetWinEventHook, UnhookWinEvent};
use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, EVENT_SYSTEM_DESKTOPSWITCH, MSG, MsgWaitForMultipleObjects, PM_REMOVE,
    PeekMessageW, QS_ALLINPUT, TranslateMessage, WINEVENT_OUTOFCONTEXT,
};
use windows::core::PCWSTR;

use crate::desktop::{self, Desktop};

struct Shared {
    /// Auto-reset event set on every received switch notification.
    event: HANDLE,
    count: AtomicU64,
}

// SAFETY: an event handle is process-wide; SetEvent/WaitForSingleObject are thread-safe.
unsafe impl Send for Shared {}
unsafe impl Sync for Shared {}

static SHARED: OnceLock<Shared> = OnceLock::new();

thread_local! {
    /// (hook label, desktop the hook thread is attached to), for log lines.
    static HOOK_CONTEXT: RefCell<(&'static str, String)> = const { RefCell::new(("", String::new())) };
}

/// Cheap handle to the shared switch notification state.
#[derive(Clone, Copy)]
pub struct SwitchSignal;

impl SwitchSignal {
    /// Number of switch notifications received so far (both hook threads).
    pub fn count(&self) -> u64 {
        shared().count.load(Ordering::SeqCst)
    }

    /// Waits for a switch notification; true if one arrived.
    pub fn wait(&self, timeout: Duration) -> bool {
        let ms = timeout.as_millis().min(u32::MAX as u128) as u32;
        unsafe { WaitForSingleObject(shared().event, ms) == WAIT_OBJECT_0 }
    }
}

fn shared() -> &'static Shared {
    SHARED.get_or_init(|| {
        let event = unsafe { CreateEventW(None, false, false, PCWSTR::null()) }
            .expect("CreateEventW for desktop-switch signal");
        Shared {
            event,
            count: AtomicU64::new(0),
        }
    })
}

/// Starts the hook threads (once per process).
pub fn start() -> SwitchSignal {
    static STARTED: OnceLock<()> = OnceLock::new();
    STARTED.get_or_init(|| {
        shared();
        for (label, follow) in [("pinned", false), ("follow", true)] {
            std::thread::Builder::new()
                .name(format!("winevent-{label}"))
                .spawn(move || hook_thread(label, follow))
                .expect("spawn winevent thread");
        }
    });
    SwitchSignal
}

fn install_hook(label: &str, desktop: &str) -> HWINEVENTHOOK {
    let hook = unsafe {
        SetWinEventHook(
            EVENT_SYSTEM_DESKTOPSWITCH,
            EVENT_SYSTEM_DESKTOPSWITCH,
            None,
            Some(on_win_event),
            0,
            0,
            WINEVENT_OUTOFCONTEXT,
        )
    };
    if hook.is_invalid() {
        log!(
            "winevent[{label}]: SetWinEventHook failed on '{desktop}': {}",
            windows::core::Error::from_thread()
        );
    } else {
        log!("winevent[{label}]: hook installed on desktop '{desktop}'");
    }
    hook
}

fn hook_thread(label: &'static str, follow: bool) {
    let mut attached = desktop::thread_desktop_name();
    HOOK_CONTEXT.with(|c| *c.borrow_mut() = (label, attached.clone()));
    let mut hook = install_hook(label, &attached);
    let mut _owned: Option<Desktop> = None;
    let mut msg = MSG::default();

    loop {
        unsafe {
            MsgWaitForMultipleObjects(None, false, 250, QS_ALLINPUT);
            // Out-of-context WinEvent callbacks are delivered while pumping.
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }

        if !follow {
            continue;
        }
        let Ok(input) = Desktop::open_input() else {
            continue;
        };
        if input.name == attached {
            continue;
        }
        if !hook.is_invalid() {
            unsafe {
                let _ = UnhookWinEvent(hook);
            }
        }
        match input.attach_current_thread() {
            Ok(()) => {
                log!(
                    "winevent[{label}]: hook thread moved '{attached}' -> '{}'",
                    input.name
                );
                attached = input.name.clone();
                _owned = Some(input);
            }
            Err(e) => log!(
                "winevent[{label}]: SetThreadDesktop('{}') failed: {e}",
                input.name
            ),
        }
        HOOK_CONTEXT.with(|c| *c.borrow_mut() = (label, attached.clone()));
        hook = install_hook(label, &attached);
    }
}

unsafe extern "system" fn on_win_event(
    _hook: HWINEVENTHOOK,
    event: u32,
    _hwnd: HWND,
    _id_object: i32,
    _id_child: i32,
    _event_thread: u32,
    _event_time: u32,
) {
    if event != EVENT_SYSTEM_DESKTOPSWITCH {
        return;
    }
    let shared = shared();
    let n = shared.count.fetch_add(1, Ordering::SeqCst) + 1;
    let input = match Desktop::open_input() {
        Ok(d) => d.name.clone(),
        Err(e) => format!("<not accessible: {e}>"),
    };
    let (label, attached) = HOOK_CONTEXT.with(|c| c.borrow().clone());
    log!(
        "winevent[{label}]: EVENT_SYSTEM_DESKTOPSWITCH #{n} received by hook on '{attached}'; input desktop now '{input}'"
    );
    unsafe {
        let _ = SetEvent(shared.event);
    }
}
