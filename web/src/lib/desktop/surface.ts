/*
 * Draws decoded frame operations onto a canvas (an OffscreenCanvas inside the render worker, or a
 * regular canvas on the main thread when workers or OffscreenCanvas are unavailable).
 */
import type { SurfaceOp } from './pipeline'

type CanvasLike = HTMLCanvasElement | OffscreenCanvas
type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

/** Shown before the first frame and after a resize, until the full frame arrives. */
export const SURFACE_BACKGROUND = '#0b0d10'

/** Decodes a JPEG tile off the main thread (the browser decodes `createImageBitmap` asynchronously). */
export function decodeJpeg(payload: Uint8Array): Promise<ImageBitmap> {
  return createImageBitmap(new Blob([payload as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }))
}

export class DesktopSurface {
  private canvas: CanvasLike
  private ctx: Context2D

  constructor(canvas: CanvasLike) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d', { alpha: false }) as Context2D | null
    if (!ctx) throw new Error('2D canvas is not available')
    this.ctx = ctx
  }

  get width() {
    return this.canvas.width
  }

  get height() {
    return this.canvas.height
  }

  reset(width: number, height: number) {
    if (this.canvas.width !== width) this.canvas.width = width
    if (this.canvas.height !== height) this.canvas.height = height
    this.ctx.imageSmoothingEnabled = false
    this.ctx.fillStyle = SURFACE_BACKGROUND
    this.ctx.fillRect(0, 0, width, height)
  }

  apply(ops: SurfaceOp<ImageBitmap>[]) {
    const ctx = this.ctx
    for (const op of ops) {
      switch (op.op) {
        case 'copy':
          // Drawing a canvas onto itself behaves as if the source were copied first, so
          // overlapping move rects (scrolling) are safe.
          ctx.drawImage(this.canvas, op.srcX, op.srcY, op.w, op.h, op.dstX, op.dstY, op.w, op.h)
          break
        case 'image':
          ctx.drawImage(op.image, op.x, op.y, op.w, op.h)
          op.image.close()
          break
        case 'pixels':
          ctx.putImageData(new ImageData(op.rgba, op.w, op.h), op.x, op.y)
          break
        case 'solid':
          ctx.fillStyle = `rgb(${op.rgb[0]} ${op.rgb[1]} ${op.rgb[2]})`
          ctx.fillRect(op.x, op.y, op.w, op.h)
          break
      }
    }
  }

  async snapshot(type = 'image/png'): Promise<Blob | null> {
    if (this.canvas.width === 0 || this.canvas.height === 0) return null
    if ('convertToBlob' in this.canvas) return this.canvas.convertToBlob({ type })
    const canvas = this.canvas
    return new Promise((resolve) => canvas.toBlob(resolve, type))
  }
}
