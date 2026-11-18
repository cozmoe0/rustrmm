/*
 * Encodes the synthetic desktop exactly like the agent: dirty 64×64 tiles, single-colour tiles as
 * `solid`, the rest merged into rectangles of up to 1024×256 px, regions of at most 256 pixels as
 * raw BGRA and everything else as JPEG; copy rects first, then tiles, then the frame end.
 */
import {
  MAX_REGION_HEIGHT,
  MAX_REGION_WIDTH,
  RAW_MAX_PIXELS,
  TILE_ENCODING,
  TILE_SIZE,
  encodeMedia,
  type CursorShapeMessage,
} from '@/lib/desktop/protocol'
import type { CursorKind, Rect } from './desktop-scene'

type Canvas = OffscreenCanvas | HTMLCanvasElement
type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D

export interface Surface {
  canvas: Canvas
  ctx: Ctx
}

export function createSurface(width: number, height: number, readable = true): Surface {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d', { willReadFrequently: readable }) as OffscreenCanvasRenderingContext2D
    return { canvas, ctx }
  }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: readable })!
  return { canvas, ctx }
}

export async function canvasToJpeg(canvas: Canvas, quality: number): Promise<Blob> {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type: 'image/jpeg', quality })
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('encode failed'))), 'image/jpeg', quality))
}

/** Marks every 64×64 tile touched by a dirty rect. */
export function dirtyTileGrid(rects: readonly Rect[], width: number, height: number): { grid: Uint8Array; cols: number; rows: number } {
  const cols = Math.ceil(width / TILE_SIZE)
  const rows = Math.ceil(height / TILE_SIZE)
  const grid = new Uint8Array(cols * rows)
  for (const rect of rects) {
    const x0 = Math.max(0, Math.floor(rect.x / TILE_SIZE))
    const y0 = Math.max(0, Math.floor(rect.y / TILE_SIZE))
    const x1 = Math.min(cols - 1, Math.floor((rect.x + rect.w - 1) / TILE_SIZE))
    const y1 = Math.min(rows - 1, Math.floor((rect.y + rect.h - 1) / TILE_SIZE))
    for (let row = y0; row <= y1; row += 1) for (let col = x0; col <= x1; col += 1) grid[row * cols + col] = 1
  }
  return { grid, cols, rows }
}

/**
 * Greedily merges marked tiles into rectangles of up to 16×4 tiles (1024×256 px): extend right
 * along the row, then down while every tile below the run is marked. Edge tiles are clipped to
 * the screen, so regions can have any size up to that limit.
 */
export function mergeTiles(grid: Uint8Array, cols: number, rows: number, width: number, height: number): Rect[] {
  const maxCols = MAX_REGION_WIDTH / TILE_SIZE
  const maxRows = MAX_REGION_HEIGHT / TILE_SIZE
  const used = new Uint8Array(grid.length)
  const regions: Rect[] = []
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const index = row * cols + col
      if (!grid[index] || used[index]) continue
      let w = 1
      while (col + w < cols && w < maxCols && grid[index + w] && !used[index + w]) w += 1
      let h = 1
      while (row + h < rows && h < maxRows) {
        let full = true
        for (let c = col; c < col + w; c += 1) {
          const below = (row + h) * cols + c
          if (!grid[below] || used[below]) {
            full = false
            break
          }
        }
        if (!full) break
        h += 1
      }
      for (let r = row; r < row + h; r += 1) for (let c = col; c < col + w; c += 1) used[r * cols + c] = 1
      const x = col * TILE_SIZE
      const y = row * TILE_SIZE
      regions.push({ x, y, w: Math.min(w * TILE_SIZE, width - x), h: Math.min(h * TILE_SIZE, height - y) })
    }
  }
  return regions
}

function rgbaToBgra(rgba: Uint8ClampedArray): Uint8Array {
  const out = new Uint8Array(rgba.length)
  for (let index = 0; index < rgba.length; index += 4) {
    out[index] = rgba[index + 2]
    out[index + 1] = rgba[index + 1]
    out[index + 2] = rgba[index]
    out[index + 3] = 255
  }
  return out
}

export interface EncodedFrame {
  messages: Uint8Array<ArrayBuffer>[]
  tiles: number
  bytes: number
  encodeMs: number
  solid: number
  raw: number
  jpeg: number
}

/**
 * Encodes one frame from the surface. `dirty` areas must already be painted and `copies` already
 * applied on the surface (so it matches what the viewer will show).
 */
export async function encodeFrame(
  surface: Surface,
  width: number,
  height: number,
  frameSeq: number,
  dirty: readonly Rect[],
  copies: readonly { src: Rect; dy: number }[],
  quality: number,
): Promise<EncodedFrame> {
  const started = performance.now()
  const { grid, cols, rows } = dirtyTileGrid(dirty, width, height)
  const nonSolid = new Uint8Array(grid.length)
  const tileMessages: Promise<Uint8Array<ArrayBuffer>>[] = []
  let solid = 0
  let raw = 0
  let jpeg = 0

  // Single-colour tiles: one readback per band of tiles that has anything dirty.
  for (let row = 0; row < rows; row += 1) {
    let any = false
    for (let col = 0; col < cols; col += 1) if (grid[row * cols + col]) any = true
    if (!any) continue
    const y = row * TILE_SIZE
    const bandH = Math.min(TILE_SIZE, height - y)
    const band = surface.ctx.getImageData(0, y, width, bandH).data
    for (let col = 0; col < cols; col += 1) {
      const index = row * cols + col
      if (!grid[index]) continue
      const x = col * TILE_SIZE
      const tileW = Math.min(TILE_SIZE, width - x)
      const first = x * 4
      const r = band[first]
      const g = band[first + 1]
      const b = band[first + 2]
      let uniform = true
      for (let ty = 0; ty < bandH && uniform; ty += 1) {
        let offset = (ty * width + x) * 4
        for (let tx = 0; tx < tileW; tx += 1, offset += 4) {
          if (band[offset] !== r || band[offset + 1] !== g || band[offset + 2] !== b) {
            uniform = false
            break
          }
        }
      }
      if (uniform) {
        solid += 1
        tileMessages.push(
          Promise.resolve(encodeMedia({ type: 'tile', frameSeq, x, y, w: tileW, h: bandH, encoding: TILE_ENCODING.solid, payload: new Uint8Array([b, g, r, 255]) })),
        )
      } else nonSolid[index] = 1
    }
  }

  for (const region of mergeTiles(nonSolid, cols, rows, width, height)) {
    if (region.w * region.h <= RAW_MAX_PIXELS) {
      raw += 1
      const pixels = rgbaToBgra(surface.ctx.getImageData(region.x, region.y, region.w, region.h).data)
      tileMessages.push(Promise.resolve(encodeMedia({ type: 'tile', frameSeq, ...region, encoding: TILE_ENCODING.rawBgra, payload: pixels })))
      continue
    }
    jpeg += 1
    // convertToBlob snapshots the bitmap synchronously, so every region gets its own small canvas.
    const scratch = createSurface(region.w, region.h, false)
    scratch.ctx.drawImage(surface.canvas, region.x, region.y, region.w, region.h, 0, 0, region.w, region.h)
    tileMessages.push(
      canvasToJpeg(scratch.canvas, quality / 100)
        .then((blob) => blob.arrayBuffer())
        .then((buffer) => encodeMedia({ type: 'tile', frameSeq, ...region, encoding: TILE_ENCODING.jpeg, payload: new Uint8Array(buffer) })),
    )
  }

  const tiles = await Promise.all(tileMessages)
  const copyMessages = copies.map((copy) =>
    encodeMedia({ type: 'copy_rect', frameSeq, srcX: copy.src.x, srcY: copy.src.y, w: copy.src.w, h: copy.src.h, dstX: copy.src.x, dstY: copy.src.y + copy.dy }),
  )
  const messages = [...copyMessages, ...tiles, encodeMedia({ type: 'frame_end', frameSeq, tiles: tiles.length })]
  return {
    messages,
    tiles: tiles.length,
    bytes: messages.reduce((sum, message) => sum + message.byteLength, 0),
    encodeMs: performance.now() - started,
    solid,
    raw,
    jpeg,
  }
}

// ------------------------------------------------------------------ cursor shapes

function shape(width: number, height: number, hotX: number, hotY: number, draw: (ctx: Ctx) => void): CursorShapeMessage {
  const { ctx } = createSurface(width, height)
  draw(ctx)
  const rgba = new Uint8Array(ctx.getImageData(0, 0, width, height).data)
  return { type: 'cursor_shape', hotX, hotY, w: width, h: height, rgba }
}

function outlined(ctx: Ctx, path: () => void, fill: string, stroke: string, width = 1) {
  ctx.lineJoin = 'round'
  path()
  ctx.fillStyle = fill
  ctx.fill()
  ctx.lineWidth = width
  ctx.strokeStyle = stroke
  ctx.stroke()
}

let cursorCache: Record<CursorKind, CursorShapeMessage> | null = null

/** Pointer images like the ones Windows reports (arrow, I-beam, hand, move), as RGBA. */
export function cursorShapes(): Record<CursorKind, CursorShapeMessage> {
  if (cursorCache) return cursorCache
  cursorCache = {
    arrow: shape(14, 22, 1, 1, (ctx) =>
      outlined(
        ctx,
        () => {
          ctx.beginPath()
          ctx.moveTo(1.5, 1.5)
          ctx.lineTo(1.5, 17.5)
          ctx.lineTo(5.5, 13.8)
          ctx.lineTo(8.3, 20.3)
          ctx.lineTo(10.9, 19.2)
          ctx.lineTo(8.2, 12.8)
          ctx.lineTo(13, 12.8)
          ctx.closePath()
        },
        '#ffffff',
        '#000000',
      ),
    ),
    ibeam: shape(11, 20, 5, 10, (ctx) => {
      ctx.lineCap = 'round'
      const path = () => {
        ctx.beginPath()
        ctx.moveTo(2, 2)
        ctx.lineTo(4.5, 3)
        ctx.lineTo(7, 2)
        ctx.moveTo(4.5, 3)
        ctx.lineTo(4.5, 17)
        ctx.moveTo(2, 18)
        ctx.lineTo(4.5, 17)
        ctx.lineTo(7, 18)
      }
      path()
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 3.5
      ctx.stroke()
      path()
      ctx.strokeStyle = '#000000'
      ctx.lineWidth = 1.4
      ctx.stroke()
    }),
    hand: shape(18, 22, 6, 1, (ctx) =>
      outlined(
        ctx,
        () => {
          ctx.beginPath()
          ctx.moveTo(5, 11)
          ctx.lineTo(5, 3)
          ctx.arcTo(5, 1, 6.5, 1, 1.6)
          ctx.arcTo(8, 1, 8, 3, 1.6)
          ctx.lineTo(8, 9)
          ctx.lineTo(10.5, 9.5)
          ctx.lineTo(13, 10)
          ctx.lineTo(15.5, 11)
          ctx.quadraticCurveTo(17, 12, 16.5, 15)
          ctx.lineTo(15.5, 19)
          ctx.quadraticCurveTo(15, 20.5, 13, 20.5)
          ctx.lineTo(7.5, 20.5)
          ctx.quadraticCurveTo(6, 20.5, 5, 19)
          ctx.lineTo(1.8, 14.2)
          ctx.quadraticCurveTo(1, 12.6, 2.6, 12.2)
          ctx.quadraticCurveTo(3.8, 12, 5, 13.5)
          ctx.closePath()
        },
        '#ffffff',
        '#000000',
      ),
    ),
    move: shape(21, 21, 10, 10, (ctx) =>
      outlined(
        ctx,
        () => {
          ctx.beginPath()
          const c = 10.5
          ctx.moveTo(c, 1)
          ctx.lineTo(c + 4, 5)
          ctx.lineTo(c + 1.5, 5)
          ctx.lineTo(c + 1.5, c - 1.5)
          ctx.lineTo(16, c - 1.5)
          ctx.lineTo(16, c - 4)
          ctx.lineTo(20, c)
          ctx.lineTo(16, c + 4)
          ctx.lineTo(16, c + 1.5)
          ctx.lineTo(c + 1.5, c + 1.5)
          ctx.lineTo(c + 1.5, 16)
          ctx.lineTo(c + 4, 16)
          ctx.lineTo(c, 20)
          ctx.lineTo(c - 4, 16)
          ctx.lineTo(c - 1.5, 16)
          ctx.lineTo(c - 1.5, c + 1.5)
          ctx.lineTo(5, c + 1.5)
          ctx.lineTo(5, c + 4)
          ctx.lineTo(1, c)
          ctx.lineTo(5, c - 4)
          ctx.lineTo(5, c - 1.5)
          ctx.lineTo(c - 1.5, c - 1.5)
          ctx.lineTo(c - 1.5, 5)
          ctx.lineTo(c - 4, 5)
          ctx.closePath()
        },
        '#ffffff',
        '#000000',
      ),
    ),
  }
  return cursorCache
}
