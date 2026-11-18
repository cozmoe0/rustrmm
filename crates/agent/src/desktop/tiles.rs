//! Dirty-tile detection and region planning on tightly packed, top-down BGRA frames.
//!
//! The screen is split into 64×64 tiles. A tile is dirty when any of its pixels differs from the
//! image the viewer already has (the last frame sent). DXGI dirty rectangles narrow the search;
//! without them (GDI, X11) every tile is compared, which costs a `memcmp` of the frame (2–3 ms for
//! 2560×1440). Dirty tiles are then planned into regions: single-colour tiles become `solid`
//! messages, and the rest are merged into rectangles of up to 16×4 tiles so a full frame is a
//! handful of JPEGs instead of hundreds.

/// Tile side in pixels.
pub const TILE: u32 = 64;
/// Most tiles merged horizontally into one region (1024 px).
const MAX_RUN_TILES: u32 = 16;
/// Most tile rows merged vertically into one region (256 px).
const MAX_ROW_TILES: u32 = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

impl Rect {
    pub fn new(x: u32, y: u32, w: u32, h: u32) -> Self {
        Self { x, y, w, h }
    }

    pub fn right(&self) -> u32 {
        self.x + self.w
    }

    pub fn bottom(&self) -> u32 {
        self.y + self.h
    }

    pub fn is_empty(&self) -> bool {
        self.w == 0 || self.h == 0
    }

    /// The part of this rectangle inside a `width`×`height` frame.
    pub fn clamp(&self, width: u32, height: u32) -> Rect {
        let x = self.x.min(width);
        let y = self.y.min(height);
        Rect {
            x,
            y,
            w: self.right().min(width) - x,
            h: self.bottom().min(height) - y,
        }
    }
}

/// A DXGI move rectangle: `dst` was copied from (`src_x`, `src_y`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MoveRect {
    pub src_x: u32,
    pub src_y: u32,
    pub dst: Rect,
}

/// Number of tile columns and rows of a frame.
pub fn grid(width: u32, height: u32) -> (u32, u32) {
    (width.div_ceil(TILE), height.div_ceil(TILE))
}

/// The pixel rectangle of tile (`tx`, `ty`), clipped to the frame.
pub fn tile_rect(tx: u32, ty: u32, width: u32, height: u32) -> Rect {
    Rect::new(tx * TILE, ty * TILE, TILE, TILE).clamp(width, height)
}

/// Every tile of the frame (a full refresh).
pub fn all_tiles(width: u32, height: u32) -> Vec<(u32, u32)> {
    let (cols, rows) = grid(width, height);
    (0..rows)
        .flat_map(|ty| (0..cols).map(move |tx| (tx, ty)))
        .collect()
}

/// Tiles whose pixels differ between `prev` and `cur` (both `width * height * 4` bytes). With a
/// `hint`, only tiles touching one of its rectangles are compared.
pub fn dirty_tiles(
    prev: &[u8],
    cur: &[u8],
    width: u32,
    height: u32,
    hint: Option<&[Rect]>,
) -> Vec<(u32, u32)> {
    let stride = width as usize * 4;
    debug_assert!(prev.len() >= stride * height as usize);
    debug_assert!(cur.len() >= stride * height as usize);
    let (cols, rows) = grid(width, height);
    let mut candidate = vec![hint.is_none(); (cols * rows) as usize];
    if let Some(rects) = hint {
        for r in rects {
            let r = r.clamp(width, height);
            if r.is_empty() {
                continue;
            }
            for ty in r.y / TILE..=(r.bottom() - 1) / TILE {
                for tx in r.x / TILE..=(r.right() - 1) / TILE {
                    candidate[(ty * cols + tx) as usize] = true;
                }
            }
        }
    }
    let mut dirty = Vec::new();
    for ty in 0..rows {
        for tx in 0..cols {
            if !candidate[(ty * cols + tx) as usize] {
                continue;
            }
            let r = tile_rect(tx, ty, width, height);
            let start = r.x as usize * 4;
            let len = r.w as usize * 4;
            let changed = (r.y..r.bottom()).any(|y| {
                let off = y as usize * stride + start;
                prev[off..off + len] != cur[off..off + len]
            });
            if changed {
                dirty.push((tx, ty));
            }
        }
    }
    dirty
}

/// The colour of a rectangle when every pixel is identical.
pub fn solid_color(frame: &[u8], width: u32, r: &Rect) -> Option<[u8; 4]> {
    let stride = width as usize * 4;
    let first = r.y as usize * stride + r.x as usize * 4;
    let pixel: [u8; 4] = frame.get(first..first + 4)?.try_into().ok()?;
    for y in r.y..r.bottom() {
        let off = y as usize * stride + r.x as usize * 4;
        let row = &frame[off..off + r.w as usize * 4];
        if !row.as_chunks::<4>().0.iter().all(|p| *p == pixel) {
            return None;
        }
    }
    Some(pixel)
}

/// One planned region of a frame update.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Region {
    pub rect: Rect,
    /// The whole region is this BGRA colour.
    pub solid: Option<[u8; 4]>,
}

/// Groups dirty tiles into regions: solid tiles stay single, the others merge into horizontal
/// runs (up to 16 tiles) that then merge with identical runs below (up to 4 rows).
pub fn plan(frame: &[u8], width: u32, height: u32, tiles: &[(u32, u32)]) -> Vec<Region> {
    let (cols, rows) = grid(width, height);
    let mut solids = Vec::new();
    let mut busy = vec![false; (cols * rows) as usize];
    for &(tx, ty) in tiles {
        if tx >= cols || ty >= rows {
            continue;
        }
        let r = tile_rect(tx, ty, width, height);
        match solid_color(frame, width, &r) {
            Some(color) => solids.push(Region {
                rect: r,
                solid: Some(color),
            }),
            None => busy[(ty * cols + tx) as usize] = true,
        }
    }
    // Horizontal runs per tile row: (tx_start, len).
    let mut runs: Vec<Vec<(u32, u32)>> = vec![Vec::new(); rows as usize];
    for ty in 0..rows {
        let mut tx = 0;
        while tx < cols {
            if !busy[(ty * cols + tx) as usize] {
                tx += 1;
                continue;
            }
            let start = tx;
            while tx < cols && busy[(ty * cols + tx) as usize] && tx - start < MAX_RUN_TILES {
                tx += 1;
            }
            runs[ty as usize].push((start, tx - start));
        }
    }
    // Merge identical runs of consecutive rows.
    let mut regions = Vec::new();
    for ty in 0..rows {
        let row = std::mem::take(&mut runs[ty as usize]);
        for (start, len) in row {
            let mut depth = 1;
            while depth < MAX_ROW_TILES && ty + depth < rows {
                let below = &mut runs[(ty + depth) as usize];
                match below.iter().position(|&run| run == (start, len)) {
                    Some(i) => {
                        below.remove(i);
                        depth += 1;
                    }
                    None => break,
                }
            }
            let rect =
                Rect::new(start * TILE, ty * TILE, len * TILE, depth * TILE).clamp(width, height);
            regions.push(Region { rect, solid: None });
        }
    }
    regions.extend(solids);
    regions
}

/// Copies rectangle `r` of `src` into the same place in `dst` (both packed, same size).
pub fn copy_rect(dst: &mut [u8], src: &[u8], width: u32, r: &Rect) {
    let stride = width as usize * 4;
    let len = r.w as usize * 4;
    for y in r.y..r.bottom() {
        let off = y as usize * stride + r.x as usize * 4;
        dst[off..off + len].copy_from_slice(&src[off..off + len]);
    }
}

/// Applies a move rectangle inside one buffer (what the viewer does with a copy-rect message).
pub fn apply_move(buf: &mut [u8], width: u32, height: u32, m: &MoveRect) {
    let dst = m.dst.clamp(width, height);
    if dst.is_empty() || m.src_x + dst.w > width || m.src_y + dst.h > height {
        return;
    }
    let stride = width as usize * 4;
    let len = dst.w as usize * 4;
    // Copy row by row in the direction that never overwrites unread source rows.
    let rows: Box<dyn Iterator<Item = u32>> = if m.src_y < dst.y {
        Box::new((0..dst.h).rev())
    } else {
        Box::new(0..dst.h)
    };
    for row in rows {
        let from = (m.src_y + row) as usize * stride + m.src_x as usize * 4;
        let to = (dst.y + row) as usize * stride + dst.x as usize * 4;
        buf.copy_within(from..from + len, to);
    }
}

/// Copies a rectangle out of a packed frame into its own packed buffer.
pub fn extract(frame: &[u8], width: u32, r: &Rect) -> Vec<u8> {
    let stride = width as usize * 4;
    let len = r.w as usize * 4;
    let mut out = Vec::with_capacity(len * r.h as usize);
    for y in r.y..r.bottom() {
        let off = y as usize * stride + r.x as usize * 4;
        out.extend_from_slice(&frame[off..off + len]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(width: u32, height: u32, color: [u8; 4]) -> Vec<u8> {
        color.repeat((width * height) as usize)
    }

    fn set(buf: &mut [u8], width: u32, x: u32, y: u32, color: [u8; 4]) {
        let off = (y * width + x) as usize * 4;
        buf[off..off + 4].copy_from_slice(&color);
    }

    #[test]
    fn grid_covers_partial_edge_tiles() {
        assert_eq!(grid(2560, 1440), (40, 23));
        assert_eq!(grid(100, 64), (2, 1));
        assert_eq!(tile_rect(1, 0, 100, 64), Rect::new(64, 0, 36, 64));
        assert_eq!(all_tiles(130, 70).len(), 3 * 2);
    }

    #[test]
    fn identical_frames_have_no_dirty_tiles() {
        let a = frame(200, 150, [1, 2, 3, 255]);
        assert!(dirty_tiles(&a, &a.clone(), 200, 150, None).is_empty());
    }

    #[test]
    fn single_pixel_changes_dirty_exactly_one_tile() {
        let a = frame(200, 150, [0, 0, 0, 255]);
        let mut b = a.clone();
        set(&mut b, 200, 130, 70, [9, 9, 9, 255]); // tile (2, 1)
        set(&mut b, 200, 199, 149, [9, 9, 9, 255]); // last pixel: tile (3, 2), partial
        assert_eq!(dirty_tiles(&a, &b, 200, 150, None), vec![(2, 1), (3, 2)]);
    }

    #[test]
    fn hints_limit_the_comparison() {
        let a = frame(256, 128, [0, 0, 0, 255]);
        let mut b = a.clone();
        set(&mut b, 256, 10, 10, [1, 1, 1, 255]); // tile (0, 0)
        set(&mut b, 256, 200, 100, [1, 1, 1, 255]); // tile (3, 1)
        let hint = [Rect::new(190, 90, 20, 20)];
        assert_eq!(dirty_tiles(&a, &b, 256, 128, Some(&hint)), vec![(3, 1)]);
        // A hint spanning two tiles checks both but reports only the changed one.
        let hint = [Rect::new(60, 0, 10, 10)];
        assert_eq!(dirty_tiles(&a, &b, 256, 128, Some(&hint)), vec![(0, 0)]);
        // An empty hint means nothing changed.
        assert!(dirty_tiles(&a, &b, 256, 128, Some(&[])).is_empty());
    }

    #[test]
    fn solid_tiles_are_detected() {
        let mut f = frame(128, 64, [5, 6, 7, 255]);
        assert_eq!(
            solid_color(&f, 128, &Rect::new(0, 0, 64, 64)),
            Some([5, 6, 7, 255])
        );
        set(&mut f, 128, 63, 63, [0, 0, 0, 255]);
        assert_eq!(solid_color(&f, 128, &Rect::new(0, 0, 64, 64)), None);
        assert_eq!(
            solid_color(&f, 128, &Rect::new(64, 0, 64, 64)),
            Some([5, 6, 7, 255])
        );
    }

    /// A noisy frame where no tile is solid.
    fn noise(width: u32, height: u32) -> Vec<u8> {
        (0..width * height * 4)
            .map(|i| (i.wrapping_mul(2_654_435_761) >> 13) as u8)
            .collect()
    }

    #[test]
    fn planning_merges_runs_and_keeps_solids_apart() {
        let (w, h) = (2560, 1440);
        let mut f = noise(w, h);
        // Tile (0, 0) is solid.
        for y in 0..64 {
            for x in 0..64 {
                set(&mut f, w, x, y, [1, 2, 3, 255]);
            }
        }
        let regions = plan(&f, w, h, &all_tiles(w, h));
        let solids: Vec<_> = regions.iter().filter(|r| r.solid.is_some()).collect();
        assert_eq!(solids.len(), 1);
        assert_eq!(solids[0].rect, Rect::new(0, 0, 64, 64));
        // Every pixel is covered exactly once.
        let mut covered = vec![0u8; (w * h) as usize];
        for r in &regions {
            for y in r.rect.y..r.rect.bottom() {
                for x in r.rect.x..r.rect.right() {
                    covered[(y * w + x) as usize] += 1;
                }
            }
        }
        assert!(covered.iter().all(|&c| c == 1));
        // Regions respect the size limits and a full frame is a few dozen JPEGs, not 920.
        let jpegs = regions.iter().filter(|r| r.solid.is_none()).count();
        assert!(jpegs < 60, "{jpegs} regions");
        assert!(regions.iter().all(|r| r.rect.w <= 1024 && r.rect.h <= 256));
    }

    #[test]
    fn planning_does_not_merge_across_gaps() {
        let (w, h) = (640, 128);
        let f = noise(w, h);
        let regions = plan(&f, w, h, &[(0, 0), (1, 0), (3, 0), (0, 1), (1, 1)]);
        let rects: Vec<Rect> = regions.iter().map(|r| r.rect).collect();
        assert!(rects.contains(&Rect::new(0, 0, 128, 128)), "{rects:?}");
        assert!(rects.contains(&Rect::new(192, 0, 64, 64)), "{rects:?}");
        assert_eq!(rects.len(), 2);
    }

    #[test]
    fn moves_copy_in_place_without_smearing() {
        let (w, h) = (4, 6);
        let mut buf: Vec<u8> = (0..w * h).flat_map(|i| [i as u8, 0, 0, 255]).collect();
        // Scroll rows 0..4 down by two rows (overlapping source and destination).
        apply_move(
            &mut buf,
            w,
            h,
            &MoveRect {
                src_x: 0,
                src_y: 0,
                dst: Rect::new(0, 2, 4, 4),
            },
        );
        let row = |buf: &[u8], y: u32| -> Vec<u8> {
            (0..w)
                .map(|x| buf[((y * w + x) * 4) as usize])
                .collect::<Vec<_>>()
        };
        assert_eq!(row(&buf, 2), vec![0, 1, 2, 3]);
        assert_eq!(row(&buf, 5), vec![12, 13, 14, 15]);
        assert_eq!(row(&buf, 0), vec![0, 1, 2, 3], "untouched");
    }

    #[test]
    fn extract_and_copy_round_trip() {
        let (w, h) = (100, 80);
        let src = noise(w, h);
        let r = Rect::new(10, 20, 30, 40);
        let tile = extract(&src, w, &r);
        assert_eq!(tile.len(), 30 * 40 * 4);
        let mut dst = frame(w, h, [0, 0, 0, 0]);
        copy_rect(&mut dst, &src, w, &r);
        assert_eq!(extract(&dst, w, &r), tile);
        // Damage a copy inside `r` only, then repair it from the source.
        let mut repaired = src.clone();
        copy_rect(
            &mut repaired,
            &dst.iter().map(|_| 0u8).collect::<Vec<_>>(),
            w,
            &r,
        );
        assert!(!dirty_tiles(&repaired, &src, w, h, None).is_empty());
        copy_rect(&mut repaired, &src, w, &r);
        assert_eq!(repaired, src);
    }
}
