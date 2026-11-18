//! Just enough VT parsing to search ConPTY output for text in tests.
//!
//! ConPTY emits a rendered *screen*, not the child's byte stream: text is interleaved with cursor
//! moves, erase-line, title (OSC) and mode sequences, and runs of spaces may be replaced by
//! cursor-forward. A real host forwards the bytes untouched to a terminal emulator (xterm.js);
//! this stripper only exists so the demo can assert on `whoami` output.

pub fn strip(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\x1b' => match chars.next() {
                // CSI: parameter/intermediate bytes, then one final byte in 0x40..=0x7E.
                Some('[') => {
                    let mut final_byte = None;
                    for n in chars.by_ref() {
                        if ('\x40'..='\x7e').contains(&n) {
                            final_byte = Some(n);
                            break;
                        }
                    }
                    match final_byte {
                        // Cursor positioning usually means "next line" in practice.
                        Some('H' | 'f') => out.push('\n'),
                        // Cursor forward / erase characters stand in for spaces.
                        Some('C' | 'X') => out.push(' '),
                        _ => {}
                    }
                }
                // OSC (e.g. window title): terminated by BEL or ST (ESC \).
                Some(']') => {
                    while let Some(n) = chars.next() {
                        if n == '\x07' {
                            break;
                        }
                        if n == '\x1b' {
                            chars.next();
                            break;
                        }
                    }
                }
                // Two-character escapes (ESC 7, ESC =, ...).
                _ => {}
            },
            '\r' => {}
            '\n' | '\t' => out.push(c),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::strip;

    #[test]
    fn strips_csi_osc_and_maps_cursor_moves() {
        let raw = b"\x1b[?25l\x1b]0;title\x07nt authority\\system\x1b[K\r\n\x1b[3;1HC:\\>\x1b[5Cx";
        assert_eq!(strip(raw), "nt authority\\system\n\nC:\\> x");
    }
}
