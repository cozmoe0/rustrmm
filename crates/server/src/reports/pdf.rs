//! PDF rendering of a [`Report`] with `pdf-writer` (pure Rust, no font files): the standard
//! Helvetica fonts with WinAnsi encoding, a small layout engine (title block, KPI tiles, tables
//! with repeated headers, bar/line/share charts, text and lists), the MSP and client logos (PNG)
//! and the accent colour from the branding settings.

use std::io::{Read, Write};

use pdf_writer::{Content, Filter, Finish, Name, Pdf, Rect, Ref, Str, TextStr};
use serde_json::Value;

use super::{Column, Kpi, Report, Section};

const PAGE_W: f32 = 595.28;
const PAGE_H: f32 = 841.89;
const MARGIN: f32 = 40.0;
const TOP: f32 = PAGE_H - 78.0;
const BOTTOM: f32 = 48.0;
const MAX_TABLE_ROWS: usize = 2000;

/// Brand inputs for the template.
#[derive(Debug, Clone, Default)]
pub struct Brand {
    pub product_name: String,
    pub accent: (u8, u8, u8),
    pub msp_logo_png: Option<Vec<u8>>,
    pub client_logo_png: Option<Vec<u8>>,
}

// ------------------------------------------------------------------ fonts

#[derive(Clone, Copy, PartialEq)]
enum Font {
    Regular,
    Bold,
}

impl Font {
    fn name(self) -> Name<'static> {
        match self {
            Font::Regular => Name(b"F1"),
            Font::Bold => Name(b"F2"),
        }
    }
}

/// Advance widths (1/1000 em) of Helvetica for ASCII 32..=126.
const HELVETICA: [u16; 95] = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
    556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
    611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
    667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
    222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

/// Advance widths of Helvetica-Bold for ASCII 32..=126.
const HELVETICA_BOLD: [u16; 95] = [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
    556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667,
    611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
    667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556,
    278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

/// Encodes text for WinAnsiEncoding (unsupported characters become `?`).
fn winansi(s: &str) -> Vec<u8> {
    s.chars()
        .filter(|c| !c.is_control())
        .map(|c| match c {
            ' '..='~' => c as u8,
            '\u{a0}'..='\u{ff}' => c as u32 as u8,
            '€' => 0x80,
            '‚' => 0x82,
            '„' => 0x84,
            '…' => 0x85,
            '‘' => 0x91,
            '’' => 0x92,
            '“' => 0x93,
            '”' => 0x94,
            '•' => 0x95,
            '–' => 0x96,
            '—' => 0x97,
            '™' => 0x99,
            '→' => b'>',
            _ => b'?',
        })
        .collect()
}

fn char_width(font: Font, byte: u8) -> f32 {
    let table = match font {
        Font::Regular => &HELVETICA,
        Font::Bold => &HELVETICA_BOLD,
    };
    match byte {
        32..=126 => table[(byte - 32) as usize] as f32,
        0x85 => 1000.0,
        0x95 => 350.0,
        0x96 => 556.0,
        0x97 => 1000.0,
        0x91 | 0x92 => 222.0,
        0x93 | 0x94 => 333.0,
        _ => 556.0,
    }
}

fn text_width(font: Font, size: f32, s: &str) -> f32 {
    winansi(s).iter().map(|b| char_width(font, *b)).sum::<f32>() * size / 1000.0
}

/// Truncates to `max` points with an ellipsis.
fn fit(font: Font, size: f32, s: &str, max: f32) -> String {
    if text_width(font, size, s) <= max {
        return s.to_string();
    }
    let ellipsis = text_width(font, size, "…");
    let mut out = String::new();
    let mut width = 0.0;
    for c in s.chars() {
        let w = text_width(font, size, &c.to_string());
        if width + w + ellipsis > max {
            break;
        }
        width += w;
        out.push(c);
    }
    out.push('…');
    out
}

/// Greedy word wrap.
fn wrap(font: Font, size: f32, s: &str, max: f32) -> Vec<String> {
    let mut lines = Vec::new();
    for paragraph in s.split('\n') {
        let mut line = String::new();
        for word in paragraph.split_whitespace() {
            let candidate = if line.is_empty() {
                word.to_string()
            } else {
                format!("{line} {word}")
            };
            if text_width(font, size, &candidate) <= max || line.is_empty() {
                line = if text_width(font, size, &candidate) > max {
                    fit(font, size, &candidate, max)
                } else {
                    candidate
                };
            } else {
                lines.push(std::mem::take(&mut line));
                line = fit(font, size, word, max);
            }
        }
        lines.push(line);
    }
    lines
}

// ------------------------------------------------------------------ layout

struct Writer {
    pages: Vec<Content>,
    y: f32,
    accent: (f32, f32, f32),
    title: String,
    has_msp_logo: bool,
    has_client_logo: bool,
    msp_logo_size: (f32, f32),
    client_logo_size: (f32, f32),
    product: String,
}

fn rgb(c: (u8, u8, u8)) -> (f32, f32, f32) {
    (c.0 as f32 / 255.0, c.1 as f32 / 255.0, c.2 as f32 / 255.0)
}

const INK: (f32, f32, f32) = (0.12, 0.13, 0.15);
const MUTED: (f32, f32, f32) = (0.42, 0.44, 0.48);
const RULE: (f32, f32, f32) = (0.85, 0.86, 0.88);
const ZEBRA: (f32, f32, f32) = (0.965, 0.968, 0.975);
const GOOD: (f32, f32, f32) = (0.18, 0.62, 0.36);
const WARN: (f32, f32, f32) = (0.91, 0.62, 0.12);
const BAD: (f32, f32, f32) = (0.82, 0.24, 0.22);

impl Writer {
    fn page(&mut self) -> &mut Content {
        self.pages.last_mut().expect("a page exists")
    }

    fn new_page(&mut self) {
        let mut c = Content::new();
        let (r, g, b) = self.accent;
        // Accent band and header.
        c.set_fill_rgb(r, g, b);
        c.rect(0.0, PAGE_H - 8.0, PAGE_W, 8.0);
        c.fill_nonzero();
        let header_y = PAGE_H - 48.0;
        if self.has_msp_logo {
            let (w, h) = self.msp_logo_size;
            c.save_state();
            c.transform([w, 0.0, 0.0, h, MARGIN, header_y - 6.0]);
            c.x_object(Name(b"Im1"));
            c.restore_state();
        } else {
            text_at(
                &mut c,
                Font::Bold,
                13.0,
                MARGIN,
                header_y,
                self.accent,
                &self.product,
            );
        }
        if self.has_client_logo {
            let (w, h) = self.client_logo_size;
            c.save_state();
            c.transform([w, 0.0, 0.0, h, PAGE_W - MARGIN - w, header_y - 6.0]);
            c.x_object(Name(b"Im2"));
            c.restore_state();
        }
        let title = fit(Font::Regular, 8.0, &self.title, 250.0);
        let tw = text_width(Font::Regular, 8.0, &title);
        let tx = if self.has_client_logo {
            PAGE_W - MARGIN - self.client_logo_size.0 - 12.0 - tw
        } else {
            PAGE_W - MARGIN - tw
        };
        text_at(
            &mut c,
            Font::Regular,
            8.0,
            tx,
            header_y + 2.0,
            MUTED,
            &title,
        );
        c.set_stroke_rgb(RULE.0, RULE.1, RULE.2);
        c.set_line_width(0.6);
        c.move_to(MARGIN, PAGE_H - 62.0);
        c.line_to(PAGE_W - MARGIN, PAGE_H - 62.0);
        c.stroke();
        self.pages.push(c);
        self.y = TOP;
    }

    fn ensure(&mut self, height: f32) {
        if self.y - height < BOTTOM {
            self.new_page();
        }
    }

    fn gap(&mut self, h: f32) {
        self.y -= h;
    }

    fn section_title(&mut self, title: &str) {
        if title.is_empty() {
            return;
        }
        self.ensure(40.0);
        self.gap(18.0);
        let accent = self.accent;
        let y = self.y;
        let c = self.page();
        text_at(c, Font::Bold, 12.5, MARGIN, y, accent, title);
        self.gap(10.0);
    }

    fn paragraph(
        &mut self,
        font: Font,
        size: f32,
        color: (f32, f32, f32),
        text: &str,
        indent: f32,
    ) {
        let lines = wrap(font, size, text, PAGE_W - 2.0 * MARGIN - indent);
        let leading = size * 1.35;
        for line in lines {
            self.ensure(leading);
            self.gap(leading);
            let y = self.y;
            text_at(self.page(), font, size, MARGIN + indent, y, color, &line);
        }
    }

    fn kpis(&mut self, items: &[Kpi]) {
        let per_row = 4usize;
        let gap = 8.0;
        let width = (PAGE_W - 2.0 * MARGIN - gap * (per_row as f32 - 1.0)) / per_row as f32;
        let height = 46.0;
        for row in items.chunks(per_row) {
            self.ensure(height + 8.0);
            self.gap(height + 6.0);
            let y = self.y;
            for (i, kpi) in row.iter().enumerate() {
                let x = MARGIN + i as f32 * (width + gap);
                let tone = match kpi.tone.as_deref() {
                    Some("good") => GOOD,
                    Some("warn") => WARN,
                    Some("bad") => BAD,
                    _ => self.accent,
                };
                let c = self.page();
                c.set_fill_rgb(ZEBRA.0, ZEBRA.1, ZEBRA.2);
                c.rect(x, y, width, height);
                c.fill_nonzero();
                c.set_fill_rgb(tone.0, tone.1, tone.2);
                c.rect(x, y, 3.0, height);
                c.fill_nonzero();
                let label = fit(Font::Regular, 7.5, &kpi.label.to_uppercase(), width - 14.0);
                text_at(
                    c,
                    Font::Regular,
                    7.5,
                    x + 9.0,
                    y + height - 13.0,
                    MUTED,
                    &label,
                );
                let mut value = cell_text(&kpi.value, None);
                if let Some(unit) = &kpi.unit {
                    value = format!("{value} {unit}");
                }
                let value = fit(Font::Bold, 15.0, &value, width - 14.0);
                text_at(c, Font::Bold, 15.0, x + 9.0, y + 12.0, INK, &value);
            }
        }
    }

    fn table(&mut self, columns: &[Column], rows: &[Vec<Value>], total: Option<usize>) {
        if columns.is_empty() {
            return;
        }
        let size = 7.5;
        let row_h = 12.5;
        let available = PAGE_W - 2.0 * MARGIN;
        // Natural widths from the header and a sample of rows.
        let mut natural: Vec<f32> = columns
            .iter()
            .map(|c| text_width(Font::Bold, size, &c.label) + 8.0)
            .collect();
        for row in rows.iter().take(60) {
            for (i, col) in columns.iter().enumerate() {
                let text = cell_text(row.get(i).unwrap_or(&Value::Null), col.format.as_deref());
                natural[i] =
                    natural[i].max(text_width(Font::Regular, size, &text).min(220.0) + 8.0);
            }
        }
        let sum: f32 = natural.iter().sum();
        let widths: Vec<f32> = if sum <= available {
            let extra = (available - sum) / natural.len() as f32;
            natural.iter().map(|w| w + extra).collect()
        } else {
            // Shrink wide columns first, keeping a floor.
            let floor = (available / natural.len() as f32).min(48.0);
            let flexible: f32 = natural.iter().map(|w| (w - floor).max(0.0)).sum();
            let excess = sum - available;
            natural
                .iter()
                .map(|w| {
                    let room = (w - floor).max(0.0);
                    if flexible > 0.0 {
                        w - excess * room / flexible
                    } else {
                        available / natural.len() as f32
                    }
                })
                .collect()
        };
        let header = |w: &mut Writer| {
            w.ensure(row_h * 2.0);
            w.gap(row_h + 2.0);
            let y = w.y;
            let c = w.page();
            c.set_fill_rgb(0.90, 0.91, 0.93);
            c.rect(MARGIN, y - 3.5, available, row_h + 1.0);
            c.fill_nonzero();
            let mut x = MARGIN;
            for (col, width) in columns.iter().zip(&widths) {
                let label = fit(Font::Bold, size, &col.label, width - 6.0);
                let tx = if col.align.as_deref() == Some("right") {
                    x + width - 3.0 - text_width(Font::Bold, size, &label)
                } else {
                    x + 3.0
                };
                text_at(c, Font::Bold, size, tx, y, INK, &label);
                x += width;
            }
        };
        header(self);
        for (n, row) in rows.iter().take(MAX_TABLE_ROWS).enumerate() {
            if self.y - row_h < BOTTOM {
                self.new_page();
                header(self);
            }
            self.gap(row_h);
            let y = self.y;
            let c = self.page();
            if n % 2 == 1 {
                c.set_fill_rgb(ZEBRA.0, ZEBRA.1, ZEBRA.2);
                c.rect(MARGIN, y - 3.5, available, row_h);
                c.fill_nonzero();
            }
            let mut x = MARGIN;
            for (i, (col, width)) in columns.iter().zip(&widths).enumerate() {
                let text = cell_text(row.get(i).unwrap_or(&Value::Null), col.format.as_deref());
                let text = fit(Font::Regular, size, &text, width - 6.0);
                let tx = if col.align.as_deref() == Some("right") {
                    x + width - 3.0 - text_width(Font::Regular, size, &text)
                } else {
                    x + 3.0
                };
                text_at(c, Font::Regular, size, tx, y, INK, &text);
                x += width;
            }
        }
        let shown = rows.len().min(MAX_TABLE_ROWS);
        let total = total.unwrap_or(rows.len());
        if rows.is_empty() {
            self.paragraph(Font::Regular, 8.5, MUTED, "No data for this period.", 3.0);
        } else if total > shown {
            self.paragraph(
                Font::Regular,
                7.5,
                MUTED,
                &format!("Showing {shown} of {total} rows; export CSV for the full list."),
                3.0,
            );
        }
    }

    fn chart(
        &mut self,
        chart: &str,
        labels: &[String],
        series: &[super::Series],
        unit: Option<&str>,
    ) {
        if labels.is_empty() || series.is_empty() {
            self.paragraph(Font::Regular, 8.5, MUTED, "No data for this period.", 3.0);
            return;
        }
        let palette = [
            self.accent,
            (0.20, 0.45, 0.75),
            (0.35, 0.65, 0.45),
            (0.60, 0.40, 0.70),
            (0.85, 0.55, 0.20),
            (0.45, 0.50, 0.55),
        ];
        if chart == "donut" {
            // A share bar with a legend (readable in print).
            let values: Vec<f64> = series[0].values.iter().map(|v| v.max(0.0)).collect();
            let total: f64 = values.iter().sum();
            self.ensure(30.0 + 13.0 * labels.len() as f32);
            self.gap(22.0);
            let y = self.y;
            let width = PAGE_W - 2.0 * MARGIN;
            let mut x = MARGIN;
            for (i, v) in values.iter().enumerate() {
                let w = if total > 0.0 {
                    (*v / total) as f32 * width
                } else {
                    0.0
                };
                let col = palette[i % palette.len()];
                let c = self.page();
                c.set_fill_rgb(col.0, col.1, col.2);
                c.rect(x, y, w, 14.0);
                c.fill_nonzero();
                x += w;
            }
            for (i, (label, v)) in labels.iter().zip(&values).enumerate() {
                self.gap(13.0);
                let y = self.y;
                let col = palette[i % palette.len()];
                let pct = if total > 0.0 { v * 100.0 / total } else { 0.0 };
                let c = self.page();
                c.set_fill_rgb(col.0, col.1, col.2);
                c.rect(MARGIN, y - 1.0, 8.0, 8.0);
                c.fill_nonzero();
                text_at(
                    c,
                    Font::Regular,
                    8.0,
                    MARGIN + 14.0,
                    y,
                    INK,
                    &format!("{label}: {} ({pct:.0}%)", number(*v)),
                );
            }
            return;
        }
        let height = 120.0;
        let label_h = 14.0;
        self.ensure(height + label_h + 30.0);
        self.gap(height + 6.0);
        let base = self.y;
        let left = MARGIN + 34.0;
        let width = PAGE_W - MARGIN - left;
        let max = series
            .iter()
            .flat_map(|s| s.values.iter().copied())
            .fold(0.0f64, f64::max)
            .max(1.0);
        let max = nice_max(max);
        {
            let c = self.page();
            c.set_stroke_rgb(RULE.0, RULE.1, RULE.2);
            c.set_line_width(0.5);
            for i in 0..=4 {
                let gy = base + height * i as f32 / 4.0;
                c.move_to(left, gy);
                c.line_to(left + width, gy);
                c.stroke();
                let v = max * i as f64 / 4.0;
                let t = number(v);
                text_at(
                    c,
                    Font::Regular,
                    6.5,
                    left - 4.0 - text_width(Font::Regular, 6.5, &t),
                    gy - 2.0,
                    MUTED,
                    &t,
                );
            }
        }
        let n = labels.len();
        let slot = width / n as f32;
        if chart == "line" {
            for (si, s) in series.iter().enumerate() {
                let col = palette[si % palette.len()];
                let c = self.page();
                c.set_stroke_rgb(col.0, col.1, col.2);
                c.set_line_width(1.4);
                for (i, v) in s.values.iter().enumerate().take(n) {
                    let x = left + slot * (i as f32 + 0.5);
                    let y = base + (v / max) as f32 * height;
                    if i == 0 {
                        c.move_to(x, y);
                    } else {
                        c.line_to(x, y);
                    }
                }
                c.stroke();
            }
        } else {
            let groups = series.len().max(1) as f32;
            let bar = (slot * 0.7 / groups).min(28.0);
            for (si, s) in series.iter().enumerate() {
                let col = palette[si % palette.len()];
                let c = self.page();
                c.set_fill_rgb(col.0, col.1, col.2);
                for (i, v) in s.values.iter().enumerate().take(n) {
                    let x = left + slot * i as f32 + (slot - bar * groups) / 2.0 + bar * si as f32;
                    let h = (v.max(0.0) / max) as f32 * height;
                    c.rect(x, base, bar, h);
                }
                c.fill_nonzero();
            }
        }
        // X labels (thinned when crowded).
        let step = (n as f32 / (width / 46.0)).ceil().max(1.0) as usize;
        for (i, label) in labels.iter().enumerate() {
            if i % step != 0 {
                continue;
            }
            let t = fit(Font::Regular, 6.5, label, slot * step as f32 - 2.0);
            let x = left + slot * (i as f32 + 0.5) - text_width(Font::Regular, 6.5, &t) / 2.0;
            text_at(self.page(), Font::Regular, 6.5, x, base - 10.0, MUTED, &t);
        }
        self.gap(label_h);
        if series.len() > 1 || unit.is_some() {
            self.gap(10.0);
            let y = self.y;
            let mut x = left;
            for (si, s) in series.iter().enumerate() {
                let col = palette[si % palette.len()];
                let name = match unit {
                    Some(u) if series.len() == 1 => format!("{} ({u})", s.name),
                    _ => s.name.clone(),
                };
                let c = self.page();
                c.set_fill_rgb(col.0, col.1, col.2);
                c.rect(x, y - 1.0, 8.0, 8.0);
                c.fill_nonzero();
                text_at(c, Font::Regular, 7.5, x + 11.0, y, INK, &name);
                x += 24.0 + text_width(Font::Regular, 7.5, &name);
            }
        }
    }
}

fn nice_max(v: f64) -> f64 {
    let magnitude = 10f64.powf(v.log10().floor());
    let n = v / magnitude;
    let nice = if n <= 1.0 {
        1.0
    } else if n <= 2.0 {
        2.0
    } else if n <= 5.0 {
        5.0
    } else {
        10.0
    };
    nice * magnitude
}

fn number(v: f64) -> String {
    if (v - v.round()).abs() < 1e-9 {
        format!("{}", v.round() as i64)
    } else {
        format!("{v:.1}")
    }
}

fn text_at(
    c: &mut Content,
    font: Font,
    size: f32,
    x: f32,
    y: f32,
    color: (f32, f32, f32),
    text: &str,
) {
    c.set_fill_rgb(color.0, color.1, color.2);
    c.begin_text();
    c.set_font(font.name(), size);
    c.next_line(x, y);
    c.show(Str(&winansi(text)));
    c.end_text();
}

/// Display text of a table cell or KPI value.
pub fn cell_text(v: &Value, format: Option<&str>) -> String {
    match v {
        Value::Null => "—".into(),
        Value::Bool(b) => if *b { "Yes" } else { "No" }.into(),
        Value::Number(n) => {
            let f = n.as_f64().unwrap_or(0.0);
            match format {
                Some("percent") => format!("{f:.1}%"),
                Some("bytes") => bytes(f),
                Some("duration") => duration_minutes(f),
                _ => {
                    if n.is_i64() || n.is_u64() {
                        n.to_string()
                    } else {
                        format!("{f:.1}")
                    }
                }
            }
        }
        Value::String(s) => match format {
            Some("datetime") => s
                .parse::<chrono::DateTime<chrono::Utc>>()
                .map(|t| t.format("%Y-%m-%d %H:%M").to_string())
                .unwrap_or_else(|_| s.clone()),
            Some("date") => s.get(..10).unwrap_or(s).to_string(),
            _ => s.clone(),
        },
        other => other.to_string(),
    }
}

fn bytes(f: f64) -> String {
    let units = ["B", "KB", "MB", "GB", "TB"];
    let mut v = f;
    let mut i = 0;
    while v >= 1024.0 && i < units.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{v:.0} {}", units[i])
    } else {
        format!("{v:.1} {}", units[i])
    }
}

fn duration_minutes(m: f64) -> String {
    if m < 60.0 {
        format!("{m:.0} min")
    } else if m < 60.0 * 48.0 {
        format!("{:.1} h", m / 60.0)
    } else {
        format!("{:.1} d", m / 1440.0)
    }
}

// ------------------------------------------------------------------ PNG logos

/// An image ready for embedding: zlib-compressed samples plus an optional alpha mask.
struct Image {
    width: u32,
    height: u32,
    gray: bool,
    data: Vec<u8>,
    /// Whether `data` still carries PNG row filters (predictor 15).
    png_predictor: bool,
    alpha: Option<Vec<u8>>,
}

fn paeth(a: u8, b: u8, c: u8) -> u8 {
    let p = a as i16 + b as i16 - c as i16;
    let (pa, pb, pc) = (
        (p - a as i16).abs(),
        (p - b as i16).abs(),
        (p - c as i16).abs(),
    );
    if pa <= pb && pa <= pc {
        a
    } else if pb <= pc {
        b
    } else {
        c
    }
}

fn unfilter(raw: &[u8], width: usize, height: usize, bpp: usize) -> Option<Vec<u8>> {
    let stride = width * bpp;
    if raw.len() < (stride + 1) * height {
        return None;
    }
    let mut out = vec![0u8; stride * height];
    for y in 0..height {
        let filter = raw[y * (stride + 1)];
        let line = &raw[y * (stride + 1) + 1..(y + 1) * (stride + 1)];
        for x in 0..stride {
            let a = if x >= bpp {
                out[y * stride + x - bpp]
            } else {
                0
            };
            let b = if y > 0 { out[(y - 1) * stride + x] } else { 0 };
            let c = if x >= bpp && y > 0 {
                out[(y - 1) * stride + x - bpp]
            } else {
                0
            };
            let v = line[x];
            out[y * stride + x] = match filter {
                0 => v,
                1 => v.wrapping_add(a),
                2 => v.wrapping_add(b),
                3 => v.wrapping_add(((a as u16 + b as u16) / 2) as u8),
                4 => v.wrapping_add(paeth(a, b, c)),
                _ => return None,
            };
        }
    }
    Some(out)
}

fn deflate(data: &[u8]) -> Option<Vec<u8>> {
    let mut e = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    e.write_all(data).ok()?;
    e.finish().ok()
}

fn decode_png(png: &[u8]) -> Option<Image> {
    if !png.starts_with(b"\x89PNG\r\n\x1a\n") {
        return None;
    }
    let mut pos = 8;
    let (mut width, mut height, mut depth, mut color, mut interlace) = (0u32, 0u32, 0u8, 0u8, 0u8);
    let mut idat = Vec::new();
    let mut palette: Vec<u8> = Vec::new();
    let mut trns: Vec<u8> = Vec::new();
    while pos + 8 <= png.len() {
        let len = u32::from_be_bytes(png[pos..pos + 4].try_into().ok()?) as usize;
        let kind = &png[pos + 4..pos + 8];
        let data = png.get(pos + 8..pos + 8 + len)?;
        match kind {
            b"IHDR" if len >= 13 => {
                width = u32::from_be_bytes(data[0..4].try_into().ok()?);
                height = u32::from_be_bytes(data[4..8].try_into().ok()?);
                depth = data[8];
                color = data[9];
                interlace = data[12];
            }
            b"PLTE" => palette = data.to_vec(),
            b"tRNS" => trns = data.to_vec(),
            b"IDAT" => idat.extend_from_slice(data),
            b"IEND" => break,
            _ => {}
        }
        pos += 12 + len;
    }
    if width == 0 || height == 0 || width > 4096 || height > 4096 || depth != 8 || interlace != 0 {
        return None;
    }
    let (w, h) = (width as usize, height as usize);
    match color {
        0 | 2 => Some(Image {
            width,
            height,
            gray: color == 0,
            data: idat,
            png_predictor: true,
            alpha: None,
        }),
        3 | 4 | 6 => {
            let mut raw = Vec::new();
            flate2::read::ZlibDecoder::new(&idat[..])
                .take(64 * 1024 * 1024)
                .read_to_end(&mut raw)
                .ok()?;
            let bpp = match color {
                3 => 1,
                4 => 2,
                _ => 4,
            };
            let pixels = unfilter(&raw, w, h, bpp)?;
            let mut rgb = Vec::with_capacity(w * h * 3);
            let mut alpha = Vec::with_capacity(w * h);
            let mut gray = Vec::with_capacity(w * h);
            for px in pixels.chunks(bpp) {
                match color {
                    3 => {
                        let i = px[0] as usize;
                        let c = palette.get(i * 3..i * 3 + 3)?;
                        rgb.extend_from_slice(c);
                        alpha.push(trns.get(i).copied().unwrap_or(255));
                    }
                    4 => {
                        gray.push(px[0]);
                        alpha.push(px[1]);
                    }
                    _ => {
                        rgb.extend_from_slice(&px[..3]);
                        alpha.push(px[3]);
                    }
                }
            }
            let has_alpha = alpha.iter().any(|a| *a != 255);
            Some(Image {
                width,
                height,
                gray: color == 4,
                data: deflate(if color == 4 { &gray } else { &rgb })?,
                png_predictor: false,
                alpha: if has_alpha {
                    Some(deflate(&alpha)?)
                } else {
                    None
                },
            })
        }
        _ => None,
    }
}

fn logo_size(img: &Image, max_h: f32, max_w: f32) -> (f32, f32) {
    let ratio = img.width as f32 / img.height as f32;
    let mut h = max_h;
    let mut w = h * ratio;
    if w > max_w {
        w = max_w;
        h = w / ratio;
    }
    (w, h)
}

// ------------------------------------------------------------------ document

/// Renders the report to PDF bytes.
pub fn render(report: &Report, brand: &Brand) -> Vec<u8> {
    let msp = brand.msp_logo_png.as_deref().and_then(decode_png);
    let client = brand.client_logo_png.as_deref().and_then(decode_png);
    let mut w = Writer {
        pages: Vec::new(),
        y: TOP,
        accent: rgb(brand.accent),
        title: report.title.clone(),
        has_msp_logo: msp.is_some(),
        has_client_logo: client.is_some(),
        msp_logo_size: msp
            .as_ref()
            .map(|i| logo_size(i, 26.0, 150.0))
            .unwrap_or_default(),
        client_logo_size: client
            .as_ref()
            .map(|i| logo_size(i, 26.0, 120.0))
            .unwrap_or_default(),
        product: if brand.product_name.is_empty() {
            "RustRMM".into()
        } else {
            brand.product_name.clone()
        },
    };
    w.new_page();

    // Title block.
    w.gap(14.0);
    let y = w.y;
    text_at(
        w.page(),
        Font::Bold,
        20.0,
        MARGIN,
        y,
        INK,
        &fit(Font::Bold, 20.0, &report.title, PAGE_W - 2.0 * MARGIN),
    );
    if let Some(sub) = &report.subtitle {
        w.paragraph(Font::Regular, 10.0, MUTED, sub, 0.0);
    }
    w.paragraph(
        Font::Regular,
        8.0,
        MUTED,
        &format!(
            "Period {} to {} · generated {}",
            report.period.from.format("%Y-%m-%d"),
            report.period.to.format("%Y-%m-%d"),
            report.generated_at.format("%Y-%m-%d %H:%M UTC")
        ),
        0.0,
    );

    for section in &report.sections {
        match section {
            Section::Kpis { title, items } => {
                w.section_title(title);
                w.kpis(items);
            }
            Section::Table {
                title,
                columns,
                rows,
                total_rows,
            } => {
                w.section_title(title);
                w.table(columns, rows, *total_rows);
            }
            Section::Chart {
                title,
                chart,
                labels,
                series,
                unit,
            } => {
                w.section_title(title);
                w.chart(chart, labels, series, unit.as_deref());
            }
            Section::Text { title, body } => {
                w.section_title(title);
                w.gap(2.0);
                w.paragraph(Font::Regular, 9.5, INK, body, 0.0);
            }
            Section::List { title, items } => {
                w.section_title(title);
                w.gap(2.0);
                for item in items {
                    w.ensure(14.0);
                    let y = w.y - 9.5 * 1.35;
                    let accent = w.accent;
                    let c = w.page();
                    c.set_fill_rgb(accent.0, accent.1, accent.2);
                    c.rect(MARGIN + 2.0, y + 2.0, 3.5, 3.5);
                    c.fill_nonzero();
                    w.paragraph(Font::Regular, 9.5, INK, item, 12.0);
                    w.gap(2.0);
                }
            }
        }
    }

    // Footers with page numbers.
    let total = w.pages.len();
    let product = w.product.clone();
    for (i, page) in w.pages.iter_mut().enumerate() {
        let left = format!("{product} · {}", report.generated_at.format("%Y-%m-%d"));
        text_at(page, Font::Regular, 7.0, MARGIN, 26.0, MUTED, &left);
        let right = format!("Page {} of {total}", i + 1);
        let rw = text_width(Font::Regular, 7.0, &right);
        text_at(
            page,
            Font::Regular,
            7.0,
            PAGE_W - MARGIN - rw,
            26.0,
            MUTED,
            &right,
        );
    }

    // Assemble.
    let mut pdf = Pdf::new();
    let catalog = Ref::new(1);
    let tree = Ref::new(2);
    let regular = Ref::new(3);
    let bold = Ref::new(4);
    let info = Ref::new(5);
    let mut next = 6;
    let mut alloc = || {
        let r = Ref::new(next);
        next += 1;
        r
    };
    let images: Vec<(Name<'static>, Ref, Option<Ref>, &Image)> = [
        (Name(b"Im1"), msp.as_ref()),
        (Name(b"Im2"), client.as_ref()),
    ]
    .into_iter()
    .filter_map(|(name, img)| img.map(|i| (name, alloc(), i.alpha.as_ref().map(|_| alloc()), i)))
    .collect();
    let page_ids: Vec<(Ref, Ref)> = (0..total).map(|_| (alloc(), alloc())).collect();

    pdf.catalog(catalog).pages(tree);
    pdf.pages(tree)
        .kids(page_ids.iter().map(|(p, _)| *p))
        .count(total as i32);
    pdf.type1_font(regular)
        .base_font(Name(b"Helvetica"))
        .encoding_predefined(Name(b"WinAnsiEncoding"));
    pdf.type1_font(bold)
        .base_font(Name(b"Helvetica-Bold"))
        .encoding_predefined(Name(b"WinAnsiEncoding"));
    pdf.document_info(info)
        .title(TextStr(&report.title))
        .producer(TextStr("RustRMM"));
    for (_, id, mask_id, img) in &images {
        let mut x = pdf.image_xobject(*id, &img.data);
        x.filter(Filter::FlateDecode);
        x.width(img.width as i32);
        x.height(img.height as i32);
        if img.gray {
            x.color_space().device_gray();
        } else {
            x.color_space().device_rgb();
        }
        x.bits_per_component(8);
        if img.png_predictor {
            x.decode_parms()
                .predictor(pdf_writer::types::Predictor::PngOptimum)
                .colors(if img.gray { 1 } else { 3 })
                .bits_per_component(8)
                .columns(img.width as i32);
        }
        if let Some(mask) = mask_id {
            x.s_mask(*mask);
        }
        x.finish();
        if let (Some(mask), Some(alpha)) = (mask_id, &img.alpha) {
            let mut m = pdf.image_xobject(*mask, alpha);
            m.filter(Filter::FlateDecode);
            m.width(img.width as i32);
            m.height(img.height as i32);
            m.color_space().device_gray();
            m.bits_per_component(8);
            m.finish();
        }
    }
    let contents: Vec<Vec<u8>> = std::mem::take(&mut w.pages)
        .into_iter()
        .map(|c| c.finish().into_vec())
        .collect();
    for ((page_id, content_id), bytes) in page_ids.iter().zip(&contents) {
        let mut page = pdf.page(*page_id);
        page.media_box(Rect::new(0.0, 0.0, PAGE_W, PAGE_H));
        page.parent(tree);
        page.contents(*content_id);
        let mut resources = page.resources();
        {
            let mut fonts = resources.fonts();
            fonts.pair(Name(b"F1"), regular);
            fonts.pair(Name(b"F2"), bold);
        }
        if !images.is_empty() {
            let mut xobjects = resources.x_objects();
            for (name, id, _, _) in &images {
                xobjects.pair(*name, *id);
            }
        }
        resources.finish();
        page.finish();
        let compressed = deflate(bytes).unwrap_or_else(|| bytes.clone());
        pdf.stream(*content_id, &compressed)
            .filter(Filter::FlateDecode);
    }
    pdf.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_metrics_and_wrapping() {
        assert!(text_width(Font::Regular, 10.0, "iiii") < text_width(Font::Regular, 10.0, "WWWW"));
        assert!(text_width(Font::Bold, 10.0, "abc") > text_width(Font::Regular, 10.0, "abc"));
        let lines = wrap(
            Font::Regular,
            10.0,
            "the quick brown fox jumps over the lazy dog",
            80.0,
        );
        assert!(lines.len() > 1);
        assert!(
            lines
                .iter()
                .all(|l| text_width(Font::Regular, 10.0, l) <= 80.5)
        );
        assert!(fit(Font::Regular, 10.0, "a very long cell value indeed", 40.0).ends_with('…'));
        assert_eq!(winansi("Zürich – 5€"), b"Z\xfcrich \x96 5\x80".to_vec());
    }

    #[test]
    fn png_rgba_logos_decode() {
        // 2×1 RGBA image: one opaque red, one transparent pixel.
        let raw = [0u8, 255, 0, 0, 255, 0, 0, 0, 0];
        let idat = deflate(&raw).expect("deflate");
        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        let chunk = |png: &mut Vec<u8>, kind: &[u8], data: &[u8]| {
            png.extend_from_slice(&(data.len() as u32).to_be_bytes());
            png.extend_from_slice(kind);
            png.extend_from_slice(data);
            png.extend_from_slice(&[0, 0, 0, 0]);
        };
        let mut ihdr = Vec::new();
        ihdr.extend_from_slice(&2u32.to_be_bytes());
        ihdr.extend_from_slice(&1u32.to_be_bytes());
        ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
        chunk(&mut png, b"IHDR", &ihdr);
        chunk(&mut png, b"IDAT", &idat);
        chunk(&mut png, b"IEND", &[]);
        let img = decode_png(&png).expect("decodes");
        assert_eq!((img.width, img.height), (2, 1));
        assert!(img.alpha.is_some());
        assert!(!img.png_predictor);
    }
}
