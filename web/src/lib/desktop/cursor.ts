/*
 * Remote cursor shapes. The agent sends a shape before the first position and whenever it
 * changes; the viewer caches the drawn shapes and composites the pointer over the screen. While
 * the operator controls the device, the local pointer takes the remote shape (a CSS cursor) so it
 * moves without network latency.
 */
import type { CursorShapeMessage } from './protocol'

export interface CursorShape {
  hotX: number
  hotY: number
  width: number
  height: number
  /** A canvas with the shape drawn at its natural size. */
  image: HTMLCanvasElement
  /** A CSS `cursor` value using the shape, or null when it can't be used as a CSS cursor. */
  css: string | null
}

/** Browsers ignore CSS cursor images larger than this. */
const MAX_CSS_CURSOR = 128

/** FNV-1a over the dimensions, hotspot and pixels: identical shapes share one cache entry. */
export function cursorKey(message: Pick<CursorShapeMessage, 'hotX' | 'hotY' | 'w' | 'h' | 'rgba'>): string {
  let hash = 0x811c9dc5
  const mix = (value: number) => {
    hash ^= value & 0xff
    hash = Math.imul(hash, 0x01000193)
  }
  for (const value of [message.hotX, message.hotY, message.w, message.h]) {
    mix(value)
    mix(value >> 8)
  }
  const { rgba } = message
  // Large shapes: sampling keeps hashing cheap while still telling shapes apart.
  const step = rgba.byteLength > 16384 ? 4 * 7 : 1
  for (let index = 0; index < rgba.byteLength; index += step) mix(rgba[index])
  return `${message.w}x${message.h}:${message.hotX},${message.hotY}:${(hash >>> 0).toString(36)}`
}

/** Whether a shape is fully transparent (the agent's way of hiding the pointer, e.g. while typing). */
export function isBlankCursor(rgba: Uint8Array): boolean {
  for (let index = 3; index < rgba.byteLength; index += 4) if (rgba[index] !== 0) return false
  return true
}

export class CursorCache {
  private shapes = new Map<string, CursorShape>()
  private limit: number

  constructor(limit = 32) {
    this.limit = limit
  }

  /** Draws (or reuses) a shape from a `cursor_shape` message. */
  get(message: CursorShapeMessage): CursorShape {
    const key = cursorKey(message)
    const cached = this.shapes.get(key)
    if (cached) {
      // Refresh recency.
      this.shapes.delete(key)
      this.shapes.set(key, cached)
      return cached
    }
    const image = document.createElement('canvas')
    image.width = Math.max(1, message.w)
    image.height = Math.max(1, message.h)
    const ctx = image.getContext('2d')
    if (ctx && message.w > 0 && message.h > 0) {
      const pixels = new Uint8ClampedArray(message.rgba.byteLength)
      pixels.set(message.rgba)
      ctx.putImageData(new ImageData(pixels, message.w, message.h), 0, 0)
    }
    let css: string | null = null
    if (message.w > 0 && message.h > 0 && message.w <= MAX_CSS_CURSOR && message.h <= MAX_CSS_CURSOR) {
      try {
        const hotX = Math.min(message.hotX, message.w - 1)
        const hotY = Math.min(message.hotY, message.h - 1)
        css = isBlankCursor(message.rgba) ? 'none' : `url("${image.toDataURL('image/png')}") ${hotX} ${hotY}, default`
      } catch {
        css = null
      }
    }
    const shape: CursorShape = { hotX: message.hotX, hotY: message.hotY, width: message.w, height: message.h, image, css }
    this.shapes.set(key, shape)
    if (this.shapes.size > this.limit) this.shapes.delete(this.shapes.keys().next().value as string)
    return shape
  }

  clear() {
    this.shapes.clear()
  }
}
