//! Keyboard and mouse injection with `SendInput` from a thread that follows the input desktop.
//!
//! Keys are physical scan codes (`KEYEVENTF_SCANCODE`, plus `KEYEVENTF_EXTENDEDKEY` for `0xE0`
//! keys) so the device's own layout produces the characters; `text` and unknown keys use
//! `KEYEVENTF_UNICODE`. The mouse moves in absolute `MOUSEEVENTF_VIRTUALDESK` coordinates across
//! the whole virtual screen. Ctrl+Alt+Del is not injectable; the service calls `SendSAS`.

use std::collections::BTreeSet;

use anyhow::{Result, bail};
use rustrmm_proto::desktop::MonitorInfo;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBD_EVENT_FLAGS, KEYBDINPUT,
    KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE, KEYEVENTF_UNICODE,
    MOUSE_EVENT_FLAGS, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN,
    MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE,
    MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL,
    MOUSEEVENTF_XDOWN, MOUSEEVENTF_XUP, MOUSEINPUT, SendInput, VIRTUAL_KEY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
};

use super::desktop::Follower;
use crate::desktop::engine::InputSink;
use crate::desktop::keymap;

const WHEEL_DELTA: f32 = 120.0;
const XBUTTON1: u32 = 1;
const XBUTTON2: u32 = 2;

/// Buttons: (DOM bit, down flag, up flag, mouseData).
const BUTTONS: [(u8, MOUSE_EVENT_FLAGS, MOUSE_EVENT_FLAGS, u32); 5] = [
    (1, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, 0),
    (2, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, 0),
    (4, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, 0),
    (8, MOUSEEVENTF_XDOWN, MOUSEEVENTF_XUP, XBUTTON1),
    (16, MOUSEEVENTF_XDOWN, MOUSEEVENTF_XUP, XBUTTON2),
];

pub struct WinInput {
    follower: Follower,
    buttons: u8,
    held: BTreeSet<String>,
    clipboard: Option<super::clipboard::Handle>,
}

impl WinInput {
    /// Must be created on the thread that injects (it binds that thread to the input desktop).
    pub fn new(clipboard: Option<super::clipboard::Handle>) -> Self {
        Self {
            follower: Follower::new(),
            buttons: 0,
            held: BTreeSet::new(),
            clipboard,
        }
    }

    fn follow(&mut self) {
        self.follower.follow(|| {});
    }
}

fn mouse_input(dx: i32, dy: i32, data: u32, flags: MOUSE_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: data,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn key_input(scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(0),
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn send(inputs: &[INPUT]) {
    if inputs.is_empty() {
        return;
    }
    // SAFETY: a slice of fully initialised INPUT structures and their size.
    let sent = unsafe { SendInput(inputs, size_of::<INPUT>() as i32) };
    if sent as usize != inputs.len() {
        tracing::debug!(
            sent,
            wanted = inputs.len(),
            error = %windows::core::Error::from_thread(),
            "SendInput was blocked (UIPI or secure desktop)"
        );
    }
}

/// Maps a virtual-desktop pixel to SendInput's 0..65535 absolute range.
pub fn normalize(v: i32, origin: i32, extent: i32) -> i32 {
    let span = i64::from((extent - 1).max(1));
    let offset = i64::from((v - origin).clamp(0, extent.max(1) - 1));
    ((offset * 65535 + span / 2) / span) as i32
}

fn unicode_inputs(text: &str) -> Vec<INPUT> {
    let mut inputs = Vec::new();
    for unit in text.encode_utf16() {
        let unit = if unit == u16::from(b'\n') {
            u16::from(b'\r')
        } else {
            unit
        };
        inputs.push(key_input(unit, KEYEVENTF_UNICODE));
        inputs.push(key_input(unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
    }
    inputs
}

impl InputSink for WinInput {
    fn mouse(&mut self, monitor: &MonitorInfo, x: i32, y: i32, buttons: u8, wheel: (f32, f32)) {
        self.follow();
        // SAFETY: plain metric queries.
        let (vx, vy, vw, vh) = unsafe {
            (
                GetSystemMetrics(SM_XVIRTUALSCREEN),
                GetSystemMetrics(SM_YVIRTUALSCREEN),
                GetSystemMetrics(SM_CXVIRTUALSCREEN),
                GetSystemMetrics(SM_CYVIRTUALSCREEN),
            )
        };
        let px = monitor.x + x.clamp(0, monitor.width.saturating_sub(1) as i32);
        let py = monitor.y + y.clamp(0, monitor.height.saturating_sub(1) as i32);
        let mut inputs = vec![mouse_input(
            normalize(px, vx, vw),
            normalize(py, vy, vh),
            0,
            MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
        )];
        for (bit, down, up, data) in BUTTONS {
            let was = self.buttons & bit != 0;
            let is = buttons & bit != 0;
            if was != is {
                inputs.push(mouse_input(0, 0, data, if is { down } else { up }));
            }
        }
        self.buttons = buttons;
        if wheel.1 != 0.0 {
            // DOM: positive y scrolls down; Windows: positive delta scrolls up.
            let delta = (-wheel.1 * WHEEL_DELTA).round() as i32;
            inputs.push(mouse_input(0, 0, delta as u32, MOUSEEVENTF_WHEEL));
        }
        if wheel.0 != 0.0 {
            let delta = (wheel.0 * WHEEL_DELTA).round() as i32;
            inputs.push(mouse_input(0, 0, delta as u32, MOUSEEVENTF_HWHEEL));
        }
        send(&inputs);
    }

    fn key(&mut self, code: &str, key: &str, down: bool) {
        self.follow();
        if let Some(sc) = keymap::scan_code(code) {
            let mut flags = KEYEVENTF_SCANCODE;
            if sc.extended {
                flags |= KEYEVENTF_EXTENDEDKEY;
            }
            if !down {
                flags |= KEYEVENTF_KEYUP;
            }
            if down {
                self.held.insert(code.to_string());
            } else {
                self.held.remove(code);
            }
            send(&[key_input(sc.code, flags)]);
            return;
        }
        // Unknown physical key (on-screen keyboards): type the character itself.
        let mut chars = key.chars();
        if let (Some(c), None) = (chars.next(), chars.next())
            && !c.is_control()
        {
            let mut buf = [0u16; 2];
            let flags = if down {
                KEYEVENTF_UNICODE
            } else {
                KEYEVENTF_UNICODE | KEYEVENTF_KEYUP
            };
            let inputs: Vec<INPUT> = c
                .encode_utf16(&mut buf)
                .iter()
                .map(|&u| key_input(u, flags))
                .collect();
            send(&inputs);
        }
    }

    fn text(&mut self, text: &str) {
        self.follow();
        for chunk in unicode_inputs(text).chunks(512) {
            send(chunk);
        }
    }

    fn set_clipboard(&mut self, text: &str) {
        if let Some(clipboard) = &self.clipboard {
            clipboard.set(text);
        }
    }

    fn cad(&mut self) -> Result<()> {
        bail!("Ctrl+Alt+Del is sent by the agent service")
    }

    fn release_all(&mut self) {
        let held: Vec<String> = std::mem::take(&mut self.held).into_iter().collect();
        for code in held {
            if let Some(sc) = keymap::scan_code(&code) {
                let mut flags = KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP;
                if sc.extended {
                    flags |= KEYEVENTF_EXTENDEDKEY;
                }
                send(&[key_input(sc.code, flags)]);
            }
        }
        let mut inputs = Vec::new();
        for (bit, _, up, data) in BUTTONS {
            if self.buttons & bit != 0 {
                inputs.push(mouse_input(0, 0, data, up));
            }
        }
        self.buttons = 0;
        send(&inputs);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absolute_coordinates_span_the_virtual_screen() {
        // Two 2560-wide monitors, the secondary on the left (virtual origin -2560).
        assert_eq!(normalize(-2560, -2560, 5120), 0);
        assert_eq!(normalize(2559, -2560, 5120), 65535);
        assert_eq!(normalize(0, -2560, 5120), 32774);
        // Out-of-range values are clamped.
        assert_eq!(normalize(-9999, -2560, 5120), 0);
        assert_eq!(normalize(9999, -2560, 5120), 65535);
    }

    #[test]
    fn unicode_text_becomes_key_pairs() {
        let inputs = unicode_inputs("a€\n");
        assert_eq!(inputs.len(), 6);
        // SAFETY: reading the keyboard variant of inputs built as keyboard events.
        let first = unsafe { inputs[0].Anonymous.ki };
        assert_eq!(first.wScan, u16::from(b'a'));
        assert_eq!(first.dwFlags, KEYEVENTF_UNICODE);
        let enter = unsafe { inputs[4].Anonymous.ki };
        assert_eq!(enter.wScan, u16::from(b'\r'));
    }
}
