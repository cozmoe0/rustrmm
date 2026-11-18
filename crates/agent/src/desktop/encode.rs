//! Region encoding: solid colours, raw BGRA for slivers, and JPEG (pure-Rust `jpeg-encoder`) for
//! everything else. The regions of one frame are encoded in parallel on scoped worker threads.

use std::sync::atomic::{AtomicUsize, Ordering};

use jpeg_encoder::{ColorType, Encoder, SamplingFactor};
use rustrmm_proto::desktop::encoding;

use super::tiles::{Rect, Region, extract};

/// Regions of at most this many pixels are sent raw (a JPEG header alone is ~600 bytes).
const RAW_MAX_PIXELS: u32 = 256;
/// At and above this quality chroma is kept at full resolution (sharper coloured text).
const FULL_CHROMA_QUALITY: u8 = 80;

/// One encoded region, ready to become a tile message.
#[derive(Debug, Clone)]
pub struct Encoded {
    pub rect: Rect,
    pub encoding: u8,
    pub payload: Vec<u8>,
}

/// Worker threads for one frame: half the cores, between 1 and 8.
pub fn default_threads() -> usize {
    std::thread::available_parallelism()
        .map(|n| (n.get() / 2).clamp(1, 8))
        .unwrap_or(2)
}

/// Encodes a single region of a packed BGRA frame.
pub fn encode_region(frame: &[u8], width: u32, region: &Region, quality: u8) -> Encoded {
    let r = region.rect;
    // Captured alpha is meaningless (GDI and 24-bit X visuals leave it at zero): raw and solid
    // payloads are sent opaque.
    if let Some(color) = region.solid {
        return Encoded {
            rect: r,
            encoding: encoding::SOLID,
            payload: vec![color[0], color[1], color[2], 255],
        };
    }
    let mut pixels = extract(frame, width, &r);
    if r.w * r.h <= RAW_MAX_PIXELS {
        opaque(&mut pixels);
        return Encoded {
            rect: r,
            encoding: encoding::RAW_BGRA,
            payload: pixels,
        };
    }
    match jpeg(&pixels, r.w, r.h, quality) {
        Some(payload) => Encoded {
            rect: r,
            encoding: encoding::JPEG,
            payload,
        },
        None => {
            opaque(&mut pixels);
            Encoded {
                rect: r,
                encoding: encoding::RAW_BGRA,
                payload: pixels,
            }
        }
    }
}

fn opaque(bgra: &mut [u8]) {
    for px in bgra.as_chunks_mut::<4>().0 {
        px[3] = 255;
    }
}

/// Area-averaging downscale of a packed BGRA image to at most `max_width` (aspect kept).
pub fn downscale(bgra: &[u8], width: u32, height: u32, max_width: u32) -> (Vec<u8>, u32, u32) {
    if width <= max_width || width == 0 || height == 0 {
        return (
            bgra[..(width * height * 4) as usize].to_vec(),
            width,
            height,
        );
    }
    let dw = max_width.max(1);
    let dh = ((u64::from(height) * u64::from(dw)) / u64::from(width)).max(1) as u32;
    let mut out = vec![0u8; (dw * dh * 4) as usize];
    for dy in 0..dh {
        let y0 = (u64::from(dy) * u64::from(height) / u64::from(dh)) as u32;
        let y1 = ((u64::from(dy + 1) * u64::from(height) / u64::from(dh)) as u32).max(y0 + 1);
        for dx in 0..dw {
            let x0 = (u64::from(dx) * u64::from(width) / u64::from(dw)) as u32;
            let x1 = ((u64::from(dx + 1) * u64::from(width) / u64::from(dw)) as u32).max(x0 + 1);
            let mut sum = [0u32; 3];
            for y in y0..y1 {
                let row = (y * width) as usize * 4;
                for x in x0..x1 {
                    let i = row + x as usize * 4;
                    sum[0] += u32::from(bgra[i]);
                    sum[1] += u32::from(bgra[i + 1]);
                    sum[2] += u32::from(bgra[i + 2]);
                }
            }
            let n = (y1 - y0) * (x1 - x0);
            let o = ((dy * dw + dx) * 4) as usize;
            out[o] = (sum[0] / n) as u8;
            out[o + 1] = (sum[1] / n) as u8;
            out[o + 2] = (sum[2] / n) as u8;
            out[o + 3] = 255;
        }
    }
    (out, dw, dh)
}

/// Baseline JPEG of a packed BGRA image.
pub fn jpeg(bgra: &[u8], width: u32, height: u32, quality: u8) -> Option<Vec<u8>> {
    let (w, h) = (u16::try_from(width).ok()?, u16::try_from(height).ok()?);
    let mut out = Vec::with_capacity((width * height / 4) as usize + 1024);
    let mut encoder = Encoder::new(&mut out, quality.clamp(1, 100));
    encoder.set_sampling_factor(if quality >= FULL_CHROMA_QUALITY {
        SamplingFactor::R_4_4_4
    } else {
        SamplingFactor::R_4_2_0
    });
    encoder.encode(bgra, w, h, ColorType::Bgra).ok()?;
    Some(out)
}

/// Encodes every region on up to `threads` workers; the output keeps the input order.
pub fn encode_regions(
    frame: &[u8],
    width: u32,
    regions: &[Region],
    quality: u8,
    threads: usize,
) -> Vec<Encoded> {
    let workers = threads
        .clamp(1, 16)
        .min(regions.iter().filter(|r| r.solid.is_none()).count().max(1));
    if workers == 1 || regions.len() < 2 {
        return regions
            .iter()
            .map(|r| encode_region(frame, width, r, quality))
            .collect();
    }
    // Largest regions first so the slowest JPEG does not start last.
    let mut order: Vec<usize> = (0..regions.len()).collect();
    order.sort_by_key(|&i| std::cmp::Reverse(regions[i].rect.w * regions[i].rect.h));
    let next = AtomicUsize::new(0);
    let mut results: Vec<(usize, Encoded)> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..workers)
            .map(|_| {
                scope.spawn(|| {
                    let mut done = Vec::new();
                    loop {
                        let k = next.fetch_add(1, Ordering::Relaxed);
                        let Some(&i) = order.get(k) else { break };
                        done.push((i, encode_region(frame, width, &regions[i], quality)));
                    }
                    done
                })
            })
            .collect();
        handles
            .into_iter()
            .flat_map(|h| h.join().unwrap_or_default())
            .collect()
    });
    results.sort_by_key(|(i, _)| *i);
    results.into_iter().map(|(_, e)| e).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::desktop::tiles::{all_tiles, plan};

    fn gradient(width: u32, height: u32) -> Vec<u8> {
        let mut f = Vec::with_capacity((width * height * 4) as usize);
        for y in 0..height {
            for x in 0..width {
                f.extend_from_slice(&[
                    (x % 256) as u8,
                    (y % 256) as u8,
                    ((x + y) % 256) as u8,
                    255,
                ]);
            }
        }
        f
    }

    #[test]
    fn encodings_follow_region_kind_and_size() {
        let (w, h) = (300, 200);
        let f = gradient(w, h);
        let solid = encode_region(
            &f,
            w,
            &Region {
                rect: Rect::new(0, 0, 64, 64),
                solid: Some([1, 2, 3, 4]),
            },
            65,
        );
        assert_eq!(solid.encoding, encoding::SOLID);
        assert_eq!(solid.payload, vec![1, 2, 3, 255], "sent opaque");
        let sliver = encode_region(
            &f,
            w,
            &Region {
                rect: Rect::new(296, 0, 4, 64),
                solid: None,
            },
            65,
        );
        assert_eq!(sliver.encoding, encoding::RAW_BGRA);
        assert_eq!(sliver.payload.len(), 4 * 64 * 4);
        let big = encode_region(
            &f,
            w,
            &Region {
                rect: Rect::new(0, 0, 256, 128),
                solid: None,
            },
            65,
        );
        assert_eq!(big.encoding, encoding::JPEG);
        assert_eq!(&big.payload[..2], &[0xff, 0xd8], "JPEG SOI marker");
        assert_eq!(&big.payload[big.payload.len() - 2..], &[0xff, 0xd9], "EOI");
    }

    #[test]
    fn parallel_encoding_matches_serial_and_keeps_order() {
        let (w, h) = (1024, 512);
        let f = gradient(w, h);
        let regions = plan(&f, w, h, &all_tiles(w, h));
        let serial = encode_regions(&f, w, &regions, 65, 1);
        let parallel = encode_regions(&f, w, &regions, 65, 4);
        assert_eq!(serial.len(), regions.len());
        for ((a, b), r) in serial.iter().zip(&parallel).zip(&regions) {
            assert_eq!(a.rect, r.rect);
            assert_eq!(b.rect, r.rect);
            assert_eq!(a.payload, b.payload, "deterministic encoder");
        }
    }

    #[test]
    fn downscale_keeps_aspect_and_averages() {
        let (w, h) = (2560, 1440);
        let f = [10u8, 20, 30, 0].repeat((w * h) as usize);
        let (out, dw, dh) = downscale(&f, w, h, 1280);
        assert_eq!((dw, dh), (1280, 720));
        assert_eq!(&out[..4], &[10, 20, 30, 255]);
        // A 2x1 black/white image halves to grey.
        let (grey, gw, gh) = downscale(&[0, 0, 0, 0, 255, 255, 255, 0], 2, 1, 1);
        assert_eq!((gw, gh), (1, 1));
        assert_eq!(&grey[..3], &[127, 127, 127]);
        let (same, sw, _) = downscale(&f, w, h, 4000);
        assert_eq!((sw, same.len()), (w, f.len()));
    }

    #[test]
    fn higher_quality_costs_more_bytes() {
        let (w, h) = (256, 256);
        let f = gradient(w, h);
        let low = jpeg(&f, w, h, 45).expect("low");
        let high = jpeg(&f, w, h, 82).expect("high");
        assert!(high.len() > low.len(), "{} vs {}", high.len(), low.len());
    }
}
