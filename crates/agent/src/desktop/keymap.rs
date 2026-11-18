//! DOM `KeyboardEvent.code` → Windows scan code (set 1) and X11 keysym.
//!
//! Scan codes follow Chromium's `dom_code_data.inc` Windows column: `0xE0xx` marks an extended key
//! (sent with `KEYEVENTF_EXTENDEDKEY`). Physical codes make the remote layout decide the
//! character, exactly like a local keyboard. Keysyms are the unshifted symbol for a US layout; the
//! X11 side looks up the keycode that produces it.

/// (code, scan code, keysym)
const KEYS: &[(&str, u16, u32)] = &[
    ("Escape", 0x0001, 0xff1b),
    ("Digit1", 0x0002, 0x0031),
    ("Digit2", 0x0003, 0x0032),
    ("Digit3", 0x0004, 0x0033),
    ("Digit4", 0x0005, 0x0034),
    ("Digit5", 0x0006, 0x0035),
    ("Digit6", 0x0007, 0x0036),
    ("Digit7", 0x0008, 0x0037),
    ("Digit8", 0x0009, 0x0038),
    ("Digit9", 0x000a, 0x0039),
    ("Digit0", 0x000b, 0x0030),
    ("Minus", 0x000c, 0x002d),
    ("Equal", 0x000d, 0x003d),
    ("Backspace", 0x000e, 0xff08),
    ("Tab", 0x000f, 0xff09),
    ("KeyQ", 0x0010, 0x0071),
    ("KeyW", 0x0011, 0x0077),
    ("KeyE", 0x0012, 0x0065),
    ("KeyR", 0x0013, 0x0072),
    ("KeyT", 0x0014, 0x0074),
    ("KeyY", 0x0015, 0x0079),
    ("KeyU", 0x0016, 0x0075),
    ("KeyI", 0x0017, 0x0069),
    ("KeyO", 0x0018, 0x006f),
    ("KeyP", 0x0019, 0x0070),
    ("BracketLeft", 0x001a, 0x005b),
    ("BracketRight", 0x001b, 0x005d),
    ("Enter", 0x001c, 0xff0d),
    ("ControlLeft", 0x001d, 0xffe3),
    ("KeyA", 0x001e, 0x0061),
    ("KeyS", 0x001f, 0x0073),
    ("KeyD", 0x0020, 0x0064),
    ("KeyF", 0x0021, 0x0066),
    ("KeyG", 0x0022, 0x0067),
    ("KeyH", 0x0023, 0x0068),
    ("KeyJ", 0x0024, 0x006a),
    ("KeyK", 0x0025, 0x006b),
    ("KeyL", 0x0026, 0x006c),
    ("Semicolon", 0x0027, 0x003b),
    ("Quote", 0x0028, 0x0027),
    ("Backquote", 0x0029, 0x0060),
    ("ShiftLeft", 0x002a, 0xffe1),
    ("Backslash", 0x002b, 0x005c),
    ("KeyZ", 0x002c, 0x007a),
    ("KeyX", 0x002d, 0x0078),
    ("KeyC", 0x002e, 0x0063),
    ("KeyV", 0x002f, 0x0076),
    ("KeyB", 0x0030, 0x0062),
    ("KeyN", 0x0031, 0x006e),
    ("KeyM", 0x0032, 0x006d),
    ("Comma", 0x0033, 0x002c),
    ("Period", 0x0034, 0x002e),
    ("Slash", 0x0035, 0x002f),
    ("ShiftRight", 0x0036, 0xffe2),
    ("NumpadMultiply", 0x0037, 0xffaa),
    ("AltLeft", 0x0038, 0xffe9),
    ("Space", 0x0039, 0x0020),
    ("CapsLock", 0x003a, 0xffe5),
    ("F1", 0x003b, 0xffbe),
    ("F2", 0x003c, 0xffbf),
    ("F3", 0x003d, 0xffc0),
    ("F4", 0x003e, 0xffc1),
    ("F5", 0x003f, 0xffc2),
    ("F6", 0x0040, 0xffc3),
    ("F7", 0x0041, 0xffc4),
    ("F8", 0x0042, 0xffc5),
    ("F9", 0x0043, 0xffc6),
    ("F10", 0x0044, 0xffc7),
    ("Pause", 0x0045, 0xff13),
    ("ScrollLock", 0x0046, 0xff14),
    ("Numpad7", 0x0047, 0xffb7),
    ("Numpad8", 0x0048, 0xffb8),
    ("Numpad9", 0x0049, 0xffb9),
    ("NumpadSubtract", 0x004a, 0xffad),
    ("Numpad4", 0x004b, 0xffb4),
    ("Numpad5", 0x004c, 0xffb5),
    ("Numpad6", 0x004d, 0xffb6),
    ("NumpadAdd", 0x004e, 0xffab),
    ("Numpad1", 0x004f, 0xffb1),
    ("Numpad2", 0x0050, 0xffb2),
    ("Numpad3", 0x0051, 0xffb3),
    ("Numpad0", 0x0052, 0xffb0),
    ("NumpadDecimal", 0x0053, 0xffae),
    ("IntlBackslash", 0x0056, 0x003c),
    ("F11", 0x0057, 0xffc8),
    ("F12", 0x0058, 0xffc9),
    ("NumpadEqual", 0x0059, 0xffbd),
    ("F13", 0x0064, 0xffca),
    ("F14", 0x0065, 0xffcb),
    ("F15", 0x0066, 0xffcc),
    ("F16", 0x0067, 0xffcd),
    ("F17", 0x0068, 0xffce),
    ("F18", 0x0069, 0xffcf),
    ("F19", 0x006a, 0xffd0),
    ("F20", 0x006b, 0xffd1),
    ("F21", 0x006c, 0xffd2),
    ("F22", 0x006d, 0xffd3),
    ("F23", 0x006e, 0xffd4),
    ("KanaMode", 0x0070, 0xff2d),
    ("Lang2", 0x0071, 0xff27),
    ("Lang1", 0x0072, 0xff31),
    ("IntlRo", 0x0073, 0x005c),
    ("F24", 0x0076, 0xffd5),
    ("Convert", 0x0079, 0xff23),
    ("NonConvert", 0x007b, 0xff22),
    ("IntlYen", 0x007d, 0x00a5),
    ("NumpadComma", 0x007e, 0xffac),
    ("MediaTrackPrevious", 0xe010, 0x1008_ff16),
    ("MediaTrackNext", 0xe019, 0x1008_ff17),
    ("NumpadEnter", 0xe01c, 0xff8d),
    ("ControlRight", 0xe01d, 0xffe4),
    ("AudioVolumeMute", 0xe020, 0x1008_ff12),
    ("LaunchApp2", 0xe021, 0x1008_ff1d),
    ("MediaPlayPause", 0xe022, 0x1008_ff14),
    ("MediaStop", 0xe024, 0x1008_ff15),
    ("AudioVolumeDown", 0xe02e, 0x1008_ff11),
    ("AudioVolumeUp", 0xe030, 0x1008_ff13),
    ("BrowserHome", 0xe032, 0x1008_ff18),
    ("NumpadDivide", 0xe035, 0xffaf),
    ("PrintScreen", 0xe037, 0xff61),
    ("AltRight", 0xe038, 0xffea),
    ("NumLock", 0xe045, 0xff7f),
    ("Home", 0xe047, 0xff50),
    ("ArrowUp", 0xe048, 0xff52),
    ("PageUp", 0xe049, 0xff55),
    ("ArrowLeft", 0xe04b, 0xff51),
    ("ArrowRight", 0xe04d, 0xff53),
    ("End", 0xe04f, 0xff57),
    ("ArrowDown", 0xe050, 0xff54),
    ("PageDown", 0xe051, 0xff56),
    ("Insert", 0xe052, 0xff63),
    ("Delete", 0xe053, 0xffff),
    ("MetaLeft", 0xe05b, 0xffeb),
    ("MetaRight", 0xe05c, 0xffec),
    ("ContextMenu", 0xe05d, 0xff67),
    ("Power", 0xe05e, 0x1008_ff2a),
    ("Sleep", 0xe05f, 0x1008_ff2f),
    ("BrowserSearch", 0xe065, 0x1008_ff1b),
    ("BrowserFavorites", 0xe066, 0x1008_ff30),
    ("BrowserRefresh", 0xe067, 0x1008_ff29),
    ("BrowserStop", 0xe068, 0x1008_ff28),
    ("BrowserForward", 0xe069, 0x1008_ff27),
    ("BrowserBack", 0xe06a, 0x1008_ff26),
    ("LaunchApp1", 0xe06b, 0x1008_ff5d),
    ("LaunchMail", 0xe06c, 0x1008_ff19),
    ("MediaSelect", 0xe06d, 0x1008_ff32),
];

/// Legacy aliases some browsers still report.
fn canonical(code: &str) -> &str {
    match code {
        "OSLeft" => "MetaLeft",
        "OSRight" => "MetaRight",
        "VolumeMute" => "AudioVolumeMute",
        "VolumeDown" => "AudioVolumeDown",
        "VolumeUp" => "AudioVolumeUp",
        other => other,
    }
}

/// A Windows scan code: the low byte plus whether the `0xE0` prefix (extended key) is needed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(windows), allow(dead_code))]
pub struct ScanCode {
    pub code: u16,
    pub extended: bool,
}

#[cfg_attr(not(windows), allow(dead_code))]
pub fn scan_code(code: &str) -> Option<ScanCode> {
    let code = canonical(code);
    KEYS.iter()
        .find(|(c, _, _)| *c == code)
        .map(|&(_, sc, _)| ScanCode {
            code: sc & 0xff,
            extended: sc & 0xff00 == 0xe000,
        })
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn keysym(code: &str) -> Option<u32> {
    let code = canonical(code);
    KEYS.iter()
        .find(|(c, _, _)| *c == code)
        .map(|&(_, _, ks)| ks)
}

/// The X11 keysym that types one character: Latin-1 directly, everything else as a Unicode keysym.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn char_keysym(c: char) -> u32 {
    let cp = c as u32;
    match cp {
        0x20..=0x7e | 0xa0..=0xff => cp,
        0x0a | 0x0d => 0xff0d,
        0x09 => 0xff09,
        0x08 => 0xff08,
        _ => 0x0100_0000 | cp,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_codes_for_common_and_extended_keys() {
        assert_eq!(
            scan_code("KeyA"),
            Some(ScanCode {
                code: 0x1e,
                extended: false
            })
        );
        assert_eq!(
            scan_code("Enter"),
            Some(ScanCode {
                code: 0x1c,
                extended: false
            })
        );
        assert_eq!(
            scan_code("NumpadEnter"),
            Some(ScanCode {
                code: 0x1c,
                extended: true
            })
        );
        assert_eq!(
            scan_code("ArrowLeft"),
            Some(ScanCode {
                code: 0x4b,
                extended: true
            })
        );
        assert_eq!(
            scan_code("Numpad4"),
            Some(ScanCode {
                code: 0x4b,
                extended: false
            })
        );
        assert_eq!(
            scan_code("MetaLeft"),
            Some(ScanCode {
                code: 0x5b,
                extended: true
            })
        );
        assert_eq!(scan_code("OSLeft"), scan_code("MetaLeft"));
        assert_eq!(
            scan_code("Delete"),
            Some(ScanCode {
                code: 0x53,
                extended: true
            })
        );
        // NumLock is the extended variant of 0x45; Pause is the plain one.
        assert!(scan_code("NumLock").expect("numlock").extended);
        assert!(!scan_code("Pause").expect("pause").extended);
        assert_eq!(scan_code("Unidentified"), None);
        assert_eq!(scan_code(""), None);
    }

    #[test]
    fn every_code_is_unique_and_mapped_both_ways() {
        let mut codes = std::collections::HashSet::new();
        let mut scans = std::collections::HashSet::new();
        for (code, sc, ks) in KEYS {
            assert!(codes.insert(*code), "duplicate code {code}");
            assert!(scans.insert(*sc), "duplicate scan code {sc:#06x} ({code})");
            assert!(*ks != 0, "{code} has no keysym");
            assert!(*sc & 0xff00 == 0 || *sc & 0xff00 == 0xe000, "{code}");
        }
        for letter in 'A'..='Z' {
            let code = format!("Key{letter}");
            assert_eq!(
                keysym(&code),
                Some(letter.to_ascii_lowercase() as u32),
                "{code}"
            );
            assert!(scan_code(&code).is_some());
        }
        for digit in 0..=9 {
            assert_eq!(keysym(&format!("Digit{digit}")), Some(0x30 + digit));
        }
        for n in 1..=24 {
            assert!(scan_code(&format!("F{n}")).is_some(), "F{n}");
            assert_eq!(keysym(&format!("F{n}")), Some(0xffbe + n - 1), "F{n}");
        }
    }

    #[test]
    fn x11_keysyms() {
        assert_eq!(keysym("Escape"), Some(0xff1b));
        assert_eq!(keysym("ArrowUp"), Some(0xff52));
        assert_eq!(keysym("ControlLeft"), Some(0xffe3));
        assert_eq!(keysym("Numpad5"), Some(0xffb5));
        assert_eq!(keysym("Space"), Some(0x20));
        assert_eq!(keysym("AudioVolumeUp"), Some(0x1008_ff13));
        assert_eq!(char_keysym('a'), 0x61);
        assert_eq!(char_keysym('é'), 0xe9);
        assert_eq!(char_keysym('€'), 0x0100_20ac);
        assert_eq!(char_keysym('\n'), 0xff0d);
        for m in [
            "ShiftLeft",
            "ShiftRight",
            "ControlLeft",
            "ControlRight",
            "AltLeft",
            "AltRight",
            "MetaLeft",
            "MetaRight",
        ] {
            assert!(scan_code(m).is_some() && keysym(m).is_some(), "{m}");
        }
    }
}
