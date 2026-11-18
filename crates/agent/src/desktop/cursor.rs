//! Pointer images converted to straight RGBA for the viewer's cursor cache.
//!
//! Windows cursors come in three flavours: 32-bit colour with alpha, colour with a separate AND
//! mask, and monochrome AND/XOR masks. "Invert" pixels (AND=1, XOR=1, used by the I-beam) cannot
//! be drawn by a canvas, so they become black with a one-pixel white halo, which stays visible on
//! light and dark backgrounds.

/// A pointer image (RGBA, rows top-down) and its hot spot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Shape {
    pub hot_x: u16,
    pub hot_y: u16,
    pub width: u16,
    pub height: u16,
    pub rgba: Vec<u8>,
}

#[cfg_attr(not(windows), allow(dead_code))]
fn bit(row: &[u8], x: usize) -> bool {
    row.get(x / 8)
        .is_some_and(|b| (b >> (7 - (x % 8))) & 1 == 1)
}

/// Monochrome cursor: `mask` holds `height` AND rows followed by `height` XOR rows, each `pitch`
/// bytes, 1 bit per pixel, most significant bit first.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn mono_to_rgba(mask: &[u8], width: usize, height: usize, pitch: usize) -> Vec<u8> {
    let mut rgba = vec![0u8; width * height * 4];
    let mut invert = vec![false; width * height];
    for y in 0..height {
        let and_row = mask.get(y * pitch..(y + 1) * pitch).unwrap_or(&[]);
        let xor_row = mask
            .get((y + height) * pitch..(y + height + 1) * pitch)
            .unwrap_or(&[]);
        for x in 0..width {
            let i = y * width + x;
            let px = match (bit(and_row, x), bit(xor_row, x)) {
                (false, false) => [0, 0, 0, 255],
                (false, true) => [255, 255, 255, 255],
                (true, false) => [0, 0, 0, 0],
                (true, true) => {
                    invert[i] = true;
                    [0, 0, 0, 255]
                }
            };
            rgba[i * 4..i * 4 + 4].copy_from_slice(&px);
        }
    }
    halo(&mut rgba, &invert, width, height);
    rgba
}

/// White outline around inverted pixels, on transparent neighbours only.
#[cfg_attr(not(windows), allow(dead_code))]
fn halo(rgba: &mut [u8], invert: &[bool], width: usize, height: usize) {
    if !invert.iter().any(|&b| b) {
        return;
    }
    let source = rgba.to_vec();
    for y in 0..height {
        for x in 0..width {
            let i = y * width + x;
            if source[i * 4 + 3] != 0 {
                continue;
            }
            let near = (y.saturating_sub(1)..=(y + 1).min(height - 1)).any(|ny| {
                (x.saturating_sub(1)..=(x + 1).min(width - 1)).any(|nx| invert[ny * width + nx])
            });
            if near {
                rgba[i * 4..i * 4 + 4].copy_from_slice(&[255, 255, 255, 255]);
            }
        }
    }
}

/// 32-bit BGRA cursor rows (`pitch` bytes apart) to RGBA. When every alpha byte is zero the
/// image has no alpha channel: `and_mask` (1 bpp rows of `mask_pitch`) supplies transparency,
/// or the pixels are taken as opaque.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn bgra_to_rgba(
    bgra: &[u8],
    width: usize,
    height: usize,
    pitch: usize,
    and_mask: Option<(&[u8], usize)>,
) -> Vec<u8> {
    let has_alpha = (0..height)
        .any(|y| (0..width).any(|x| bgra.get(y * pitch + x * 4 + 3).is_some_and(|&a| a != 0)));
    let mut rgba = vec![0u8; width * height * 4];
    for y in 0..height {
        for x in 0..width {
            let s = y * pitch + x * 4;
            let Some(p) = bgra.get(s..s + 4) else {
                continue;
            };
            let alpha = if has_alpha {
                p[3]
            } else {
                match and_mask {
                    Some((mask, mp)) if bit(mask.get(y * mp..(y + 1) * mp).unwrap_or(&[]), x) => 0,
                    _ => 255,
                }
            };
            let d = (y * width + x) * 4;
            rgba[d..d + 4].copy_from_slice(&[p[2], p[1], p[0], alpha]);
        }
    }
    rgba
}

/// Crops an image wider or taller than `max` (cursors are tiny; this only guards the wire size).
pub fn clamp_size(shape: Shape, max: u16) -> Shape {
    if shape.width <= max && shape.height <= max {
        return shape;
    }
    let (w, h) = (
        shape.width.min(max) as usize,
        shape.height.min(max) as usize,
    );
    let src_w = shape.width as usize;
    let mut rgba = Vec::with_capacity(w * h * 4);
    for y in 0..h {
        rgba.extend_from_slice(&shape.rgba[y * src_w * 4..(y * src_w + w) * 4]);
    }
    Shape {
        hot_x: shape.hot_x.min(w as u16 - 1),
        hot_y: shape.hot_y.min(h as u16 - 1),
        width: w as u16,
        height: h as u16,
        rgba,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn monochrome_masks_map_to_black_white_clear_and_halo() {
        // 8×2 cursor, pitch 1: AND rows then XOR rows.
        // Row 0: pixels 0-1 black, 2-3 white, 4-5 transparent, 6 invert, 7 transparent.
        let and = [0b0000_1111u8, 0xff];
        let xor = [0b0011_0010u8, 0x00];
        let mask = [and[0], and[1], xor[0], xor[1]];
        let rgba = mono_to_rgba(&mask, 8, 2, 1);
        let px = |x: usize, y: usize| -> [u8; 4] {
            let i = (y * 8 + x) * 4;
            rgba[i..i + 4].try_into().expect("px")
        };
        assert_eq!(px(0, 0), [0, 0, 0, 255]);
        assert_eq!(px(2, 0), [255, 255, 255, 255]);
        assert_eq!(px(4, 0), [0, 0, 0, 0]);
        assert_eq!(px(6, 0), [0, 0, 0, 255], "invert drawn black");
        assert_eq!(px(5, 0), [255, 255, 255, 255], "halo next to invert");
        assert_eq!(px(7, 0), [255, 255, 255, 255], "halo next to invert");
        assert_eq!(px(6, 1), [255, 255, 255, 255], "halo below invert");
        assert_eq!(px(0, 1), [0, 0, 0, 0], "transparent row");
    }

    #[test]
    fn colour_cursors_swap_channels_and_use_masks_without_alpha() {
        let bgra = [10, 20, 30, 128, 1, 2, 3, 0];
        assert_eq!(
            bgra_to_rgba(&bgra, 2, 1, 8, None),
            vec![30, 20, 10, 128, 3, 2, 1, 0]
        );
        // No alpha at all: the AND mask decides (pixel 1 transparent).
        let opaque = [10, 20, 30, 0, 1, 2, 3, 0];
        let mask = [0b0100_0000u8];
        assert_eq!(
            bgra_to_rgba(&opaque, 2, 1, 8, Some((&mask, 1))),
            vec![30, 20, 10, 255, 3, 2, 1, 0]
        );
    }

    #[test]
    fn oversized_shapes_are_cropped() {
        let shape = Shape {
            hot_x: 300,
            hot_y: 1,
            width: 300,
            height: 2,
            rgba: vec![7; 300 * 2 * 4],
        };
        let cropped = clamp_size(shape, 256);
        assert_eq!((cropped.width, cropped.height), (256, 2));
        assert_eq!(cropped.rgba.len(), 256 * 2 * 4);
        assert_eq!(cropped.hot_x, 255);
    }
}
